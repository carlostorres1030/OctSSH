import readline from "node:readline";
import { discoverHostAliases } from "../ssh/config/hosts.js";
import { saveInventory } from "../state/inventory.js";
import { getOctsshDir } from "../state/paths.js";
import { loadConfig } from "../state/config.js";
import { ConnectionPool } from "../ssh/connectionPool.js";
import { connectDirect, connectWithProxyJump } from "../ssh/connect.js";
import { planMachineConnection } from "../ssh/machine.js";
import { collectExtendedInfo } from "./extended.js";

function ask(rl: readline.Interface, q: string) {
  return new Promise<string>((resolve) => rl.question(q, resolve));
}

function isoNow() {
  return new Date().toISOString();
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;

  const workers = Array.from({ length: limit }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]);
    }
  });

  await Promise.all(workers);
  return results;
}

export async function runInitCli() {
  const cfg = loadConfig(getOctsshDir());
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(
      [
        "OctSSH Security Notice",
        "- This tool will read your local ssh_config.",
        "- If you enable Extended init, it will CONNECT to your SSH servers and run read-only info commands.",
        "- You are responsible for what hosts are in your ssh_config and what credentials are used.",
        "",
      ].join("\n")
    );

    const ok = (await ask(rl, "Type 'yes' to continue: ")).trim().toLowerCase();
    if (ok !== "yes") {
      process.stdout.write("Aborted.\n");
      return;
    }

    const hosts = discoverHostAliases();
    process.stdout.write(`Discovered ${hosts.length} hosts.\n`);
    if (hosts.length > cfg.promptThresholdHosts) {
      const cont = (await ask(
        rl,
        `Host count > ${cfg.promptThresholdHosts}. Continue? (yes/no): `
      ))
        .trim()
        .toLowerCase();
      if (cont !== "yes") {
        process.stdout.write("Aborted.\n");
        return;
      }
    }

    const extended = (await ask(rl, "Run Extended init (connect + collect info)? (yes/no): "))
      .trim()
      .toLowerCase();

    if (extended !== "yes") {
      saveInventory(
        {
          extended: false,
          machines: hosts.map((h) => ({ name: h, updatedAt: isoNow() })),
        },
        getOctsshDir()
      );
      process.stdout.write("Saved host list (no extended info).\n");
      return;
    }

    const pool = new ConnectionPool({
      create: async (machine) => {
        const plan = planMachineConnection(machine);
        return plan.jump
          ? await connectWithProxyJump({ jump: plan.jump, target: plan.target })
          : await connectDirect(plan.target);
      },
      close: async (ssh) => ssh.end(),
      options: {
        maxConnections: cfg.maxConnections,
        idleTtlMs: cfg.idleTtlSeconds * 1000,
      },
    });

    const machines = await mapLimit(hosts, cfg.maxConcurrentInit, async (machine) => {
      const lease = await pool.get(machine);
      try {
        const info = await collectExtendedInfo(lease.value.client);
        return { name: machine, updatedAt: isoNow(), ...info };
      } catch (err) {
        return { name: machine, updatedAt: isoNow(), error: String(err) };
      } finally {
        lease.release();
      }
    });

    saveInventory({ extended: true, machines }, getOctsshDir());
    process.stdout.write("Extended init complete; inventory saved.\n");
  } finally {
    rl.close();
  }
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ConnectionPool } from "../ssh/connectionPool.js";
import { connectDirect, connectWithProxyJump } from "../ssh/connect.js";
import { planMachineConnection } from "../ssh/machine.js";
import { runCommand } from "../ssh/runCommand.js";
import { wrapSh, wrapSudoSh, isSudoPasswordError } from "../ssh/shell.js";
import { discoverHostAliases } from "../ssh/config/hosts.js";
import { loadConfig } from "../state/config.js";
import { getOctsshDir } from "../state/paths.js";
import { startAsyncInScreen } from "../ssh/asyncScreen.js";
import { loadSession, saveSession } from "../state/sessions.js";
import { quoteForSh } from "../ssh/shell.js";
import { findExpiredSessions, deleteSessionFile } from "../state/cleanup.js";
import { loadInventory, saveInventory } from "../state/inventory.js";
import { collectExtendedInfo } from "../init/extended.js";

type ToolResult = {
  ok: boolean;
  tool: string;
  error?: string;
  data?: unknown;
};

function respond(result: ToolResult) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(result, null, 2),
      },
    ],
    structuredContent: result,
  };
}

function notImplemented(tool: string) {
  return respond({ ok: false, tool, error: "not implemented" });
}

function isoNow() {
  return new Date().toISOString();
}

function toHomeAbs(remotePath: string) {
  // Session records store paths either as `.octssh/...` or `~/.octssh/...`.
  // We normalize to a shell-safe `$HOME/...` reference.
  const p = remotePath.trim();
  if (p.startsWith("~/")) return `$HOME/${p.slice(2)}`;
  if (p.startsWith(".")) return `$HOME/${p}`;
  return p;
}

export function createOctsshServer() {
  const cfg = loadConfig(getOctsshDir());

  type MachineConn = {
    ssh: { client: any; end: () => void };
    warnings: string[];
  };

  const pool = new ConnectionPool<string, MachineConn>({
    create: async (machine) => {
      const plan = planMachineConnection(machine);
      const ssh = plan.jump
        ? await connectWithProxyJump({ jump: plan.jump, target: plan.target })
        : await connectDirect(plan.target);
      return { ssh, warnings: plan.warnings };
    },
    close: async (v) => {
      v.ssh.end();
    },
    options: {
      maxConnections: cfg.maxConnections,
      idleTtlMs: cfg.idleTtlSeconds * 1000,
    },
  });

  // Best-effort background sweep. This doesn't need to be perfect; the pool
  // also evicts on demand when hitting caps.
  setInterval(() => {
    pool.sweep().catch(() => undefined);
  }, Math.min(cfg.idleTtlSeconds * 1000, 60_000)).unref();

  // TTL cleanup (local + remote best-effort). Default retention is 7 days.
  setInterval(async () => {
    try {
      const currentCfg = loadConfig(getOctsshDir());
      const expired = findExpiredSessions({
        baseDir: getOctsshDir(),
        retentionDays: currentCfg.retentionDays,
      });
      for (const rec of expired) {
        // Best-effort remote cleanup.
        try {
          const lease = await pool.get(rec.machine);
          try {
            await runCommand(
              lease.value.ssh.client,
              wrapSh(
                [
                  `rm -rf \"$HOME/${rec.remoteDir}\" 2>/dev/null || true`,
                  `screen -S ${quoteForSh(rec.screenName)} -X quit 2>/dev/null || true`,
                ].join("; ")
              ),
              { maxStdoutBytes: 8 * 1024, maxStderrBytes: 8 * 1024 }
            );
          } finally {
            lease.release();
          }
        } catch {
          // ignore remote errors
        }

        // Always delete local record when expired.
        deleteSessionFile(rec.session_id, getOctsshDir());
      }
    } catch {
      // ignore cleanup errors
    }
  }, 60 * 60 * 1000).unref();

  const server = new McpServer({
    name: "octssh",
    version: "0.0.0",
  });

  server.registerTool(
    "list",
    {
      title: "List SSH Hosts",
      description:
        "List configured SSH hosts from local ssh_config. Optionally return cached extended fields.",
      inputSchema: z
        .object({
          target: z.array(z.string()).optional(),
        })
        .optional(),
    },
    async (input) => {
      const hosts = discoverHostAliases();
      const target = (input as any)?.target as string[] | undefined;

      const inv = loadInventory(getOctsshDir());
      if (target && inv && inv.extended) {
        const byName = new Map(inv.machines.map((m) => [m.name, m]));
        const machines = hosts.map((h) => {
          const m = byName.get(h);
          const out: any = { name: h };
          for (const t of target) {
            if (m && Object.prototype.hasOwnProperty.call(m, t)) out[t] = (m as any)[t];
          }
          return out;
        });

        return respond({ ok: true, tool: "list", data: { machines, target } });
      }

      return respond({ ok: true, tool: "list", data: { hosts } });
    }
  );

  server.registerTool(
    "info",
    {
      title: "Machine Info",
      description:
        "Get cached (or refreshed) extended info for a machine via SSH.",
      inputSchema: z.object({
        machine: z.string().min(1),
        refresh: z.boolean().optional(),
      }),
    },
    async ({ machine, refresh }) => {
      const baseDir = getOctsshDir();
      const inv = loadInventory(baseDir);

      if (!refresh) {
        const entry = inv?.machines.find((m) => m.name === machine);
        if (!entry) {
          return respond({
            ok: false,
            tool: "info",
            error:
              "No cached info. Run `octssh init` (Extended) or call info(refresh=true).",
          });
        }
        return respond({ ok: true, tool: "info", data: entry });
      }

      const lease = await pool.get(machine);
      try {
        const info = await collectExtendedInfo(lease.value.ssh.client);
        const updated = { name: machine, updatedAt: isoNow(), ...info };

        const existing = inv ?? { extended: true, machines: [] };
        const filtered = existing.machines.filter((m) => m.name !== machine);
        saveInventory({ extended: true, machines: [...filtered, updated] }, baseDir);

        return respond({ ok: true, tool: "info", data: updated });
      } catch (err: any) {
        return respond({ ok: false, tool: "info", error: String(err?.message ?? err) });
      } finally {
        lease.release();
      }
    }
  );

  server.registerTool(
    "exec",
    {
      title: "Execute Command",
      description: "Execute a command on a machine (no sudo).",
      inputSchema: z.object({
        machine: z.string().min(1),
        command: z.string().min(1),
      }),
    },
    async ({ machine, command }) => {
      const lease = await pool.get(machine);
      try {
        const res = await runCommand(lease.value.ssh.client, wrapSh(command));
        return respond({
          ok: res.exitCode === 0,
          tool: "exec",
          data: {
            machine,
            exitCode: res.exitCode,
            stdout: res.stdout,
            stderr: res.stderr,
            truncated: res.truncated,
            warnings: lease.value.warnings,
          },
        });
      } finally {
        lease.release();
      }
    }
  );

  server.registerTool(
    "sudo-exec",
    {
      title: "Execute Command (sudo)",
      description:
        "Execute a command on a machine using passwordless sudo (sudo -n).",
      inputSchema: z.object({
        machine: z.string().min(1),
        command: z.string().min(1),
      }),
    },
    async ({ machine, command }) => {
      const lease = await pool.get(machine);
      try {
        const res = await runCommand(lease.value.ssh.client, wrapSudoSh(command));
        const sudoHint =
          res.exitCode !== 0 && isSudoPasswordError(res.stderr)
            ? "Passwordless sudo is required. Configure sudoers to allow sudo without password for the SSH user."
            : null;

        return respond({
          ok: res.exitCode === 0,
          tool: "sudo-exec",
          data: {
            machine,
            exitCode: res.exitCode,
            stdout: res.stdout,
            stderr: res.stderr,
            truncated: res.truncated,
            sudoHint,
            warnings: lease.value.warnings,
          },
        });
      } finally {
        lease.release();
      }
    }
  );

  server.registerTool(
    "exec-async",
    {
      title: "Execute Async",
      description:
        "Execute a long-running command in background (remote screen session).",
      inputSchema: z.object({
        machine: z.string().min(1),
        command: z.string().min(1),
      }),
    },
    async ({ machine, command }) => {
      const lease = await pool.get(machine);
      try {
        const started = await startAsyncInScreen(lease.value.ssh.client, {
          machine,
          command,
          sudo: false,
        });
        return respond({ ok: true, tool: "exec-async", data: started });
      } finally {
        lease.release();
      }
    }
  );

  server.registerTool(
    "exec-async-sudo",
    {
      title: "Execute Async (sudo)",
      description:
        "Execute a long-running command in background using passwordless sudo.",
      inputSchema: z.object({
        machine: z.string().min(1),
        command: z.string().min(1),
      }),
    },
    async ({ machine, command }) => {
      const lease = await pool.get(machine);
      try {
        const started = await startAsyncInScreen(lease.value.ssh.client, {
          machine,
          command,
          sudo: true,
        });
        return respond({ ok: true, tool: "exec-async-sudo", data: started });
      } finally {
        lease.release();
      }
    }
  );

  server.registerTool(
    "get-result",
    {
      title: "Get Async Result",
      description:
        "Get async command status; optionally tail last N lines from logs.",
      inputSchema: z.object({
        session_id: z.string().min(1),
        lines: z.number().int().positive().max(2000).optional(),
      }),
    },
    async ({ session_id, lines }) => {
      const rec = loadSession(session_id, getOctsshDir());
      if (!rec) {
        return respond({ ok: false, tool: "get-result", error: "session not found" });
      }

      const lease = await pool.get(rec.machine);
      try {
        // Read remote meta.json (best-effort).
        const metaCmd = wrapSh(
          `test -f \"${toHomeAbs(rec.metaPath)}\" && cat \"${toHomeAbs(rec.metaPath)}\" || true`
        );
        const metaRes = await runCommand(lease.value.ssh.client, metaCmd, {
          maxStdoutBytes: 16 * 1024,
          maxStderrBytes: 4 * 1024,
        });

        let remoteMeta: any = null;
        try {
          remoteMeta = metaRes.stdout.trim() ? JSON.parse(metaRes.stdout) : null;
        } catch {
          remoteMeta = null;
        }

        let status = rec.status;
        let exitCode = rec.exitCode ?? null;
        if (remoteMeta && typeof remoteMeta.status === "string") {
          if (remoteMeta.status === "running") status = "running";
          if (remoteMeta.status === "done") {
            status = remoteMeta.exitCode === 0 ? "done" : "failed";
            if (typeof remoteMeta.exitCode === "number") exitCode = remoteMeta.exitCode;
          }
        }

        // Persist status update.
        if (status !== rec.status || exitCode !== rec.exitCode) {
          saveSession(
            {
              ...rec,
              status,
              exitCode: exitCode === null ? undefined : exitCode,
              updatedAt: isoNow(),
            },
            getOctsshDir()
          );
        }

        let tails: any = null;
        if (lines) {
          const n = Math.max(1, Math.min(2000, Math.floor(lines)));
          const tailStdout = await runCommand(
            lease.value.ssh.client,
            wrapSh(
              `tail -n ${n} \"${toHomeAbs(rec.stdoutPath)}\" 2>/dev/null || true`
            ),
            { maxStdoutBytes: 64 * 1024, maxStderrBytes: 4 * 1024 }
          );
          const tailStderr = await runCommand(
            lease.value.ssh.client,
            wrapSh(
              `tail -n ${n} \"${toHomeAbs(rec.stderrPath)}\" 2>/dev/null || true`
            ),
            { maxStdoutBytes: 64 * 1024, maxStderrBytes: 4 * 1024 }
          );
          tails = {
            stdout: tailStdout.stdout,
            stderr: tailStderr.stdout,
          };
        }

        return respond({
          ok: true,
          tool: "get-result",
          data: {
            session_id,
            machine: rec.machine,
            status,
            exitCode,
            screenName: rec.screenName,
            cmdPid: rec.cmdPid ?? null,
            tails,
          },
        });
      } finally {
        lease.release();
      }
    }
  );

  server.registerTool(
    "grep-result",
    {
      title: "Search Async Logs",
      description: "Search async stdout/stderr logs by pattern.",
      inputSchema: z.object({
        session_id: z.string().min(1),
        pattern: z.string().min(1),
        maxMatches: z.number().int().positive().max(500).optional(),
        contextLines: z.number().int().min(0).max(50).optional(),
      }),
    },
    async ({ session_id, pattern, maxMatches, contextLines }) => {
      const rec = loadSession(session_id, getOctsshDir());
      if (!rec) {
        return respond({ ok: false, tool: "grep-result", error: "session not found" });
      }

      const lease = await pool.get(rec.machine);
      try {
        const m = Math.max(1, Math.min(500, Math.floor(maxMatches ?? 50)));
        const c = Math.max(0, Math.min(50, Math.floor(contextLines ?? 2)));

        const grep = (file: string) =>
          wrapSh(
            `command -v grep >/dev/null 2>&1 && grep -n -E -m ${m} -C ${c} -e ${quoteForSh(
              pattern
            )} \"${toHomeAbs(file)}\" 2>/dev/null || true`
          );

        const outStdout = await runCommand(lease.value.ssh.client, grep(rec.stdoutPath), {
          maxStdoutBytes: 64 * 1024,
          maxStderrBytes: 4 * 1024,
        });
        const outStderr = await runCommand(lease.value.ssh.client, grep(rec.stderrPath), {
          maxStdoutBytes: 64 * 1024,
          maxStderrBytes: 4 * 1024,
        });

        return respond({
          ok: true,
          tool: "grep-result",
          data: {
            session_id,
            machine: rec.machine,
            pattern,
            maxMatches: m,
            contextLines: c,
            matches: {
              stdout: outStdout.stdout,
              stderr: outStderr.stdout,
            },
          },
        });
      } finally {
        lease.release();
      }
    }
  );

  server.registerTool(
    "cancel",
    {
      title: "Cancel Async Session",
      description:
        "Terminate a running async session by session_id (signal is optional).",
      inputSchema: z.object({
        session_id: z.string().min(1),
        signal: z.string().optional(),
      }),
    },
    async ({ session_id, signal }) => {
      const rec = loadSession(session_id, getOctsshDir());
      if (!rec) {
        return respond({ ok: false, tool: "cancel", error: "session not found" });
      }

      if (rec.status !== "running") {
        return respond({
          ok: true,
          tool: "cancel",
          data: {
            session_id,
            machine: rec.machine,
            status: rec.status,
            note: "session is not running",
          },
        });
      }

      const lease = await pool.get(rec.machine);
      try {
        const sig = (signal ?? "TERM").toUpperCase();
        const safeSig = /^[A-Z0-9]+$/.test(sig) ? sig : "TERM";

        const parts: string[] = [];
        if (rec.cmdPid) {
          parts.push(`kill -s ${safeSig} ${rec.cmdPid} 2>/dev/null || true`);
        }
        parts.push(
          `screen -S ${quoteForSh(rec.screenName)} -X quit 2>/dev/null || true`
        );

        await runCommand(lease.value.ssh.client, wrapSh(parts.join("; ")), {
          maxStdoutBytes: 8 * 1024,
          maxStderrBytes: 8 * 1024,
        });

        saveSession(
          {
            ...rec,
            status: "cancelled",
            updatedAt: isoNow(),
          },
          getOctsshDir()
        );

        return respond({
          ok: true,
          tool: "cancel",
          data: {
            session_id,
            machine: rec.machine,
            status: "cancelled",
            signal: safeSig,
          },
        });
      } finally {
        lease.release();
      }
    }
  );

  server.registerTool(
    "sleep",
    {
      title: "Sleep",
      description: "Sleep for a duration (ms).",
      inputSchema: z.object({
        time: z.number().int().min(0).max(60_000),
      }),
    },
    async ({ time }) => {
      await new Promise((r) => setTimeout(r, time));
      return respond({ ok: true, tool: "sleep", data: { sleptMs: time } });
    }
  );

  return server;
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { Client } from "ssh2";
import { connectViaProxyJump } from "./proxyJump.js";

export type SshClientParams = {
  host?: string;
  port?: number;
  username: string;

  // Either connect directly over TCP (`host`/`port`), or over an existing stream (`sock`).
  sock?: Duplex;

  // Auth: prefer agent if available, otherwise use key.
  privateKey?: string;
  agent?: string;

  readyTimeoutMs?: number;
};

export type ConnectedSsh = {
  client: Client;
  end: () => void;
};

function expandHome(p: string) {
  if (!p.startsWith("~")) return p;
  return path.join(os.homedir(), p.slice(1));
}

export function loadFirstPrivateKey(identityFiles: string[]) {
  for (const p of identityFiles) {
    const abs = expandHome(p);
    if (!fs.existsSync(abs)) continue;
    return fs.readFileSync(abs, "utf8");
  }
  return undefined;
}

export function connectSsh2(params: SshClientParams): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;

    const cleanup = () => {
      client.removeAllListeners("ready");
      client.removeAllListeners("error");
    };

    client.on("ready", () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(client);
    });

    client.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });

    // IMPORTANT: only set `sock` if it is actually provided.
    // Passing `sock: undefined` breaks some ssh2 versions (they check key presence).
    const connectOptions: any = {
      host: params.host ?? "127.0.0.1",
      port: params.port ?? 22,
      username: params.username,
      readyTimeout: params.readyTimeoutMs ?? 20_000,
    };
    if (params.sock) connectOptions.sock = params.sock;
    if (params.privateKey) connectOptions.privateKey = params.privateKey;
    if (params.agent) connectOptions.agent = params.agent;

    client.connect(connectOptions);
  });
}

export async function connectDirect(params: Omit<SshClientParams, "sock">): Promise<ConnectedSsh> {
  const client = await connectSsh2(params);
  return {
    client,
    end: () => client.end(),
  };
}

export async function connectWithProxyJump(params: {
  jump: Omit<SshClientParams, "sock"> & { host: string; port?: number };
  target: Omit<SshClientParams, "sock"> & { host: string; port?: number };
}) {
  const jumpClient = await connectSsh2(params.jump);
  try {
    const targetClient = await connectViaProxyJump({
      jumpClient,
      targetHost: params.target.host,
      targetPort: params.target.port ?? 22,
      connectTarget: async (sock) => {
        return connectSsh2({
          ...params.target,
          sock,
        });
      },
    });

    return {
      client: targetClient,
      end: () => {
        // Closing target will implicitly close the forwarded channel.
        targetClient.end();
        jumpClient.end();
      },
    } satisfies ConnectedSsh;
  } catch (err) {
    jumpClient.end();
    throw err;
  }
}

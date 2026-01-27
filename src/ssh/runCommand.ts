import type { Client } from "ssh2";

export type ExecOptions = {
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
};

export type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  truncated: {
    stdout: boolean;
    stderr: boolean;
  };
};

export async function runCommand(
  client: Client,
  command: string,
  options: ExecOptions = {}
): Promise<ExecResult> {
  const maxStdoutBytes = options.maxStdoutBytes ?? 64 * 1024;
  const maxStderrBytes = options.maxStderrBytes ?? 64 * 1024;

  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) return reject(err);

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stdoutTrunc = false;
      let stderrTrunc = false;

      stream.on("data", (chunk: Buffer) => {
        if (stdoutTrunc) return;
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxStdoutBytes) {
          stdoutTrunc = true;
          return;
        }
        stdoutChunks.push(chunk);
      });

      stream.stderr.on("data", (chunk: Buffer) => {
        if (stderrTrunc) return;
        stderrBytes += chunk.length;
        if (stderrBytes > maxStderrBytes) {
          stderrTrunc = true;
          return;
        }
        stderrChunks.push(chunk);
      });

      stream.on("close", (code: number, signal: string) => {
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          exitCode: Number.isFinite(code) ? code : null,
          signal: signal ?? null,
          truncated: { stdout: stdoutTrunc, stderr: stderrTrunc },
        });
      });
    });
  });
}

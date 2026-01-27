import crypto from "node:crypto";
import type { Client } from "ssh2";
import { runCommand } from "./runCommand.js";
import { quoteForSh, wrapSh } from "./shell.js";
import { saveSession } from "../state/sessions.js";
import { getOctsshDir } from "../state/paths.js";

export type StartAsyncParams = {
  machine: string;
  command: string;
  sudo: boolean;
};

export type StartedAsync = {
  session_id: string;
  screenName: string;
  cmdPid?: number;
  remoteDir: string;
  stdoutPath: string;
  stderrPath: string;
  metaPath: string;
};

function nowIso() {
  return new Date().toISOString();
}

function buildScreenWrapper(params: { sessionId: string; command: string; sudo: boolean }) {
  const runDir = `$HOME/.octssh/runs/${params.sessionId}`;
  const stdout = `${runDir}/stdout.log`;
  const stderr = `${runDir}/stderr.log`;
  const meta = `${runDir}/meta.json`;
  const pidFile = `${runDir}/cmd.pid`;

  const inner = params.sudo
    ? `sudo -n -- sh -lc ${quoteForSh(params.command)}`
    : `sh -lc ${quoteForSh(params.command)}`;

  // This wrapper runs inside the screen session.
  // It writes cmd pid + status meta for polling.
  return [
    `run=${quoteForSh(runDir)}`,
    `mkdir -p "$run"`,
    `stdout=${quoteForSh(stdout)}`,
    `stderr=${quoteForSh(stderr)}`,
    `meta=${quoteForSh(meta)}`,
    `pidfile=${quoteForSh(pidFile)}`,
    `ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)`,
    `printf '{"status":"running","startedAt":"%s"}\n' "$ts" > "$meta"`,
    // Run the command in background so we can record its pid.
    `(${inner}) >"$stdout" 2>"$stderr" & cmdpid=$!`,
    `echo "$cmdpid" > "$pidfile"`,
    `wait "$cmdpid"; code=$?`,
    `ts2=$(date -u +%Y-%m-%dT%H:%M:%SZ)`,
    `printf '{"status":"done","exitCode":%s,"endedAt":"%s"}\n' "$code" "$ts2" > "$meta"`,
  ].join("; ");
}

export async function startAsyncInScreen(
  client: Client,
  params: StartAsyncParams
): Promise<StartedAsync> {
  const sessionId = crypto.randomUUID();
  const screenName = `octssh-${sessionId}`;

  // Remote locations are standardized.
  // Store paths relative to $HOME so we can reliably address them remotely.
  const remoteDir = `.octssh/runs/${sessionId}`;
  const stdoutPath = `${remoteDir}/stdout.log`;
  const stderrPath = `${remoteDir}/stderr.log`;
  const metaPath = `${remoteDir}/meta.json`;

  // Preflight: require screen.
  const hasScreen = await runCommand(client, wrapSh("command -v screen >/dev/null 2>&1"));
  if (hasScreen.exitCode !== 0) {
    throw new Error("Remote prerequisite missing: `screen` is required on the server.");
  }

  const wrapper = buildScreenWrapper({ sessionId, command: params.command, sudo: params.sudo });

  // Start a detached screen session.
  // After starting, try to read cmd.pid (best-effort).
  const launcher = [
    `run=\"$HOME/.octssh/runs/${sessionId}\"`,
    `mkdir -p \"$run\"`,
    // Create placeholder files so polling doesn't see an empty dir.
    `: > \"$run/stdout.log\"; : > \"$run/stderr.log\"`,
    `printf '{"status":"running","startedAt":"%s"}\n' \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\" > \"$run/meta.json\"`,
    // Launch screen; then verify it exists.
    `screen -dmS ${quoteForSh(screenName)} sh -lc ${quoteForSh(wrapper)}`,
    `screen -ls | grep -F ${quoteForSh(screenName)} >/dev/null 2>&1 || { echo 'screen failed to start' 1>&2; exit 1; }`,
    // Best-effort: wait for cmd.pid a few seconds.
    `i=0; while [ $i -lt 5 ]; do if [ -f \"$run/cmd.pid\" ]; then cat \"$run/cmd.pid\"; exit 0; fi; i=$((i+1)); sleep 1; done; exit 0`,
  ].join("; ");

  const started = await runCommand(client, wrapSh(launcher), {
    maxStdoutBytes: 1024,
    maxStderrBytes: 1024,
    // screen may require a TTY depending on remote config.
    pty: true,
  });

  if (started.exitCode !== 0) {
    throw new Error(
      `Failed to start remote screen session (${started.stderr.trim() || "unknown error"})`
    );
  }

  let cmdPid: number | undefined;
  const pidText = started.stdout.trim();
  if (pidText) {
    const n = Number(pidText);
    if (Number.isFinite(n) && n > 0) cmdPid = n;
  }

  // Persist local session record.
  const now = nowIso();
  saveSession(
    {
      session_id: sessionId,
      machine: params.machine,
      createdAt: now,
      updatedAt: now,
      status: "running",
      screenName,
      cmdPid,
      remoteDir,
      stdoutPath,
      stderrPath,
      metaPath,
    },
    getOctsshDir()
  );

  return {
    session_id: sessionId,
    screenName,
    cmdPid,
    remoteDir,
    stdoutPath,
    stderrPath,
    metaPath,
  };
}

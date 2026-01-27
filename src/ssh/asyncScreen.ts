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

  // Note: This runs inside the screen session.
  // It writes a cmd.pid so the launcher can capture it.
  return [
    `run=${quoteForSh(runDir)}`,
    `mkdir -p "$run"`,
    `stdout=${quoteForSh(stdout)}`,
    `stderr=${quoteForSh(stderr)}`,
    `meta=${quoteForSh(meta)}`,
    `pidfile=${quoteForSh(pidFile)}`,
    `start=${quoteForSh(params.sessionId)}`,
    `echo '{"status":"running","startedAt":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)'""}' > "$meta"`,
    `(${inner}) >"$stdout" 2>"$stderr" & cmdpid=$!`,
    `echo "$cmdpid" > "$pidfile"`,
    `wait "$cmdpid"; code=$?`,
    `echo '{"status":"done","exitCode":'"$code"',"endedAt":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)'""}' > "$meta"`,
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
    `screen -dmS ${quoteForSh(screenName)} sh -lc ${quoteForSh(wrapper)}`,
    `i=0; while [ $i -lt 5 ]; do if [ -f \"$run/cmd.pid\" ]; then cat \"$run/cmd.pid\"; exit 0; fi; i=$((i+1)); sleep 1; done; exit 0`,
  ].join("; ");

  const started = await runCommand(client, wrapSh(launcher), {
    maxStdoutBytes: 1024,
    maxStderrBytes: 1024,
  });

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

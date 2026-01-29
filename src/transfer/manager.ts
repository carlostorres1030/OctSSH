import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Client } from "ssh2";
import { getOctsshDir } from "../state/paths.js";
import { loadSession, saveSession, type SessionRecord } from "../state/sessions.js";
import { performDownload, type DownloadPlan } from "./download.js";
import { performUpload, type UploadPlan } from "./upload.js";

type TransferRuntime = {
  abort: AbortController;
};

const runtimes = new Map<string, TransferRuntime>();

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

function getTransferLogsDir(baseDir = getOctsshDir()) {
  return path.join(baseDir, "transfer-logs");
}

function appendLog(sessionId: string, line: string, baseDir = getOctsshDir()) {
  const dir = getTransferLogsDir(baseDir);
  ensureDir(dir);
  const p = path.join(dir, `${sessionId}.log`);
  fs.appendFileSync(p, `${nowIso()} ${line}\n`, "utf8");
  return p;
}

function setTransferSession(update: Partial<SessionRecord> & { session_id: string }, baseDir = getOctsshDir()) {
  const prev = loadSession(update.session_id, baseDir);
  if (!prev) return;
  saveSession({ ...prev, ...update, updatedAt: nowIso() } as any, baseDir);
}

export function cancelTransfer(sessionId: string) {
  const rt = runtimes.get(sessionId);
  if (!rt) return false;
  rt.abort.abort();
  return true;
}

export function startUploadAsync(params: {
  client: Client;
  machine: string;
  localPath: string;
  remotePath: string;
  plan: UploadPlan;
}) {
  const baseDir = getOctsshDir();
  const sessionId = crypto.randomUUID();
  const logPath = appendLog(sessionId, `upload start: ${params.localPath} -> ${params.remotePath}`, baseDir);

  saveSession(
    {
      kind: "transfer",
      session_id: sessionId,
      machine: params.machine,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      status: "running",
      direction: "upload",
      localPath: params.localPath,
      remotePath: params.remotePath,
      bytesTotal: params.plan.totalBytes,
      bytesDone: 0,
      localLogPath: logPath,
    },
    baseDir
  );

  const abort = new AbortController();
  runtimes.set(sessionId, { abort });

  (async () => {
    try {
      let done = 0;
      for (const f of params.plan.files) {
        if (abort.signal.aborted) throw new Error("cancelled");
        appendLog(sessionId, `put ${f.local} -> ${f.remote}`, baseDir);
        // performUpload already ensures dirs; here we upload per file for progress.
        await performUpload(params.client, { ...params.plan, files: [f], totalBytes: f.size, dirs: params.plan.dirs, isDir: params.plan.isDir });
        done += f.size ?? 0;
        setTransferSession({ session_id: sessionId, bytesDone: done } as any, baseDir);
      }
      appendLog(sessionId, "upload done", baseDir);
      setTransferSession({ session_id: sessionId, status: "done", bytesDone: done } as any, baseDir);
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      appendLog(sessionId, `upload failed: ${msg}`, baseDir);
      setTransferSession({ session_id: sessionId, status: msg === "cancelled" ? "cancelled" : "failed", error: msg } as any, baseDir);
    } finally {
      runtimes.delete(sessionId);
    }
  })();

  return { session_id: sessionId };
}

export function startDownloadAsync(params: {
  client: Client;
  machine: string;
  remotePath: string;
  localPath: string;
  plan: DownloadPlan;
}) {
  const baseDir = getOctsshDir();
  const sessionId = crypto.randomUUID();
  const logPath = appendLog(sessionId, `download start: ${params.remotePath} -> ${params.localPath}`, baseDir);

  saveSession(
    {
      kind: "transfer",
      session_id: sessionId,
      machine: params.machine,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      status: "running",
      direction: "download",
      localPath: params.localPath,
      remotePath: params.remotePath,
      bytesTotal: params.plan.totalBytes,
      bytesDone: 0,
      localLogPath: logPath,
    },
    baseDir
  );

  const abort = new AbortController();
  runtimes.set(sessionId, { abort });

  (async () => {
    try {
      let done = 0;
      for (const f of params.plan.files) {
        if (abort.signal.aborted) throw new Error("cancelled");
        appendLog(sessionId, `get ${f.remote} -> ${f.local}`, baseDir);
        await performDownload(params.client, { ...params.plan, files: [f], totalBytes: f.size, dirs: params.plan.dirs, isDir: params.plan.isDir });
        done += f.size ?? 0;
        setTransferSession({ session_id: sessionId, bytesDone: done } as any, baseDir);
      }
      appendLog(sessionId, "download done", baseDir);
      setTransferSession({ session_id: sessionId, status: "done", bytesDone: done } as any, baseDir);
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      appendLog(sessionId, `download failed: ${msg}`, baseDir);
      setTransferSession({ session_id: sessionId, status: msg === "cancelled" ? "cancelled" : "failed", error: msg } as any, baseDir);
    } finally {
      runtimes.delete(sessionId);
    }
  })();

  return { session_id: sessionId };
}

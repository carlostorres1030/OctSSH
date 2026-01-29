import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { atomicWriteFileSync, readJsonIfExistsSync } from "./fs.js";
import { getOctsshDir } from "./paths.js";

const execPendingSchema = z
  .object({
    kind: z.literal("exec"),
    createdAt: z.string().min(1),
    machine: z.string().min(1),
    command: z.string().min(1),
    preview: z
      .object({
        type: z.string().min(1),
        total: z.number().int().nonnegative(),
        truncated: z.boolean(),
        sample: z.array(z.string()),
      })
      .strict(),
  })
  .strict();

const uploadPendingSchema = z
  .object({
    kind: z.literal("upload"),
    createdAt: z.string().min(1),
    machine: z.string().min(1),
    localPath: z.string().min(1),
    remotePath: z.string().min(1),
    conflicts: z.array(z.string()),
  })
  .strict();

export const pendingSchema = z.union([execPendingSchema, uploadPendingSchema]);
export type PendingRecord = z.infer<typeof pendingSchema>;

export function getPendingDir(baseDir?: string) {
  const root = baseDir ?? getOctsshDir();
  return path.join(root, "pending");
}

export function getPendingPath(code: string, baseDir?: string) {
  return path.join(getPendingDir(baseDir), `${code}.json`);
}

export function createPending(record: PendingRecord, baseDir?: string) {
  const code = crypto.randomUUID();
  const p = getPendingPath(code, baseDir);
  atomicWriteFileSync(p, JSON.stringify(record, null, 2) + "\n");
  return code;
}

export function loadPending(code: string, baseDir?: string): PendingRecord | null {
  const p = getPendingPath(code, baseDir);
  const json = readJsonIfExistsSync<unknown>(p);
  if (!json) return null;
  return pendingSchema.parse(json);
}

export function deletePending(code: string, baseDir?: string) {
  const p = getPendingPath(code, baseDir);
  try {
    fs.rmSync(p, { force: true });
  } catch {
    // best-effort
  }
}

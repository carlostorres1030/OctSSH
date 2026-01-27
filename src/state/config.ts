import path from "node:path";
import { z } from "zod";
import { atomicWriteFileSync, readJsonIfExistsSync } from "./fs.js";
import { getOctsshDir } from "./paths.js";

export const configSchema = z
  .object({
    retentionDays: z.number().int().min(1).max(365).default(7),
    maxConcurrentInit: z.number().int().min(1).max(50).default(5),
    promptThresholdHosts: z.number().int().min(1).max(10_000).default(20),
    idleTtlSeconds: z.number().int().min(1).max(3600).default(300),
    maxConnections: z.number().int().min(1).max(500).default(10),
    allowSshG: z.boolean().default(false)
  })
  .strict();

export type OctsshConfig = z.infer<typeof configSchema>;

export const DEFAULT_CONFIG: OctsshConfig = configSchema.parse({});

export function getConfigPath(baseDir?: string) {
  const root = baseDir ?? getOctsshDir();
  return path.join(root, "config.json");
}

export function loadConfig(baseDir?: string): OctsshConfig {
  const configPath = getConfigPath(baseDir);
  const json = readJsonIfExistsSync<unknown>(configPath);
  if (!json) return DEFAULT_CONFIG;

  // Merge defaults so new fields get populated.
  return configSchema.parse({ ...DEFAULT_CONFIG, ...(json as any) });
}

export function saveConfig(config: OctsshConfig, baseDir?: string) {
  const configPath = getConfigPath(baseDir);
  const normalized = configSchema.parse(config);
  atomicWriteFileSync(configPath, JSON.stringify(normalized, null, 2) + "\n");
}

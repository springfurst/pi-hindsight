/**
 * Hindsight configuration parsing and path handling.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface HindsightConfig {
  api_url?: string;
  api_key?: string;
  global_bank?: string;
  project_bank_id?: string;
  recall_types?: string[];
  recall_budget?: string;
  recall_max_tokens?: number;
  recall_timeout?: number;
  recall_hint_interval?: number;
  recall_hint_message?: string;
  recall_nudge_message?: string;
  recall_nudge_display?: "message" | "indicator";
  reflect_timeout?: number;
  retain_timeout?: number;
  flush_timeout?: number;
  auto_missions?: boolean;
  redact_secrets?: boolean;
  async_retain?: boolean;
  retain_feedback?: "message" | "status" | "both" | "none";
  recall_enabled?: boolean;
  retain_enabled?: boolean;
  homedir_project?: boolean;
}

export const DEFAULT_RECALL_HINT_INTERVAL = 1;
export const DEFAULT_RECALL_HINT_MESSAGE =
  "Persistent memory is available through the `hindsight_recall` tool. Before answering, consider whether recalling relevant context would help; if so, call `hindsight_recall` with a focused query. Skip it when the request does not depend on past context.";
export const DEFAULT_RECALL_NUDGE_MESSAGE =
  "You have not recalled memory recently. Consider whether hindsight_recall would provide useful context for the current request.";
export const DEFAULT_RECALL_NUDGE_DISPLAY: "message" | "indicator" = "indicator";

export const TIMEOUT_DEFAULTS = {
  recall_timeout: 10000,
  reflect_timeout: 60000,
  retain_timeout: 60000,
  flush_timeout: 30000,
} as const;

export const DEFAULT_RECALL_TIMEOUT_MS = TIMEOUT_DEFAULTS.recall_timeout;
export const DEFAULT_REFLECT_TIMEOUT_MS = TIMEOUT_DEFAULTS.reflect_timeout;
export const DEFAULT_RETAIN_TIMEOUT_MS = TIMEOUT_DEFAULTS.retain_timeout;
export const DEFAULT_FLUSH_TIMEOUT_MS = TIMEOUT_DEFAULTS.flush_timeout;

export const CONFIG_DEFAULTS = {
  recall_budget: "mid",
  recall_types: "observation",
  recall_hint_interval: String(DEFAULT_RECALL_HINT_INTERVAL),
  recall_hint_message: DEFAULT_RECALL_HINT_MESSAGE,
  recall_nudge_message: DEFAULT_RECALL_NUDGE_MESSAGE,
  recall_nudge_display: DEFAULT_RECALL_NUDGE_DISPLAY,
  retain_feedback: "status",
  auto_missions: "true",
  redact_secrets: "true",
  async_retain: "true",
  recall_enabled: "true",
  retain_enabled: "true",
  homedir_project: "true",
  recall_timeout: String(TIMEOUT_DEFAULTS.recall_timeout),
  reflect_timeout: String(TIMEOUT_DEFAULTS.reflect_timeout),
  retain_timeout: String(TIMEOUT_DEFAULTS.retain_timeout),
  flush_timeout: String(TIMEOUT_DEFAULTS.flush_timeout),
} as const;

export interface ConfigSource {
  global: Record<string, string>;
  local: Record<string, string>;
  merged: Record<string, string>;
  isHomeDir: boolean;
}

interface ConfigCacheEntry extends ConfigSource {
  key: string;
  config: HindsightConfig | null;
}

let configCache: ConfigCacheEntry | null = null;

function stripInlineComment(raw: string): string {
  let quote: string | null = null;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\" && quote === '"') {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if ((ch === "#" || ch === ";") && (i === 0 || /\s/.test(raw[i - 1]))) {
      return raw.slice(0, i);
    }
  }
  return raw;
}

function parseConfigValue(raw: string): string {
  let value = stripInlineComment(raw).trim();
  if (value.length >= 2 && ((value[0] === '"' && value.at(-1) === '"') || (value[0] === "'" && value.at(-1) === "'"))) {
    const quote = value[0];
    value = value.slice(1, -1);
    if (quote === '"') {
      value = value.replace(/\\(["\\nrt])/g, (_match, escape) => {
        switch (escape) {
          case "n": return "\n";
          case "r": return "\r";
          case "t": return "\t";
          case '"': return '"';
          case "\\": return "\\";
          default: return escape;
        }
      });
    } else {
      value = value.replace(/''/g, "'");
    }
  }
  return value;
}

export function parseConfigFile(filePath: string): Record<string, string> {
  const raw = readFileSync(filePath, "utf-8");
  const config: Record<string, string> = {};
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";") || line.startsWith("[")) continue;
    const match = line.match(/^([a-zA-Z0-9_]+)\s*=\s*(.*)$/);
    if (match) config[match[1]] = parseConfigValue(match[2]);
  }
  return config;
}

function parseOptionalPositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw.trim());
  return Number.isFinite(value) && Number.isInteger(value) && value > 0 ? value : undefined;
}

function parseOptionalNonNegativeInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw.trim());
  return Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const value = raw.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(value)) return true;
  if (["false", "0", "no", "off"].includes(value)) return false;
  return fallback;
}

// Legacy key aliases: old_key → canonical_key
const CONFIG_ALIASES: Record<string, string> = {
  bank_id: "global_bank",
  max_tokens: "recall_max_tokens",
};

function applyAliases(raw: Record<string, string>): Record<string, string> {
  const result = { ...raw };
  for (const [oldKey, newKey] of Object.entries(CONFIG_ALIASES)) {
    if (result[oldKey] !== undefined && result[newKey] === undefined) {
      result[newKey] = result[oldKey];
    }
  }
  return result;
}

function resolveConfig(merged: Record<string, string>): HindsightConfig {
  const allowedRecallTypes = new Set(["world", "experience", "observation"]);
  const recall_types = merged.recall_types
    ? merged.recall_types.split(",").map((type) => type.trim().toLowerCase()).filter((type) => allowedRecallTypes.has(type))
    : ["observation"];
  if (recall_types.length === 0) recall_types.push("observation");

  const budgetRaw = (merged.recall_budget || CONFIG_DEFAULTS.recall_budget).trim().toLowerCase();
  const recall_budget = ["low", "mid", "high"].includes(budgetRaw) ? budgetRaw : CONFIG_DEFAULTS.recall_budget;
  const feedbackRaw = (merged.retain_feedback || CONFIG_DEFAULTS.retain_feedback).trim().toLowerCase();
  const retain_feedback: HindsightConfig["retain_feedback"] =
    ["message", "status", "both", "none"].includes(feedbackRaw)
      ? feedbackRaw as HindsightConfig["retain_feedback"]
      : "status";
  const nudgeDisplayRaw = (merged.recall_nudge_display || DEFAULT_RECALL_NUDGE_DISPLAY).trim().toLowerCase();
  const recall_nudge_display: HindsightConfig["recall_nudge_display"] =
    nudgeDisplayRaw === "message" || nudgeDisplayRaw === "true" ? "message" : "indicator";

  return {
    api_url: merged.api_url?.trim().replace(/\/+$/, "") || undefined,
    api_key: merged.api_key?.trim(),
    global_bank: merged.global_bank?.trim(),
    project_bank_id: merged.project_bank_id?.trim(),
    recall_types,
    recall_budget,
    recall_max_tokens: parseOptionalPositiveInt(merged.recall_max_tokens),
    recall_timeout: parseOptionalPositiveInt(merged.recall_timeout),
    recall_hint_interval: parseOptionalNonNegativeInt(merged.recall_hint_interval) ?? DEFAULT_RECALL_HINT_INTERVAL,
    recall_hint_message: merged.recall_hint_message?.trim() || DEFAULT_RECALL_HINT_MESSAGE,
    recall_nudge_message: merged.recall_nudge_message?.trim() || DEFAULT_RECALL_NUDGE_MESSAGE,
    recall_nudge_display,
    reflect_timeout: parseOptionalPositiveInt(merged.reflect_timeout),
    retain_timeout: parseOptionalPositiveInt(merged.retain_timeout),
    flush_timeout: parseOptionalPositiveInt(merged.flush_timeout),
    auto_missions: parseBoolean(merged.auto_missions, true),
    redact_secrets: parseBoolean(merged.redact_secrets, true),
    async_retain: parseBoolean(merged.async_retain, true),
    retain_feedback,
    recall_enabled: parseBoolean(merged.recall_enabled, true),
    retain_enabled: parseBoolean(merged.retain_enabled, true),
    homedir_project: parseBoolean(merged.homedir_project, true),
  };
}

function statKey(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch (_) {
    return "missing";
  }
}

function loadConfig(cwd: string): ConfigCacheEntry {
  const globalPath = join(homedir(), ".hindsight", "config");
  const localPath = join(cwd, ".hindsight", "config");
  const isHomeDir = cwd === homedir();
  const key = [
    globalPath,
    statKey(globalPath),
    isHomeDir ? "home" : localPath,
    isHomeDir ? "home" : statKey(localPath),
  ].join("|");

  if (configCache?.key === key) return configCache;

  const globalRaw = existsSync(globalPath) ? parseConfigFile(globalPath) : {};
  const localRaw = !isHomeDir && existsSync(localPath) ? parseConfigFile(localPath) : {};
  const global = applyAliases(globalRaw);
  const local = applyAliases(localRaw);
  const merged = { ...global, ...local };
  let config: HindsightConfig | null = null;
  if (existsSync(globalPath)) {
    try {
      config = resolveConfig(merged);
    } catch (_) {
      config = null;
    }
  }

  configCache = { key, config, global, local, merged, isHomeDir };
  return configCache;
}

export function resetConfigCache(): void {
  configCache = null;
}

export function getConfig(cwd: string = process.cwd()): HindsightConfig | null {
  try {
    return loadConfig(cwd).config;
  } catch (_) {
    return null;
  }
}

export function getConfigWithSource(cwd: string = process.cwd()): ConfigSource {
  const entry = loadConfig(cwd);
  return {
    global: entry.global,
    local: entry.local,
    merged: entry.merged,
    isHomeDir: entry.isHomeDir,
  };
}

export function writeConfigValue(filePath: string, key: string, value: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  let lines: string[] = [];
  if (existsSync(filePath)) {
    lines = readFileSync(filePath, "utf-8").split("\n");
  }
  const pattern = new RegExp(`^\\s*${key}\\s*=`);
  const idx = lines.findIndex((line) => pattern.test(line));
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n");
  const newLine = `${key} = "${escaped}"`;
  if (idx >= 0) {
    lines[idx] = newLine;
  } else {
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
    lines.push(newLine);
  }
  writeFileSync(filePath, lines.join("\n") + "\n");
  resetConfigCache();
}

export function detectLegacyKeys(cwd: string = process.cwd()): { file: string; key: string; canonical: string }[] {
  const issues: { file: string; key: string; canonical: string }[] = [];
  const globalCfgPath = join(homedir(), ".hindsight", "config");
  const localCfgPath = join(cwd, ".hindsight", "config");
  const isHomeDir = cwd === homedir();
  const files = [globalCfgPath];
  if (!isHomeDir && existsSync(localCfgPath)) files.push(localCfgPath);
  for (const file of files) {
    if (!existsSync(file)) continue;
    const raw = parseConfigFile(file);
    for (const [oldKey, newKey] of Object.entries(CONFIG_ALIASES)) {
      if (raw[oldKey] !== undefined && raw[newKey] === undefined) {
        issues.push({ file, key: oldKey, canonical: newKey });
      }
    }
  }
  return issues;
}

export function migrateConfigFile(filePath: string): string[] {
  const migrated: string[] = [];
  if (!existsSync(filePath)) return migrated;
  const lines = readFileSync(filePath, "utf-8").split("\n");
  for (const [oldKey, newKey] of Object.entries(CONFIG_ALIASES)) {
    const pattern = new RegExp(`^(\\s*)${oldKey}(\\s*=)`);
    const idx = lines.findIndex((line) => pattern.test(line));
    if (idx >= 0) {
      const hasCanonical = lines.some((line) => new RegExp(`^\\s*${newKey}\\s*=`).test(line));
      if (!hasCanonical) {
        lines[idx] = lines[idx].replace(pattern, `$1${newKey}$2`);
        migrated.push(`${oldKey} → ${newKey}`);
      }
    }
  }
  if (migrated.length > 0) {
    writeFileSync(filePath, lines.join("\n"));
    resetConfigCache();
  }
  return migrated;
}

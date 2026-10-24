/**
 * `/hindsight` command handlers.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  CONFIG_DEFAULTS,
  DEFAULT_RECALL_HINT_INTERVAL,
  DEFAULT_RECALL_NUDGE_DISPLAY,
  TIMEOUT_DEFAULTS,
  detectLegacyKeys,
  getConfig,
  getConfigWithSource,
  migrateConfigFile,
  writeConfigValue,
  type HindsightConfig,
} from "./config.ts";
import { getProjectBank, getRecallBanks } from "./banks.ts";
import { HindsightClient } from "./api.ts";
import { DEBUG, readRecentLogErrors } from "./logging.ts";
import type { HookRecord, SessionState } from "./session.ts";

interface SettingMeta {
  key: string;
  label: string;
  isBool: boolean;
  default: string;
}

const SETTINGS_META: SettingMeta[] = [
  { key: "api_url", label: "API URL", isBool: false, default: "(required)" },
  { key: "api_key", label: "API Key", isBool: false, default: "(required)" },
  { key: "global_bank", label: "Global Bank", isBool: false, default: "(not set)" },
  { key: "project_bank_id", label: "Project Bank Override", isBool: false, default: "(auto)" },
  { key: "recall_enabled", label: "Recall Hints", isBool: true, default: CONFIG_DEFAULTS.recall_enabled },
  { key: "recall_hint_interval", label: "Recall Nudge Interval", isBool: false, default: String(DEFAULT_RECALL_HINT_INTERVAL) },
  { key: "recall_hint_message", label: "Recall System Hint", isBool: false, default: "(default)" },
  { key: "recall_nudge_message", label: "Recall Nudge Message", isBool: false, default: "(default)" },
  { key: "recall_nudge_display", label: "Recall Nudge UI (message|indicator)", isBool: false, default: DEFAULT_RECALL_NUDGE_DISPLAY },
  { key: "retain_enabled", label: "Auto-Retain", isBool: true, default: CONFIG_DEFAULTS.retain_enabled },
  { key: "async_retain", label: "Async Retain", isBool: true, default: CONFIG_DEFAULTS.async_retain },
  { key: "retain_feedback", label: "Retain Feedback", isBool: false, default: CONFIG_DEFAULTS.retain_feedback },
  { key: "redact_secrets", label: "Redact Secrets", isBool: true, default: CONFIG_DEFAULTS.redact_secrets },
  { key: "auto_missions", label: "Auto Bank Missions", isBool: true, default: CONFIG_DEFAULTS.auto_missions },
  { key: "homedir_project", label: "Home Dir as Project", isBool: true, default: CONFIG_DEFAULTS.homedir_project },
  { key: "recall_types", label: "Recall Types", isBool: false, default: CONFIG_DEFAULTS.recall_types },
  { key: "recall_budget", label: "Recall Budget", isBool: false, default: CONFIG_DEFAULTS.recall_budget },
  { key: "recall_max_tokens", label: "Max Tokens", isBool: false, default: "(default)" },
  { key: "recall_timeout", label: "Recall Timeout (ms)", isBool: false, default: String(TIMEOUT_DEFAULTS.recall_timeout) },
  { key: "reflect_timeout", label: "Reflect Timeout (ms)", isBool: false, default: String(TIMEOUT_DEFAULTS.reflect_timeout) },
  { key: "retain_timeout", label: "Retain Timeout (ms)", isBool: false, default: String(TIMEOUT_DEFAULTS.retain_timeout) },
  { key: "flush_timeout", label: "Flush Timeout (ms)", isBool: false, default: String(TIMEOUT_DEFAULTS.flush_timeout) },
];

const DONE_LABEL = "← Done";

function hookIcon(result?: string): string {
  return result === "ok" ? "✓" : result === "failed" ? "✗" : result === "skipped" ? "-" : "...";
}

function formatHook(hook: HookRecord): string {
  return hook.firedAt
    ? `${hookIcon(hook.result)} ${hook.result}${hook.detail ? ` (${hook.detail})` : ""}`
    : "not fired";
}

function missionFromConfig(config: Record<string, any>, overrides?: Record<string, any>): string | null {
  const mission = config.reflect_mission ?? overrides?.reflect_mission;
  return typeof mission === "string" && mission.trim() ? mission : null;
}

async function handleStatus(ctx: any, state: SessionState, config: HindsightConfig): Promise<void> {
  const lines: string[] = [];
  let hasError = false;

  if (state.disabled) {
    lines.push("Session: disabled (memory bank not created)");
  }

  lines.push(`URL:    ${config.api_url || "Not set"}`);
  if (!config.api_url) {
    lines.push("  ✗ api_url missing");
    hasError = true;
  }
  if (!config.api_key) {
    lines.push("  ⚠ api_key not set");
  }

  if (config.api_url) {
    const client = new HindsightClient(config);
    const health = await client.health();
    lines.push(`Server: ${health.ok ? "✓ online" : `✗ unreachable${health.status ? ` (HTTP ${health.status})` : ""}`}`);
    if (!health.ok) hasError = true;
    if (health.ok) {
      const version = await client.version();
      if (version) lines.push(`API:    ${version}`);
    }

    const bank = getProjectBank(config, state.cwd);
    lines.push(`Bank:   ${bank}`);
    const bankCheck = await client.bankConfig(bank);
    if (!bankCheck.ok) {
      if (bankCheck.status === 404) {
        lines.push("  ○ not created yet (created on first retain)");
      } else {
        lines.push(`  ✗ ${bankCheck.authError ? "auth invalid - check api_key" : "bank unreachable"}`);
        hasError = true;
      }
    } else {
      lines.push("  ✓ auth ok");
      const data = bankCheck.data;
      if (data) {
        const mission = missionFromConfig(data.config, data.overrides);
        if (mission) {
          lines.push(`  mission: ${mission.slice(0, 120)}${mission.length > 120 ? "…" : ""}`);
        }
      }
    }
  }

  if (config.global_bank) lines.push(`Global: ${config.global_bank}`);
  lines.push("");
  lines.push("Hooks this session:");
  lines.push(`  session_start:      ${formatHook(state.hookStats.sessionStart)}`);
  lines.push(`  recall:             ${formatHook(state.hookStats.recall)}`);
  lines.push(`  retain:             ${formatHook(state.hookStats.retain)}`);

  lines.push("");
  if (DEBUG) {
    const logLines = readRecentLogErrors(10);
    lines.push(`Debug log (last ${logLines.length} lines):`);
    logLines.forEach((line) => lines.push(`  ${line}`));
  } else {
    lines.push("Debug log: disabled (set HINDSIGHT_DEBUG=1 to enable)");
  }

  ctx.ui.notify(lines.join("\n"), hasError ? "error" : "info");
}

async function handleStats(ctx: any, state: SessionState, config: HindsightConfig): Promise<void> {
  const client = new HindsightClient(config);
  const banks = getRecallBanks(config, state.cwd);
  const allStats = await Promise.all(
    banks.map(async (bank) => ({ bank, result: await client.bankStats(bank) })),
  );
  const lines = allStats.map(({ bank, result }) => {
    if (!result.ok) return `${bank}: unavailable`;
    const entries = Object.entries(result.data ?? {})
      .map(([key, value]) => `  ${key}: ${value}`)
      .join("\n");
    return `${bank}:\n${entries}`;
  });
  ctx.ui.notify(lines.join("\n\n"), "info");
}

async function handleSettings(ctx: any, state: SessionState): Promise<void> {
  const globalCfgPath = join(homedir(), ".hindsight", "config");
  const localCfgPath = join(state.cwd, ".hindsight", "config");
  let cfg = getConfigWithSource(state.cwd);
  const isHomeDir = cfg.isHomeDir;

  const buildOptions = () => {
    const options: string[] = [];
    if (isHomeDir) options.push("⚠ CWD is home dir - all saves go to global config");
    for (const setting of SETTINGS_META) {
      const value = cfg.merged[setting.key] ?? setting.default;
      const source = cfg.local[setting.key] !== undefined ? "project" : cfg.global[setting.key] !== undefined ? "global" : "default";
      const shown = String(setting.key === "api_key" && value !== setting.default ? "****" : value);
      const compact = shown.length > 80 ? `${shown.slice(0, 77)}…` : shown;
      options.push(`${setting.label}: ${compact} [${source}]`);
    }
    options.push(DONE_LABEL);
    return options;
  };

  while (true) {
    const choice = await ctx.ui.select("Hindsight Settings", buildOptions());
    if (!choice || choice === DONE_LABEL || choice.startsWith("⚠")) {
      if (choice?.startsWith("⚠")) continue;
      break;
    }

    const selected = SETTINGS_META.find((setting) => choice.startsWith(setting.label + ":"));
    if (!selected) continue;

    const currentValue = cfg.merged[selected.key];
    let newValue: string | undefined;

    if (selected.isBool) {
      const currentBool = currentValue !== "false";
      const toggleChoice = await ctx.ui.select(
        `${selected.label} (currently ${currentBool ? "on" : "off"})`,
        ["On", "Off", "← Cancel"],
      );
      if (!toggleChoice || toggleChoice === "← Cancel") continue;
      newValue = toggleChoice === "On" ? "true" : "false";
    } else {
      const inputValue = await ctx.ui.input(`${selected.label}:`, currentValue || "");
      if (inputValue === undefined || inputValue === "") continue;
      newValue = inputValue;
    }

    let saveGlobal = true;
    let saveLocal = false;
    if (!isHomeDir) {
      const target = await ctx.ui.select(
        `Save ${selected.label} to:`,
        ["Project (.hindsight/config)", "Global (~/.hindsight/config)", "← Cancel"],
      );
      if (!target || target === "← Cancel") continue;
      saveGlobal = target.startsWith("Global");
      saveLocal = target.startsWith("Project");
    }

    if (!newValue) continue;
    if (saveGlobal) writeConfigValue(globalCfgPath, selected.key, newValue);
    if (saveLocal) writeConfigValue(localCfgPath, selected.key, newValue);

    cfg = getConfigWithSource(state.cwd);
    ctx.ui.notify(`${selected.label} → ${selected.key === "api_key" ? "****" : newValue}`, "info");
  }
}

async function handleDoctor(ctx: any, state: SessionState): Promise<void> {
  const issues = detectLegacyKeys(state.cwd);
  if (issues.length === 0) {
    ctx.ui.notify("No issues found. Config is up to date.", "info");
    return;
  }

  const summary = issues.map((issue) => `  ${issue.key} \u2192 ${issue.canonical} in ${issue.file}`).join("\n");
  ctx.ui.notify(`Legacy config keys found:\n${summary}`, "warning");

  const ok = await ctx.ui.confirm(
    "Migrate config?",
    "This will rename legacy keys in your config file(s). The old values are preserved, only the key names change.",
  );
  if (!ok) {
    ctx.ui.notify("Migration skipped. You can edit config files manually.", "info");
    return;
  }

  const migrated: string[] = [];
  const seen = new Set<string>();
  for (const issue of issues) {
    if (seen.has(issue.file)) continue;
    seen.add(issue.file);
    migrated.push(...migrateConfigFile(issue.file).map((entry) => `${entry} in ${issue.file}`));
  }

  if (migrated.length > 0) {
    ctx.ui.setStatus("hindsight", undefined);
    ctx.ui.notify(`Migrated:\n  ${migrated.join("\n  ")}`, "info");
  } else {
    ctx.ui.notify("Nothing to migrate.", "info");
  }
}

export function registerCommands(pi: ExtensionAPI, state: SessionState): void {
  pi.registerCommand("hindsight", {
    description: "Hindsight memory. Usage: /hindsight [status | stats | settings | doctor]",
    handler: async (args: any, ctx) => {
      const config = getConfig(state.cwd);
      if (!config) {
        ctx.ui.notify("Hindsight config not found. Create ~/.hindsight/config", "error");
        return;
      }

      const argsStr = (typeof args === "string" ? args : "").trim();
      if (argsStr === "status") return handleStatus(ctx, state, config);
      if (argsStr === "stats") return handleStats(ctx, state, config);
      if (argsStr === "settings") return handleSettings(ctx, state);
      if (argsStr === "doctor") return handleDoctor(ctx, state);

      const status = [
        `URL: ${config.api_url || "Not set"}`,
        `Global Bank: ${config.global_bank || "Not set"}`,
        `Project Bank (Recall & Default Retain): ${getProjectBank(config, state.cwd)}`,
        `Active Recall Banks: ${getRecallBanks(config, state.cwd).join(", ")}`,
        `Commands: /hindsight status | stats | settings | doctor`,
      ].join("\n");
      ctx.ui.notify(status, "info");
    },
  });
}

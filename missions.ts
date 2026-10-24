/**
 * Automatic retain/observations mission setup for active banks.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { HindsightConfig } from "./config.ts";
import { HindsightClient } from "./api.ts";
import { getProjectBank, isHomeDirSession } from "./banks.ts";
import { log } from "./logging.ts";

interface MissionCache {
  global: Record<string, number>;
  project: Record<string, number>;
}

export const GLOBAL_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
export const PROJECT_TTL_SECONDS = 24 * 60 * 60; // 24 hours

export const GLOBAL_RETAIN_MISSION = "Focus on user preferences, communication style, workflow habits, and recurring patterns across projects. Deprioritize one-time events and project-specific implementation details.";
export const GLOBAL_OBSERVATIONS_MISSION = "Observations are durable user preferences, coding conventions, tooling decisions, and workflow patterns. Focus on what the user consistently does or prefers — not one-time events or actions. Merge repeated patterns into single observations. Highlight when behavior contradicts previous observations.";

export const PROJECT_RETAIN_MISSION = "Focus on coding conventions, architecture decisions, tech stack choices, project-specific patterns, and user preferences within this codebase. Deprioritize one-time events and transient debugging steps.";
export const PROJECT_OBSERVATIONS_MISSION = "Observations are durable user preferences, coding conventions, tooling decisions, and workflow patterns. Also capture key project context: architecture decisions, tech stack choices, known constraints, and established patterns in the codebase. Focus on what persists across sessions — not one-time events or actions. Merge repeated patterns into single observations. Highlight when behavior contradicts previous observations.";

export function getMissionCachePath(): string {
  return join(homedir(), ".hindsight", "mission-cache.json");
}

export function loadMissionCache(): MissionCache {
  try {
    const path = getMissionCachePath();
    if (!existsSync(path)) {
      return { global: {}, project: {} };
    }
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (_) {
    return { global: {}, project: {} };
  }
}

export function saveMissionCache(cache: MissionCache): void {
  try {
    const path = getMissionCachePath();
    mkdirSync(join(homedir(), ".hindsight"), { recursive: true });
    writeFileSync(path, JSON.stringify(cache, null, 2));
  } catch (_) {}
}

export function isCacheStale(timestamp: number, isGlobal: boolean): boolean {
  if (!timestamp) return true;
  const ttl = isGlobal ? GLOBAL_TTL_SECONDS : PROJECT_TTL_SECONDS;
  return Date.now() / 1000 - timestamp > ttl;
}

export async function setupBankMission(
  config: HindsightConfig,
  bank: string,
  isGlobal: boolean,
): Promise<void> {
  const client = new HindsightClient(config);
  const configResult = await client.bankConfig(bank);
  if (!configResult.ok) {
    log(`setupBankMission: ${bank} config read failed (HTTP ${configResult.status})`);
    return;
  }

  const data = configResult.data;
  if (!data) {
    log(`setupBankMission: ${bank} config read returned no data`);
    return;
  }
  const cfg = data.config;
  const overrides = data.overrides;
  const retainConfigured = overrides ? overrides.retain_mission != null : cfg.retain_mission != null;
  const observationsConfigured = overrides ? overrides.observations_mission != null : cfg.observations_mission != null;
  if (retainConfigured && observationsConfigured) return;

  const updates: Record<string, string> = {};
  if (!retainConfigured) {
    updates.retain_mission = isGlobal ? GLOBAL_RETAIN_MISSION : PROJECT_RETAIN_MISSION;
  }
  if (!observationsConfigured) {
    updates.observations_mission = isGlobal ? GLOBAL_OBSERVATIONS_MISSION : PROJECT_OBSERVATIONS_MISSION;
  }
  if (Object.keys(updates).length === 0) return;

  const patchResult = await client.updateBankConfig(bank, updates);
  if (!patchResult.ok) {
    log(`setupBankMission: ${bank} update failed (HTTP ${patchResult.status})`);
    return;
  }

  const cache = loadMissionCache();
  const cacheKey = isGlobal ? "global" : "project";
  if (!cache[cacheKey]) cache[cacheKey] = {};
  cache[cacheKey][bank] = Math.floor(Date.now() / 1000);
  saveMissionCache(cache);
  log(`setupBankMission: ${bank} updated (global=${isGlobal})`);
}

export async function runMissionAutoSetup(
  config: HindsightConfig,
  cwd: string = process.cwd(),
): Promise<void> {
  if (config.auto_missions === false) return;
  const cache = loadMissionCache();
  const banksToCheck: { bank: string; isGlobal: boolean }[] = [];
  if (config.global_bank) {
    banksToCheck.push({ bank: config.global_bank, isGlobal: true });
  }
  const skipProject = isHomeDirSession(cwd) && config.homedir_project === false;
  if (!skipProject) {
    banksToCheck.push({ bank: getProjectBank(config, cwd), isGlobal: false });
  }

  for (const { bank, isGlobal } of banksToCheck) {
    const cacheKey = isGlobal ? "global" : "project";
    const entry = cache[cacheKey]?.[bank];
    if (!isCacheStale(entry, isGlobal)) continue;
    await setupBankMission(config, bank, isGlobal);
  }
}

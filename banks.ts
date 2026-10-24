/**
 * Bank selection rules for project, global, recall, and retain.
 */

import { basename } from "node:path";
import { homedir } from "node:os";
import type { HindsightConfig } from "./config.ts";

export function isHomeDirSession(cwd: string): boolean {
  return cwd === homedir();
}

export function getProjectBank(config?: HindsightConfig | null, cwd: string = process.cwd()): string {
  if (config?.project_bank_id) return config.project_bank_id;
  return basename(cwd);
}

function skipProjectBank(config: HindsightConfig, cwd: string): boolean {
  return isHomeDirSession(cwd) && config.homedir_project === false;
}

export function getPrimaryBank(config: HindsightConfig, cwd: string = process.cwd()): string | null {
  if (skipProjectBank(config, cwd)) {
    return config.global_bank ?? null;
  }
  return getProjectBank(config, cwd);
}

export function getRecallBanks(config: HindsightConfig, cwd: string = process.cwd()): string[] {
  const banks = new Set<string>();
  if (config.global_bank) banks.add(config.global_bank);
  if (!skipProjectBank(config, cwd)) {
    banks.add(getProjectBank(config, cwd));
  }
  return Array.from(banks);
}

export function getRetainBanks(config: HindsightConfig, cwd: string, prompt: string): string[] {
  const banks = new Set<string>();
  if (!skipProjectBank(config, cwd)) {
    banks.add(getProjectBank(config, cwd));
  }

  // Opt-in for global bank retention.
  if (config.global_bank && /(?:^|\s)#(?:global|me)\b/i.test(prompt)) {
    banks.add(config.global_bank);
  }
  return Array.from(banks);
}

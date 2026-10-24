/**
 * Debug logging shared by the extension modules.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const DEBUG = process.env.HINDSIGHT_DEBUG === "1";
export const LOG_PATH = join(homedir(), ".hindsight", "debug.log");
const LOG_MAX_BYTES = Number(process.env.HINDSIGHT_LOG_MAX_BYTES) > 0
  ? Number(process.env.HINDSIGHT_LOG_MAX_BYTES)
  : 1_000_000;

function rotateLogIfNeeded(): void {
  try {
    if (!existsSync(LOG_PATH) || statSync(LOG_PATH).size < LOG_MAX_BYTES) return;
    const rotated = `${LOG_PATH}.1`;
    if (existsSync(rotated)) unlinkSync(rotated);
    renameSync(LOG_PATH, rotated);
  } catch (_) {}
}

export function log(msg: string): void {
  if (!DEBUG) return;
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    mkdirSync(join(homedir(), ".hindsight"), { recursive: true });
    rotateLogIfNeeded();
    appendFileSync(LOG_PATH, line);
  } catch (_) {}
}

export function readRecentLogErrors(maxLines = 20): string[] {
  try {
    if (!existsSync(LOG_PATH)) return [];
    const content = readFileSync(LOG_PATH, "utf-8");
    return content
      .split("\n")
      .filter((line) => line.trim())
      .slice(-maxLines);
  } catch (_) {
    return [];
  }
}

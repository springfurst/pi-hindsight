/**
 * Hindsight Self-Hosted Extension for Pi
 * Fully autonomous memory via lifecycle hooks.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_FLUSH_TIMEOUT_MS,
  DEFAULT_RECALL_HINT_INTERVAL,
  DEFAULT_RECALL_HINT_MESSAGE,
  DEFAULT_RECALL_NUDGE_MESSAGE,
  DEFAULT_RETAIN_TIMEOUT_MS,
  detectLegacyKeys,
  getConfig,
  type HindsightConfig,
} from "./config.ts";
import { getRecallBanks, getRetainBanks } from "./banks.ts";
import { HindsightClient } from "./api.ts";
import { log } from "./logging.ts";
import { runMissionAutoSetup } from "./missions.ts";
import {
  buildRetainItem,
  buildRetainTranscript,
  escapeXmlText,
  extractRetainTags,
  getLastUserMessage,
  redactSecrets,
  retainSkipReason,
} from "./retain.ts";
import { createSessionState, resetSessionState } from "./session.ts";
import { registerMessageRenderers } from "./renderers.ts";
import { registerTools } from "./tools.ts";
import { registerCommands } from "./commands.ts";

export type { HindsightConfig } from "./config.ts";
export {
  CONFIG_DEFAULTS,
  DEFAULT_RECALL_HINT_INTERVAL,
  DEFAULT_RECALL_HINT_MESSAGE,
  DEFAULT_RECALL_NUDGE_DISPLAY,
  DEFAULT_RECALL_NUDGE_MESSAGE,
  DEFAULT_RECALL_TIMEOUT_MS,
  DEFAULT_REFLECT_TIMEOUT_MS,
  DEFAULT_RETAIN_TIMEOUT_MS,
  DEFAULT_FLUSH_TIMEOUT_MS,
  TIMEOUT_DEFAULTS,
  detectLegacyKeys,
  getConfig,
  getConfigWithSource,
  migrateConfigFile,
  parseConfigFile,
  resetConfigCache,
  writeConfigValue,
} from "./config.ts";
export * from "./missions.ts";
export { redactSecrets } from "./retain.ts";

export default function hindsightExtension(pi: ExtensionAPI): void {
  const state = createSessionState();

  function trackRetain(promise: Promise<unknown>, abort: () => void): void {
    state.pendingRetains.set(promise, abort);
    promise
      .finally(() => state.pendingRetains.delete(promise))
      .catch(() => {});
  }

  async function flushPendingRetains(reason: string): Promise<void> {
    if (state.pendingRetains.size === 0) return;

    const timeoutMs = getConfig(state.cwd)?.flush_timeout ?? DEFAULT_FLUSH_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    log(`flush(${reason}): waiting for ${state.pendingRetains.size} pending retain(s)`);

    while (state.pendingRetains.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        const count = state.pendingRetains.size;
        for (const abort of state.pendingRetains.values()) abort();
        log(`flush(${reason}): timed out with ${count} retain(s) still pending; aborted requests`);
        break;
      }

      const pending = Array.from(state.pendingRetains.keys());
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled(pending),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, remaining);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }

    log(`flush(${reason}): complete`);
  }

  function postRetain(
    config: HindsightConfig,
    bank: string,
    item: Record<string, unknown>,
    asyncMode: boolean,
  ): Promise<string> {
    const controller = new AbortController();
    const client = new HindsightClient(config);
    const timeoutMs = config.retain_timeout ?? DEFAULT_RETAIN_TIMEOUT_MS;
    const promise = client.retain(bank, item, asyncMode, timeoutMs, controller.signal)
      .then((result) => {
        log(`retain: bank=${bank} HTTP ${result.status}`);
        if (!result.ok) {
          const detail = result.body
            ? `: ${result.body.slice(0, 200)}`
            : result.error
              ? `: ${result.error}`
              : "";
          throw new Error(`HTTP ${result.status ?? "error"}${detail}`);
        }
        return bank;
      });
    trackRetain(promise, () => controller.abort());
    return promise;
  }

  async function ensureBankExists(config: HindsightConfig, bank: string, ctx: any): Promise<boolean> {
    const client = new HindsightClient(config);
    const check = await client.bankConfig(bank, 5000);
    if (check.ok || check.status !== 404) return true;

    const canPrompt = ctx.hasUI !== false && typeof ctx.ui?.confirm === "function";
    if (!canPrompt) {
      log(`session_start: bank=${bank} missing and UI cannot prompt`);
      ctx.ui.setStatus("hindsight", "disabled - memory bank missing");
      ctx.ui.notify(
        `Hindsight memory bank "${bank}" does not exist.\n\n` +
        "Run Pi interactively to be prompted to create it, or create it with:\n" +
        `  hindsight bank create ${bank}`,
        "warning",
      );
      return false;
    }

    let create = false;
    try {
      create = await ctx.ui.confirm(
        "Create Hindsight memory bank?",
        `Memory bank "${bank}" does not exist yet. Create it for this session?`,
      );
    } catch (error) {
      log(`session_start: bank=${bank} prompt failed: ${error}`);
      return false;
    }

    if (!create) {
      log(`session_start: bank=${bank} creation declined`);
      ctx.ui.setStatus("hindsight", "disabled for this session (bank not created)");
      ctx.ui.notify(
        `Hindsight memory bank "${bank}" was not created. Hindsight is disabled for this session.`,
        "info",
      );
      return false;
    }

    const created = await client.createBank(bank);
    if (!created.ok) {
      log(`session_start: bank=${bank} creation failed${created.status ? ` (HTTP ${created.status})` : ""}`);
      ctx.ui.setStatus("hindsight", "disabled - bank creation failed");
      ctx.ui.notify(
        `Failed to create Hindsight memory bank "${bank}"${created.status ? ` (HTTP ${created.status})` : ""}. Hindsight is disabled for this session.`,
        "error",
      );
      return false;
    }

    log(`session_start: created bank=${bank}`);
    ctx.ui.notify(`Created Hindsight memory bank: ${bank}`, "info");
    return true;
  }

  async function ensureActiveBanks(config: HindsightConfig, ctx: any): Promise<boolean> {
    for (const bank of getRecallBanks(config, state.cwd)) {
      if (!(await ensureBankExists(config, bank, ctx))) return false;
    }
    return true;
  }

  pi.on("input", async (event: any) => {
    if (event.input) state.currentPrompt = event.input;
    else if (event.text) state.currentPrompt = event.text;
  });

  pi.on("session_start", async (_event, ctx) => {
    resetSessionState(state, ctx.cwd || process.cwd());
    state.hookStats.sessionStart = { firedAt: new Date().toISOString(), result: "ok" };
    ctx.ui.setStatus("hindsight", undefined);
    log("session_start: state reset");

    const config = getConfig(state.cwd);
    if (!config) return;

    const banks = getRecallBanks(config, state.cwd);
    if (banks.length === 0) {
      ctx.ui.setStatus("hindsight", "⚠ no banks — /hindsight settings to configure");
      ctx.ui.notify(
        "Hindsight has no active banks. Memory recall and retain are disabled.\n" +
        "\n" +
        "Fix: run /hindsight settings and set global_bank, or set homedir_project = true.",
        "warning",
      );
      log("session_start: no active banks — global_bank not set and homedir_project=false in home dir");
    } else if (!(await ensureActiveBanks(config, ctx))) {
      state.disabled = true;
      log("session_start: hindsight disabled for this session");
      return;
    }

    const legacyIssues = detectLegacyKeys(state.cwd);
    if (legacyIssues.length > 0) {
      const keys = legacyIssues.map((issue) => `${issue.key} → ${issue.canonical}`).join(", ");
      ctx.ui.setStatus("hindsight", "⚠ outdated config — run /hindsight doctor");
      ctx.ui.notify(
        `Your config uses deprecated keys: ${keys}\n` +
        "Run /hindsight doctor to auto-migrate, or update manually.",
        "warning",
      );
      log(`session_start: legacy keys detected: ${keys}`);
    }

    if (config.api_url) {
      new HindsightClient(config).health()
        .then(() => log("session_start: warm-up ping ok"))
        .catch(() => log("session_start: warm-up ping failed (server may be cold)"));
    }

    if (config.auto_missions !== false) {
      runMissionAutoSetup(config, state.cwd).catch(() => {});
    }
  });

  pi.on("session_compact", async (_event, ctx) => {
    await flushPendingRetains("compact");
    state.cwd = ctx.cwd || process.cwd();
    state.currentPrompt = "";
    state.retainSuccessCount = 0;
    state.retainEligibleCount = 0;
    ctx.ui.setStatus("hindsight", undefined);
    log("session_compact: state reset");
  });

  pi.on("session_before_switch", async (event) => {
    await flushPendingRetains(`switch:${event.reason}`);
  });

  pi.on("session_before_fork", async () => {
    await flushPendingRetains("fork");
  });

  pi.on("session_shutdown", async (event) => {
    state.shuttingDown = true;
    await flushPendingRetains(`shutdown:${event.reason}`);
  });

  registerMessageRenderers(pi);
  registerTools(pi, { state, retainToBank: postRetain });
  registerCommands(pi, state);

  pi.on("before_agent_start", async (event: any, ctx) => {
    if (state.disabled) {
      log("before_agent_start: hindsight disabled for this session");
      return;
    }

    const config = getConfig(state.cwd);
    if (!config || !config.api_url) {
      log("before_agent_start: no config, skipping recall hint");
      ctx.ui.setStatus("hindsight", "⚠ not configured");
      return;
    }

    // Freeze the static system hint for the session. Changing it later would
    // change the prompt prefix and invalidate provider prompt caches.
    if (!state.sessionHintResolved) {
      state.sessionHintActive = config.recall_enabled !== false && getRecallBanks(config, state.cwd).length > 0;
      state.sessionHintMessage = escapeXmlText((config.recall_hint_message || DEFAULT_RECALL_HINT_MESSAGE).trim());
      state.sessionHintResolved = true;
      log(`before_agent_start: session recall hint ${state.sessionHintActive ? "enabled" : "disabled"}`);
    }

    let result: { systemPrompt?: string; message?: any } | undefined;

    if (state.sessionHintActive && state.sessionHintMessage) {
      if (event.systemPromptOptions?.sections) {
        event.systemPromptOptions.sections.hindsight_recall_hint = state.sessionHintMessage;
      } else if (typeof event.systemPrompt === "string") {
        result = {
          systemPrompt: `${event.systemPrompt}

<hindsight_recall_hint>
${state.sessionHintMessage}
</hindsight_recall_hint>`,
        };
      } else {
        log("before_agent_start: no system prompt available for recall hint");
      }
    }

    if (event.messageType !== "user") {
      log(`before_agent_start: skip nudge for ${event.messageType} run`);
      return result;
    }

    state.activeUserTurn = true;
    state.recallCalledThisTurn = false;
    if (!state.sessionHintActive) return result;

    const interval = config.recall_hint_interval ?? DEFAULT_RECALL_HINT_INTERVAL;
    const shouldNudge = interval === 0 || state.turnsSinceRecall >= interval;
    if (!shouldNudge) {
      log(`before_agent_start: recall nudge skipped (turnsSinceRecall=${state.turnsSinceRecall}, interval=${interval})`);
      return result;
    }

    const nudgeText = escapeXmlText((config.recall_nudge_message || DEFAULT_RECALL_NUDGE_MESSAGE).trim());
    if (!nudgeText) {
      log("before_agent_start: recall nudge message is empty");
      return result;
    }

    // The nudge is append-only, so it never changes the cached prompt prefix.
    // Pi converts custom messages to the user role for the model, hence the XML
    // wrapper; the UI can either render it as a custom block or hide it.
    const display = config.recall_nudge_display === "message";
    const nudge = {
      customType: "hindsight-recall-nudge",
      content: `<hindsight_recall_nudge>\n${nudgeText}\n</hindsight_recall_nudge>`,
      display,
      details: { interval, turnsSinceRecall: state.turnsSinceRecall },
    };

    state.hookStats.recall = {
      firedAt: new Date().toISOString(),
      result: "ok",
      detail: display ? "nudge message" : "nudge indicator",
    };

    if (display) {
      log(`before_agent_start: appended recall nudge as custom message (turnsSinceRecall=${state.turnsSinceRecall}, interval=${interval})`);
    } else {
      log(`before_agent_start: appended hidden recall nudge with UI indicator (turnsSinceRecall=${state.turnsSinceRecall}, interval=${interval})`);
      ctx.ui.setStatus("hindsight", "💡 recall nudge sent");
    }

    return { ...(result ?? {}), message: nudge };
  });

  pi.on("agent_settled", async () => {
    if (!state.activeUserTurn) return;
    state.activeUserTurn = false;
    if (state.recallCalledThisTurn) {
      state.turnsSinceRecall = 0;
      log("agent_settled: recall tool used this turn; resetting hint counter");
    } else {
      state.turnsSinceRecall++;
      log(`agent_settled: no recall this turn; turnsSinceRecall=${state.turnsSinceRecall}`);
    }
    state.recallCalledThisTurn = false;
  });

  pi.on("agent_end", async (event: any, ctx) => {
    log("agent_end: fired");
    if (state.disabled) {
      log("agent_end: hindsight disabled for this session");
      return;
    }

    const config = getConfig(state.cwd);
    if (!config || !config.api_url) {
      log("agent_end: no config, skipping");
      return;
    }
    if (config.retain_enabled === false) {
      log("agent_end: retain disabled by config");
      return;
    }

    const lastUserPrompt = getLastUserMessage(ctx, state.currentPrompt);
    const skipReason = retainSkipReason(lastUserPrompt);
    if (skipReason) {
      log(`agent_end: ${skipReason}, skipping retain`);
      return;
    }

    const sessionId = ctx.sessionManager?.getSessionId?.() || `unknown-${Date.now()}`;
    let transcript = buildRetainTranscript(lastUserPrompt, event.messages || []);
    if (transcript.length < 20) return;

    const tags = extractRetainTags(lastUserPrompt);
    const banks = getRetainBanks(config, state.cwd, lastUserPrompt);
    if (banks.length === 0) {
      log("agent_end: no retain banks active, skipping");
      return;
    }

    if (config.redact_secrets !== false) {
      transcript = redactSecrets(transcript);
    }

    const makeItem = (bank: string) => buildRetainItem({
      transcript,
      sessionId,
      lastUserPrompt,
      tags,
      bank,
      mode: "auto",
      cwd: state.cwd,
    });

    state.retainEligibleCount++;

    const reportResults = (results: PromiseSettledResult<string>[]) => {
      const succeededBanks = results
        .filter((result) => result.status === "fulfilled")
        .map((result) => (result as PromiseFulfilledResult<string>).value);
      const allFailed = succeededBanks.length === 0;
      state.hookStats.retain = {
        firedAt: new Date().toISOString(),
        result: allFailed ? "failed" : "ok",
        detail: allFailed ? "all banks unreachable" : succeededBanks.join(", "),
      };
      if (!allFailed) state.retainSuccessCount++;

      const showMessage = config.retain_feedback === "message" || config.retain_feedback === "both";
      const showStatus = config.retain_feedback === "status" || config.retain_feedback === "both";
      if (allFailed) {
        log("agent_end: all banks failed");
        if (showStatus) {
          ctx.ui.setStatus("hindsight", `Memorized: ${state.retainSuccessCount}/${state.retainEligibleCount}`);
        }
        if (showMessage) {
          pi.sendMessage(
            { customType: "hindsight-retain-failed", content: "", display: true },
            { deliverAs: "nextTurn" },
          );
        }
        return;
      }

      log(`agent_end: retained to banks=${succeededBanks.join(",")}`);
      if (showStatus) {
        ctx.ui.setStatus("hindsight", `Memorized: ${state.retainSuccessCount}/${state.retainEligibleCount}`);
      }
      if (showMessage) {
        pi.sendMessage(
          { customType: "hindsight-retain", content: "", display: true, details: { banks: succeededBanks } },
          { deliverAs: "nextTurn" },
        );
      }
    };

    if (config.async_retain !== false) {
      log("agent_end: async retain fired (not awaiting)");
      const retainPromise = Promise.allSettled(
        banks.map((bank) => postRetain(config, bank, makeItem(bank), true)),
      );
      retainPromise
        .then((results) => {
          if (state.shuttingDown) return;
          reportResults(results);
        })
        .catch((error) => log(`agent_end: async retain completion error ${error}`));
      return;
    }

    try {
      log(`agent_end: retaining to banks=${banks.join(",")} transcript_len=${transcript.length} tags=${tags.join(",")}`);
      const results = await Promise.allSettled(
        banks.map((bank) => postRetain(config, bank, makeItem(bank), false)),
      );
      reportResults(results);
    } catch (error) {
      log(`agent_end: error ${error}`);
    }
  });
}

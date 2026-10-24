/**
 * Agent tools: recall, retain, and reflect.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { DEFAULT_RECALL_TIMEOUT_MS, DEFAULT_REFLECT_TIMEOUT_MS, getConfig } from "./config.ts";
import { HindsightClient } from "./api.ts";
import { getPrimaryBank, getRecallBanks } from "./banks.ts";
import { redactSecrets, retainMetadata } from "./retain.ts";
import type { SessionState } from "./session.ts";

export interface ToolRuntime {
  state: SessionState;
  retainToBank: (
    config: NonNullable<ReturnType<typeof getConfig>>,
    bank: string,
    item: Record<string, unknown>,
    asyncMode: boolean,
  ) => Promise<string>;
}

type RecallBankResult = string[] | { rateLimited?: boolean; timedOut?: boolean };

export function registerTools(pi: ExtensionAPI, runtime: ToolRuntime): void {
  const { state } = runtime;

  const disabledToolResult = () => ({
    content: [{ type: "text" as const, text: "Hindsight is disabled for this session because its memory bank was not created." }],
    details: {},
    isError: true,
  });

  const errorResult = (text: string) => ({
    content: [{ type: "text" as const, text }],
    details: {},
    isError: true,
  });

  pi.registerTool({
    name: "hindsight_recall",
    label: "Hindsight Recall",
    description: "Recall relevant context, conventions, or past solutions from the team memory. Use this when the user explicitly asks you to search memory.",
    parameters: Type.Object({
      query: Type.String(),
    }),
    async execute(_id, params) {
      const { query } = params as { query: string };
      const config = getConfig(state.cwd);
      if (!config || !config.api_url) return errorResult("Hindsight not configured.");
      if (state.disabled) return disabledToolResult();
      state.recallCalledThisTurn = true;

      const banks = getRecallBanks(config, state.cwd);
      if (banks.length === 0) {
        return errorResult("Hindsight has no active banks. Set global_bank or enable homedir_project.");
      }

      try {
        const client = new HindsightClient(config);
        const timeoutMs = config.recall_timeout ?? DEFAULT_RECALL_TIMEOUT_MS;
        const resultsArrays = await Promise.all(
          banks.map(async (bank): Promise<RecallBankResult> => {
            const body: Record<string, unknown> = {
              query,
              budget: config.recall_budget,
              query_timestamp: new Date().toISOString(),
              types: config.recall_types,
            };
            if (config.recall_max_tokens !== undefined) body.max_tokens = config.recall_max_tokens;

            try {
              const result = await client.recall(bank, body, timeoutMs);
              if (result.rateLimited) return { rateLimited: true };
              if (result.timedOut) return { timedOut: true };
              if (!result.ok) return [];
              return (result.data?.results ?? []).map((item) => `[Bank: ${bank}] - ${item.text}`);
            } catch (error) {
              return [];
            }
          }),
        );

        if (resultsArrays.some((result) => !Array.isArray(result) && result.rateLimited)) {
          return errorResult("Recall was rate-limited by Hindsight. Retry shortly or check the server's reranker/provider quota.");
        }
        if (resultsArrays.some((result) => !Array.isArray(result) && result.timedOut)) {
          return errorResult(`Recall timed out after ${timeoutMs}ms.`);
        }

        const allResults = resultsArrays.flatMap((result) => Array.isArray(result) ? result : []);
        if (allResults.length > 0) {
          return { content: [{ type: "text" as const, text: allResults.join("\n\n") }], details: {} };
        }
        return { content: [{ type: "text" as const, text: "No memories found." }], details: {} };
      } catch (error) {
        return errorResult(`Error: ${error}`);
      }
    },
  });

  pi.registerTool({
    name: "hindsight_retain",
    label: "Hindsight Retain",
    description: "Force-save an explicit insight to memory. Only use when explicitly requested by the user, as normal conversation is auto-retained.",
    parameters: Type.Object({
      content: Type.String({ description: "The rich context to save" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const { content } = params as { content: string };
      const config = getConfig(state.cwd);
      if (!config || !config.api_url) return errorResult("Hindsight not configured.");
      if (state.disabled) return disabledToolResult();

      const bank = getPrimaryBank(config, state.cwd);
      if (!bank) {
        return errorResult("Hindsight: no bank available. Set global_bank in ~/.hindsight/config.");
      }

      try {
        const safeContent = config.redact_secrets !== false ? redactSecrets(content) : content;
        const sessionId = ctx?.sessionManager?.getSessionId?.() || "manual";
        await runtime.retainToBank(config, bank, {
          content: safeContent,
          context: "pi coding session: explicit user save",
          timestamp: new Date().toISOString(),
          metadata: {
            source: "pi-hindsight",
            mode: "manual",
            project: state.cwd.split(/[\\/]/).filter(Boolean).pop() || state.cwd,
            session_id: sessionId,
            bank_id: bank,
          },
        }, false);
        return { content: [{ type: "text" as const, text: "Memory explicitly retained." }], details: {} };
      } catch (error) {
        return errorResult(`Failed to retain memory: ${error}`);
      }
    },
  });

  pi.registerTool({
    name: "hindsight_reflect",
    label: "Hindsight Reflect",
    description: "Synthesize context from memory to answer a question.",
    parameters: Type.Object({
      query: Type.String(),
    }),
    async execute(_id, params) {
      const { query } = params as { query: string };
      const config = getConfig(state.cwd);
      if (!config || !config.api_url) return errorResult("Hindsight not configured.");
      if (state.disabled) return disabledToolResult();

      const bank = getPrimaryBank(config, state.cwd);
      if (!bank) {
        return errorResult("Hindsight: no bank available. Set global_bank in ~/.hindsight/config.");
      }

      try {
        const client = new HindsightClient(config);
        const result = await client.reflect(
          bank,
          query,
          config.reflect_timeout ?? DEFAULT_REFLECT_TIMEOUT_MS,
        );
        if (result.ok) {
          const data = result.data ?? {};
          const text = typeof data.text === "string"
            ? data.text
            : typeof data.synthesis === "string"
              ? data.synthesis
              : JSON.stringify(data);
          return { content: [{ type: "text" as const, text }], details: {} };
        }
        const detail = result.body ? `: ${result.body.slice(0, 200)}` : ".";
        return errorResult(`Failed to reflect${detail}`);
      } catch (error) {
        return errorResult(`Error reflecting: ${error}`);
      }
    },
  });
}

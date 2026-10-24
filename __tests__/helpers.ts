/**
 * Shared test doubles for the extension's Pi hooks, tools, and commands.
 */

import { vi } from "vitest";

type Handler = (event: any, ctx: any) => Promise<unknown> | unknown;

export function makePiMock() {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  return {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    registerMessageRenderer() {},
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
    registerShortcut() {},
    registerFlag() {},
    sendMessage: vi.fn(),
    async emit(event: string, eventData: any = {}, ctx: any = {}) {
      let result: unknown;
      for (const handler of handlers.get(event) ?? []) {
        result = await handler(eventData, ctx);
      }
      return result;
    },
    tools,
    commands,
  };
}

export function makeCtx(
  prompt = "please remember this important implementation detail",
  sessionId = "session-1",
) {
  return {
    cwd: process.cwd(),
    ui: {
      setStatus: vi.fn(),
      notify: vi.fn(),
    },
    sessionManager: {
      getEntries() {
        return [
          {
            type: "message",
            message: { role: "user", content: prompt },
          },
        ];
      },
      getSessionId() {
        return sessionId;
      },
    },
  };
}

export function makeBeforeAgentStartEvent() {
  return {
    type: "before_agent_start",
    messageType: "user",
    prompt: "test prompt",
    systemPrompt: "base system prompt",
    systemPromptOptions: { sections: {} },
  } as any;
}

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

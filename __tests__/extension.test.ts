/**
 * Tests that exercise the real extension implementation through its public Pi
 * hooks, tools, and command.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

import hindsightExtension, {
  DEFAULT_RECALL_HINT_MESSAGE,
  DEFAULT_RECALL_NUDGE_MESSAGE,
  getConfig,
  parseConfigFile,
  redactSecrets,
} from "../index.ts";

type Handler = (event: any, ctx: any) => Promise<unknown> | unknown;

function makePiMock() {
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

function makeCtx(prompt = "please remember this important implementation detail", sessionId = "session-1") {
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

function makeBeforeAgentStartEvent() {
  return {
    type: "before_agent_start",
    messageType: "user",
    prompt: "test prompt",
    systemPrompt: "base system prompt",
    systemPromptOptions: { sections: {} },
  } as any;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

let tempHome = "";
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

function writeConfig(extra: string[] = []) {
  const lines = [
    'api_url = "http://localhost:9999"',
    'api_key = "test-key"',
    'global_bank = "global"',
    ...extra,
  ];
  writeFileSync(join(tempHome, ".hindsight", "config"), lines.join("\n"));
}

function setupTempHome(extra: string[] = []) {
  tempHome = mkdtempSync(join(tmpdir(), "hindsight-extension-test-"));
  mkdirSync(join(tempHome, ".hindsight"), { recursive: true });
  writeConfig(extra);
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
}

function teardownTempHome() {
  if (originalHome !== undefined) process.env.HOME = originalHome;
  else delete process.env.HOME;
  if (originalUserProfile !== undefined) process.env.USERPROFILE = originalUserProfile;
  else delete process.env.USERPROFILE;
  rmSync(tempHome, { recursive: true, force: true });
}

describe("config parsing", () => {
  beforeEach(() => setupTempHome());
  afterEach(() => teardownTempHome());

  it("parses comments, quotes, bool aliases, and validates numbers", () => {
    writeConfig([
      'api_url = "http://localhost:9999/" # trailing comment',
      'recall_budget = "HIGH"',
      'recall_types = "observation,unknown,experience"',
      'recall_timeout = "0"',
      'recall_hint_interval = "0"',
      'recall_hint_message = "Custom memory hint."',
      'recall_nudge_message = "Custom memory nudge."',
      'recall_nudge_display = "message"',
      'reflect_timeout = "not-a-number"',
      'retain_timeout = "45000"',
      'async_retain = "False"',
      'redact_secrets = "no"',
      'auto_missions = "off"',
      'homedir_project = "0"',
      'retain_feedback = "NONE"',
    ]);
    const config = getConfig();
    expect(config).not.toBeNull();
    expect(config!.api_url).toBe("http://localhost:9999");
    expect(config!.recall_budget).toBe("high");
    expect(config!.recall_types).toEqual(["observation", "experience"]);
    expect(config!.recall_timeout).toBeUndefined();
    expect(config!.recall_hint_interval).toBe(0);
    expect(config!.recall_hint_message).toBe("Custom memory hint.");
    expect(config!.recall_nudge_message).toBe("Custom memory nudge.");
    expect(config!.recall_nudge_display).toBe("message");
    expect(config!.reflect_timeout).toBeUndefined();
    expect(config!.retain_timeout).toBe(45000);
    expect(config!.async_retain).toBe(false);
    expect(config!.redact_secrets).toBe(false);
    expect(config!.auto_missions).toBe(false);
    expect(config!.homedir_project).toBe(false);
    expect(config!.retain_feedback).toBe("none");
  });

  it("preserves escaped quotes and ignores comment markers inside strings", () => {
    const path = join(tempHome, "quoted-config");
    writeFileSync(path, 'api_key = "abc#def" # outside comment\n');
    expect(parseConfigFile(path).api_key).toBe("abc#def");
  });
});

describe("secret redaction", () => {
  it("removes common credentials without touching normal prose", () => {
    const input = [
      "Use Bearer abcdefghijklmnopqrstuvwxyz in the header.",
      "OPENAI_KEY=sk-1234567890abcdef123456",
      "the word secrective should survive",
    ].join("\n");
    const output = redactSecrets(input);
    expect(output).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(output).not.toContain("sk-1234567890abcdef123456");
    expect(output).toContain("secrective");
  });
});

describe("recall hint lifecycle", () => {
  beforeEach(() => setupTempHome());
  afterEach(() => {
    teardownTempHome();
    vi.unstubAllGlobals();
  });

  async function emitTurn(pi: ReturnType<typeof makePiMock>, ctx: any, recall: boolean) {
    const event = makeBeforeAgentStartEvent();
    const result: any = await pi.emit("before_agent_start", event, ctx);
    if (recall) {
      await pi.tools
        .get("hindsight_recall")
        .execute("call-1", { query: "test query" }, undefined, undefined, ctx);
    }
    await pi.emit("agent_settled", {}, ctx);
    return { event, result };
  }

  it("keeps a stable system hint and appends a hidden nudge when due", async () => {
    const pi = makePiMock();
    const ctx = makeCtx();
    const fetchMock = vi.fn(async () => jsonResponse({ results: [{ text: "Should not be fetched" }] }));
    vi.stubGlobal("fetch", fetchMock);
    hindsightExtension(pi as any);

    const first = await emitTurn(pi, ctx, false);
    const second = await emitTurn(pi, ctx, false);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(first.event.systemPromptOptions.sections.hindsight_recall_hint).toBe(DEFAULT_RECALL_HINT_MESSAGE);
    expect(second.event.systemPromptOptions.sections.hindsight_recall_hint).toBe(DEFAULT_RECALL_HINT_MESSAGE);
    expect(first.result).toBeUndefined();
    expect(second.result.message).toMatchObject({
      customType: "hindsight-recall-nudge",
      display: false,
    });
    expect(second.result.message.content).toContain("<hindsight_recall_nudge>");
    expect(second.result.message.content).toContain(DEFAULT_RECALL_NUDGE_MESSAGE);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("hindsight", "💡 recall nudge sent");
  });

  it("uses configured hint and nudge messages", async () => {
    writeConfig([
      'recall_hint_interval = "0"',
      'recall_hint_message = "Static memory hint."',
      'recall_nudge_message = "Custom memory nudge."',
    ]);
    const pi = makePiMock();
    const ctx = makeCtx();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({})));
    hindsightExtension(pi as any);

    const { event, result } = await emitTurn(pi, ctx, false);

    expect(event.systemPromptOptions.sections.hindsight_recall_hint).toBe("Static memory hint.");
    expect(result.message.content).toContain("<hindsight_recall_nudge>");
    expect(result.message.content).toContain("Custom memory nudge.");
    expect(result.message.content).toContain("</hindsight_recall_nudge>");
  });

  it("suppresses the nudge after a turn that called the recall tool", async () => {
    const pi = makePiMock();
    const ctx = makeCtx();
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }));
    vi.stubGlobal("fetch", fetchMock);
    hindsightExtension(pi as any);

    const first = await emitTurn(pi, ctx, true);
    expect(first.result).toBeUndefined();
    expect(fetchMock).toHaveBeenCalled();

    const second = await emitTurn(pi, ctx, false);
    expect(second.result).toBeUndefined();
    expect(ctx.ui.setStatus).not.toHaveBeenCalledWith("hindsight", "💡 recall nudge sent");
  });

  it("waits for the configured number of turns without recall", async () => {
    writeConfig(['recall_hint_interval = "2"']);
    const pi = makePiMock();
    const ctx = makeCtx();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({})));
    hindsightExtension(pi as any);

    const first = await emitTurn(pi, ctx, false);
    const second = await emitTurn(pi, ctx, false);
    const third = await emitTurn(pi, ctx, false);

    expect(first.result).toBeUndefined();
    expect(second.result).toBeUndefined();
    expect(third.result.message).toMatchObject({ display: false });
  });

  it("nudges every turn when the interval is 0", async () => {
    writeConfig(['recall_hint_interval = "0"']);
    const pi = makePiMock();
    const ctx = makeCtx();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ results: [] })));
    hindsightExtension(pi as any);

    const first = await emitTurn(pi, ctx, true);
    const second = await emitTurn(pi, ctx, false);

    expect(first.result.message).toMatchObject({ display: false });
    expect(second.result.message).toMatchObject({ display: false });
  });

  it("renders the nudge as a custom message when configured", async () => {
    writeConfig(['recall_hint_interval = "0"', 'recall_nudge_display = "message"']);
    const pi = makePiMock();
    const ctx = makeCtx();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({})));
    hindsightExtension(pi as any);

    const { result } = await emitTurn(pi, ctx, false);

    expect(result.message).toMatchObject({
      customType: "hindsight-recall-nudge",
      display: true,
    });
    expect(ctx.ui.setStatus).not.toHaveBeenCalledWith("hindsight", "💡 recall nudge sent");
  });

  it("freezes the system hint for the session", async () => {
    writeConfig(['recall_hint_message = "First hint."']);
    const pi = makePiMock();
    const ctx = makeCtx();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({})));
    hindsightExtension(pi as any);

    const first = await emitTurn(pi, ctx, false);
    writeConfig(['recall_hint_message = "Second hint."']);
    const second = await emitTurn(pi, ctx, false);

    expect(first.event.systemPromptOptions.sections.hindsight_recall_hint).toBe("First hint.");
    expect(second.event.systemPromptOptions.sections.hindsight_recall_hint).toBe("First hint.");
  });
});

describe("retain lifecycle", () => {
  beforeEach(() => setupTempHome());
  afterEach(() => {
    teardownTempHome();
    vi.unstubAllGlobals();
  });

  it("retains with metadata, tags, and redacted secrets", async () => {
    const pi = makePiMock();
    const ctx = makeCtx("remember this #architecture #global architecture note");
    const fetchMock = vi.fn(async () => jsonResponse({ success: true }, 200));
    vi.stubGlobal("fetch", fetchMock);
    hindsightExtension(pi as any);

    await pi.emit(
      "agent_end",
      { messages: [{ role: "assistant", content: "Use sk-1234567890abcdef123456 as a test key." }] },
      ctx,
    );
    await pi.emit("session_shutdown", { reason: "quit" }, ctx);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)));
    for (const body of bodies) {
      const item = body.items[0];
      expect(item.document_id).toBe("session-session-1");
      expect(item.update_mode).toBe("append");
      expect(item.async).toBeUndefined();
      expect(body.async).toBe(true);
      expect(item.tags).toEqual(["architecture"]);
      expect(item.content).not.toContain("sk-1234567890abcdef123456");
      expect(item.metadata).toMatchObject({
        source: "pi-hindsight",
        mode: "auto",
        session_id: "session-1",
      });
    }
  });

  it("does not route on #global substrings", async () => {
    const pi = makePiMock();
    const ctx = makeCtx("write about #globalization without a global tag");
    const fetchMock = vi.fn(async () => jsonResponse({ success: true }, 200));
    vi.stubGlobal("fetch", fetchMock);
    hindsightExtension(pi as any);

    await pi.emit("agent_end", { messages: [{ role: "assistant", content: "Globalization context." }] }, ctx);
    await pi.emit("session_shutdown", { reason: "quit" }, ctx);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain(`/banks/${basename(process.cwd())}/`);
    expect(String(fetchMock.mock.calls[0][0])).not.toContain("/banks/project-");
  });

  it("skips auto-retain when no banks are active", async () => {
    writeConfig(['homedir_project = "false"', 'global_bank = ""', 'auto_missions = "false"']);
    const pi = makePiMock();
    const ctx = makeCtx("remember this important detail");
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/health")) return jsonResponse({ status: "healthy" });
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);
    hindsightExtension(pi as any);

    await pi.emit("session_start", {}, { ...ctx, cwd: tempHome });
    fetchMock.mockClear();

    await pi.emit("agent_end", { messages: [{ role: "assistant", content: "Durable detail." }] }, ctx);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("respects retain_feedback = none on failure", async () => {
    writeConfig(['async_retain = "false"', 'retain_feedback = "none"']);
    const pi = makePiMock();
    const ctx = makeCtx();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    hindsightExtension(pi as any);

    await pi.emit("agent_end", { messages: [{ role: "assistant", content: "Durable detail." }] }, ctx);
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
  });
});

describe("reflect and status", () => {
  beforeEach(() => setupTempHome());
  afterEach(() => {
    teardownTempHome();
    vi.unstubAllGlobals();
  });

  it("reflects through the global bank in home-directory mode", async () => {
    writeConfig(['homedir_project = "false"', 'auto_missions = "false"']);
    const pi = makePiMock();
    const ctx = makeCtx();
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/reflect")) return jsonResponse({ text: "reflected answer" });
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);
    hindsightExtension(pi as any);

    await pi.emit("session_start", {}, { ...ctx, cwd: tempHome });
    fetchMock.mockClear();

    const tool = pi.tools.get("hindsight_reflect");
    const result = await tool.execute("call-1", { query: "what happened?" }, undefined, undefined, ctx);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/banks/global/reflect");
    expect(result.content[0].text).toBe("reflected answer");
  });


  it("does not configure a project bank in home-directory mode", async () => {
    writeConfig(['homedir_project = "false"']);
    const pi = makePiMock();
    const ctx = makeCtx();
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/config")) {
        return jsonResponse({
          config: { retain_mission: "resolved", observations_mission: "resolved" },
          overrides: { retain_mission: "resolved", observations_mission: "resolved" },
        });
      }
      return jsonResponse({ status: "healthy" });
    });
    vi.stubGlobal("fetch", fetchMock);
    hindsightExtension(pi as any);

    await pi.emit("session_start", {}, { ...ctx, cwd: tempHome });
    await new Promise((resolve) => setTimeout(resolve, 30));

    const configUrls = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes("/config"));
    expect(configUrls.some((url) => url.includes("/banks/global/config"))).toBe(true);
    expect(configUrls.every((url) => url.includes("/banks/global/config"))).toBe(true);
  });

  it("treats a missing bank as not created yet in /hindsight status", async () => {
    const pi = makePiMock();
    const ctx = makeCtx();
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/health")) return jsonResponse({ status: "healthy" });
      if (url.endsWith("/version")) return jsonResponse({ api_version: "1.1.0" });
      if (url.includes("/config")) return jsonResponse({ detail: "not found" }, 404);
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);
    hindsightExtension(pi as any);

    await pi.commands.get("hindsight").handler("status", ctx);
    const message = ctx.ui.notify.mock.calls[0][0] as string;
    expect(message).toContain("API:    1.1.0");
    expect(message).toContain("not created yet");
    expect(ctx.ui.notify.mock.calls[0][1]).toBe("info");
  });
});

describe("bank creation prompt", () => {
  beforeEach(() => setupTempHome());
  afterEach(() => {
    teardownTempHome();
    vi.unstubAllGlobals();
  });

  function makeBankCtx() {
    const ctx: any = makeCtx();
    ctx.hasUI = true;
    ctx.ui.confirm = vi.fn(async () => true);
    return ctx;
  }

  it("prompts before creating a missing bank", async () => {
    writeConfig(['global_bank = ""', 'auto_missions = "false"']);
    const pi = makePiMock();
    const ctx = makeBankCtx();
    const projectBank = basename(process.cwd());
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PUT") return jsonResponse({ bank_id: projectBank });
      if (String(url).endsWith(`/banks/${projectBank}/config`)) {
        return new Response("not found", { status: 404 });
      }
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);
    hindsightExtension(pi as any);

    await pi.emit("session_start", {}, ctx);

    expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);
    expect(ctx.ui.confirm.mock.calls[0][1]).toContain(projectBank);
    const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(putCall).toBeTruthy();
    expect(String(putCall![0])).toBe(`http://localhost:9999/v1/default/banks/${projectBank}`);
    expect(ctx.ui.notify).toHaveBeenCalledWith(`Created Hindsight memory bank: ${projectBank}`, "info");
  });

  it("disables hindsight for the session when creation is declined", async () => {
    writeConfig(['global_bank = ""', 'auto_missions = "false"']);
    const pi = makePiMock();
    const ctx = makeBankCtx();
    ctx.ui.confirm = vi.fn(async () => false);
    const projectBank = basename(process.cwd());
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PUT") return jsonResponse({ bank_id: projectBank });
      if (String(url).endsWith(`/banks/${projectBank}/config`)) {
        return new Response("not found", { status: 404 });
      }
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);
    hindsightExtension(pi as any);

    await pi.emit("session_start", {}, ctx);

    expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "hindsight",
      "disabled for this session (bank not created)",
    );

    fetchMock.mockClear();
    await pi.emit("before_agent_start", {}, ctx);
    await pi.emit("agent_end", { messages: [{ role: "assistant", content: "Durable detail." }] }, ctx);
    const recallResult: any = await pi.tools
      .get("hindsight_recall")
      .execute("call-1", { query: "anything" }, undefined, undefined, ctx);
    const retainResult: any = await pi.tools
      .get("hindsight_retain")
      .execute("call-1", { content: "anything" }, undefined, undefined, ctx);
    const reflectResult: any = await pi.tools
      .get("hindsight_reflect")
      .execute("call-1", { query: "anything" }, undefined, undefined, ctx);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(recallResult.isError).toBe(true);
    expect(retainResult.isError).toBe(true);
    expect(reflectResult.isError).toBe(true);
  });
});

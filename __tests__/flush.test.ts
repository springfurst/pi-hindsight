/**
 * Regression tests for draining fire-and-forget retains before Pi replaces or
 * tears down the session runtime.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import hindsightExtension from "../index.ts";

type Handler = (event: any, ctx: any) => Promise<unknown> | unknown;

function makePiMock() {
  const handlers = new Map<string, Handler[]>();
  return {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    registerMessageRenderer() {},
    registerTool() {},
    registerCommand() {},
    registerShortcut() {},
    registerFlag() {},
    sendMessage: vi.fn(),
    async emit(event: string, eventData: any = {}, ctx: any = {}) {
      for (const handler of handlers.get(event) ?? []) {
        await handler(eventData, ctx);
      }
    },
  };
}

function makeCtx() {
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
            message: {
              role: "user",
              content: "please remember this important implementation detail",
            },
          },
        ];
      },
      getSessionId() {
        return "flush-test-session";
      },
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let tempHome = "";
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

function setupTempHome() {
  tempHome = mkdtempSync(join(tmpdir(), "hindsight-flush-test-"));
  const dir = join(tempHome, ".hindsight");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "config"),
    [
      'api_url = "http://localhost:9999"',
      'api_key = "test-key"',
      'async_retain = "true"',
      'retain_feedback = "none"',
    ].join("\n"),
  );

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

async function startPendingRetain() {
  const pi = makePiMock();
  const ctx = makeCtx();
  const retainResponse = deferred<{ ok: boolean; status: number }>();
  const fetchMock = vi.fn(() => retainResponse.promise);
  vi.stubGlobal("fetch", fetchMock);

  hindsightExtension(pi as any);

  await pi.emit(
    "agent_end",
    {
      messages: [
        {
          role: "assistant",
          content: "This is the assistant response containing durable context.",
        },
      ],
    },
    ctx,
  );

  expect(fetchMock).toHaveBeenCalledTimes(1);
  return { pi, ctx, retainResponse };
}

async function expectHookToWaitForRetain(
  hook: string,
  event: any,
) {
  const { pi, ctx, retainResponse } = await startPendingRetain();
  let settled = false;

  const flush = pi.emit(hook, event, ctx).then(() => {
    settled = true;
  });

  // The retain request is still in flight, so the lifecycle hook must not finish.
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);

  retainResponse.resolve({ ok: true, status: 200 });
  await flush;
  expect(settled).toBe(true);
}

describe("retain flushing", () => {
  beforeEach(setupTempHome);
  afterEach(() => {
    teardownTempHome();
    vi.unstubAllGlobals();
  });

  it("waits for pending retains on session_shutdown", async () => {
    await expectHookToWaitForRetain("session_shutdown", { reason: "quit" });
  });

  it("waits for pending retains before switching sessions", async () => {
    await expectHookToWaitForRetain("session_before_switch", { reason: "new" });
  });

  it("waits for pending retains before forking", async () => {
    await expectHookToWaitForRetain("session_before_fork", {
      entryId: "entry-1",
      position: "at",
    });
  });

  it("waits for pending retains on compact", async () => {
    await expectHookToWaitForRetain("session_compact", { reason: "manual" });
  });

  it("waits for all overlapping retains", async () => {
    const pi = makePiMock();
    const ctx = makeCtx();
    const first = deferred<{ ok: boolean; status: number }>();
    const second = deferred<{ ok: boolean; status: number }>();
    const responses = [first, second];
    const fetchMock = vi.fn(() => responses.shift()!.promise);
    vi.stubGlobal("fetch", fetchMock);
    hindsightExtension(pi as any);

    const event = {
      messages: [{ role: "assistant", content: "Durable context from the turn." }],
    };
    await pi.emit("agent_end", event, ctx);
    await pi.emit("agent_end", event, ctx);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    let settled = false;
    const flush = pi.emit("session_shutdown", { reason: "quit" }, ctx).then(() => {
      settled = true;
    });

    first.resolve({ ok: true, status: 200 });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    second.resolve({ ok: true, status: 200 });
    await flush;
    expect(settled).toBe(true);
  });
});

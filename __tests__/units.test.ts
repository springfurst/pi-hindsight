import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { getProjectBank, getRecallBanks, getRetainBanks } from "../banks.ts";
import {
  buildRetainTranscript,
  escapeXmlText,
  extractRetainTags,
  retainSkipReason,
} from "../retain.ts";
import type { HindsightConfig } from "../config.ts";

describe("retain helpers", () => {
  it("builds a transcript and filters operational tool calls", () => {
    const transcript = buildRetainTranscript("Remember this decision", [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Architecture decision." },
          { type: "tool_use", name: "bash", input: { command: "ls" } },
          { type: "tool_use", name: "custom_tool", input: { value: 42 } },
        ],
      },
    ]);

    expect(transcript).toContain("[role: user]\nRemember this decision");
    expect(transcript).toContain("Architecture decision.");
    expect(transcript).toContain("[Tool Use: custom_tool]");
    expect(transcript).not.toContain("[Tool Use: bash]");
    expect(transcript).toContain("[assistant:end]");
  });

  it("strips memory blocks and caps oversized transcripts", () => {
    const transcript = buildRetainTranscript("prompt", [
      {
        role: "assistant",
        content: `<hindsight_memories>old memory</hindsight_memories>${"x".repeat(60_000)}`,
      },
    ]);

    expect(transcript).not.toContain("old memory");
    expect(transcript).toContain("[TRUNCATED]");
  });

  it("extracts tags while ignoring reserved controls", () => {
    expect(extractRetainTags("use #Architecture and #bug #global #nomem")).toEqual([
      "architecture",
      "bug",
    ]);
  });

  it("classifies prompts that should not be retained", () => {
    expect(retainSkipReason("ok")).toBe("trivial prompt");
    expect(retainSkipReason("#nomem skip this")).toBe("opt-out tag");
    expect(retainSkipReason("please remember this decision")).toBeNull();
  });

  it("escapes XML text", () => {
    expect(escapeXmlText("<tag> & value")).toBe("&lt;tag&gt; &amp; value");
  });
});

describe("bank selection", () => {
  const config: HindsightConfig = {
    global_bank: "global",
    homedir_project: true,
  };

  it("uses the working-directory name for the project bank", () => {
    expect(getProjectBank(config, "/work/my-project")).toBe("my-project");
    expect(getRecallBanks(config, "/work/my-project")).toEqual(["global", "my-project"]);
  });

  it("routes #global prompts to the global bank", () => {
    expect(getRetainBanks(config, "/work/my-project", "remember #global this")).toEqual([
      "my-project",
      "global",
    ]);
    expect(getRetainBanks(config, "/work/my-project", "#globalization is not a tag")).toEqual([
      "my-project",
    ]);
  });

  it("skips the project bank in the home directory when disabled", () => {
    const homeConfig = { ...config, homedir_project: false };
    expect(getRecallBanks(homeConfig, homedir())).toEqual(["global"]);
    expect(getRetainBanks(homeConfig, homedir(), "remember #global this")).toEqual(["global"]);
  });
});

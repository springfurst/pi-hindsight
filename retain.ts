/**
 * Retain transcript construction, tag extraction, redaction, and metadata.
 */

const OPERATIONAL_TOOLS = new Set([
  "bash", "nu", "powershell", "process", "read", "write", "edit",
  "grep", "find", "ls", "glob", "ast_grep_search", "ast_grep_replace",
  "lsp_navigation", "tool_search",
]);

const MAX_TRANSCRIPT_CHARS = 50_000;

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(sk-[A-Za-z0-9_-]{16,})\b/g, "[REDACTED_OPENAI_KEY]"],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g, "[REDACTED_SLACK_TOKEN]"],
  [/\b(AKIA[0-9A-Z]{16})\b/g, "[REDACTED_AWS_KEY]"],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[REDACTED]"],
  [/\b((?:api[_-]?key|access[_-]?token|secret|password|passwd|token)\s*[:=]\s*)(["']?)([^\s"']{8,})\2/gi, "$1$2[REDACTED]$2"],
];

const RESERVED_TAGS = new Set(["nomem", "skip", "global", "me"]);
const TRIVIAL_PROMPT = /^(ok|yes|no|thanks|continue|next|done|sure|stop)$/i;

export function redactSecrets(text: string): string {
  let result = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

export function messageContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block: any) => {
        if (block?.type === "text" && typeof block.text === "string") return block.text;
        if (block?.type === "image") return "[image]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return content == null ? "" : JSON.stringify(content);
}

export function getLastUserMessage(ctx: any, fallbackPrompt: string): string {
  try {
    const entries = ctx.sessionManager?.getEntries() || [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type === "message" && entry.message?.role === "user") {
        return messageContentToText(entry.message.content);
      }
    }
  } catch (_) {}
  return fallbackPrompt;
}

export function retainSkipReason(prompt: string): string | null {
  if (!prompt) return "no user prompt found";
  const trimmed = prompt.trim();
  if (trimmed.length < 5 || TRIVIAL_PROMPT.test(trimmed)) return "trivial prompt";
  if (trimmed.startsWith("#nomem") || trimmed.startsWith("#skip")) return "opt-out tag";
  return null;
}

export function extractRetainTags(prompt: string): string[] {
  return Array.from(prompt.matchAll(/(?<=^|\s)#([a-zA-Z0-9_-]+)/g))
    .map((match) => match[1].toLowerCase())
    .filter((tag) => !RESERVED_TAGS.has(tag));
}

export function buildRetainTranscript(lastUserPrompt: string, messages: unknown[]): string {
  let transcript = `[role: user]\n${lastUserPrompt}\n[user:end]\n\n[role: assistant]\n`;

  for (const raw of messages) {
    const msg = raw as { role?: string; content?: unknown };
    if (msg?.role !== "assistant") continue;

    const content = msg.content;
    if (typeof content === "string") {
      transcript += `${content}\n`;
    } else if (Array.isArray(content)) {
      for (const block of content as Array<any>) {
        if (block?.type === "text") {
          transcript += `${block.text}\n`;
        } else if (block?.type === "tool_use" && !OPERATIONAL_TOOLS.has(block.name)) {
          transcript += `[Tool Use: ${block.name}]\n`;
          if (block.input) {
            transcript += `${JSON.stringify(block.input)}\n`;
          }
        }
      }
    }
  }

  transcript += "[assistant:end]";
  transcript = transcript.replace(/<hindsight_memories>[\s\S]*?<\/hindsight_memories>/g, "").trim();
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    transcript = transcript.slice(0, MAX_TRANSCRIPT_CHARS) + "\n...[TRUNCATED]";
  }
  return transcript;
}

export function retainMetadata(
  sessionId: string,
  bank: string,
  mode: "auto" | "manual",
  cwd: string,
): Record<string, string> {
  const project = cwd.split(/[\\/]/).filter(Boolean).pop() || cwd;
  return {
    source: "pi-hindsight",
    mode,
    project,
    session_id: sessionId,
    bank_id: bank,
  };
}

export interface RetainItemOptions {
  transcript: string;
  sessionId: string;
  lastUserPrompt: string;
  tags: string[];
  bank: string;
  mode: "auto" | "manual";
  cwd: string;
}

export function buildRetainItem(options: RetainItemOptions): Record<string, unknown> {
  return {
    content: options.transcript,
    document_id: `session-${options.sessionId}`,
    update_mode: "append",
    context: `pi coding session: ${options.lastUserPrompt.slice(0, 100)}`,
    timestamp: new Date().toISOString(),
    metadata: retainMetadata(options.sessionId, options.bank, options.mode, options.cwd),
    ...(options.tags.length > 0 && { tags: options.tags }),
  };
}

export function escapeXmlText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

# pi-hindsight

*Memory that compounds, not clutters.*

Persistent memory for Pi, backed by a self-hosted [Hindsight](https://github.com/vectorize-io/hindsight) server. Install it, point it at your server, and memory works automatically from the first session.

**Best fit for:**
- Self-hosted Hindsight users who want full data control
- Long-lived repo work where context carries across sessions, including cross-project memory via a shared global bank
- Users who want per-prompt memory controls (`#nomem`, `#global`, `#tags`)
- Anyone who prefers a minimal, single-file extension with zero extra dependencies

## Requirements

This extension connects to a **self-hosted Hindsight server**. It does not include or manage the backend.

You need a running [Hindsight](https://github.com/vectorize-io/hindsight) server.

This release targets Hindsight **1.1.x** (HTTP API `1.1.0`). It uses the bank config API for missions and reflection settings; the legacy bank profile endpoints are no longer used.

If you don't have a Hindsight server yet, follow the [Hindsight getting started guide](https://hindsight.vectorize.io/developer/api/quickstart) first, then come back here.

## Install

```bash
pi install npm:pi-hindsight
```

Or from GitHub:

```bash
pi install git:github.com/anh-chu/pi-hindsight
```

## Quick start

1. **Install** the extension (see above).

2. **Configure** your Hindsight server in `~/.hindsight/config`:
   ```toml
   api_url = "http://your-hindsight-server:8888"
   api_key = "<API_KEY>"
   global_bank = "optional-global-bank-id"
   ```

3. **Verify** in Pi:
   ```
   /hindsight status
   ```

That's it. Pi nudges the agent to recall when useful and retains each turn automatically. The first time you use a project, Pi asks whether to create its memory bank. If you decline, Hindsight stays disabled for that session.

## Features

### Memory lifecycle

- **Recall hint:** Before a turn, a short system-prompt hint tells the agent that `hindsight_recall` is available and lets it decide whether to search memory. No automatic recall request is made from the user prompt.
- **Auto-retain:** After each agent turn, the conversation is appended to a per-session memory document. Only the new delta is processed, no redundant work.
- **Graceful flush:** Pending async retains are drained before shutdown, session switch, fork, and compaction. Hung requests are aborted at the configurable flush deadline.
- **Secret redaction:** Common API keys, bearer tokens, passwords, and similar credentials are redacted before retain by default.
- **Feedback loop prevention:** Memory blocks are stripped from retained content. No recursive memory bloat.
- **Noise filtering:** Low-signal tool calls (bash, read, write, edit, find, ls, powershell, etc.) are dropped from retained transcripts. Conversation and meaningful tool usage are kept.
- **Retain metadata:** Auto and manual retains include source, project, session, bank, and mode metadata.
- **Configurable hint cadence:** `recall_hint_interval` controls how many turns without a recall call pass before the hint is shown again. The default is `1`; `0` shows it every turn.
- **Consent before bank creation:** If an active memory bank does not exist yet, Pi asks before creating it. Declining disables Hindsight for the rest of that session.

### Per-prompt controls

- `#nomem` or `#skip`: skip retain for this turn (sensitive or throwaway prompts).
- `#global` or `#me`: also retain this turn to your global bank (cross-project learnings).
- `#architecture`, `#bug`, etc.: custom tags extracted and attached to memory for filtering.

### Project-level opt-out

Disable memory for specific projects by setting `recall_enabled` and `retain_enabled` to `false` in a project-level `.hindsight/config`:

```toml
recall_enabled = false
retain_enabled = false
```

Or use the interactive `/hindsight settings` command.

Manual tools (`hindsight_recall`, `hindsight_retain`, `hindsight_reflect`) remain available regardless of those toggles. If you decline the bank-creation prompt at session start, Hindsight (including manual tools) stays disabled for that session.

### Home directory handling

When Pi runs from your home directory, the global config (`~/.hindsight/config`) and local config (`.hindsight/config` in CWD) are the same file. This means a `<username>` bank is created alongside your global bank, causing duplicate recall and retain.

To fix this, set `homedir_project = false` in your global config:

```toml
homedir_project = false
```

With this set, sessions started from the home directory use only the global bank. All other project directories are unaffected.

### In-chat visibility

| Event | What you see |
|-------|-------------|
| Recall hint | Hindsight: recall hint inserted |
| Retain (success) | 💾 Hindsight saved turn to memory → bank-name |
| Retain (failure) | 💾 Hindsight retain failed, use hindsight_retain to save manually |

### Manual tools

- `hindsight_recall`: Pull additional context from memory on demand.
- `hindsight_retain`: Force-save a specific insight.
- `hindsight_reflect`: Ask Hindsight to synthesize an answer from your memories (server-side reasoning).

## Configuration

### Global config: `~/.hindsight/config`

```toml
api_url          = "http://localhost:8888"
api_key          = "your-api-key"
global_bank      = "sil"
recall_types     = "observation"
recall_budget    = "mid"
recall_max_tokens = 800
async_retain     = true
```

### Project override: `.hindsight/config` (in project root)

Place a `.hindsight/config` file in any project directory to override global settings. Local values win.

```toml
recall_types     = "observation,experience"
recall_budget    = "low"
recall_max_tokens = 512
```

### Config reference

| Key | Default | Description |
|-----|---------|-------------|
| `recall_types` | `observation` | Memory types to search: `observation`, `world`, `experience`. Comma-separated. Each type runs the full retrieval pipeline independently. |
| `recall_budget` | `mid` | Retrieval depth: `low`, `mid`, `high`. Higher = more coverage but added latency. |
| `recall_max_tokens` | Server default (4096) | Max tokens returned by `hindsight_recall`. Lower values reduce context size. Recommended: `800`. |
| `async_retain` | `true` | Non-blocking retain. Set `false` for sync retain with failure notifications. |
| `recall_enabled` | `true` | Enable the recall hint before agent turns. Set `false` to stop nudging the agent. The `hindsight_recall` tool still works. |
| `recall_hint_interval` | `1` | Show the recall hint on the first turn, then again after this many turns without a `hindsight_recall` call. `0` shows it every turn. |
| `recall_hint_message` | See below | Text inserted into a system-prompt section. Customize it to change how the agent is nudged to use `hindsight_recall`. |
| `retain_enabled` | `true` | Enable automatic retain after agent turns. Set `false` to disable auto-retain for this project. Manual `hindsight_retain` tool still works. |
| `redact_secrets` | `true` | Redact common credentials from auto- and manually-retained content before sending it to Hindsight. |
| `auto_missions` | `true` | Automatically configure retain/observations missions on the active banks at session start. Set `false` to manage bank missions yourself. |
| `recall_timeout` | `10000` | Timeout in milliseconds for recall requests. |
| `reflect_timeout` | `60000` | Timeout in milliseconds for the manual reflect tool. |
| `retain_timeout` | `60000` | Timeout in milliseconds for individual retain requests. |
| `flush_timeout` | `30000` | Maximum time to wait for pending retains during shutdown, switch, fork, or compaction. Requests still pending are aborted. |

The default `recall_hint_message` is:

> Persistent memory is available through the `hindsight_recall` tool. Before answering, consider whether recalling relevant context would help; if so, call `hindsight_recall` with a focused query. Skip it when the request does not depend on past context.
| `homedir_project` | `true` | Treat home directory as a project. Set `false` to prevent creating a `<username>` bank when running from your home directory. Recall and retain use only `global_bank` instead. |
| `global_bank` | _(none)_ | Bank ID for cross-project memory. When set, this bank is queried alongside the project bank on every recall. Turns tagged `#global` or `#me` are also retained here. Leave unset if you only want per-project memory. |

## Commands

### `/hindsight status`
Full health check: server reachability, auth, bank access, hook state, debug log tail.

```
URL:    http://localhost:8888
Server: ✓ online
API:    1.1.0
Bank:   myapp
  ✓ auth ok
  mission: Focus on coding conventions...
Global: global-bank

Hooks this session:
  session_start:      ✓ ok
  recall:             ✓ ok (hint inserted)
  retain:             ✓ ok (myapp)

Debug log: disabled (set HINDSIGHT_DEBUG=1 to enable)
```

When you decline the bank-creation prompt, `/hindsight status` shows `Session: disabled (memory bank not created)` and no recall, retain, or manual memory tools run for that session.

### `/hindsight stats`
Memory, entity, and document counts for all active banks. Nested values are shown as JSON rather than `[object Object]`.

### `/hindsight settings`
Interactive settings menu. View all current settings with their source (global, project, or default), toggle boolean settings, edit text values, and choose where to save (project or global config). When running from the home directory, saves go to global config only.

Use this to opt out a project from memory:
```
/hindsight settings
→ Recall Hint: true [default]  →  toggle Off  →  save to Project
→ Auto-Retain: true [default]  →  toggle Off  →  save to Project
```

Or to disable home directory as a project:
```
/hindsight settings
→ Home Dir as Project: true [default]  →  toggle Off
```

## Banks

### Project bank

Named `<dirname>` based on your current working directory. At session start Hindsight checks whether the bank exists and asks before creating it. If you decline, Hindsight is disabled for the rest of the session; start a new session to be prompted again. All turns are retained here by default, so each project builds its own isolated memory over time.

### Global bank

Optional. Set `global_bank = <bank-id>` in your config to enable it. The global bank is meant for knowledge that applies across projects: preferred patterns, personal conventions, people and teams you work with, recurring tools.

When the agent calls `hindsight_recall`, both active banks are queried in parallel and their results are merged into a single response. The agent gets project-specific context and cross-project context together, choosing the query itself.

Turns are retained to the global bank only when you explicitly tag the prompt with `#global` or `#me`. Everything else goes to the project bank only, keeping global memory intentional.

## Debug logging

Set `HINDSIGHT_DEBUG=1` to enable verbose logging to `~/.hindsight/debug.log`. Log tail is shown inline in `/hindsight status`.

## Performance

Recall latency depends primarily on your database indexes and hosting tier. With HNSW indexes on Supabase free tier, expect ~4s for a parallel global + project bank recall. This cost is now paid only when the agent chooses to call `hindsight_recall`, not before every turn.

For benchmarks, latency analysis, recommended settings, and a Supabase index checklist, see **[docs/performance.md](docs/performance.md)**.

## Why Hindsight over other memory approaches

| Approach | Typical tradeoff | Hindsight + this extension |
|---|---|---|
| Markdown/file-based memory | Human-readable, but quality degrades over time | Automatic retain + retrieval, still inspectable |
| Custom vector DB (ChromaDB, etc.) | Flexible, but requires ongoing tuning | Built-in memory model with multi-strategy recall |
| Other Pi memory extensions | Often weak deduplication or limited bank cooperation | Observation-first recall with dedup, project + global bank cooperation |

When the agent calls `hindsight_recall`, both your project bank and global bank are queried in parallel. Project memories cover the current codebase; global memories carry patterns and preferences you've built across all your projects. You get both without any extra setup beyond setting `global_bank` in your config.

Hindsight uses semantic, BM25, graph, and temporal retrieval strategies. Entities (people, projects, tools) are recalled as connected context, not isolated snippets. Recent memories rank higher automatically.

## Comparison with [@walodayeet/hindsight-pi](https://github.com/walodayeet/hindsight-pi)

There are two Hindsight extensions for Pi. Both connect to a self-hosted Hindsight server and provide memory recall and auto-retain. They share the same core goal but differ in philosophy: this extension optimizes for simplicity and per-prompt control, while `@walodayeet/hindsight-pi` optimizes for configurability and operational tooling.

This section aims to help you pick the right one. Both are good.

### At a glance

| Dimension | **pi-hindsight** (this) | **@walodayeet/hindsight-pi** |
|---|---|---|
| Install | `pi install npm:pi-hindsight` | `pi install npm:@walodayeet/hindsight-pi` |
| Backend required | Self-hosted Hindsight server + Postgres (pgvector) + embedding API | Same |
| Extra dependencies | None (raw `fetch`) | `@vectorize-io/hindsight-client` SDK |
| Config format | `.ini` | JSON |
| Codebase | Single file (~1,300 LOC) | Multi-file modular (~1500 LOC) |

### Recall

| Dimension | **pi-hindsight** | **@walodayeet/hindsight-pi** |
|---|---|---|
| Trigger | `before_agent_start` system-prompt hint | `before_agent_start` or `context` hook |
| Injection frequency | First turn, then every N turns without a recall call | Explicit: `first-turn` or `every-turn` |
| Recall modes | Hint-driven tool choice + manual tools | `hybrid`, `context`, `tools`, or `off` |
| Dual-bank recall | `hindsight_recall` queries global + project in parallel | Queries primary bank + optional `globalBankId` |
| Recall types | Configurable, defaults to `observation` | Configurable per-type with `recallPerType` count |
| Budget control | `recall_budget` + `recall_max_tokens` | `budget` + `maxTokens` via SDK |
| Retry on failure | Rate-limit retry inside `hindsight_recall` | No retry on recall failure |

**What the differences mean:**

- **Recall modes.** `@walodayeet/hindsight-pi` lets you set `recallMode: tools` to skip auto-injection entirely. This extension uses a hint-driven tool mode: the agent decides when to call `hindsight_recall`, so there is no blocking recall request from `before_agent_start`.
- **Dual-bank recall.** Both extensions query multiple banks. This extension's `hindsight_recall` tool queries global + project banks in parallel, so cross-project knowledge is available on demand. `@walodayeet/hindsight-pi` does the same when `globalBankId` is configured, plus supports linked banks for multi-server setups.
- **Injection frequency.** This extension inserts a system hint on the first turn and then only after `recall_hint_interval` turns without a recall call. If the agent recalls every turn, the hint does not come back.
- **Retry logic.** This extension retries rate-limited `hindsight_recall` requests. `@walodayeet/hindsight-pi` does not retry recall, but retries retain writes with a 1.5s backoff.

### Retain

| Dimension | **pi-hindsight** | **@walodayeet/hindsight-pi** |
|---|---|---|
| Trigger | `agent_end`, async by default | `agent_end` |
| Write scheduling | Immediate (async fire-and-forget) or sync | `turn`, `async`, `session`, or N-turn batch |
| Retain modes | Full transcript, append mode | `response`, `step-batch`, `both`, or `off` |
| Content retained | User + assistant + non-operational tool calls | User + assistant text (turn summary) |
| Document strategy | Append-mode with stable `document_id` per session | Per-turn writes, chunked if large |
| Credential sanitization | No | Yes (strips API keys, tokens, secrets) |
| Session lifecycle | Flushes on shutdown, switch, compact, fork | Flushes on shutdown, switch, compact, fork |

**What the differences mean:**

- **Write scheduling.** `@walodayeet/hindsight-pi` offers `session` (batch all writes until session end) and numeric batching (flush every N turns). This reduces server load for long sessions. This extension fires immediately after each turn, either async (non-blocking, default) or sync (blocks until confirmed).
- **Retain content.** This extension retains the full transcript including tool call names and inputs (excluding noisy operational tools like `bash`, `read`, `write`). This gives Hindsight richer context for extraction. `@walodayeet/hindsight-pi` retains a user+assistant text summary, which is lighter but may lose tool-use context.
- **Append mode.** This extension uses `document_id` + `update_mode: append`, so Hindsight only re-extracts the new delta each turn rather than reprocessing the entire session. `@walodayeet/hindsight-pi` writes each turn as separate retain calls, which is simpler but means each turn is processed independently.
- **Credential sanitization.** `@walodayeet/hindsight-pi` strips API keys, bearer tokens, and secrets from retained content before sending to the server. This extension does not, so secrets in conversation may end up in your Hindsight memory. If you work with credentials in chat, this matters.
- **Session lifecycle.** Both extensions hook into session lifecycle events to flush pending writes. This extension drains in-flight async retains on shutdown, session switch, fork, and compaction.

### Per-prompt controls

| Dimension | **pi-hindsight** | **@walodayeet/hindsight-pi** |
|---|---|---|
| Opt-out | `#nomem`/`#skip` per-prompt, `recall_enabled`/`retain_enabled` per-project | Not available |
| Global bank routing | `#global` or `#me` per prompt | Configured at bank strategy level |
| Custom tags | `#hashtags` in prompt attached to memory | Automatic metadata tags (source, workspace, kind) |
| Trivial prompt skip | Yes | Yes, plus meta-memory query filtering |

**What the differences mean:**

- **Opt-out.** This extension lets you prevent any single turn from being retained by starting your prompt with `#nomem` or `#skip`. Useful for sensitive discussions, throwaway questions, or noisy debugging sessions. `@walodayeet/hindsight-pi` has no per-prompt opt-out; you would need to set `retainMode: off` in config.
- **Global bank routing.** This extension lets you tag individual prompts with `#global` or `#me` to also retain that turn to your global bank (cross-project learnings). `@walodayeet/hindsight-pi` routes to global bank based on the configured `bankStrategy`, not per-prompt.
- **Custom tags.** This extension extracts `#hashtags` from your prompt and attaches them as Hindsight tags, useful for filtering memories later. `@walodayeet/hindsight-pi` adds structured metadata tags automatically (source, workspace, bank, kind) but does not extract user-defined tags from prompts.

### Tooling and setup

| Dimension         | **pi-hindsight**                                            | **@walodayeet/hindsight-pi**                                                          |
| -------------------| -------------------------------------------------------------| ---------------------------------------------------------------------------------------|
| Config format     | `.ini` (`~/.hindsight/config`)                              | JSON (`~/.hindsight/config.json`), also reads `.toml`                                 |
| Config inspection | `/hindsight config` shows current values                    | `/hindsight:where` shows which file won precedence                                    |
| Setup experience  | Manual: edit config file, run `/hindsight status`           | Interactive: `/hindsight:setup` wizard                                                |
| Diagnostics       | `/hindsight status` (health + hooks + log tail)             | `/hindsight:doctor` (preflight), `/hindsight:status` (runtime)                        |
| Manual tools      | `hindsight_recall`, `hindsight_retain`, `hindsight_reflect` | `hindsight_search`, `hindsight_context`, `hindsight_retain`, `hindsight_bank_profile` |
| Commands          | 4 (`status`, `stats`, `settings`, `doctor`)                  | 10+ (setup, settings, doctor, where, sync, map, mode, config, connect, stats)         |
| Performance docs  | Benchmarks, latency analysis, Supabase index guide          | Not included                                                                          |

**What the differences mean:**

- **Setup.** `@walodayeet/hindsight-pi` has an interactive setup wizard that walks you through enabling Hindsight, setting the URL, choosing bank strategy, and saving. This extension requires manually editing a config file. If you are comfortable with config files, this is fine. If you want a guided first run, theirs is smoother.
- **Diagnostics.** Both have status commands. `@walodayeet/hindsight-pi` adds `/hindsight:doctor` for preflight checks and `/hindsight:where` to show exactly which config file contributed each value. This extension shows hook state and debug log tail inline in `/hindsight status`.
- **Tools.** This extension includes `hindsight_reflect` for server-side memory synthesis (Hindsight reasons over your memories and returns a synthesized answer). `@walodayeet/hindsight-pi` includes `hindsight_context` (similar, backed by the reflect API) and `hindsight_bank_profile` for inspecting bank metadata.
- **Performance documentation.** This extension includes latency benchmarks, analysis of what causes slow recall, and a Supabase index checklist. Useful if you are tuning a self-hosted setup.

### Backend requirements

Both extensions require the same backend:
- A self-hosted [Hindsight](https://github.com/vectorize-io/hindsight) server
- Postgres with pgvector (Supabase works, dedicated Postgres works)
- An embedding API (Gemini `embedding-001` or compatible)
- HNSW indexes on `memory_units` for acceptable recall latency (see [Performance tuning](docs/performance.md))

Neither extension bundles or manages the backend. You deploy Hindsight separately and point the extension at it via config.

This extension uses raw `fetch` calls against the Hindsight REST API, no SDK dependency. `@walodayeet/hindsight-pi` uses the official `@vectorize-io/hindsight-client` SDK, which adds a dependency but tracks API changes automatically.

### When to choose this extension

- You want a single-file, low-overhead setup with minimal config.
- Per-project opt-out matters: disable memory for specific projects or your home directory via config or `/hindsight settings`.
- Per-prompt memory controls matter: `#nomem` to skip, `#global` to route, `#tags` to annotate.
- You prefer full transcript retention with append-mode documents over turn summaries.
- You want `hindsight_reflect` for server-side memory synthesis.
- You want documented performance benchmarks and Supabase index guidance.
- You prefer zero extra dependencies beyond Pi itself.

### When to choose @walodayeet/hindsight-pi

- You want additional recall modes (`hybrid`, `context`, or `off`) beyond hint-driven tool use.
- Flexible retain scheduling matters: `session`, `async`, or N-turn batching to reduce server load.
- You want a setup wizard and diagnostic commands (`/hindsight:doctor`, `/hindsight:where`).
- Credential sanitization in retained content is important to you.
- You prefer JSON config with a richer settings hierarchy.
- You want the official Hindsight client SDK for automatic API compatibility.

### Shared strengths

Both extensions:
- Hint the agent to recall relevant memories when useful
- Auto-retain conversation after agent turns
- Query global + project banks for cross-project knowledge
- Show visible recall/retain indicators in chat
- Provide manual tools for explicit memory operations
- Skip trivial prompts to reduce noise
- Support project-level config overrides
- Work with any self-hosted Hindsight server

## Running tests

This project uses [pnpm](https://pnpm.io/).

```bash
pnpm install
pnpm test
pnpm check
pnpm check:sync
```

`check:sync` rebuilds `index.js` and fails if the committed generated file is out of date.

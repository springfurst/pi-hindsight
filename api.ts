/**
 * Small Hindsight HTTP client shared by hooks, tools, commands, and missions.
 */

import type { HindsightConfig } from "./config.ts";
import { DEFAULT_RECALL_TIMEOUT_MS, DEFAULT_REFLECT_TIMEOUT_MS } from "./config.ts";
import { log } from "./logging.ts";

const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_BACKOFF_MS = [1000, 2000, 4000];

export interface ApiResult<T = unknown> {
  ok: boolean;
  status?: number;
  data?: T;
  body?: string;
  authError: boolean;
  rateLimited?: boolean;
  timedOut?: boolean;
  aborted?: boolean;
  error?: string;
}

export interface BankConfigSnapshot {
  config: Record<string, any>;
  overrides?: Record<string, any>;
}

export interface RecallItem {
  text?: string;
  [key: string]: unknown;
}

export interface RecallResponse {
  results?: RecallItem[];
}

export interface ReflectResponse {
  text?: string;
  synthesis?: string;
  [key: string]: unknown;
}

type RequestHeaders = Record<string, string>;
type RequestInitWithHeaders = Omit<RequestInit, "headers"> & { headers?: RequestHeaders };

interface RequestOptions {
  timeoutMs: number;
  label: string;
  retryRateLimit?: boolean;
  signal?: AbortSignal;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBody(body: string): unknown {
  if (!body) return undefined;
  try {
    return JSON.parse(body);
  } catch (_) {
    return undefined;
  }
}

async function readResponseBody(res: Response): Promise<string> {
  if (typeof (res as any).text === "function") {
    return res.text().catch(() => "");
  }
  try {
    return JSON.stringify(await (res as any).json?.() ?? {});
  } catch (_) {
    return "";
  }
}

function isRateLimitError(status: number, body: string): boolean {
  return status === 429 || body.includes("429") || body.includes("TooManyRequestsError");
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

export class HindsightClient {
  constructor(private readonly config: HindsightConfig) {}

  private url(path: string): string {
    return `${this.config.api_url}${path}`;
  }

  private async request(
    path: string,
    init: RequestInitWithHeaders,
    options: RequestOptions,
  ): Promise<ApiResult<unknown>> {
    const deadline = Date.now() + options.timeoutMs;
    let lastStatus: number | undefined;
    let lastBody = "";

    for (let attempt = 0; ; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        log(`${options.label}: timed out after ${options.timeoutMs}ms`);
        return {
          ok: false,
          status: lastStatus,
          body: lastBody,
          authError: false,
          rateLimited: lastStatus === 429,
          timedOut: true,
        };
      }

      const timeoutController = new AbortController();
      const timer = setTimeout(() => timeoutController.abort(), remaining);
      const signal = options.signal
        ? AbortSignal.any([timeoutController.signal, options.signal])
        : timeoutController.signal;
      let res: Response;
      try {
        res = await fetch(this.url(path), {
          ...init,
          headers: {
            Authorization: `Bearer ${this.config.api_key || ""}`,
            ...(init.body ? { "Content-Type": "application/json" } : {}),
            ...init.headers,
          },
          signal,
        });
      } catch (error) {
        if (options.signal?.aborted) {
          return { ok: false, authError: false, aborted: true, error: "aborted" };
        }
        if (timeoutController.signal.aborted) {
          log(`${options.label}: timed out after ${options.timeoutMs}ms`);
          return {
            ok: false,
            status: lastStatus,
            body: lastBody,
            authError: false,
            rateLimited: lastStatus === 429,
            timedOut: true,
          };
        }
        const message = error instanceof Error ? error.message : String(error);
        log(`${options.label}: request failed - ${message}`);
        return { ok: false, authError: false, error: message };
      } finally {
        clearTimeout(timer);
      }

      const body = await readResponseBody(res);
      lastStatus = res.status;
      lastBody = body;
      if (res.ok) {
        return { ok: true, status: res.status, body, data: parseBody(body), authError: false };
      }

      if (!options.retryRateLimit || !isRateLimitError(res.status, body)) {
        log(`${options.label}: HTTP ${res.status} - ${body.slice(0, 200)}`);
        return {
          ok: false,
          status: res.status,
          body,
          data: parseBody(body),
          authError: res.status === 401 || res.status === 403,
        };
      }

      if (attempt >= RATE_LIMIT_RETRIES) {
        log(`${options.label}: rate-limited (429), exhausted ${RATE_LIMIT_RETRIES} retries`);
        return {
          ok: false,
          status: res.status,
          body,
          data: parseBody(body),
          authError: false,
          rateLimited: true,
        };
      }

      const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
      const remainingAfter = deadline - Date.now();
      if (remainingAfter <= 0) {
        log(`${options.label}: rate-limited (429), no time left for retry`);
        return {
          ok: false,
          status: res.status,
          body,
          data: parseBody(body),
          authError: false,
          rateLimited: true,
          timedOut: true,
        };
      }
      const delay = Math.min(retryAfterMs ?? RATE_LIMIT_BACKOFF_MS[attempt], remainingAfter);
      log(`${options.label}: rate-limited (429), retrying in ${delay}ms (attempt ${attempt + 1}/${RATE_LIMIT_RETRIES})`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  async health(timeoutMs = 5000): Promise<ApiResult<unknown>> {
    return this.request("/health", {}, { timeoutMs, label: "health" });
  }

  async version(timeoutMs = 5000): Promise<string | null> {
    const result = await this.request("/version", {}, { timeoutMs, label: "version" });
    if (!result.ok) return null;
    return isRecord(result.data) && typeof result.data.api_version === "string"
      ? result.data.api_version
      : null;
  }

  async bankConfig(bank: string, timeoutMs = 10000): Promise<ApiResult<BankConfigSnapshot>> {
    const result = await this.request(
      `/v1/default/banks/${bank}/config`,
      {},
      { timeoutMs, label: `bank=${bank} config` },
    );
    if (!result.ok) return result as ApiResult<BankConfigSnapshot>;
    const data = isRecord(result.data) ? result.data : {};
    return {
      ...result,
      data: {
        config: isRecord(data.config) ? data.config : {},
        overrides: isRecord(data.overrides) ? data.overrides : undefined,
      },
    };
  }

  async createBank(bank: string, timeoutMs = 10000): Promise<ApiResult<unknown>> {
    return this.request(
      `/v1/default/banks/${bank}`,
      { method: "PUT", body: JSON.stringify({}) },
      { timeoutMs, label: `create bank=${bank}` },
    );
  }

  async updateBankConfig(
    bank: string,
    updates: Record<string, string>,
    timeoutMs = 10000,
  ): Promise<ApiResult<unknown>> {
    return this.request(
      `/v1/default/banks/${bank}/config`,
      { method: "PATCH", body: JSON.stringify({ updates }) },
      { timeoutMs, label: `update bank=${bank} config` },
    );
  }

  async bankStats(bank: string, timeoutMs = 10000): Promise<ApiResult<Record<string, unknown>>> {
    const result = await this.request(
      `/v1/default/banks/${bank}/stats`,
      {},
      { timeoutMs, label: `bank=${bank} stats` },
    );
    if (!result.ok) return result as ApiResult<Record<string, unknown>>;
    return {
      ...result,
      data: isRecord(result.data) ? result.data : {},
    };
  }

  async recall(
    bank: string,
    body: Record<string, unknown>,
    timeoutMs: number = DEFAULT_RECALL_TIMEOUT_MS,
  ): Promise<ApiResult<RecallResponse>> {
    const result = await this.request(
      `/v1/default/banks/${bank}/memories/recall`,
      { method: "POST", body: JSON.stringify(body) },
      { timeoutMs, label: `recall bank=${bank}`, retryRateLimit: true },
    );
    if (!result.ok) return result as ApiResult<RecallResponse>;
    return {
      ...result,
      data: isRecord(result.data) ? result.data as RecallResponse : {},
    };
  }

  async reflect(
    bank: string,
    query: string,
    timeoutMs: number = DEFAULT_REFLECT_TIMEOUT_MS,
  ): Promise<ApiResult<ReflectResponse>> {
    const result = await this.request(
      `/v1/default/banks/${bank}/reflect`,
      { method: "POST", body: JSON.stringify({ query }) },
      { timeoutMs, label: `reflect bank=${bank}` },
    );
    if (!result.ok) return result as ApiResult<ReflectResponse>;
    return {
      ...result,
      data: isRecord(result.data) ? result.data as ReflectResponse : {},
    };
  }

  async retain(
    bank: string,
    item: Record<string, unknown>,
    asyncMode: boolean,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ApiResult<unknown>> {
    return this.request(
      `/v1/default/banks/${bank}/memories`,
      { method: "POST", body: JSON.stringify({ items: [item], async: asyncMode }) },
      { timeoutMs, label: `retain bank=${bank}`, signal },
    );
  }
}

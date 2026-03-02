import { spawn } from "node:child_process";
import { Type } from "@sinclair/typebox";
import { formatCliCommand } from "../../cli/command-format.js";
import type { OpenClawConfig } from "../../config/config.js";
import { logVerbose } from "../../globals.js";
import { wrapWebContent } from "../../security/external-content.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";
import {
  WEB_TOOLS_TRUSTED_NETWORK_SSRF_POLICY,
  withWebToolsNetworkGuard,
} from "./web-guarded-fetch.js";
import {
  CacheEntry,
  DEFAULT_CACHE_TTL_MINUTES,
  DEFAULT_TIMEOUT_SECONDS,
  normalizeCacheKey,
  readCache,
  readResponseText,
  resolveCacheTtlMs,
  resolveTimeoutSeconds,
  writeCache,
} from "./web-shared.js";

const SEARCH_PROVIDERS = ["brave", "perplexity", "grok", "gemini", "kimi", "comet_mcp"] as const;
const DEFAULT_SEARCH_COUNT = 5;
const MAX_SEARCH_COUNT = 10;
const COMET_MCP_OUTPUT_LIMIT_CHARS = 200_000;
const COMET_MCP_JSON_BLOCK = /```(?:json)?\s*([\s\S]*?)```/gi;
const COMET_MCP_URL_PATTERN = /https?:\/\/[^\s)\]}>,]+/g;

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const DEFAULT_PERPLEXITY_BASE_URL = "https://openrouter.ai/api/v1";
const PERPLEXITY_DIRECT_BASE_URL = "https://api.perplexity.ai";
const DEFAULT_PERPLEXITY_MODEL = "perplexity/sonar-pro";
const PERPLEXITY_KEY_PREFIXES = ["pplx-"];
const OPENROUTER_KEY_PREFIXES = ["sk-or-"];

const XAI_API_ENDPOINT = "https://api.x.ai/v1/responses";
const DEFAULT_GROK_MODEL = "grok-4-1-fast";
const DEFAULT_KIMI_BASE_URL = "https://api.moonshot.ai/v1";
const DEFAULT_KIMI_MODEL = "moonshot-v1-128k";
const KIMI_WEB_SEARCH_TOOL = {
  type: "builtin_function",
  function: { name: "$web_search" },
} as const;
const DEFAULT_COMET_MCP_SERVER_NAME = "comet-bridge";
const COMET_MCP_SUPPORTED_MODES = new Set(["search", "research", "labs", "learn"]);

const SEARCH_CACHE = new Map<string, CacheEntry<Record<string, unknown>>>();
const BRAVE_FRESHNESS_SHORTCUTS = new Set(["pd", "pw", "pm", "py"]);
const BRAVE_FRESHNESS_RANGE = /^(\d{4}-\d{2}-\d{2})to(\d{4}-\d{2}-\d{2})$/;
const BRAVE_SEARCH_LANG_CODE = /^[a-z]{2}$/i;
const BRAVE_UI_LANG_LOCALE = /^([a-z]{2})-([a-z]{2})$/i;

const WebSearchSchema = Type.Object({
  query: Type.String({ description: "Search query string." }),
  count: Type.Optional(
    Type.Number({
      description: "Number of results to return (1-10).",
      minimum: 1,
      maximum: MAX_SEARCH_COUNT,
    }),
  ),
  country: Type.Optional(
    Type.String({
      description:
        "2-letter country code for region-specific results (e.g., 'DE', 'US', 'ALL'). Default: 'US'.",
    }),
  ),
  search_lang: Type.Optional(
    Type.String({
      description:
        "Short ISO language code for search results (e.g., 'de', 'en', 'fr', 'tr'). Must be a 2-letter code, NOT a locale.",
    }),
  ),
  ui_lang: Type.Optional(
    Type.String({
      description:
        "Locale code for UI elements in language-region format (e.g., 'en-US', 'de-DE', 'fr-FR', 'tr-TR'). Must include region subtag.",
    }),
  ),
  freshness: Type.Optional(
    Type.String({
      description:
        "Filter results by discovery time. Brave supports 'pd', 'pw', 'pm', 'py', and date range 'YYYY-MM-DDtoYYYY-MM-DD'. Perplexity supports 'pd', 'pw', 'pm', and 'py'.",
    }),
  ),
});

type WebSearchConfig = NonNullable<OpenClawConfig["tools"]>["web"] extends infer Web
  ? Web extends { search?: infer Search }
    ? Search
    : undefined
  : undefined;

type BraveSearchResult = {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
};

type BraveSearchResponse = {
  web?: {
    results?: BraveSearchResult[];
  };
};

type PerplexityConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
};

type PerplexityApiKeySource = "config" | "perplexity_env" | "openrouter_env" | "none";

type GrokConfig = {
  apiKey?: string;
  model?: string;
  inlineCitations?: boolean;
};

type KimiConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
};

type CometMcpMode = "search" | "research" | "labs" | "learn";

type CometMcpConfig = {
  serverName?: string;
  mode?: CometMcpMode;
  timeoutMs?: number;
  fallbackToBrave?: boolean;
};

type GrokSearchResponse = {
  output?: Array<{
    type?: string;
    role?: string;
    text?: string; // present when type === "output_text" (top-level output_text block)
    content?: Array<{
      type?: string;
      text?: string;
      annotations?: Array<{
        type?: string;
        url?: string;
        start_index?: number;
        end_index?: number;
      }>;
    }>;
    annotations?: Array<{
      type?: string;
      url?: string;
      start_index?: number;
      end_index?: number;
    }>;
  }>;
  output_text?: string; // deprecated field - kept for backwards compatibility
  citations?: string[];
  inline_citations?: Array<{
    start_index: number;
    end_index: number;
    url: string;
  }>;
};

type KimiToolCall = {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

type KimiMessage = {
  role?: string;
  content?: string;
  reasoning_content?: string;
  tool_calls?: KimiToolCall[];
};

type KimiSearchResponse = {
  choices?: Array<{
    finish_reason?: string;
    message?: KimiMessage;
  }>;
  search_results?: Array<{
    title?: string;
    url?: string;
    content?: string;
  }>;
};

type PerplexitySearchResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  citations?: string[];
};

type PerplexityBaseUrlHint = "direct" | "openrouter";

function extractGrokContent(data: GrokSearchResponse): {
  text: string | undefined;
  annotationCitations: string[];
} {
  // xAI Responses API format: find the message output with text content
  for (const output of data.output ?? []) {
    if (output.type === "message") {
      for (const block of output.content ?? []) {
        if (block.type === "output_text" && typeof block.text === "string" && block.text) {
          const urls = (block.annotations ?? [])
            .filter((a) => a.type === "url_citation" && typeof a.url === "string")
            .map((a) => a.url as string);
          return { text: block.text, annotationCitations: [...new Set(urls)] };
        }
      }
    }
    // Some xAI responses place output_text blocks directly in the output array
    // without a message wrapper.
    if (
      output.type === "output_text" &&
      "text" in output &&
      typeof output.text === "string" &&
      output.text
    ) {
      const rawAnnotations =
        "annotations" in output && Array.isArray(output.annotations) ? output.annotations : [];
      const urls = rawAnnotations
        .filter(
          (a: Record<string, unknown>) => a.type === "url_citation" && typeof a.url === "string",
        )
        .map((a: Record<string, unknown>) => a.url as string);
      return { text: output.text, annotationCitations: [...new Set(urls)] };
    }
  }
  // Fallback: deprecated output_text field
  const text = typeof data.output_text === "string" ? data.output_text : undefined;
  return { text, annotationCitations: [] };
}

type GeminiConfig = {
  apiKey?: string;
  model?: string;
};

type GeminiGroundingResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
    groundingMetadata?: {
      groundingChunks?: Array<{
        web?: {
          uri?: string;
          title?: string;
        };
      }>;
      searchEntryPoint?: {
        renderedContent?: string;
      };
      webSearchQueries?: string[];
    };
  }>;
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
};

const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

function resolveSearchConfig(cfg?: OpenClawConfig): WebSearchConfig {
  const search = cfg?.tools?.web?.search;
  if (!search || typeof search !== "object") {
    return undefined;
  }
  return search as WebSearchConfig;
}

function resolveSearchEnabled(params: { search?: WebSearchConfig; sandboxed?: boolean }): boolean {
  if (typeof params.search?.enabled === "boolean") {
    return params.search.enabled;
  }
  if (params.sandboxed) {
    return true;
  }
  return true;
}

function resolveSearchApiKey(search?: WebSearchConfig): string | undefined {
  const fromConfig =
    search && "apiKey" in search && typeof search.apiKey === "string"
      ? normalizeSecretInput(search.apiKey)
      : "";
  const fromEnv = normalizeSecretInput(process.env.BRAVE_API_KEY);
  return fromConfig || fromEnv || undefined;
}

function missingSearchKeyPayload(provider: (typeof SEARCH_PROVIDERS)[number]) {
  if (provider === "comet_mcp") {
    return {
      error: "missing_comet_mcp_bridge",
      message:
        "web_search (comet_mcp) uses mcporter + comet-mcp instead of an API key. Install mcporter, register a comet-mcp server, and set tools.web.search.cometMcp.serverName if needed.",
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }
  if (provider === "perplexity") {
    return {
      error: "missing_perplexity_api_key",
      message:
        "web_search (perplexity) needs an API key. Set PERPLEXITY_API_KEY or OPENROUTER_API_KEY in the Gateway environment, or configure tools.web.search.perplexity.apiKey.",
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }
  if (provider === "grok") {
    return {
      error: "missing_xai_api_key",
      message:
        "web_search (grok) needs an xAI API key. Set XAI_API_KEY in the Gateway environment, or configure tools.web.search.grok.apiKey.",
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }
  if (provider === "gemini") {
    return {
      error: "missing_gemini_api_key",
      message:
        "web_search (gemini) needs an API key. Set GEMINI_API_KEY in the Gateway environment, or configure tools.web.search.gemini.apiKey.",
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }
  if (provider === "kimi") {
    return {
      error: "missing_kimi_api_key",
      message:
        "web_search (kimi) needs a Moonshot API key. Set KIMI_API_KEY or MOONSHOT_API_KEY in the Gateway environment, or configure tools.web.search.kimi.apiKey.",
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }
  return {
    error: "missing_brave_api_key",
    message: `web_search needs a Brave Search API key. Run \`${formatCliCommand("openclaw configure --section web")}\` to store it, or set BRAVE_API_KEY in the Gateway environment.`,
    docs: "https://docs.openclaw.ai/tools/web",
  };
}

function resolveSearchProvider(search?: WebSearchConfig): (typeof SEARCH_PROVIDERS)[number] {
  const raw =
    search && "provider" in search && typeof search.provider === "string"
      ? search.provider.trim().toLowerCase()
      : "";
  if (raw === "perplexity") {
    return "perplexity";
  }
  if (raw === "grok") {
    return "grok";
  }
  if (raw === "gemini") {
    return "gemini";
  }
  if (raw === "kimi") {
    return "kimi";
  }
  if (raw === "comet_mcp" || raw === "comet-mcp") {
    return "comet_mcp";
  }
  if (raw === "brave") {
    return "brave";
  }

  // Auto-detect provider from available API keys (priority order)
  if (raw === "") {
    // 1. Brave
    if (resolveSearchApiKey(search)) {
      logVerbose(
        'web_search: no provider configured, auto-detected "brave" from available API keys',
      );
      return "brave";
    }
    // 2. Gemini
    const geminiConfig = resolveGeminiConfig(search);
    if (resolveGeminiApiKey(geminiConfig)) {
      logVerbose(
        'web_search: no provider configured, auto-detected "gemini" from available API keys',
      );
      return "gemini";
    }
    // 3. Kimi
    const kimiConfig = resolveKimiConfig(search);
    if (resolveKimiApiKey(kimiConfig)) {
      logVerbose(
        'web_search: no provider configured, auto-detected "kimi" from available API keys',
      );
      return "kimi";
    }
    // 4. Perplexity
    const perplexityConfig = resolvePerplexityConfig(search);
    const { apiKey: perplexityKey } = resolvePerplexityApiKey(perplexityConfig);
    if (perplexityKey) {
      logVerbose(
        'web_search: no provider configured, auto-detected "perplexity" from available API keys',
      );
      return "perplexity";
    }
    // 5. Grok
    const grokConfig = resolveGrokConfig(search);
    if (resolveGrokApiKey(grokConfig)) {
      logVerbose(
        'web_search: no provider configured, auto-detected "grok" from available API keys',
      );
      return "grok";
    }
  }

  return "brave";
}

function resolvePerplexityConfig(search?: WebSearchConfig): PerplexityConfig {
  if (!search || typeof search !== "object") {
    return {};
  }
  const perplexity = "perplexity" in search ? search.perplexity : undefined;
  if (!perplexity || typeof perplexity !== "object") {
    return {};
  }
  return perplexity as PerplexityConfig;
}

function resolvePerplexityApiKey(perplexity?: PerplexityConfig): {
  apiKey?: string;
  source: PerplexityApiKeySource;
} {
  const fromConfig = normalizeApiKey(perplexity?.apiKey);
  if (fromConfig) {
    return { apiKey: fromConfig, source: "config" };
  }

  const fromEnvPerplexity = normalizeApiKey(process.env.PERPLEXITY_API_KEY);
  if (fromEnvPerplexity) {
    return { apiKey: fromEnvPerplexity, source: "perplexity_env" };
  }

  const fromEnvOpenRouter = normalizeApiKey(process.env.OPENROUTER_API_KEY);
  if (fromEnvOpenRouter) {
    return { apiKey: fromEnvOpenRouter, source: "openrouter_env" };
  }

  return { apiKey: undefined, source: "none" };
}

function normalizeApiKey(key: unknown): string {
  return normalizeSecretInput(key);
}

function inferPerplexityBaseUrlFromApiKey(apiKey?: string): PerplexityBaseUrlHint | undefined {
  if (!apiKey) {
    return undefined;
  }
  const normalized = apiKey.toLowerCase();
  if (PERPLEXITY_KEY_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return "direct";
  }
  if (OPENROUTER_KEY_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return "openrouter";
  }
  return undefined;
}

function resolvePerplexityBaseUrl(
  perplexity?: PerplexityConfig,
  apiKeySource: PerplexityApiKeySource = "none",
  apiKey?: string,
): string {
  const fromConfig =
    perplexity && "baseUrl" in perplexity && typeof perplexity.baseUrl === "string"
      ? perplexity.baseUrl.trim()
      : "";
  if (fromConfig) {
    return fromConfig;
  }
  if (apiKeySource === "perplexity_env") {
    return PERPLEXITY_DIRECT_BASE_URL;
  }
  if (apiKeySource === "openrouter_env") {
    return DEFAULT_PERPLEXITY_BASE_URL;
  }
  if (apiKeySource === "config") {
    const inferred = inferPerplexityBaseUrlFromApiKey(apiKey);
    if (inferred === "direct") {
      return PERPLEXITY_DIRECT_BASE_URL;
    }
    if (inferred === "openrouter") {
      return DEFAULT_PERPLEXITY_BASE_URL;
    }
  }
  return DEFAULT_PERPLEXITY_BASE_URL;
}

function resolvePerplexityModel(perplexity?: PerplexityConfig): string {
  const fromConfig =
    perplexity && "model" in perplexity && typeof perplexity.model === "string"
      ? perplexity.model.trim()
      : "";
  return fromConfig || DEFAULT_PERPLEXITY_MODEL;
}

function isDirectPerplexityBaseUrl(baseUrl: string): boolean {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return false;
  }
  try {
    return new URL(trimmed).hostname.toLowerCase() === "api.perplexity.ai";
  } catch {
    return false;
  }
}

function resolvePerplexityRequestModel(baseUrl: string, model: string): string {
  if (!isDirectPerplexityBaseUrl(baseUrl)) {
    return model;
  }
  return model.startsWith("perplexity/") ? model.slice("perplexity/".length) : model;
}

function resolveGrokConfig(search?: WebSearchConfig): GrokConfig {
  if (!search || typeof search !== "object") {
    return {};
  }
  const grok = "grok" in search ? search.grok : undefined;
  if (!grok || typeof grok !== "object") {
    return {};
  }
  return grok as GrokConfig;
}

function resolveGrokApiKey(grok?: GrokConfig): string | undefined {
  const fromConfig = normalizeApiKey(grok?.apiKey);
  if (fromConfig) {
    return fromConfig;
  }
  const fromEnv = normalizeApiKey(process.env.XAI_API_KEY);
  return fromEnv || undefined;
}

function resolveGrokModel(grok?: GrokConfig): string {
  const fromConfig =
    grok && "model" in grok && typeof grok.model === "string" ? grok.model.trim() : "";
  return fromConfig || DEFAULT_GROK_MODEL;
}

function resolveGrokInlineCitations(grok?: GrokConfig): boolean {
  return grok?.inlineCitations === true;
}

function resolveKimiConfig(search?: WebSearchConfig): KimiConfig {
  if (!search || typeof search !== "object") {
    return {};
  }
  const kimi = "kimi" in search ? search.kimi : undefined;
  if (!kimi || typeof kimi !== "object") {
    return {};
  }
  return kimi as KimiConfig;
}

function resolveKimiApiKey(kimi?: KimiConfig): string | undefined {
  const fromConfig = normalizeApiKey(kimi?.apiKey);
  if (fromConfig) {
    return fromConfig;
  }
  const fromEnvKimi = normalizeApiKey(process.env.KIMI_API_KEY);
  if (fromEnvKimi) {
    return fromEnvKimi;
  }
  const fromEnvMoonshot = normalizeApiKey(process.env.MOONSHOT_API_KEY);
  return fromEnvMoonshot || undefined;
}

function resolveKimiModel(kimi?: KimiConfig): string {
  const fromConfig =
    kimi && "model" in kimi && typeof kimi.model === "string" ? kimi.model.trim() : "";
  return fromConfig || DEFAULT_KIMI_MODEL;
}

function resolveKimiBaseUrl(kimi?: KimiConfig): string {
  const fromConfig =
    kimi && "baseUrl" in kimi && typeof kimi.baseUrl === "string" ? kimi.baseUrl.trim() : "";
  return fromConfig || DEFAULT_KIMI_BASE_URL;
}

function resolveCometMcpConfig(search?: WebSearchConfig): CometMcpConfig {
  if (!search || typeof search !== "object") {
    return {};
  }
  const cometMcp = "cometMcp" in search ? search.cometMcp : undefined;
  if (!cometMcp || typeof cometMcp !== "object") {
    return {};
  }
  return cometMcp as CometMcpConfig;
}

function resolveCometMcpServerName(cometMcp?: CometMcpConfig): string {
  const fromConfig =
    cometMcp && "serverName" in cometMcp && typeof cometMcp.serverName === "string"
      ? cometMcp.serverName.trim()
      : "";
  return fromConfig || DEFAULT_COMET_MCP_SERVER_NAME;
}

function resolveCometMcpMode(cometMcp?: CometMcpConfig): CometMcpMode | undefined {
  const raw =
    cometMcp && "mode" in cometMcp && typeof cometMcp.mode === "string"
      ? cometMcp.mode.trim().toLowerCase()
      : "";
  if (!raw || !COMET_MCP_SUPPORTED_MODES.has(raw)) {
    return undefined;
  }
  return raw as CometMcpMode;
}

function resolveCometMcpTimeoutMs(
  cometMcp: CometMcpConfig | undefined,
  fallbackTimeoutSeconds: number,
): number {
  const raw =
    cometMcp && "timeoutMs" in cometMcp && typeof cometMcp.timeoutMs === "number"
      ? cometMcp.timeoutMs
      : undefined;
  if (raw && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  return Math.max(1_000, Math.floor(fallbackTimeoutSeconds * 1_000));
}

function resolveCometFallbackToBrave(cometMcp?: CometMcpConfig): boolean {
  return cometMcp?.fallbackToBrave === true;
}

function resolveGeminiConfig(search?: WebSearchConfig): GeminiConfig {
  if (!search || typeof search !== "object") {
    return {};
  }
  const gemini = "gemini" in search ? search.gemini : undefined;
  if (!gemini || typeof gemini !== "object") {
    return {};
  }
  return gemini as GeminiConfig;
}

function resolveGeminiApiKey(gemini?: GeminiConfig): string | undefined {
  const fromConfig = normalizeApiKey(gemini?.apiKey);
  if (fromConfig) {
    return fromConfig;
  }
  const fromEnv = normalizeApiKey(process.env.GEMINI_API_KEY);
  return fromEnv || undefined;
}

function resolveGeminiModel(gemini?: GeminiConfig): string {
  const fromConfig =
    gemini && "model" in gemini && typeof gemini.model === "string" ? gemini.model.trim() : "";
  return fromConfig || DEFAULT_GEMINI_MODEL;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function appendOutputWithCap(
  current: string,
  chunk: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (maxChars <= 0) {
    return { text: "", truncated: true };
  }
  if (current.length >= maxChars) {
    return { text: current.slice(0, maxChars), truncated: true };
  }
  const next = `${current}${chunk}`;
  if (next.length > maxChars) {
    return { text: next.slice(0, maxChars), truncated: true };
  }
  return { text: next, truncated: false };
}

function resolveWindowsCommandShim(command: string): string {
  if (process.platform !== "win32") {
    return command;
  }
  return command.toLowerCase().endsWith(".cmd") ? command : `${command}.cmd`;
}

async function runMcporterCall(params: {
  selector: string;
  args: Record<string, unknown>;
  timeoutMs: number;
}): Promise<unknown> {
  const timeoutMs = Math.max(1_000, Math.floor(params.timeoutMs));
  const commandArgs = [
    "call",
    params.selector,
    "--args",
    JSON.stringify(params.args),
    "--output",
    "json",
    "--timeout",
    String(timeoutMs),
  ];

  return await new Promise<unknown>((resolve, reject) => {
    const child = spawn(resolveWindowsCommandShim("mcporter"), commandArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    const killTimer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`mcporter ${commandArgs.join(" ")} timed out after ${timeoutMs}ms`));
    }, timeoutMs + 2_000);

    child.stdout.on("data", (chunk) => {
      const next = appendOutputWithCap(
        stdout,
        chunk.toString("utf8"),
        COMET_MCP_OUTPUT_LIMIT_CHARS,
      );
      stdout = next.text;
      stdoutTruncated = stdoutTruncated || next.truncated;
    });

    child.stderr.on("data", (chunk) => {
      const next = appendOutputWithCap(
        stderr,
        chunk.toString("utf8"),
        COMET_MCP_OUTPUT_LIMIT_CHARS,
      );
      stderr = next.text;
      stderrTruncated = stderrTruncated || next.truncated;
    });

    child.on("error", (error) => {
      clearTimeout(killTimer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(killTimer);
      if (stdoutTruncated || stderrTruncated) {
        reject(
          new Error(
            `mcporter ${commandArgs.join(" ")} produced too much output (limit ${COMET_MCP_OUTPUT_LIMIT_CHARS} chars)`,
          ),
        );
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `mcporter ${commandArgs.join(" ")} failed (code ${code}): ${stderr || stdout || "unknown error"}`,
          ),
        );
        return;
      }
      try {
        const parsed = JSON.parse(stdout || "{}") as unknown;
        resolve(parsed);
      } catch (error) {
        reject(
          new Error(
            `mcporter ${commandArgs.join(" ")} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    });
  });
}

function collectMcpTextContent(value: unknown, output: string[]): void {
  if (typeof value === "string") {
    const text = value.trim();
    if (text) {
      output.push(text);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectMcpTextContent(item, output);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  if (typeof value.text === "string") {
    const text = value.text.trim();
    if (text) {
      output.push(text);
    }
  }
  if ("content" in value) {
    collectMcpTextContent(value.content, output);
  }
  if ("result" in value) {
    collectMcpTextContent(value.result, output);
  }
  if ("structuredContent" in value) {
    collectMcpTextContent(value.structuredContent, output);
  }
}

function extractMcporterText(payload: unknown): string {
  const parts: string[] = [];
  collectMcpTextContent(payload, parts);
  return parts.join("\n").trim();
}

type CometSearchResult = {
  title: string;
  url: string;
  snippet: string;
};

function normalizeHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return trimmed;
  } catch {
    return undefined;
  }
}

function normalizeCometResultEntry(value: unknown): CometSearchResult | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const url =
    normalizeHttpUrl(value.url) ??
    normalizeHttpUrl(value.link) ??
    normalizeHttpUrl(value.source) ??
    "";
  const title =
    (typeof value.title === "string" ? value.title.trim() : "") ||
    (typeof value.headline === "string" ? value.headline.trim() : "") ||
    (typeof value.name === "string" ? value.name.trim() : "");
  const snippet =
    (typeof value.snippet === "string" ? value.snippet.trim() : "") ||
    (typeof value.description === "string" ? value.description.trim() : "") ||
    (typeof value.summary === "string" ? value.summary.trim() : "") ||
    (typeof value.content === "string" ? value.content.trim() : "") ||
    (typeof value.text === "string" ? value.text.trim() : "");
  if (!title && !url && !snippet) {
    return undefined;
  }
  return {
    title: title || resolveSiteName(url) || "Untitled result",
    url,
    snippet,
  };
}

function parseCometResultPayload(value: unknown): CometSearchResult[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeCometResultEntry(entry))
      .filter(Boolean) as CometSearchResult[];
  }
  if (!isRecord(value)) {
    return [];
  }
  if (Array.isArray(value.results)) {
    return value.results
      .map((entry) => normalizeCometResultEntry(entry))
      .filter(Boolean) as CometSearchResult[];
  }
  if (Array.isArray(value.items)) {
    return value.items
      .map((entry) => normalizeCometResultEntry(entry))
      .filter(Boolean) as CometSearchResult[];
  }
  const single = normalizeCometResultEntry(value);
  return single ? [single] : [];
}

function collectJsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  for (const match of text.matchAll(COMET_MCP_JSON_BLOCK)) {
    const body = match[1]?.trim();
    if (body) {
      candidates.push(body);
    }
  }
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    candidates.push(trimmed);
  }
  const firstObject = trimmed.indexOf("{");
  const lastObject = trimmed.lastIndexOf("}");
  if (firstObject >= 0 && lastObject > firstObject) {
    candidates.push(trimmed.slice(firstObject, lastObject + 1));
  }
  const firstArray = trimmed.indexOf("[");
  const lastArray = trimmed.lastIndexOf("]");
  if (firstArray >= 0 && lastArray > firstArray) {
    candidates.push(trimmed.slice(firstArray, lastArray + 1));
  }
  return [...new Set(candidates)];
}

function parseCometJsonResults(text: string): CometSearchResult[] {
  for (const candidate of collectJsonCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const results = parseCometResultPayload(parsed);
      if (results.length > 0) {
        return results;
      }
    } catch {
      // try next candidate
    }
  }
  return [];
}

function buildSnippetAroundIndex(text: string, index: number): string {
  const start = Math.max(0, index - 120);
  const end = Math.min(text.length, index + 240);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

function parseCometLinkResults(text: string): CometSearchResult[] {
  const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  const output: CometSearchResult[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(linkRegex)) {
    const title = match[1]?.trim() || "Untitled result";
    const url = normalizeHttpUrl(match[2]) ?? "";
    if (!url || seen.has(url)) {
      continue;
    }
    seen.add(url);
    output.push({
      title,
      url,
      snippet: buildSnippetAroundIndex(text, match.index ?? 0),
    });
  }
  return output;
}

function parseCometUrlResults(text: string): CometSearchResult[] {
  const output: CometSearchResult[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(COMET_MCP_URL_PATTERN)) {
    const url = normalizeHttpUrl(match[0]) ?? "";
    if (!url || seen.has(url)) {
      continue;
    }
    seen.add(url);
    output.push({
      title: resolveSiteName(url) || "Result",
      url,
      snippet: buildSnippetAroundIndex(text, match.index ?? 0),
    });
  }
  return output;
}

function dedupeCometResults(results: CometSearchResult[]): CometSearchResult[] {
  const seen = new Set<string>();
  const out: CometSearchResult[] = [];
  for (const entry of results) {
    const key = `${entry.url}::${entry.title}`.trim();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(entry);
  }
  return out;
}

function extractCometSearchResults(text: string, limit: number): CometSearchResult[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  if (/^error:/i.test(trimmed)) {
    throw new Error(trimmed);
  }
  const merged = dedupeCometResults([
    ...parseCometJsonResults(trimmed),
    ...parseCometLinkResults(trimmed),
    ...parseCometUrlResults(trimmed),
  ]);
  if (merged.length > 0) {
    return merged.slice(0, Math.max(1, limit));
  }
  return [
    {
      title: "Comet MCP response",
      url: "",
      snippet: trimmed.replace(/\s+/g, " ").slice(0, 600),
    },
  ];
}

function buildCometSearchPrompt(query: string, count: number): string {
  return [
    `Search the web for: ${query}`,
    `Return only valid JSON using this exact shape: {"results":[{"title":"...","url":"https://...","snippet":"..."}]}.`,
    `Include up to ${count} results. Use absolute URLs.`,
    "Do not include markdown fences or commentary outside the JSON.",
  ].join("\n");
}

async function runCometMcpSearch(params: {
  query: string;
  count: number;
  serverName: string;
  mode?: CometMcpMode;
  timeoutMs: number;
}): Promise<CometSearchResult[]> {
  const selectorBase = params.serverName.trim() || DEFAULT_COMET_MCP_SERVER_NAME;
  const callTimeoutMs = Math.max(2_000, params.timeoutMs + 2_000);

  await runMcporterCall({
    selector: `${selectorBase}.comet_connect`,
    args: {},
    timeoutMs: callTimeoutMs,
  });

  if (params.mode) {
    await runMcporterCall({
      selector: `${selectorBase}.comet_mode`,
      args: { mode: params.mode },
      timeoutMs: callTimeoutMs,
    });
  }

  const askPayload = await runMcporterCall({
    selector: `${selectorBase}.comet_ask`,
    args: {
      prompt: buildCometSearchPrompt(params.query, params.count),
      newChat: true,
      timeout: params.timeoutMs,
    },
    timeoutMs: callTimeoutMs,
  });
  const rawText = extractMcporterText(askPayload);
  return extractCometSearchResults(rawText, params.count);
}

async function withTrustedWebSearchEndpoint<T>(
  params: {
    url: string;
    timeoutSeconds: number;
    init: RequestInit;
  },
  run: (response: Response) => Promise<T>,
): Promise<T> {
  return withWebToolsNetworkGuard(
    {
      url: params.url,
      init: params.init,
      timeoutSeconds: params.timeoutSeconds,
      policy: WEB_TOOLS_TRUSTED_NETWORK_SSRF_POLICY,
    },
    async ({ response }) => run(response),
  );
}

async function runGeminiSearch(params: {
  query: string;
  apiKey: string;
  model: string;
  timeoutSeconds: number;
}): Promise<{ content: string; citations: Array<{ url: string; title?: string }> }> {
  const endpoint = `${GEMINI_API_BASE}/models/${params.model}:generateContent`;

  return withTrustedWebSearchEndpoint(
    {
      url: endpoint,
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": params.apiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: params.query }],
            },
          ],
          tools: [{ google_search: {} }],
        }),
      },
    },
    async (res) => {
      if (!res.ok) {
        const detailResult = await readResponseText(res, { maxBytes: 64_000 });
        // Strip API key from any error detail to prevent accidental key leakage in logs
        const safeDetail = (detailResult.text || res.statusText).replace(
          /key=[^&\s]+/gi,
          "key=***",
        );
        throw new Error(`Gemini API error (${res.status}): ${safeDetail}`);
      }

      let data: GeminiGroundingResponse;
      try {
        data = (await res.json()) as GeminiGroundingResponse;
      } catch (err) {
        const safeError = String(err).replace(/key=[^&\s]+/gi, "key=***");
        throw new Error(`Gemini API returned invalid JSON: ${safeError}`, { cause: err });
      }

      if (data.error) {
        const rawMsg = data.error.message || data.error.status || "unknown";
        const safeMsg = rawMsg.replace(/key=[^&\s]+/gi, "key=***");
        throw new Error(`Gemini API error (${data.error.code}): ${safeMsg}`);
      }

      const candidate = data.candidates?.[0];
      const content =
        candidate?.content?.parts
          ?.map((p) => p.text)
          .filter(Boolean)
          .join("\n") ?? "No response";

      const groundingChunks = candidate?.groundingMetadata?.groundingChunks ?? [];
      const rawCitations = groundingChunks
        .filter((chunk) => chunk.web?.uri)
        .map((chunk) => ({
          url: chunk.web!.uri!,
          title: chunk.web?.title || undefined,
        }));

      // Resolve Google grounding redirect URLs to direct URLs with concurrency cap.
      // Gemini typically returns 3-8 citations; cap at 10 concurrent to be safe.
      const MAX_CONCURRENT_REDIRECTS = 10;
      const citations: Array<{ url: string; title?: string }> = [];
      for (let i = 0; i < rawCitations.length; i += MAX_CONCURRENT_REDIRECTS) {
        const batch = rawCitations.slice(i, i + MAX_CONCURRENT_REDIRECTS);
        const resolved = await Promise.all(
          batch.map(async (citation) => {
            const resolvedUrl = await resolveRedirectUrl(citation.url);
            return { ...citation, url: resolvedUrl };
          }),
        );
        citations.push(...resolved);
      }

      return { content, citations };
    },
  );
}

const REDIRECT_TIMEOUT_MS = 5000;

/**
 * Resolve a redirect URL to its final destination using a HEAD request.
 * Returns the original URL if resolution fails or times out.
 */
async function resolveRedirectUrl(url: string): Promise<string> {
  try {
    return await withWebToolsNetworkGuard(
      {
        url,
        init: { method: "HEAD" },
        timeoutMs: REDIRECT_TIMEOUT_MS,
        policy: WEB_TOOLS_TRUSTED_NETWORK_SSRF_POLICY,
      },
      async ({ finalUrl }) => finalUrl || url,
    );
  } catch {
    return url;
  }
}

function resolveSearchCount(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const clamped = Math.max(1, Math.min(MAX_SEARCH_COUNT, Math.floor(parsed)));
  return clamped;
}

function normalizeBraveSearchLang(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || !BRAVE_SEARCH_LANG_CODE.test(trimmed)) {
    return undefined;
  }
  return trimmed.toLowerCase();
}

function normalizeBraveUiLang(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const match = trimmed.match(BRAVE_UI_LANG_LOCALE);
  if (!match) {
    return undefined;
  }
  const [, language, region] = match;
  return `${language.toLowerCase()}-${region.toUpperCase()}`;
}

function normalizeBraveLanguageParams(params: { search_lang?: string; ui_lang?: string }): {
  search_lang?: string;
  ui_lang?: string;
  invalidField?: "search_lang" | "ui_lang";
} {
  const rawSearchLang = params.search_lang?.trim() || undefined;
  const rawUiLang = params.ui_lang?.trim() || undefined;
  let searchLangCandidate = rawSearchLang;
  let uiLangCandidate = rawUiLang;

  // Recover common LLM mix-up: locale in search_lang + short code in ui_lang.
  if (normalizeBraveUiLang(rawSearchLang) && normalizeBraveSearchLang(rawUiLang)) {
    searchLangCandidate = rawUiLang;
    uiLangCandidate = rawSearchLang;
  }

  const search_lang = normalizeBraveSearchLang(searchLangCandidate);
  if (searchLangCandidate && !search_lang) {
    return { invalidField: "search_lang" };
  }

  const ui_lang = normalizeBraveUiLang(uiLangCandidate);
  if (uiLangCandidate && !ui_lang) {
    return { invalidField: "ui_lang" };
  }

  return { search_lang, ui_lang };
}

function normalizeFreshness(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const lower = trimmed.toLowerCase();
  if (BRAVE_FRESHNESS_SHORTCUTS.has(lower)) {
    return lower;
  }

  const match = trimmed.match(BRAVE_FRESHNESS_RANGE);
  if (!match) {
    return undefined;
  }

  const [, start, end] = match;
  if (!isValidIsoDate(start) || !isValidIsoDate(end)) {
    return undefined;
  }
  if (start > end) {
    return undefined;
  }

  return `${start}to${end}`;
}

/**
 * Map normalized freshness values (pd/pw/pm/py) to Perplexity's
 * search_recency_filter values (day/week/month/year).
 */
function freshnessToPerplexityRecency(freshness: string | undefined): string | undefined {
  if (!freshness) {
    return undefined;
  }
  const map: Record<string, string> = {
    pd: "day",
    pw: "week",
    pm: "month",
    py: "year",
  };
  return map[freshness] ?? undefined;
}

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return false;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function resolveSiteName(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

async function throwWebSearchApiError(res: Response, providerLabel: string): Promise<never> {
  const detailResult = await readResponseText(res, { maxBytes: 64_000 });
  const detail = detailResult.text;
  throw new Error(`${providerLabel} API error (${res.status}): ${detail || res.statusText}`);
}

async function runPerplexitySearch(params: {
  query: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutSeconds: number;
  freshness?: string;
}): Promise<{ content: string; citations: string[] }> {
  const baseUrl = params.baseUrl.trim().replace(/\/$/, "");
  const endpoint = `${baseUrl}/chat/completions`;
  const model = resolvePerplexityRequestModel(baseUrl, params.model);

  const body: Record<string, unknown> = {
    model,
    messages: [
      {
        role: "user",
        content: params.query,
      },
    ],
  };

  const recencyFilter = freshnessToPerplexityRecency(params.freshness);
  if (recencyFilter) {
    body.search_recency_filter = recencyFilter;
  }

  return withTrustedWebSearchEndpoint(
    {
      url: endpoint,
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${params.apiKey}`,
          "HTTP-Referer": "https://openclaw.ai",
          "X-Title": "OpenClaw Web Search",
        },
        body: JSON.stringify(body),
      },
    },
    async (res) => {
      if (!res.ok) {
        return await throwWebSearchApiError(res, "Perplexity");
      }

      const data = (await res.json()) as PerplexitySearchResponse;
      const content = data.choices?.[0]?.message?.content ?? "No response";
      const citations = data.citations ?? [];

      return { content, citations };
    },
  );
}

async function runGrokSearch(params: {
  query: string;
  apiKey: string;
  model: string;
  timeoutSeconds: number;
  inlineCitations: boolean;
}): Promise<{
  content: string;
  citations: string[];
  inlineCitations?: GrokSearchResponse["inline_citations"];
}> {
  const body: Record<string, unknown> = {
    model: params.model,
    input: [
      {
        role: "user",
        content: params.query,
      },
    ],
    tools: [{ type: "web_search" }],
  };

  // Note: xAI's /v1/responses endpoint does not support the `include`
  // parameter (returns 400 "Argument not supported: include"). Inline
  // citations are returned automatically when available — we just parse
  // them from the response without requesting them explicitly (#12910).

  return withTrustedWebSearchEndpoint(
    {
      url: XAI_API_ENDPOINT,
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${params.apiKey}`,
        },
        body: JSON.stringify(body),
      },
    },
    async (res) => {
      if (!res.ok) {
        return await throwWebSearchApiError(res, "xAI");
      }

      const data = (await res.json()) as GrokSearchResponse;
      const { text: extractedText, annotationCitations } = extractGrokContent(data);
      const content = extractedText ?? "No response";
      // Prefer top-level citations; fall back to annotation-derived ones
      const citations = (data.citations ?? []).length > 0 ? data.citations! : annotationCitations;
      const inlineCitations = data.inline_citations;

      return { content, citations, inlineCitations };
    },
  );
}

function extractKimiMessageText(message: KimiMessage | undefined): string | undefined {
  const content = message?.content?.trim();
  if (content) {
    return content;
  }
  const reasoning = message?.reasoning_content?.trim();
  return reasoning || undefined;
}

function extractKimiCitations(data: KimiSearchResponse): string[] {
  const citations = (data.search_results ?? [])
    .map((entry) => entry.url?.trim())
    .filter((url): url is string => Boolean(url));

  for (const toolCall of data.choices?.[0]?.message?.tool_calls ?? []) {
    const rawArguments = toolCall.function?.arguments;
    if (!rawArguments) {
      continue;
    }
    try {
      const parsed = JSON.parse(rawArguments) as {
        search_results?: Array<{ url?: string }>;
        url?: string;
      };
      if (typeof parsed.url === "string" && parsed.url.trim()) {
        citations.push(parsed.url.trim());
      }
      for (const result of parsed.search_results ?? []) {
        if (typeof result.url === "string" && result.url.trim()) {
          citations.push(result.url.trim());
        }
      }
    } catch {
      // ignore malformed tool arguments
    }
  }

  return [...new Set(citations)];
}

function buildKimiToolResultContent(data: KimiSearchResponse): string {
  return JSON.stringify({
    search_results: (data.search_results ?? []).map((entry) => ({
      title: entry.title ?? "",
      url: entry.url ?? "",
      content: entry.content ?? "",
    })),
  });
}

async function runKimiSearch(params: {
  query: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutSeconds: number;
}): Promise<{ content: string; citations: string[] }> {
  const baseUrl = params.baseUrl.trim().replace(/\/$/, "");
  const endpoint = `${baseUrl}/chat/completions`;
  const messages: Array<Record<string, unknown>> = [
    {
      role: "user",
      content: params.query,
    },
  ];
  const collectedCitations = new Set<string>();
  const MAX_ROUNDS = 3;

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const nextResult = await withTrustedWebSearchEndpoint(
      {
        url: endpoint,
        timeoutSeconds: params.timeoutSeconds,
        init: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${params.apiKey}`,
          },
          body: JSON.stringify({
            model: params.model,
            messages,
            tools: [KIMI_WEB_SEARCH_TOOL],
          }),
        },
      },
      async (
        res,
      ): Promise<{ done: true; content: string; citations: string[] } | { done: false }> => {
        if (!res.ok) {
          return await throwWebSearchApiError(res, "Kimi");
        }

        const data = (await res.json()) as KimiSearchResponse;
        for (const citation of extractKimiCitations(data)) {
          collectedCitations.add(citation);
        }
        const choice = data.choices?.[0];
        const message = choice?.message;
        const text = extractKimiMessageText(message);
        const toolCalls = message?.tool_calls ?? [];

        if (choice?.finish_reason !== "tool_calls" || toolCalls.length === 0) {
          return { done: true, content: text ?? "No response", citations: [...collectedCitations] };
        }

        messages.push({
          role: "assistant",
          content: message?.content ?? "",
          ...(message?.reasoning_content
            ? {
                reasoning_content: message.reasoning_content,
              }
            : {}),
          tool_calls: toolCalls,
        });

        const toolContent = buildKimiToolResultContent(data);
        let pushedToolResult = false;
        for (const toolCall of toolCalls) {
          const toolCallId = toolCall.id?.trim();
          if (!toolCallId) {
            continue;
          }
          pushedToolResult = true;
          messages.push({
            role: "tool",
            tool_call_id: toolCallId,
            content: toolContent,
          });
        }

        if (!pushedToolResult) {
          return { done: true, content: text ?? "No response", citations: [...collectedCitations] };
        }

        return { done: false };
      },
    );

    if (nextResult.done) {
      return { content: nextResult.content, citations: nextResult.citations };
    }
  }

  return {
    content: "Search completed but no final answer was produced.",
    citations: [...collectedCitations],
  };
}

async function runWebSearch(params: {
  query: string;
  count: number;
  apiKey: string;
  timeoutSeconds: number;
  cacheTtlMs: number;
  provider: (typeof SEARCH_PROVIDERS)[number];
  country?: string;
  search_lang?: string;
  ui_lang?: string;
  freshness?: string;
  perplexityBaseUrl?: string;
  perplexityModel?: string;
  grokModel?: string;
  grokInlineCitations?: boolean;
  geminiModel?: string;
  kimiBaseUrl?: string;
  kimiModel?: string;
  cometMcpServerName?: string;
  cometMcpMode?: CometMcpMode;
  cometMcpTimeoutMs?: number;
  cometFallbackToBrave?: boolean;
  braveFallbackApiKey?: string;
}): Promise<Record<string, unknown>> {
  const cacheKey = normalizeCacheKey(
    params.provider === "brave"
      ? `${params.provider}:${params.query}:${params.count}:${params.country || "default"}:${params.search_lang || "default"}:${params.ui_lang || "default"}:${params.freshness || "default"}`
      : params.provider === "perplexity"
        ? `${params.provider}:${params.query}:${params.perplexityBaseUrl ?? DEFAULT_PERPLEXITY_BASE_URL}:${params.perplexityModel ?? DEFAULT_PERPLEXITY_MODEL}:${params.freshness || "default"}`
        : params.provider === "kimi"
          ? `${params.provider}:${params.query}:${params.kimiBaseUrl ?? DEFAULT_KIMI_BASE_URL}:${params.kimiModel ?? DEFAULT_KIMI_MODEL}`
          : params.provider === "comet_mcp"
            ? `${params.provider}:${params.query}:${params.count}:${params.cometMcpServerName ?? DEFAULT_COMET_MCP_SERVER_NAME}:${params.cometMcpMode ?? "search"}:${String(params.cometFallbackToBrave ?? false)}`
            : params.provider === "gemini"
              ? `${params.provider}:${params.query}:${params.geminiModel ?? DEFAULT_GEMINI_MODEL}`
              : `${params.provider}:${params.query}:${params.grokModel ?? DEFAULT_GROK_MODEL}:${String(params.grokInlineCitations ?? false)}`,
  );
  const cached = readCache(SEARCH_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  const start = Date.now();

  if (params.provider === "comet_mcp") {
    try {
      const cometResults = await runCometMcpSearch({
        query: params.query,
        count: params.count,
        serverName: params.cometMcpServerName ?? DEFAULT_COMET_MCP_SERVER_NAME,
        mode: params.cometMcpMode,
        timeoutMs: params.cometMcpTimeoutMs ?? Math.max(1_000, params.timeoutSeconds * 1_000),
      });

      const mapped = cometResults.map((entry) => ({
        title: entry.title ? wrapWebContent(entry.title, "web_search") : "",
        url: entry.url,
        description: entry.snippet ? wrapWebContent(entry.snippet, "web_search") : "",
        siteName: resolveSiteName(entry.url) || undefined,
      }));

      const payload = {
        query: params.query,
        provider: params.provider,
        count: mapped.length,
        tookMs: Date.now() - start,
        externalContent: {
          untrusted: true,
          source: "web_search",
          provider: params.provider,
          wrapped: true,
        },
        results: mapped,
      };
      writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
      return payload;
    } catch (error) {
      if (!params.cometFallbackToBrave) {
        throw error;
      }
      if (!params.braveFallbackApiKey) {
        throw new Error(
          `Comet MCP search failed (${error instanceof Error ? error.message : String(error)}). fallbackToBrave=true requires BRAVE_API_KEY or tools.web.search.apiKey.`,
          { cause: error },
        );
      }
      logVerbose(
        `web_search: comet_mcp failed; falling back to brave (${error instanceof Error ? error.message : String(error)})`,
      );
      return await runWebSearch({
        ...params,
        provider: "brave",
        apiKey: params.braveFallbackApiKey,
      });
    }
  }

  if (params.provider === "perplexity") {
    const { content, citations } = await runPerplexitySearch({
      query: params.query,
      apiKey: params.apiKey,
      baseUrl: params.perplexityBaseUrl ?? DEFAULT_PERPLEXITY_BASE_URL,
      model: params.perplexityModel ?? DEFAULT_PERPLEXITY_MODEL,
      timeoutSeconds: params.timeoutSeconds,
      freshness: params.freshness,
    });

    const payload = {
      query: params.query,
      provider: params.provider,
      model: params.perplexityModel ?? DEFAULT_PERPLEXITY_MODEL,
      tookMs: Date.now() - start,
      externalContent: {
        untrusted: true,
        source: "web_search",
        provider: params.provider,
        wrapped: true,
      },
      content: wrapWebContent(content),
      citations,
    };
    writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
    return payload;
  }

  if (params.provider === "grok") {
    const { content, citations, inlineCitations } = await runGrokSearch({
      query: params.query,
      apiKey: params.apiKey,
      model: params.grokModel ?? DEFAULT_GROK_MODEL,
      timeoutSeconds: params.timeoutSeconds,
      inlineCitations: params.grokInlineCitations ?? false,
    });

    const payload = {
      query: params.query,
      provider: params.provider,
      model: params.grokModel ?? DEFAULT_GROK_MODEL,
      tookMs: Date.now() - start,
      externalContent: {
        untrusted: true,
        source: "web_search",
        provider: params.provider,
        wrapped: true,
      },
      content: wrapWebContent(content),
      citations,
      inlineCitations,
    };
    writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
    return payload;
  }

  if (params.provider === "kimi") {
    const { content, citations } = await runKimiSearch({
      query: params.query,
      apiKey: params.apiKey,
      baseUrl: params.kimiBaseUrl ?? DEFAULT_KIMI_BASE_URL,
      model: params.kimiModel ?? DEFAULT_KIMI_MODEL,
      timeoutSeconds: params.timeoutSeconds,
    });

    const payload = {
      query: params.query,
      provider: params.provider,
      model: params.kimiModel ?? DEFAULT_KIMI_MODEL,
      tookMs: Date.now() - start,
      externalContent: {
        untrusted: true,
        source: "web_search",
        provider: params.provider,
        wrapped: true,
      },
      content: wrapWebContent(content),
      citations,
    };
    writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
    return payload;
  }

  if (params.provider === "gemini") {
    const geminiResult = await runGeminiSearch({
      query: params.query,
      apiKey: params.apiKey,
      model: params.geminiModel ?? DEFAULT_GEMINI_MODEL,
      timeoutSeconds: params.timeoutSeconds,
    });

    const payload = {
      query: params.query,
      provider: params.provider,
      model: params.geminiModel ?? DEFAULT_GEMINI_MODEL,
      tookMs: Date.now() - start, // Includes redirect URL resolution time
      externalContent: {
        untrusted: true,
        source: "web_search",
        provider: params.provider,
        wrapped: true,
      },
      content: wrapWebContent(geminiResult.content),
      citations: geminiResult.citations,
    };
    writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
    return payload;
  }

  if (params.provider !== "brave") {
    throw new Error("Unsupported web search provider.");
  }

  const url = new URL(BRAVE_SEARCH_ENDPOINT);
  url.searchParams.set("q", params.query);
  url.searchParams.set("count", String(params.count));
  if (params.country) {
    url.searchParams.set("country", params.country);
  }
  if (params.search_lang) {
    url.searchParams.set("search_lang", params.search_lang);
  }
  if (params.ui_lang) {
    url.searchParams.set("ui_lang", params.ui_lang);
  }
  if (params.freshness) {
    url.searchParams.set("freshness", params.freshness);
  }

  const mapped = await withTrustedWebSearchEndpoint(
    {
      url: url.toString(),
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": params.apiKey,
        },
      },
    },
    async (res) => {
      if (!res.ok) {
        const detailResult = await readResponseText(res, { maxBytes: 64_000 });
        const detail = detailResult.text;
        throw new Error(`Brave Search API error (${res.status}): ${detail || res.statusText}`);
      }

      const data = (await res.json()) as BraveSearchResponse;
      const results = Array.isArray(data.web?.results) ? (data.web?.results ?? []) : [];
      return results.map((entry) => {
        const description = entry.description ?? "";
        const title = entry.title ?? "";
        const url = entry.url ?? "";
        const rawSiteName = resolveSiteName(url);
        return {
          title: title ? wrapWebContent(title, "web_search") : "",
          url, // Keep raw for tool chaining
          description: description ? wrapWebContent(description, "web_search") : "",
          published: entry.age || undefined,
          siteName: rawSiteName || undefined,
        };
      });
    },
  );

  const payload = {
    query: params.query,
    provider: params.provider,
    count: mapped.length,
    tookMs: Date.now() - start,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: params.provider,
      wrapped: true,
    },
    results: mapped,
  };
  writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
  return payload;
}

export function createWebSearchTool(options?: {
  config?: OpenClawConfig;
  sandboxed?: boolean;
}): AnyAgentTool | null {
  const search = resolveSearchConfig(options?.config);
  if (!resolveSearchEnabled({ search, sandboxed: options?.sandboxed })) {
    return null;
  }

  const provider = resolveSearchProvider(search);
  const perplexityConfig = resolvePerplexityConfig(search);
  const grokConfig = resolveGrokConfig(search);
  const geminiConfig = resolveGeminiConfig(search);
  const kimiConfig = resolveKimiConfig(search);
  const cometMcpConfig = resolveCometMcpConfig(search);

  const description =
    provider === "perplexity"
      ? "Search the web using Perplexity Sonar (direct or via OpenRouter). Returns AI-synthesized answers with citations from real-time web search."
      : provider === "grok"
        ? "Search the web using xAI Grok. Returns AI-synthesized answers with citations from real-time web search."
        : provider === "kimi"
          ? "Search the web using Kimi by Moonshot. Returns AI-synthesized answers with citations from native $web_search."
          : provider === "comet_mcp"
            ? "Search the web using Comet MCP via an MCP bridge. Returns normalized title/url/snippet results from delegated Comet browsing."
            : provider === "gemini"
              ? "Search the web using Gemini with Google Search grounding. Returns AI-synthesized answers with citations from Google Search."
              : "Search the web using Brave Search API. Supports region-specific and localized search via country and language parameters. Returns titles, URLs, and snippets for fast research.";

  return {
    label: "Web Search",
    name: "web_search",
    description,
    parameters: WebSearchSchema,
    execute: async (_toolCallId, args) => {
      const braveApiKey = resolveSearchApiKey(search);
      const perplexityAuth =
        provider === "perplexity" ? resolvePerplexityApiKey(perplexityConfig) : undefined;
      const apiKey =
        provider === "perplexity"
          ? perplexityAuth?.apiKey
          : provider === "grok"
            ? resolveGrokApiKey(grokConfig)
            : provider === "kimi"
              ? resolveKimiApiKey(kimiConfig)
              : provider === "gemini"
                ? resolveGeminiApiKey(geminiConfig)
                : provider === "comet_mcp"
                  ? undefined
                  : braveApiKey;

      if (provider !== "comet_mcp" && !apiKey) {
        return jsonResult(missingSearchKeyPayload(provider));
      }
      const params = args as Record<string, unknown>;
      const query = readStringParam(params, "query", { required: true });
      const count =
        readNumberParam(params, "count", { integer: true }) ?? search?.maxResults ?? undefined;
      const country = readStringParam(params, "country");
      const rawSearchLang = readStringParam(params, "search_lang");
      const rawUiLang = readStringParam(params, "ui_lang");
      const normalizedBraveLanguageParams =
        provider === "brave"
          ? normalizeBraveLanguageParams({ search_lang: rawSearchLang, ui_lang: rawUiLang })
          : { search_lang: rawSearchLang, ui_lang: rawUiLang };
      if (normalizedBraveLanguageParams.invalidField === "search_lang") {
        return jsonResult({
          error: "invalid_search_lang",
          message:
            "search_lang must be a 2-letter ISO language code like 'en' (not a locale like 'en-US').",
          docs: "https://docs.openclaw.ai/tools/web",
        });
      }
      if (normalizedBraveLanguageParams.invalidField === "ui_lang") {
        return jsonResult({
          error: "invalid_ui_lang",
          message: "ui_lang must be a language-region locale like 'en-US'.",
          docs: "https://docs.openclaw.ai/tools/web",
        });
      }
      const search_lang = normalizedBraveLanguageParams.search_lang;
      const ui_lang = normalizedBraveLanguageParams.ui_lang;
      const rawFreshness = readStringParam(params, "freshness");
      if (rawFreshness && provider !== "brave" && provider !== "perplexity") {
        return jsonResult({
          error: "unsupported_freshness",
          message: "freshness is only supported by the Brave and Perplexity web_search providers.",
          docs: "https://docs.openclaw.ai/tools/web",
        });
      }
      const freshness = rawFreshness ? normalizeFreshness(rawFreshness) : undefined;
      if (rawFreshness && !freshness) {
        return jsonResult({
          error: "invalid_freshness",
          message:
            "freshness must be one of pd, pw, pm, py, or a range like YYYY-MM-DDtoYYYY-MM-DD.",
          docs: "https://docs.openclaw.ai/tools/web",
        });
      }
      const timeoutSeconds = resolveTimeoutSeconds(search?.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS);
      const result = await runWebSearch({
        query,
        count: resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
        apiKey: apiKey ?? "",
        timeoutSeconds,
        cacheTtlMs: resolveCacheTtlMs(search?.cacheTtlMinutes, DEFAULT_CACHE_TTL_MINUTES),
        provider,
        country,
        search_lang,
        ui_lang,
        freshness,
        perplexityBaseUrl: resolvePerplexityBaseUrl(
          perplexityConfig,
          perplexityAuth?.source,
          perplexityAuth?.apiKey,
        ),
        perplexityModel: resolvePerplexityModel(perplexityConfig),
        grokModel: resolveGrokModel(grokConfig),
        grokInlineCitations: resolveGrokInlineCitations(grokConfig),
        geminiModel: resolveGeminiModel(geminiConfig),
        kimiBaseUrl: resolveKimiBaseUrl(kimiConfig),
        kimiModel: resolveKimiModel(kimiConfig),
        cometMcpServerName: resolveCometMcpServerName(cometMcpConfig),
        cometMcpMode: resolveCometMcpMode(cometMcpConfig),
        cometMcpTimeoutMs: resolveCometMcpTimeoutMs(cometMcpConfig, timeoutSeconds),
        cometFallbackToBrave: resolveCometFallbackToBrave(cometMcpConfig),
        braveFallbackApiKey: braveApiKey,
      });
      return jsonResult(result);
    },
  };
}

export const __testing = {
  resolveSearchProvider,
  inferPerplexityBaseUrlFromApiKey,
  resolvePerplexityBaseUrl,
  isDirectPerplexityBaseUrl,
  resolvePerplexityRequestModel,
  normalizeBraveLanguageParams,
  normalizeFreshness,
  freshnessToPerplexityRecency,
  resolveGrokApiKey,
  resolveGrokModel,
  resolveGrokInlineCitations,
  extractGrokContent,
  resolveKimiApiKey,
  resolveKimiModel,
  resolveKimiBaseUrl,
  extractKimiCitations,
  resolveRedirectUrl,
} as const;

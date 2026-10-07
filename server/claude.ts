import Anthropic from "@anthropic-ai/sdk";
import type { BetaContentBlock, BetaMessage, BetaToolRunnerParams } from "@anthropic-ai/sdk/resources/beta/messages";

// Per-model request settings. Models differ in what they accept (thinking modes, effort,
// server-side fallbacks), so unknown model ids get the plainest request that works everywhere.

type Effort = "low" | "medium" | "high";

// Models that return short progress notes between tool calls with display: "updates".
// We show those notes as the speech bubbles above workers' heads.
const PROGRESS_UPDATE_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-fable-5"]);
const ADAPTIVE_THINKING_MODELS = new Set([
  ...PROGRESS_UPDATE_MODELS,
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
]);
// Models that accept `fallbacks: "default"`: if a safety classifier declines a request, the API
// retries it on Anthropic's recommended fallback model instead of returning a refusal.
const DEFAULT_FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

export function modelParams(model: string, effort: Effort): Pick<
  BetaToolRunnerParams,
  "model" | "betas" | "thinking" | "output_config" | "fallbacks"
> {
  const betas: string[] = [];
  const params: ReturnType<typeof modelParams> = { model };

  if (PROGRESS_UPDATE_MODELS.has(model)) {
    params.thinking = { type: "adaptive", display: "updates" };
    betas.push("thinking-display-updates-2026-08-18");
  } else if (ADAPTIVE_THINKING_MODELS.has(model)) {
    params.thinking = { type: "adaptive" };
  }
  if (ADAPTIVE_THINKING_MODELS.has(model)) params.output_config = { effort };
  if (DEFAULT_FALLBACK_MODELS.has(model)) {
    params.fallbacks = "default";
    betas.push("server-side-fallback-2026-07-01");
  }
  if (betas.length) params.betas = betas;
  return params;
}

/**
 * The status line for one finished content block: a progress note, or a description of a tool
 * call. Returns null for blocks that aren't worth showing.
 */
export function blockActivity(
  block: BetaContentBlock,
  describeTool: (name: string, input: unknown) => string | null,
): string | null {
  if (block.type === "thinking") return block.thinking.trim() || null;
  if (block.type === "tool_use") return describeTool(block.name, block.input);
  if (block.type === "server_tool_use") {
    return block.name === "web_search" ? "🔎 Searching the web" : "🌐 Reading a web page";
  }
  return null;
}

export function finalText(message: BetaMessage | undefined): string {
  if (!message) return "";
  return message.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

/** A one-line, boss-friendly explanation of an API failure. */
export function explainError(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) return "Your API key was rejected. Check it in Settings.";
  if (error instanceof Anthropic.PermissionDeniedError) return "This API key isn't allowed to use that model.";
  if (error instanceof Anthropic.NotFoundError) return "That model wasn't found. Pick another one in Settings.";
  if (error instanceof Anthropic.RateLimitError) return "Rate limited by the API. Try again in a moment.";
  if (error instanceof Anthropic.BadRequestError) return `The API rejected the request: ${error.message}`;
  if (error instanceof Anthropic.APIConnectionError) return "Couldn't reach the Claude API. Check your connection.";
  if (error instanceof Anthropic.APIError) return `Claude API error (${error.status ?? "unknown"}): ${error.message}`;
  if (error instanceof Error && error.name === "AbortError") return "Cancelled.";
  return error instanceof Error ? error.message : String(error);
}

export function shorten(text: string, max = 140) {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

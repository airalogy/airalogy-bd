import type { AiSettings } from "./ai-types";
export type TokenUsage = { inputTokens: number; outputTokens: number; cachedTokens: number };
export function parseTokenUsage(value: unknown): TokenUsage | null {
  if (!value || typeof value !== "object") return null;
  const usage = value as Record<string, unknown>;
  const details = usage.prompt_tokens_details as Record<string, unknown> | undefined;
  const input = usage.prompt_tokens, output = usage.completion_tokens, cached = details?.cached_tokens ?? 0;
  if (![input, output, cached].every(n => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= 1_000_000_000)) return null;
  if (Number(cached) > Number(input)) return null;
  return { inputTokens: Number(input), outputTokens: Number(output), cachedTokens: Number(cached) };
}
export type TokenPrices = Pick<AiSettings, "inputPriceCny" | "cachedInputPriceCny" | "outputPriceCny">;
export function estimateCost(usage: TokenUsage, prices: TokenPrices): number | null {
  if (prices.inputPriceCny === null || prices.outputPriceCny === null) return null;
  return ((usage.inputTokens - usage.cachedTokens) * prices.inputPriceCny + usage.cachedTokens * (prices.cachedInputPriceCny ?? prices.inputPriceCny) + usage.outputTokens * prices.outputPriceCny) / 1_000_000;
}

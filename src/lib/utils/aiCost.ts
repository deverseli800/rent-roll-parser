import type { AIUsage } from '../parsers/aiClient';

/**
 * API cost estimation from per-call usage records.
 *
 * Rates are USD per million tokens, from
 * https://platform.claude.com/docs/en/about-claude/pricing (fetched 2026-10-04).
 * `input` covers uncached input tokens; cache writes are the 5-minute
 * ephemeral tier (1.25x input) — the only tier this app uses; cache reads are
 * 0.1x input except where a model is discounted further (Fable 5.1: 0.025x,
 * Opus 5.5: 0.05x). `input_tokens` from the API is already the uncached
 * remainder, so the four buckets are disjoint and simply sum.
 *
 * Rows for models no longer in the ladder stay so that saved extractions which
 * ran on them still price correctly.
 */
interface ModelRates {
  input: number;
  cacheWrite5m: number;
  cacheRead: number;
  output: number;
}

/**
 * Model-id substring lookup (API model ids may carry suffixes). Order matters:
 * a point release must be tested before its base id ('fable-5-1' contains
 * 'fable-5', 'opus-5-5' contains 'opus-5').
 */
function ratesFor(model: string): ModelRates | null {
  const m = model.toLowerCase();
  if (m.includes('fable-5-1') || m.includes('mythos-5-1')) {
    return { input: 10, cacheWrite5m: 12.5, cacheRead: 0.25, output: 50 };
  }
  if (m.includes('fable-5') || m.includes('mythos-5')) {
    return { input: 10, cacheWrite5m: 12.5, cacheRead: 1, output: 50 };
  }
  if (m.includes('opus-5-5')) {
    return { input: 4, cacheWrite5m: 5, cacheRead: 0.2, output: 20 };
  }
  if (m.includes('opus-5') || /opus-4-[5-8]/.test(m)) {
    return { input: 5, cacheWrite5m: 6.25, cacheRead: 0.5, output: 25 };
  }
  if (m.includes('sonnet-5')) {
    // Covers both 5 and 5.5.
    return { input: 2, cacheWrite5m: 2.5, cacheRead: 0.2, output: 10 };
  }
  if (m.includes('sonnet-4')) {
    return { input: 3, cacheWrite5m: 3.75, cacheRead: 0.3, output: 15 };
  }
  if (m.includes('haiku-4-5')) {
    return { input: 1, cacheWrite5m: 1.25, cacheRead: 0.1, output: 5 };
  }
  return null;
}

/**
 * Total estimated USD cost across per-call usage records, cache-aware.
 * Returns null only when NO call had a priceable model (unknown models are
 * skipped with a warning rather than silently under-reporting the rest).
 */
export function estimateCostUSD(usages: AIUsage[]): number | null {
  let total = 0;
  let priced = false;
  for (const u of usages) {
    const rates = ratesFor(u.modelUsed);
    if (!rates) {
      if (u.inputTokens > 0 || u.outputTokens > 0) {
        console.warn(`[aiCost] no pricing for model "${u.modelUsed}" — excluded from cost estimate`);
      }
      continue;
    }
    priced = true;
    total +=
      (u.inputTokens * rates.input +
        (u.cacheCreationInputTokens ?? 0) * rates.cacheWrite5m +
        (u.cacheReadInputTokens ?? 0) * rates.cacheRead +
        u.outputTokens * rates.output) / 1_000_000;
  }
  return priced ? total : null;
}

/** "$0.0042" for sub-cent amounts, "$0.42" / "$12.40" otherwise. */
export function formatUSD(cost: number | null | undefined): string {
  if (cost === null || cost === undefined) return '—';
  return cost > 0 && cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
}

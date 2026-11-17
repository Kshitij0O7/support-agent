// Estimated cost of one model call, from the token usage the API returns.
// Prices are Anthropic's published USD rates per 1M tokens (5-minute cache).
// Used by the run log and the eval, so "cost per 100 tickets" comes from real usage.

const PRICES = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
};

/** USD, or null when the model's price is unknown or there was no call. */
export function estimateCostUsd(model, usage) {
  const price = PRICES[model];
  if (!price || !usage) return null;
  return (
    ((usage.input_tokens ?? 0) * price.input +
      (usage.output_tokens ?? 0) * price.output +
      (usage.cache_read_input_tokens ?? 0) * price.cacheRead +
      (usage.cache_creation_input_tokens ?? 0) * price.cacheWrite) /
    1e6
  );
}

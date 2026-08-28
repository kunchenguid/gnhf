export function formatTokens(count: number): string {
  if (count >= 1_000_000_000_000) {
    return `${(count / 1_000_000_000_000).toFixed(1)}T`;
  }
  if (count >= 1_000_000_000) {
    return `${(count / 1_000_000_000).toFixed(1)}B`;
  }
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 1_000) {
    return `${Math.round(count / 1_000)}K`;
  }
  return String(count);
}

export function getTotalTokenCount(
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheCreationTokens = 0,
): number {
  return inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;
}

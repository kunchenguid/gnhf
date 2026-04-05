const JSON_FENCE_RE = /```(?:json)?\s*\n([\s\S]*?)\n\s*```/;
const TRAILING_JSON_RE = /\{[\s\S]*\}\s*$/;

export function extractJson(text: string): string {
  const fenceMatch = text.match(JSON_FENCE_RE);
  if (fenceMatch) return fenceMatch[1];
  const trailingMatch = text.match(TRAILING_JSON_RE);
  if (trailingMatch) return trailingMatch[0];
  return text;
}

/**
 * Helpers for pulling a JSON object out of an agent's final assistant message.
 *
 * Agents are instructed to return JSON only, but several (rovodev, ACP targets)
 * sometimes prepend prose or wrap the JSON in markdown fences. These helpers
 * recover the structured payload in those cases without changing behaviour for
 * the well-formed pure-JSON path.
 */

export function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;

  const withoutOpen = trimmed.replace(/^```(?:json)?\s*\n?/, "");
  return withoutOpen.replace(/\n?```\s*$/, "").trim();
}

/**
 * Walk forward from `start` (which must be `{`) and return the substring of
 * the first balanced JSON object, or null if no balanced object is found.
 * Tracks string state and escape sequences so braces inside strings don't
 * affect depth.
 */
export function tryExtractBalancedObject(
  text: string,
  start: number,
): string | null {
  if (text[start] !== "{") return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try {
          JSON.parse(candidate);
          return candidate;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Look for a balanced JSON object inside `text`, preferring the rightmost one
 * (since the agent is supposed to end the message with the structured answer).
 */
export function extractLastJsonObject(
  text: string,
  accepts?: (value: unknown) => boolean,
): string | null {
  let cursor = text.lastIndexOf("{");
  while (cursor >= 0) {
    const candidate = tryExtractBalancedObject(text, cursor);
    if (candidate !== null) {
      if (!accepts) return candidate;
      try {
        if (accepts(JSON.parse(candidate))) return candidate;
      } catch {
        // Keep scanning earlier objects when a candidate is not valid JSON.
      }
    }
    cursor = text.lastIndexOf("{", cursor - 1);
  }
  return null;
}

export function parseAgentJson(
  text: string,
  accepts?: (value: unknown) => boolean,
): unknown | null {
  const cleaned = stripJsonFences(text);
  if (!cleaned) return null;
  try {
    const parsed = JSON.parse(cleaned);
    if (!accepts || accepts(parsed)) return parsed;
    return null;
  } catch {
    // fall through to extraction
  }
  const extracted = extractLastJsonObject(cleaned, accepts);
  if (!extracted) return null;
  try {
    return JSON.parse(extracted);
  } catch {
    return null;
  }
}

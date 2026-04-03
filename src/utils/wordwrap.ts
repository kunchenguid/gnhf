import {
  graphemeWidth,
  splitGraphemes,
  stringWidth,
} from "./terminal-width.js";

function sliceToWidth(text: string, width: number): string {
  let result = "";
  let currentWidth = 0;

  for (const grapheme of splitGraphemes(text)) {
    const nextWidth = currentWidth + graphemeWidth(grapheme);
    if (nextWidth > width) break;
    result += grapheme;
    currentWidth = nextWidth;
  }

  return result;
}

function splitByWidth(text: string, width: number): string[] {
  const lines: string[] = [];
  let current = "";
  let currentWidth = 0;

  for (const grapheme of splitGraphemes(text)) {
    const glyphWidth = graphemeWidth(grapheme);
    if (current && currentWidth + glyphWidth > width) {
      lines.push(current);
      current = grapheme;
      currentWidth = glyphWidth;
      continue;
    }

    current += grapheme;
    currentWidth += glyphWidth;
  }

  if (current) lines.push(current);
  return lines;
}

export function wordWrap(
  text: string,
  width: number,
  maxLines?: number,
): string[] {
  if (!text) return [];

  const lines: string[] = [];

  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let current = "";
    let currentWidth = 0;

    for (const word of words) {
      const wordWidth = stringWidth(word);

      if (wordWidth > width) {
        if (current) {
          lines.push(current);
          current = "";
          currentWidth = 0;
        }
        for (const slice of splitByWidth(word, width)) {
          lines.push(slice);
        }
        continue;
      }

      const nextWidth = current ? currentWidth + 1 + wordWidth : wordWidth;
      if (current && nextWidth > width) {
        lines.push(current);
        current = word;
        currentWidth = wordWidth;
      } else {
        current = current ? current + " " + word : word;
        currentWidth = nextWidth;
      }
    }
    if (current) lines.push(current);
  }

  if (maxLines && lines.length > maxLines) {
    const capped = lines.slice(0, maxLines);
    const last = capped[maxLines - 1];
    capped[maxLines - 1] =
      stringWidth(last) >= width
        ? sliceToWidth(last, width - 1) + "…"
        : last + "…";
    return capped;
  }

  return lines;
}

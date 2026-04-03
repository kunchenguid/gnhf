const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

const MARK_REGEX = /\p{Mark}/u;
const REGIONAL_INDICATOR_REGEX = /\p{Regional_Indicator}/u;
const EXTENDED_PICTOGRAPHIC_REGEX = /\p{Extended_Pictographic}/u;

function isFullWidthCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0x3247 && codePoint !== 0x303f) ||
      (codePoint >= 0x3250 && codePoint <= 0x4dbf) ||
      (codePoint >= 0x4e00 && codePoint <= 0xa4c6) ||
      (codePoint >= 0xa960 && codePoint <= 0xa97c) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6b) ||
      (codePoint >= 0xff01 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1b000 && codePoint <= 0x1b001) ||
      (codePoint >= 0x1f200 && codePoint <= 0x1f251) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  );
}

function codePointWidth(codePoint: number): number {
  if (
    codePoint === 0 ||
    codePoint === 0x200c ||
    codePoint === 0x200d ||
    codePoint === 0xfe0e ||
    codePoint === 0xfe0f
  ) {
    return 0;
  }

  if (MARK_REGEX.test(String.fromCodePoint(codePoint))) return 0;
  return isFullWidthCodePoint(codePoint) ? 2 : 1;
}

function isWideEmojiGrapheme(grapheme: string): boolean {
  return (
    grapheme.includes("\u200d") ||
    grapheme.includes("\ufe0f") ||
    grapheme.includes("\u20e3") ||
    REGIONAL_INDICATOR_REGEX.test(grapheme) ||
    Array.from(grapheme).some((char) => EXTENDED_PICTOGRAPHIC_REGEX.test(char))
  );
}

export function splitGraphemes(text: string): string[] {
  return Array.from(graphemeSegmenter.segment(text), ({ segment }) => segment);
}

export function graphemeWidth(grapheme: string): number {
  if (!grapheme) return 0;
  if (isWideEmojiGrapheme(grapheme)) return 2;

  let width = 0;
  for (const char of grapheme) {
    width += codePointWidth(char.codePointAt(0) ?? 0);
  }
  return width;
}

export function stringWidth(text: string): number {
  let width = 0;
  for (const grapheme of splitGraphemes(text)) {
    width += graphemeWidth(grapheme);
  }
  return width;
}

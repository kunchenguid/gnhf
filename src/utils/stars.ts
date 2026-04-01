const STAR_CHARS = [
  "·",
  "·",
  "·",
  "·",
  "·",
  "·",
  "✧",
  "⋆",
  "⋆",
  "⋆",
  "°",
  "°",
] as const;

export interface Star {
  x: number;
  y: number;
  char: string;
  /** Random phase offset in radians */
  phase: number;
  /** Full cycle duration in ms (each star twinkles at its own speed) */
  period: number;
  /** The state this star shows most of the time */
  rest: StarState;
}

export type StarState = "bright" | "dim" | "hidden";

export function generateStarField(
  width: number,
  height: number,
  density: number,
  seed: number,
): Star[] {
  const stars: Star[] = [];
  let s = seed;
  const rand = () => {
    s = (s * 16807 + 0) % 2147483647;
    return s / 2147483647;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rand() < density) {
        const charIdx = Math.floor(rand() * STAR_CHARS.length);
        const r = rand();
        const rest: StarState =
          r < 0.15 ? "hidden" : r < 0.4 ? "dim" : "bright";
        stars.push({
          x,
          y,
          char: STAR_CHARS[charIdx],
          phase: rand() * Math.PI * 2,
          period: 10_000 + rand() * 15_000,
          rest,
        });
      }
    }
  }
  return stars;
}

export function getStarState(star: Star, now: number): StarState {
  const t =
    ((now % star.period) / star.period + star.phase / (Math.PI * 2)) % 1;
  // Outside the blink window → steady state
  if (t > 0.05) return star.rest;
  // bright/hidden share the same blink envelope: dim → opposite → dim
  if (star.rest === "bright" || star.rest === "hidden") {
    const opposite: StarState = star.rest === "bright" ? "hidden" : "bright";
    if (t > 0.0325) return "dim";
    if (t > 0.0175) return opposite;
    return "dim";
  }
  // dim rest → blink bright
  if (t > 0.025) return "bright";
  return "dim";
}

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
const MIN_METEOR_START_GAP_MS = 500;

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

export interface Meteor {
  x: number;
  y: number;
  length: number;
  phase: number;
  period: number;
  duration: number;
}

export interface MeteorCell {
  x: number;
  y: number;
  state: "bright" | "dim";
  char: string;
}

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

export function generateMeteorShower(
  width: number,
  height: number,
  count: number,
  seed: number,
): Meteor[] {
  if (width <= 0 || height <= 0 || count <= 0) return [];

  const meteors: Meteor[] = [];
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  const rand = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };

  for (let i = 0; i < count; i++) {
    const length = Math.min(height, 2 + ((i + Math.floor(rand() * 6)) % 6));
    const xMax = Math.max(1, width - length);
    const yMin = Math.max(0, length - 1);
    const yMaxExclusive = Math.max(yMin + 1, Math.ceil(height * 0.75));
    const ySpan = Math.max(1, yMaxExclusive - yMin);
    const period = 16_000 + rand() * 20_000;
    const duration = count >= 8 ? 3_000 + rand() * 600 : 900 + rand() * 500;
    meteors.push({
      x: Math.floor(rand() * xMax),
      y: yMin + Math.floor(rand() * ySpan),
      length,
      phase: i === 0 ? 0 : i * (MIN_METEOR_START_GAP_MS + 80) + rand() * 60,
      period,
      duration,
    });
  }

  return meteors;
}

export function getMeteorTrail(meteor: Meteor, now: number): MeteorCell[] {
  const elapsed = ((now - meteor.phase) % meteor.period) + meteor.period;
  const cycleTime = elapsed % meteor.period;
  if (cycleTime >= meteor.duration) return [];

  const step = Math.floor(cycleTime / 120);
  const cells: MeteorCell[] = [];
  for (let i = 0; i < meteor.length; i++) {
    cells.push({
      x: meteor.x - step + i,
      y: meteor.y + step - i,
      state: i === 0 ? "bright" : "dim",
      char: "╱",
    });
  }
  return cells;
}

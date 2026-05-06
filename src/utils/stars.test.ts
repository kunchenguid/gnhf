import { describe, it, expect } from "vitest";
import {
  generateMeteorShower,
  generateStarField,
  getMeteorTrail,
  getStarState,
} from "./stars.js";

describe("generateStarField", () => {
  it("returns an empty array for zero density", () => {
    const stars = generateStarField(80, 10, 0, 42);
    expect(stars).toEqual([]);
  });

  it("generates stars within bounds", () => {
    const width = 40;
    const height = 5;
    const stars = generateStarField(width, height, 0.1, 42);
    expect(stars.length).toBeGreaterThan(0);
    for (const star of stars) {
      expect(star.x).toBeGreaterThanOrEqual(0);
      expect(star.x).toBeLessThan(width);
      expect(star.y).toBeGreaterThanOrEqual(0);
      expect(star.y).toBeLessThan(height);
    }
  });

  it("assigns valid star characters", () => {
    const validChars = ["·", "✧", "⋆", "°"];
    const stars = generateStarField(80, 10, 0.05, 42);
    for (const star of stars) {
      expect(validChars).toContain(star.char);
    }
  });

  it("assigns phase in [0, 2π) and period in [10000, 25000)", () => {
    const stars = generateStarField(80, 10, 0.05, 42);
    for (const star of stars) {
      expect(star.phase).toBeGreaterThanOrEqual(0);
      expect(star.phase).toBeLessThan(Math.PI * 2);
      expect(star.period).toBeGreaterThanOrEqual(10_000);
      expect(star.period).toBeLessThan(25_000);
    }
  });

  it("is deterministic for the same seed", () => {
    const a = generateStarField(40, 5, 0.05, 99);
    const b = generateStarField(40, 5, 0.05, 99);
    expect(a).toEqual(b);
  });

  it("produces different fields for different seeds", () => {
    const a = generateStarField(40, 5, 0.05, 1);
    const b = generateStarField(40, 5, 0.05, 2);
    expect(a).not.toEqual(b);
  });
});

describe("getStarState", () => {
  const bright = {
    x: 0,
    y: 0,
    char: "·",
    phase: 0,
    period: 10_000,
    rest: "bright" as const,
  };

  it("returns rest state for most of the cycle", () => {
    expect(getStarState(bright, 5000)).toBe("bright");
    const dimStar = { ...bright, rest: "dim" as const };
    expect(getStarState(dimStar, 5000)).toBe("dim");
    const hiddenStar = { ...bright, rest: "hidden" as const };
    expect(getStarState(hiddenStar, 5000)).toBe("hidden");
  });

  it("bright star blinks to hidden during blink window", () => {
    // t = 250/10000 = 0.025, in hidden band (0.0175..0.0325)
    expect(getStarState(bright, 250)).toBe("hidden");
  });

  it("hidden star blinks to bright during blink window", () => {
    const hidden = { ...bright, rest: "hidden" as const };
    // t = 0.025, in bright band (0.0175..0.0325)
    expect(getStarState(hidden, 250)).toBe("bright");
  });

  it("dim star blinks to bright during blink window", () => {
    const dimStar = { ...bright, rest: "dim" as const };
    // t = 350/10000 = 0.035, in bright band (0.025..0.05)
    expect(getStarState(dimStar, 350)).toBe("bright");
  });

  it("respects the phase offset", () => {
    const shifted = { ...bright, phase: Math.PI };
    expect(getStarState(shifted, 5000)).toBe("dim");
  });
});

describe("generateMeteorShower", () => {
  it("keeps meteor start times at least 500ms apart", () => {
    const meteors = generateMeteorShower(120, 12, 10, 42);
    const phases = meteors.map((meteor) => meteor.phase).sort((a, b) => a - b);

    for (let i = 1; i < phases.length; i++) {
      expect(phases[i] - phases[i - 1]).toBeGreaterThanOrEqual(500);
    }
  });

  it("generates a wider variety of meteor lengths", () => {
    const meteors = generateMeteorShower(120, 12, 30, 42);
    const lengths = new Set(meteors.map((meteor) => meteor.length));

    expect(Math.min(...lengths)).toBeLessThanOrEqual(2);
    expect(Math.max(...lengths)).toBeGreaterThanOrEqual(6);
    expect(lengths.size).toBeGreaterThanOrEqual(4);
  });

  it("starts meteors within the top three quarters of the field", () => {
    const height = 20;
    const meteors = generateMeteorShower(120, height, 30, 42);
    const maxStartY = Math.ceil(height * 0.75);

    for (const meteor of meteors) {
      expect(meteor.y).toBeLessThan(maxStartY);
    }
  });

  it("allows meteor starts in the third quarter of the field", () => {
    const height = 20;
    const meteors = generateMeteorShower(120, height, 100, 42);
    const previousLimit = Math.ceil((height * 2) / 3);

    expect(meteors.some((meteor) => meteor.y >= previousLimit)).toBe(true);
  });

  it("does not generate headed meteors", () => {
    const meteors = generateMeteorShower(120, 12, 30, 42);

    expect(meteors.some((meteor) => "hasHead" in meteor)).toBe(false);
  });
});

describe("getMeteorTrail", () => {
  const meteor = {
    x: 10,
    y: 6,
    length: 6,
    phase: 0,
    period: 10_000,
    duration: 1_000,
  };

  it("renders every meteor cell as a clean streak", () => {
    const trail = getMeteorTrail(meteor, 0);

    expect(trail.every((cell) => cell.char === "╱")).toBe(true);
  });

  it("moves the meteor at least two cells within 300ms", () => {
    const start = getMeteorTrail(meteor, 0)[0];
    const later = getMeteorTrail(meteor, 300)[0];

    expect(start.x - later.x).toBeGreaterThanOrEqual(2);
    expect(later.y - start.y).toBeGreaterThanOrEqual(2);
  });
});

import type { CommitMessageConfig } from "./commit-message.js";
import { InvalidConfigError } from "./config-errors.js";

export function normalizeCommitMessageConfig(
  value: unknown,
): CommitMessageConfig | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidConfigError(
      `Invalid config value for commitMessage: expected an object`,
    );
  }

  const raw = value as Record<string, unknown>;
  if (raw.preset !== "angular") {
    throw new InvalidConfigError(
      `Invalid config value for commitMessage.preset: expected "angular"`,
    );
  }

  for (const key of Object.keys(raw)) {
    if (key !== "preset") {
      throw new InvalidConfigError(
        `Unsupported config key for commitMessage.${key}`,
      );
    }
  }

  return { preset: "angular" };
}

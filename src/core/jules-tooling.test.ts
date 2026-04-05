import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "./config.js";
import {
  getVisibleAgentNames,
  isJulesConfigured,
  maybePromptForJulesSetup,
} from "./jules-tooling.js";

function createConfig(overrides: Partial<Config> = {}): Config {
  return {
    agent: "claude",
    agentPathOverride: {},
    maxConsecutiveFailures: 3,
    preventSleep: true,
    ...overrides,
  };
}

describe("jules-tooling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("treats JULES_API_KEY as the Jules configuration signal", () => {
    expect(isJulesConfigured({})).toBe(false);
    expect(isJulesConfigured({ JULES_API_KEY: "   " })).toBe(false);
    expect(isJulesConfigured({ JULES_API_KEY: "secret" })).toBe(true);
  });

  it("hides jules from visible agent names when it is not configured", () => {
    expect(getVisibleAgentNames(createConfig(), {})).not.toContain("jules");
  });

  it("shows jules in visible agent names when it is configured", () => {
    expect(
      getVisibleAgentNames(createConfig(), { JULES_API_KEY: "secret" }),
    ).toContain("jules");
  });

  it("does not prompt when Jules is already configured", async () => {
    const ask = vi.fn();

    const result = await maybePromptForJulesSetup(
      createConfig(),
      { JULES_API_KEY: "secret" },
      true,
      { ask },
    );

    expect(ask).not.toHaveBeenCalled();
    expect(result).toEqual(createConfig());
  });

  it("does not prompt when stdin is not interactive", async () => {
    const ask = vi.fn();

    await maybePromptForJulesSetup(createConfig(), {}, false, { ask });

    expect(ask).not.toHaveBeenCalled();
  });

  it("prints setup guidance without enabling Jules when the user asks to set it up", async () => {
    const ask = vi.fn(async () => "y");
    const write = vi.fn();
    const saveConfig = vi.fn();

    const result = await maybePromptForJulesSetup(createConfig(), {}, true, {
      ask,
      write,
      saveConfig,
    });

    expect(write).toHaveBeenCalledWith(expect.stringContaining("JULES_API_KEY"));
    expect(saveConfig).not.toHaveBeenCalled();
    expect(result).toEqual(createConfig());
  });

  it("persists dismissal and keeps Jules hidden when the user dismisses setup", async () => {
    const ask = vi.fn(async () => "d");
    const saveConfig = vi.fn();

    const result = await maybePromptForJulesSetup(createConfig(), {}, true, {
      ask,
      saveConfig,
    });

    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        jules: { dismissed: true },
      }),
    );
    expect(result).toMatchObject({
      jules: { dismissed: true },
    });
    expect(getVisibleAgentNames(result, {})).not.toContain("jules");
  });

  it("does not prompt again after Jules setup was dismissed", async () => {
    const ask = vi.fn();

    await maybePromptForJulesSetup(
      createConfig({ jules: { dismissed: true } }),
      {},
      true,
      { ask },
    );

    expect(ask).not.toHaveBeenCalled();
  });
});

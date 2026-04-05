import { beforeEach, describe, expect, it, vi } from "vitest";
import { JulesClient, JulesRateLimitError } from "./jules-api.js";

const fetchMock = vi.fn();

describe("JulesClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("includes authorization when an API key is configured", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: "session-1", state: "queued", prompt: "x" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const client = new JulesClient({ apiKey: "secret", baseUrl: "https://example.test" });
    await client.getSession("session-1");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.test/sessions/session-1",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer secret",
        }),
      }),
    );
  });

  it("preserves request headers while adding authorization", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: "session-1", state: "queued", prompt: "x" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const client = new JulesClient({ apiKey: "secret", baseUrl: "https://example.test" });
    await client.createSession({ prompt: "ship it" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.test/sessions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          Authorization: "Bearer secret",
        }),
      }),
    );
  });

  it("throws a JulesRateLimitError with retryAfterMs on 429", async () => {
    fetchMock.mockResolvedValue(
      new Response("slow down", {
        status: 429,
        headers: { "Retry-After": "7" },
      }),
    );

    const client = new JulesClient({ baseUrl: "https://example.test" });

    await expect(client.getSession("session-1")).rejects.toMatchObject({
      name: "JulesRateLimitError",
      retryAfterMs: 7000,
    } satisfies Partial<JulesRateLimitError>);
  });

  it("falls back to statusText when an error body cannot be read", async () => {
    const response = {
      ok: false,
      status: 500,
      statusText: "Server exploded",
      headers: new Headers(),
      text: vi.fn(async () => {
        throw new Error("unreadable");
      }),
    } as unknown as Response;
    fetchMock.mockResolvedValue(response);

    const client = new JulesClient({ baseUrl: "https://example.test" });

    await expect(client.getActivities("session-1")).rejects.toThrow(
      "Jules API error (500): Server exploded",
    );
  });
});

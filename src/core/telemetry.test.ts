import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTelemetryClient,
  resolveTelemetryConfig,
  type TelemetryClient,
} from "./telemetry.js";

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function createFetchSpy(options: { delayMs?: number; throws?: Error } = {}): {
  fetch: typeof fetch;
  spy: ReturnType<typeof vi.fn>;
  requests: CapturedRequest[];
  release: () => void;
} {
  const requests: CapturedRequest[] = [];
  let resolveBlocking: (() => void) | null = null;

  const fetchImpl = vi.fn(
    async (url: string | URL | Request, init: RequestInit = {}) => {
      if (options.throws) throw options.throws;

      const headers: Record<string, string> = {};
      if (init.headers) {
        for (const [k, v] of Object.entries(
          init.headers as Record<string, string>,
        )) {
          headers[k] = v;
        }
      }
      requests.push({
        url: typeof url === "string" ? url : url.toString(),
        method: init.method ?? "GET",
        headers,
        body: init.body
          ? (JSON.parse(init.body as string) as unknown)
          : undefined,
      });

      if (options.delayMs !== undefined) {
        await new Promise<void>((resolve) => {
          resolveBlocking = resolve;
          setTimeout(resolve, options.delayMs);
        });
      }
      return new Response(null, { status: 200 });
    },
  );

  return {
    fetch: fetchImpl as unknown as typeof fetch,
    spy: fetchImpl,
    requests,
    release: () => resolveBlocking?.(),
  };
}

describe("resolveTelemetryConfig", () => {
  it("disables telemetry when GNHF_TELEMETRY=0", () => {
    const config = resolveTelemetryConfig({
      env: { GNHF_TELEMETRY: "0" },
      buildHost: "https://build.example",
      buildWebsiteID: "build-id",
    });
    expect(config.enabled).toBe(false);
  });

  it.each(["false", "off", "FALSE", "Off"])(
    "disables telemetry when GNHF_TELEMETRY=%s",
    (value) => {
      const config = resolveTelemetryConfig({
        env: { GNHF_TELEMETRY: value },
        buildHost: "https://build.example",
        buildWebsiteID: "build-id",
      });
      expect(config.enabled).toBe(false);
    },
  );

  it("disables when no website ID is configured", () => {
    const config = resolveTelemetryConfig({
      env: {},
      buildHost: "https://build.example",
      buildWebsiteID: "",
    });
    expect(config.enabled).toBe(false);
  });

  it("uses env vars over build-time defaults", () => {
    const config = resolveTelemetryConfig({
      env: {
        GNHF_UMAMI_HOST: "https://env.example",
        GNHF_UMAMI_WEBSITE_ID: "env-id",
      },
      buildHost: "https://build.example",
      buildWebsiteID: "build-id",
    });
    expect(config.enabled).toBe(true);
    expect(config.host).toBe("https://env.example");
    expect(config.websiteID).toBe("env-id");
  });

  it("falls back to build-time defaults when env vars are unset", () => {
    const config = resolveTelemetryConfig({
      env: {},
      buildHost: "https://build.example",
      buildWebsiteID: "build-id",
    });
    expect(config.enabled).toBe(true);
    expect(config.host).toBe("https://build.example");
    expect(config.websiteID).toBe("build-id");
  });

  it("falls back to the hard-coded host when neither env nor build provide it", () => {
    const config = resolveTelemetryConfig({
      env: { GNHF_UMAMI_WEBSITE_ID: "env-id" },
      buildHost: "",
      buildWebsiteID: "",
    });
    expect(config.enabled).toBe(true);
    expect(config.host).toBe("https://a.kunchenguid.com");
  });

  it("trims whitespace around env values", () => {
    const config = resolveTelemetryConfig({
      env: {
        GNHF_UMAMI_HOST: "  https://env.example  ",
        GNHF_UMAMI_WEBSITE_ID: "  env-id  ",
      },
      buildHost: "",
      buildWebsiteID: "",
    });
    expect(config.host).toBe("https://env.example");
    expect(config.websiteID).toBe("env-id");
  });
});

describe("TelemetryClient", () => {
  let client: TelemetryClient;

  afterEach(async () => {
    await client?.close(50);
  });

  it("sends an Umami /api/send POST with the expected payload shape", async () => {
    const { fetch, requests } = createFetchSpy();
    client = createTelemetryClient({
      enabled: true,
      host: "https://a.example.com",
      websiteID: "site-1",
      app: "gnhf",
      version: "1.2.3",
      platform: "darwin",
      arch: "arm64",
      fetch,
    });

    client.track("run", { agent: "claude", status: "success" });
    await client.close(500);

    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.url).toBe("https://a.example.com/api/send");
    expect(req.method).toBe("POST");
    expect(req.headers["Content-Type"]).toBe("application/json");
    expect(req.headers["User-Agent"]).toMatch(/^gnhf\/1\.2\.3 telemetry$/);

    const body = req.body as {
      type: string;
      payload: {
        website: string;
        hostname: string;
        title: string;
        url: string;
        name: string;
        data: Record<string, unknown>;
        timestamp: number;
      };
    };
    expect(body.type).toBe("event");
    expect(body.payload.website).toBe("site-1");
    expect(body.payload.hostname).toBe("cli");
    expect(body.payload.name).toBe("run");
    expect(body.payload.url).toBe("app://gnhf/run");
    expect(body.payload.data).toMatchObject({
      agent: "claude",
      status: "success",
    });
    expect(typeof body.payload.timestamp).toBe("number");
  });

  it("appends /api/send when host already has a path", async () => {
    const { fetch, requests } = createFetchSpy();
    client = createTelemetryClient({
      enabled: true,
      host: "https://a.example.com/umami/",
      websiteID: "site-1",
      app: "gnhf",
      version: "1.0.0",
      fetch,
    });

    client.track("run", {});
    await client.close(500);

    expect(requests[0]!.url).toBe("https://a.example.com/umami/api/send");
  });

  it("treats a host already ending in /api/send as the full endpoint", async () => {
    const { fetch, requests } = createFetchSpy();
    client = createTelemetryClient({
      enabled: true,
      host: "https://a.example.com/api/send",
      websiteID: "site-1",
      app: "gnhf",
      version: "1.0.0",
      fetch,
    });

    client.track("run", {});
    await client.close(500);

    expect(requests[0]!.url).toBe("https://a.example.com/api/send");
  });

  it("issues pageviews with the supplied path and no event name", async () => {
    const { fetch, requests } = createFetchSpy();
    client = createTelemetryClient({
      enabled: true,
      host: "https://a.example.com",
      websiteID: "site-1",
      app: "gnhf",
      version: "1.0.0",
      fetch,
    });

    client.pageview("/run", { agent: "codex" });
    await client.close(500);

    const body = requests[0]!.body as {
      payload: { url: string; name?: string };
    };
    expect(body.payload.url).toBe("/run");
    expect(body.payload.name).toBeFalsy();
  });

  it("does nothing when disabled", async () => {
    const { fetch, spy, requests } = createFetchSpy();
    client = createTelemetryClient({
      enabled: false,
      host: "https://a.example.com",
      websiteID: "site-1",
      app: "gnhf",
      version: "1.0.0",
      fetch,
    });

    client.track("run", { agent: "claude" });
    client.pageview("/run", {});
    await client.close(500);

    expect(spy).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
  });

  it("swallows fetch failures so callers never see them", async () => {
    const { fetch } = createFetchSpy({ throws: new Error("network down") });
    client = createTelemetryClient({
      enabled: true,
      host: "https://a.example.com",
      websiteID: "site-1",
      app: "gnhf",
      version: "1.0.0",
      fetch,
    });

    expect(() => client.track("run", {})).not.toThrow();
    await expect(client.close(500)).resolves.toBeUndefined();
  });

  it("close() waits for in-flight requests up to the timeout", async () => {
    const { fetch, requests, release } = createFetchSpy({ delayMs: 10_000 });
    client = createTelemetryClient({
      enabled: true,
      host: "https://a.example.com",
      websiteID: "site-1",
      app: "gnhf",
      version: "1.0.0",
      fetch,
    });

    client.track("run", {});
    const closePromise = client.close(20);
    await closePromise;
    expect(requests).toHaveLength(1);
    release();
  });

  it("ignores send calls after close()", async () => {
    const { fetch, spy, requests } = createFetchSpy();
    client = createTelemetryClient({
      enabled: true,
      host: "https://a.example.com",
      websiteID: "site-1",
      app: "gnhf",
      version: "1.0.0",
      fetch,
    });

    await client.close(50);
    client.track("run", {});
    expect(spy).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
  });
});

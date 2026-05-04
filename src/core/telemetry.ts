/**
 * Anonymous usage telemetry for gnhf, sent to a self-hosted Umami instance.
 *
 * The wire format mirrors no-mistakes' telemetry: POST /api/send with
 * { type: "event", payload: { website, hostname, title, url, name, data,
 * timestamp } }. Events use a synthetic "app://gnhf/<event>" URL so Umami
 * treats CLI events as distinct pages.
 *
 * Layering (highest wins): GNHF_TELEMETRY=0|false|off opt-out, then
 * GNHF_UMAMI_HOST/GNHF_UMAMI_WEBSITE_ID env vars, then build-time defaults
 * injected via tsdown's `define`, then a hard-coded host fallback.
 */

declare const __GNHF_UMAMI_HOST__: string;
declare const __GNHF_UMAMI_WEBSITE_ID__: string;

const HARDCODED_FALLBACK_HOST = "https://a.kunchenguid.com";
const UMAMI_PATH = "/api/send";
const DEFAULT_HOSTNAME = "cli";
const DEFAULT_TITLE = "gnhf CLI";
const DEFAULT_REQUEST_TIMEOUT_MS = 1_000;

export type TelemetryFields = Record<string, unknown>;

export interface TelemetryClient {
  track(name: string, fields?: TelemetryFields): void;
  pageview(path: string, fields?: TelemetryFields): void;
  close(timeoutMs?: number): Promise<void>;
}

export interface TelemetryClientConfig {
  enabled: boolean;
  host: string;
  websiteID: string;
  app: string;
  version: string;
  platform?: string;
  arch?: string;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
}

export interface ResolvedTelemetryConfig {
  enabled: boolean;
  host: string;
  websiteID: string;
}

interface ResolveInput {
  env: NodeJS.ProcessEnv;
  buildHost: string;
  buildWebsiteID: string;
}

export function resolveTelemetryConfig(
  input: ResolveInput,
): ResolvedTelemetryConfig {
  const optOut = (input.env.GNHF_TELEMETRY ?? "").trim().toLowerCase();
  if (optOut === "0" || optOut === "false" || optOut === "off") {
    return { enabled: false, host: "", websiteID: "" };
  }

  const websiteID =
    (input.env.GNHF_UMAMI_WEBSITE_ID ?? "").trim() ||
    input.buildWebsiteID.trim();
  if (!websiteID) {
    return { enabled: false, host: "", websiteID: "" };
  }

  const host =
    (input.env.GNHF_UMAMI_HOST ?? "").trim() ||
    input.buildHost.trim() ||
    HARDCODED_FALLBACK_HOST;

  return { enabled: true, host, websiteID };
}

export function getBuildTimeUmamiHost(): string {
  return typeof __GNHF_UMAMI_HOST__ === "string" ? __GNHF_UMAMI_HOST__ : "";
}

export function getBuildTimeUmamiWebsiteID(): string {
  return typeof __GNHF_UMAMI_WEBSITE_ID__ === "string"
    ? __GNHF_UMAMI_WEBSITE_ID__
    : "";
}

function normalizeEndpoint(host: string): string | null {
  let url: URL;
  try {
    url = new URL(host.trim());
  } catch {
    return null;
  }
  if (!url.protocol || !url.host) return null;

  const pathname = url.pathname.replace(/\/+$/, "");
  if (pathname.endsWith(UMAMI_PATH)) {
    url.pathname = pathname;
  } else {
    url.pathname = pathname + UMAMI_PATH;
  }
  return url.toString();
}

function eventURL(app: string, name: string): string {
  if (!name) return `app://${app}`;
  return `app://${app}/${name.replace(/\./g, "/")}`;
}

function normalizePagePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "/";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

class NoopClient implements TelemetryClient {
  track(): void {}
  pageview(): void {}
  async close(): Promise<void> {}
}

class HttpClient implements TelemetryClient {
  private readonly endpoint: string;
  private readonly websiteID: string;
  private readonly app: string;
  private readonly version: string;
  private readonly userAgent: string;
  private readonly platform: string;
  private readonly arch: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly inFlight = new Set<Promise<void>>();
  private closed = false;

  constructor(endpoint: string, config: TelemetryClientConfig) {
    this.endpoint = endpoint;
    this.websiteID = config.websiteID;
    this.app = config.app;
    this.version = config.version;
    this.userAgent = `${config.app}/${config.version} telemetry`;
    this.platform = config.platform ?? "";
    this.arch = config.arch ?? "";
    this.fetchImpl = config.fetch ?? fetch;
    this.timeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  track(name: string, fields: TelemetryFields = {}): void {
    if (this.closed) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    this.send(trimmed, eventURL(this.app, trimmed), fields);
  }

  pageview(path: string, fields: TelemetryFields = {}): void {
    if (this.closed) return;
    this.send("", normalizePagePath(path), fields);
  }

  async close(timeoutMs = 1_000): Promise<void> {
    this.closed = true;
    if (this.inFlight.size === 0) return;

    const drained = Promise.allSettled(Array.from(this.inFlight)).then(
      () => undefined,
    );
    if (timeoutMs <= 0) return;
    await Promise.race([
      drained,
      new Promise<void>((resolve) => {
        setTimeout(resolve, timeoutMs).unref?.();
      }),
    ]);
  }

  private send(name: string, url: string, fields: TelemetryFields): void {
    const data: Record<string, unknown> = { ...fields };
    if (this.platform && data.platform === undefined)
      data.platform = this.platform;
    if (this.arch && data.arch === undefined) data.arch = this.arch;
    if (data.version === undefined) data.version = this.version;

    const payload = {
      type: "event",
      payload: {
        website: this.websiteID,
        hostname: DEFAULT_HOSTNAME,
        title: DEFAULT_TITLE,
        url,
        name,
        data,
        timestamp: Math.floor(Date.now() / 1000),
      },
    };

    let body: string;
    try {
      body = JSON.stringify(payload);
    } catch {
      return;
    }

    const promise = this.fire(body);
    this.inFlight.add(promise);
    promise.finally(() => this.inFlight.delete(promise));
  }

  private async fire(body: string): Promise<void> {
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": this.userAgent,
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      // Drain the body so the connection can be reused.
      try {
        await response.body?.cancel?.();
      } catch {
        // Ignore.
      }
    } catch {
      // Telemetry is best-effort.
    }
  }
}

export function createTelemetryClient(
  config: TelemetryClientConfig,
): TelemetryClient {
  if (!config.enabled) return new NoopClient();
  const endpoint = normalizeEndpoint(config.host);
  if (!endpoint || !config.websiteID) return new NoopClient();
  return new HttpClient(endpoint, config);
}

let defaultClient: TelemetryClient | null = null;

export interface DefaultTelemetryInit {
  app: string;
  version: string;
  platform?: string;
  arch?: string;
  env?: NodeJS.ProcessEnv;
}

export function initDefaultTelemetry(
  init: DefaultTelemetryInit,
): TelemetryClient {
  const resolved = resolveTelemetryConfig({
    env: init.env ?? process.env,
    buildHost: getBuildTimeUmamiHost(),
    buildWebsiteID: getBuildTimeUmamiWebsiteID(),
  });
  defaultClient = createTelemetryClient({
    enabled: resolved.enabled,
    host: resolved.host,
    websiteID: resolved.websiteID,
    app: init.app,
    version: init.version,
    platform: init.platform,
    arch: init.arch,
  });
  return defaultClient;
}

export function getDefaultTelemetry(): TelemetryClient {
  return defaultClient ?? new NoopClient();
}

/** Test-only: reset the module-level singleton between tests. */
export function resetDefaultTelemetryForTests(): void {
  defaultClient = null;
}

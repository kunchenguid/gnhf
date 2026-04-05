const DEFAULT_BASE_URL = "https://jules.google.com/api/v1";

export interface JulesClientOptions {
  apiKey?: string;
  baseUrl?: string;
}

export interface JulesCreateSessionRequest {
  prompt: string;
  title?: string;
  sourceContext?: {
    source: string;
    githubRepoContext?: {
      startingBranch?: string;
    };
  };
  requirePlanApproval?: boolean;
  automationMode?: "AUTO_CREATE_PR" | "MANUAL";
}

export interface JulesSession {
  id: string;
  url?: string;
  state: string;
  prompt: string;
  title?: string;
  outputs?: Array<{
    pullRequest?: {
      url: string;
      title?: string;
    };
  }>;
}

export interface JulesActivity {
  type: string;
  changeSet?: {
    gitPatch?: {
      unidiffPatch: string;
      suggestedCommitMessage?: string;
    };
  };
}

export class JulesRateLimitError extends Error {
  constructor(
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "JulesRateLimitError";
  }
}

export class JulesClient {
  private baseUrl: string;
  private apiKey: string | undefined;

  constructor(options: JulesClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.apiKey = options.apiKey ?? process.env.JULES_API_KEY;
  }

  async createSession(
    request: JulesCreateSessionRequest,
  ): Promise<JulesSession> {
    const response = await this.fetchWithAuth("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw await this.parseError(response);
    }

    return (await response.json()) as JulesSession;
  }

  async getSession(sessionId: string): Promise<JulesSession> {
    const response = await this.fetchWithAuth(`/sessions/${sessionId}`);

    if (!response.ok) {
      throw await this.parseError(response);
    }

    return (await response.json()) as JulesSession;
  }

  async getActivities(sessionId: string): Promise<JulesActivity[]> {
    const response = await this.fetchWithAuth(
      `/sessions/${sessionId}/activities`,
    );

    if (!response.ok) {
      throw await this.parseError(response);
    }

    return (await response.json()) as JulesActivity[];
  }

  private async fetchWithAuth(
    path: string,
    init?: RequestInit,
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      ...((init?.headers as Record<string, string> | undefined) ?? {}),
    };

    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    return fetch(url, { ...init, headers });
  }

  private async parseError(response: Response): Promise<Error> {
    if (response.status === 429) {
      const retryAfter = response.headers.get("Retry-After");
      const retryAfterMs = retryAfter
        ? Number.parseInt(retryAfter, 10) * 1000
        : undefined;
      return new JulesRateLimitError(
        `Rate limited by Jules API (${response.status})`,
        retryAfterMs,
      );
    }

    let body: string | undefined;
    try {
      body = await response.text();
    } catch {
      // Ignore
    }

    return new Error(
      `Jules API error (${response.status}): ${body ?? response.statusText}`,
    );
  }
}

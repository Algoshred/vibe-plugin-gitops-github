/**
 * Thin REST + GraphQL client over GitHub's API. Pure HTTP — no shell.
 * - REST v3 base: https://api.github.com
 * - GraphQL v4:   https://api.github.com/graphql
 *
 * Handles:
 * - bearer auth from in-memory token (set on saveCredentials)
 * - 429 / 403 secondary-rate-limit retry with Retry-After
 * - pagination cursor extraction (Link header → next cursor)
 */

import { GitOpsError } from "./types.js";

export interface RateLimitState {
  remaining: number;
  resetAt: string;
}

const DEFAULT_BASE_REST = "https://api.github.com";
const DEFAULT_BASE_GQL = "https://api.github.com/graphql";

export interface ClientOptions {
  baseUrlRest?: string;
  baseUrlGraphql?: string;
  userAgent?: string;
}

export class GitHubClient {
  private token: string | null = null;
  private rateLimit: RateLimitState | null = null;
  private readonly baseRest: string;
  private readonly baseGql: string;
  private readonly userAgent: string;

  constructor(opts: ClientOptions = {}) {
    this.baseRest = opts.baseUrlRest ?? DEFAULT_BASE_REST;
    this.baseGql = opts.baseUrlGraphql ?? DEFAULT_BASE_GQL;
    this.userAgent =
      opts.userAgent ??
      "vibecontrols-gitops-github/0.1 (+https://vibecontrols.com)";
  }

  setToken(token: string | null): void {
    this.token = token;
  }

  hasToken(): boolean {
    return !!this.token;
  }

  getRateLimit(): RateLimitState | null {
    return this.rateLimit;
  }

  private updateRateLimit(headers: Headers): void {
    const remaining = headers.get("x-ratelimit-remaining");
    const reset = headers.get("x-ratelimit-reset");
    if (remaining && reset) {
      this.rateLimit = {
        remaining: parseInt(remaining, 10),
        resetAt: new Date(parseInt(reset, 10) * 1000).toISOString(),
      };
    }
  }

  private mapHttpError(status: number, body: string): GitOpsError {
    if (status === 401)
      return new GitOpsError("AUTH", "GitHub: unauthorized", {
        upstreamStatus: status,
      });
    if (status === 403) {
      if (/rate limit/i.test(body) || /api rate limit exceeded/i.test(body)) {
        return new GitOpsError("RATE_LIMITED", "GitHub: rate-limited", {
          upstreamStatus: status,
        });
      }
      return new GitOpsError("FORBIDDEN", "GitHub: forbidden", {
        upstreamStatus: status,
      });
    }
    if (status === 404)
      return new GitOpsError("NOT_FOUND", "GitHub: not found", {
        upstreamStatus: status,
      });
    if (status === 429)
      return new GitOpsError("RATE_LIMITED", "GitHub: too many requests", {
        upstreamStatus: status,
      });
    if (status >= 500)
      return new GitOpsError("UPSTREAM", "GitHub: " + status, {
        upstreamStatus: status,
      });
    return new GitOpsError(
      "UPSTREAM",
      "GitHub: " + status + " " + body.slice(0, 200),
      { upstreamStatus: status },
    );
  }

  private authHeaders(extra?: Record<string, string>): Headers {
    const h = new Headers({
      "User-Agent": this.userAgent,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(extra ?? {}),
    });
    if (this.token) h.set("Authorization", "Bearer " + this.token);
    return h;
  }

  async rest<T>(
    path: string,
    init?: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
    },
  ): Promise<{ data: T; headers: Headers }> {
    const url = path.startsWith("http") ? path : this.baseRest + path;
    const method = init?.method ?? "GET";

    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(url, {
        method,
        headers: this.authHeaders(init?.headers),
        body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
      this.updateRateLimit(res.headers);

      if (
        res.status === 429 ||
        (res.status === 403 && res.headers.get("retry-after"))
      ) {
        if (attempt === 0) {
          const retryAfter = parseInt(
            res.headers.get("retry-after") ?? "1",
            10,
          );
          await new Promise((r) =>
            setTimeout(r, Math.min(retryAfter, 5) * 1000),
          );
          continue;
        }
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw this.mapHttpError(res.status, text);
      }

      const ct = res.headers.get("content-type") ?? "";
      const data = (
        ct.includes("json") ? await res.json() : await res.text()
      ) as T;
      return { data, headers: res.headers };
    }

    throw new GitOpsError("RATE_LIMITED", "GitHub: exhausted retries");
  }

  async graphql<T>(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    const res = await fetch(this.baseGql, {
      method: "POST",
      headers: this.authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ query, variables }),
    });
    this.updateRateLimit(res.headers);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw this.mapHttpError(res.status, text);
    }
    const json = (await res.json()) as {
      data?: T;
      errors?: Array<{ message: string }>;
    };
    if (json.errors && json.errors.length > 0) {
      throw new GitOpsError(
        "UPSTREAM",
        "GitHub GraphQL: " + json.errors.map((e) => e.message).join("; "),
      );
    }
    if (!json.data) {
      throw new GitOpsError("UPSTREAM", "GitHub GraphQL: empty data");
    }
    return json.data;
  }

  parseNextLink(headers: Headers): string | null {
    const link = headers.get("link");
    if (!link) return null;
    const match = /<([^>]+)>;\s*rel="next"/.exec(link);
    return match?.[1] ?? null;
  }
}

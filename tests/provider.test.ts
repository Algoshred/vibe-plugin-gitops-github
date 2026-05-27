/**
 * Unit tests for GitHubProvider — mock the REST endpoints via globalThis.fetch.
 */
import { afterEach, beforeEach, describe, expect, test, mock } from "bun:test";

import { GitHubProvider } from "../src/provider.js";

type FetchInit = {
  method?: string;
  headers?: HeadersInit;
  body?: string;
};

interface MockResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function setupMockFetch(
  handler: (url: string, init?: FetchInit) => MockResponse,
) {
  const original = globalThis.fetch;
  globalThis.fetch = mock(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const r = handler(url, init as FetchInit | undefined);
      const headers = new Headers(r.headers ?? {});
      if (!headers.has("content-type"))
        headers.set("content-type", "application/json");
      return new Response(JSON.stringify(r.body ?? {}), {
        status: r.status ?? 200,
        headers,
      });
    },
  ) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function makeStorage() {
  const store = new Map<string, string>();
  return {
    storage: {
      get: async (_ns: string, key: string) => store.get(key) ?? null,
      set: async (_ns: string, key: string, value: string) => {
        store.set(key, String(value));
      },
      delete: async (_ns: string, key: string) => store.delete(key),
    },
  } as never;
}

describe("GitHubProvider", () => {
  let restore: () => void = () => {};

  beforeEach(() => {
    restore = () => {};
  });

  afterEach(() => restore());

  test("saveCredentials persists PAT + validates", async () => {
    restore = setupMockFetch((url) => {
      if (url.endsWith("/user")) {
        return {
          body: { login: "octocat" },
          headers: { "x-oauth-scopes": "repo, workflow, read:org" },
        };
      }
      return { body: {} };
    });
    const p = new GitHubProvider(makeStorage());
    await p.saveCredentials({ kind: "pat", token: "ghp_test" });
    const v = await p.validateCredentials();
    expect(v.ok).toBe(true);
    expect(v.account).toBe("octocat");
    expect(v.scopes).toContain("repo");
  });

  test("validateCredentials returns ok:false on 401", async () => {
    restore = setupMockFetch(() => ({
      status: 401,
      body: { message: "Bad credentials" },
    }));
    const p = new GitHubProvider(makeStorage());
    await p.saveCredentials({ kind: "pat", token: "ghp_bogus" });
    const v = await p.validateCredentials();
    expect(v.ok).toBe(false);
  });

  test("listRepos normalises payload", async () => {
    restore = setupMockFetch(() => ({
      body: [
        {
          full_name: "octocat/hello",
          private: false,
          visibility: "public",
          default_branch: "main",
          html_url: "https://github.com/octocat/hello",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-05-01T00:00:00Z",
          pushed_at: "2026-05-20T00:00:00Z",
          archived: false,
          fork: false,
        },
      ],
    }));
    const p = new GitHubProvider(makeStorage());
    await p.saveCredentials({ kind: "pat", token: "ghp_test" });
    const page = await p.listRepos({ org: "octocat", limit: 5 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.fqn).toBe("octocat/hello");
    expect(page.items[0]?.visibility).toBe("public");
    expect(page.items[0]?.provider).toBe("github");
  });

  test("pipelineAnalytics computes percentiles", async () => {
    const runs = Array.from({ length: 20 }, (_, i) => ({
      id: i + 1,
      name: "ci",
      head_branch: "main",
      status: "completed",
      conclusion: i % 4 === 0 ? "failure" : "success",
      run_started_at: "2026-05-01T00:00:00Z",
      updated_at: new Date(
        Date.parse("2026-05-01T00:00:00Z") + (i + 1) * 60_000,
      ).toISOString(),
      html_url: `https://github.com/octocat/hello/actions/runs/${i + 1}`,
    }));
    restore = setupMockFetch((url) => {
      if (url.includes("/actions/runs")) {
        return { body: { workflow_runs: runs } };
      }
      return { body: {} };
    });
    const p = new GitHubProvider(makeStorage());
    await p.saveCredentials({ kind: "pat", token: "ghp_test" });
    const a = await p.pipelineAnalytics("octocat/hello");
    expect(a.successRate).toBeGreaterThan(0.5);
    expect(a.durationP95).toBeGreaterThanOrEqual(a.durationP50);
    expect(a.totalRunsLast30Days).toBe(20);
  });
});

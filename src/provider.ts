/**
 * GitHubProvider — implements GitOpsProvider over the GitHub REST/GraphQL
 * APIs. Pure HTTP — no `gh` CLI dependency.
 *
 * Storage namespace: `gitops-github`
 *   - `pat:<workspaceId>` → encrypted PAT envelope (AES-GCM via Skalex)
 *
 * Caching: in-process 30s/60s TTLs to dampen UI polling storms.
 */

import type { HostServices } from "@vibecontrols/plugin-sdk/contract";
import { BoundLogger } from "@vibecontrols/plugin-sdk";

import { GitHubClient } from "./client.js";
import {
  mapBranch,
  mapCodeScanAlert,
  mapContributor,
  mapDependabotAlert,
  mapIssue,
  mapJob,
  mapPipeline,
  mapPullRequest,
  mapRepo,
  mapRun,
  mapSecretScanAlert,
  mapWebhook,
} from "./mappers.js";
import {
  GitOpsError,
  type AuthInput,
  type AuthValidation,
  type Branch,
  type Contributor,
  type Environment,
  type GitOpsProvider,
  type HealthSnapshot,
  type IssueSummary,
  type NormalisedRepo,
  type OrgRollup,
  type Pipeline,
  type PipelineAnalytics,
  type PipelineRun,
  type PullRequest,
  type PullRequestAnalytics,
  type RepoPage,
  type SecurityAlert,
  type Webhook,
} from "./types.js";

const STORAGE_NS = "gitops-github";
const KEY_PAT = "pat:default";

interface StoredAuth {
  kind: "pat" | "oauth" | "app";
  token: string;
  meta?: Record<string, string>;
  savedAt: string;
}

interface CacheEntry<T> {
  ts: number;
  ttlMs: number;
  value: T;
}

export class GitHubProvider implements GitOpsProvider {
  readonly name = "github" as const;
  private readonly host: HostServices;
  private readonly log: BoundLogger;
  private readonly client: GitHubClient;
  private readonly cache = new Map<string, CacheEntry<unknown>>();

  constructor(host: HostServices) {
    this.host = host;
    this.log = new BoundLogger(host.logger, "gitops-github");
    this.client = new GitHubClient();
  }

  async init(): Promise<void> {
    const stored = await this.loadAuth();
    if (stored) {
      this.client.setToken(stored.token);
      this.log.info("Loaded persisted GitHub PAT");
    }
  }

  // ── auth lifecycle ──────────────────────────────────────────────────

  private async loadAuth(): Promise<StoredAuth | null> {
    const raw = await this.host.storage?.get<string>(STORAGE_NS, KEY_PAT);
    if (!raw) return null;
    try {
      return typeof raw === "string"
        ? (JSON.parse(raw) as StoredAuth)
        : (raw as StoredAuth);
    } catch {
      return null;
    }
  }

  async saveCredentials(input: AuthInput): Promise<void> {
    const env: StoredAuth = {
      kind: input.kind,
      token: input.token,
      meta: input.meta,
      savedAt: new Date().toISOString(),
    };
    await this.host.storage?.set(STORAGE_NS, KEY_PAT, JSON.stringify(env));
    this.client.setToken(input.token);
    this.cache.clear();
  }

  async validateCredentials(): Promise<AuthValidation> {
    if (!this.client.hasToken()) {
      const stored = await this.loadAuth();
      if (!stored) return { ok: false, message: "No PAT stored" };
      this.client.setToken(stored.token);
    }
    try {
      const { data, headers } = await this.client.rest<{
        login: string;
      }>("/user");
      const scopes = (headers.get("x-oauth-scopes") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      return { ok: true, account: data.login, scopes };
    } catch (err) {
      const e = err instanceof GitOpsError ? err : null;
      return {
        ok: false,
        message:
          e?.message ?? (err instanceof Error ? err.message : String(err)),
      };
    }
  }

  async rotateCredentials(input: AuthInput): Promise<AuthValidation> {
    await this.saveCredentials(input);
    return this.validateCredentials();
  }

  async revokeCredentials(): Promise<void> {
    await this.host.storage?.delete(STORAGE_NS, KEY_PAT);
    this.client.setToken(null);
    this.cache.clear();
  }

  async healthCheck(): Promise<HealthSnapshot> {
    if (!this.client.hasToken()) {
      const stored = await this.loadAuth();
      if (stored) this.client.setToken(stored.token);
    }
    try {
      const { data } = await this.client.rest<{
        resources: { core: { remaining: number; reset: number } };
      }>("/rate_limit");
      return {
        ok: true,
        rateLimit: {
          remaining: data.resources.core.remaining,
          resetAt: new Date(data.resources.core.reset * 1000).toISOString(),
        },
      };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ── cache helper ────────────────────────────────────────────────────

  private cached<T>(
    key: string,
    ttlMs: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    const entry = this.cache.get(key) as CacheEntry<T> | undefined;
    if (entry && Date.now() - entry.ts < entry.ttlMs) {
      return Promise.resolve(entry.value);
    }
    return fn().then((value) => {
      this.cache.set(key, { ts: Date.now(), ttlMs, value });
      return value;
    });
  }

  // ── repos ───────────────────────────────────────────────────────────

  async listRepos(opts: {
    org?: string;
    limit?: number;
    cursor?: string;
  }): Promise<RepoPage> {
    const limit = Math.max(1, Math.min(opts.limit ?? 30, 100));
    const path =
      opts.cursor ??
      (opts.org
        ? `/orgs/${encodeURIComponent(opts.org)}/repos?per_page=${limit}&sort=pushed`
        : `/user/repos?per_page=${limit}&sort=pushed&affiliation=owner,collaborator,organization_member`);
    const { data, headers } = await this.client.rest<unknown[]>(path);
    const items = (data as Parameters<typeof mapRepo>[0][]).map(mapRepo);
    return {
      items,
      nextCursor: this.client.parseNextLink(headers) ?? undefined,
    };
  }

  async getRepo(fqn: string): Promise<NormalisedRepo> {
    const cacheKey = `repo:${fqn}`;
    return this.cached(cacheKey, 60_000, async () => {
      const { data } = await this.client.rest<Parameters<typeof mapRepo>[0]>(
        `/repos/${fqn}`,
      );
      return mapRepo(data);
    });
  }

  async listBranches(fqn: string): Promise<Branch[]> {
    const { data } = await this.client.rest<Parameters<typeof mapBranch>[0][]>(
      `/repos/${fqn}/branches?per_page=100`,
    );
    return data.map(mapBranch);
  }

  async listLanguages(fqn: string): Promise<Record<string, number>> {
    const cacheKey = `langs:${fqn}`;
    return this.cached(cacheKey, 5 * 60_000, async () => {
      const { data } = await this.client.rest<Record<string, number>>(
        `/repos/${fqn}/languages`,
      );
      return data;
    });
  }

  async listContributors(
    fqn: string,
    opts?: { limit?: number },
  ): Promise<Contributor[]> {
    const limit = Math.max(1, Math.min(opts?.limit ?? 20, 100));
    const cacheKey = `contrib:${fqn}:${limit}`;
    return this.cached(cacheKey, 5 * 60_000, async () => {
      const { data } = await this.client.rest<
        Parameters<typeof mapContributor>[0][]
      >(`/repos/${fqn}/contributors?per_page=${limit}`);
      return data.map(mapContributor);
    });
  }

  // ── PRs ─────────────────────────────────────────────────────────────

  async listPullRequests(
    fqn: string,
    opts?: { state?: "open" | "closed" | "all"; limit?: number },
  ): Promise<PullRequest[]> {
    const state = opts?.state ?? "open";
    const limit = Math.max(1, Math.min(opts?.limit ?? 30, 100));
    const { data } = await this.client.rest<
      Parameters<typeof mapPullRequest>[0][]
    >(
      `/repos/${fqn}/pulls?state=${state}&per_page=${limit}&sort=updated&direction=desc`,
    );
    return data.map(mapPullRequest);
  }

  async getPullRequest(fqn: string, id: number): Promise<PullRequest> {
    const { data } = await this.client.rest<
      Parameters<typeof mapPullRequest>[0]
    >(`/repos/${fqn}/pulls/${id}`);
    return mapPullRequest(data);
  }

  async pullRequestAnalytics(fqn: string): Promise<PullRequestAnalytics> {
    const open = await this.listPullRequests(fqn, {
      state: "open",
      limit: 100,
    });
    const closed = await this.listPullRequests(fqn, {
      state: "closed",
      limit: 100,
    });
    const merged = closed.filter((p) => p.state === "merged");
    const withDuration = merged.filter(
      (p) => typeof p.durationOpenSeconds === "number",
    );
    const sorted = [...withDuration].sort(
      (a, b) => (a.durationOpenSeconds ?? 0) - (b.durationOpenSeconds ?? 0),
    );
    const median = sorted.length
      ? (sorted[Math.floor(sorted.length / 2)]?.durationOpenSeconds ?? 0) / 3600
      : 0;
    return {
      slowest: sorted.slice(-5).reverse(),
      fastest: sorted.slice(0, 5),
      medianAgeHours: Math.round(median * 10) / 10,
      awaitingReview: open.filter((p) => !p.reviewDecision),
      awaitingApproval: open.filter(
        (p) => p.reviewDecision === "REVIEW_REQUIRED",
      ),
    };
  }

  // ── issues ──────────────────────────────────────────────────────────

  async listIssues(
    fqn: string,
    opts?: { state?: "open" | "closed"; limit?: number },
  ): Promise<IssueSummary[]> {
    const state = opts?.state ?? "open";
    const limit = Math.max(1, Math.min(opts?.limit ?? 30, 100));
    const { data } = await this.client.rest<Parameters<typeof mapIssue>[0][]>(
      `/repos/${fqn}/issues?state=${state}&per_page=${limit}`,
    );
    return data.map(mapIssue).filter((i): i is IssueSummary => !!i);
  }

  async labelStats(fqn: string): Promise<Record<string, number>> {
    const open = await this.listIssues(fqn, { state: "open", limit: 100 });
    const out: Record<string, number> = {};
    for (const i of open) for (const l of i.labels) out[l] = (out[l] ?? 0) + 1;
    return out;
  }

  // ── CI/CD ───────────────────────────────────────────────────────────

  async listPipelines(fqn: string): Promise<Pipeline[]> {
    const cacheKey = `workflows:${fqn}`;
    return this.cached(cacheKey, 60_000, async () => {
      const { data } = await this.client.rest<{
        workflows: Parameters<typeof mapPipeline>[0][];
      }>(`/repos/${fqn}/actions/workflows`);
      return data.workflows.map(mapPipeline);
    });
  }

  async listRecentRuns(
    fqn: string,
    opts?: { limit?: number; branch?: string },
  ): Promise<PipelineRun[]> {
    const limit = Math.max(1, Math.min(opts?.limit ?? 30, 100));
    const branchQs = opts?.branch
      ? `&branch=${encodeURIComponent(opts.branch)}`
      : "";
    const { data } = await this.client.rest<{
      workflow_runs: Parameters<typeof mapRun>[0][];
    }>(`/repos/${fqn}/actions/runs?per_page=${limit}${branchQs}`);
    return data.workflow_runs.map(mapRun);
  }

  async getRun(fqn: string, runId: string): Promise<PipelineRun> {
    const { data } = await this.client.rest<Parameters<typeof mapRun>[0]>(
      `/repos/${fqn}/actions/runs/${runId}`,
    );
    const run = mapRun(data);
    try {
      const { data: jobs } = await this.client.rest<{
        jobs: Parameters<typeof mapJob>[0][];
      }>(`/repos/${fqn}/actions/runs/${runId}/jobs`);
      run.jobs = jobs.jobs.map(mapJob);
    } catch {
      // job listing is optional; ignore failures
    }
    return run;
  }

  async pipelineAnalytics(fqn: string): Promise<PipelineAnalytics> {
    const runs = await this.listRecentRuns(fqn, { limit: 100 });
    const completed = runs.filter((r) => r.status === "completed");
    const succ = completed.filter((r) => r.conclusion === "success").length;
    const durations = completed
      .map((r) => r.durationSeconds ?? 0)
      .filter((d) => d > 0)
      .sort((a, b) => a - b);
    const pct = (p: number) =>
      durations.length === 0
        ? 0
        : (durations[
            Math.min(durations.length - 1, Math.floor(durations.length * p))
          ] ?? 0);
    return {
      successRate: completed.length ? succ / completed.length : 0,
      durationP50: pct(0.5),
      durationP95: pct(0.95),
      slowest: [...completed]
        .sort((a, b) => (b.durationSeconds ?? 0) - (a.durationSeconds ?? 0))
        .slice(0, 5),
      fastest: [...completed]
        .filter((r) => (r.durationSeconds ?? 0) > 0)
        .sort((a, b) => (a.durationSeconds ?? 0) - (b.durationSeconds ?? 0))
        .slice(0, 5),
      running: runs.filter((r) => r.status === "running"),
      queued: runs.filter((r) => r.status === "queued"),
      pendingApproval: runs.filter((r) => r.status === "waiting"),
      totalRunsLast30Days: runs.length,
    };
  }

  async listEnvironments(fqn: string): Promise<Environment[]> {
    try {
      const { data } = await this.client.rest<{
        environments?: Array<{
          name: string;
          updated_at?: string;
          html_url?: string;
        }>;
      }>(`/repos/${fqn}/environments`);
      return (data.environments ?? []).map((e) => ({
        name: e.name,
        state: "active",
        lastDeployedAt: e.updated_at,
        url: e.html_url,
      }));
    } catch {
      return [];
    }
  }

  // ── security ────────────────────────────────────────────────────────

  async listSecurityAlerts(
    fqn: string,
    opts?: { kind?: SecurityAlert["type"] },
  ): Promise<SecurityAlert[]> {
    const kinds = opts?.kind
      ? [opts.kind]
      : (["dependency", "code-scan", "secret-scan"] as const);
    const out: SecurityAlert[] = [];

    for (const k of kinds) {
      try {
        if (k === "dependency") {
          const { data } = await this.client.rest<
            Parameters<typeof mapDependabotAlert>[0][]
          >(`/repos/${fqn}/dependabot/alerts?state=open&per_page=50`);
          out.push(...data.map(mapDependabotAlert));
        } else if (k === "code-scan") {
          const { data } = await this.client.rest<
            Parameters<typeof mapCodeScanAlert>[0][]
          >(`/repos/${fqn}/code-scanning/alerts?state=open&per_page=50`);
          out.push(...data.map(mapCodeScanAlert));
        } else if (k === "secret-scan") {
          const { data } = await this.client.rest<
            Parameters<typeof mapSecretScanAlert>[0][]
          >(`/repos/${fqn}/secret-scanning/alerts?state=open&per_page=50`);
          out.push(...data.map(mapSecretScanAlert));
        }
      } catch (err) {
        if (err instanceof GitOpsError && err.code === "FORBIDDEN") {
          // Feature disabled or scope missing; skip
          continue;
        }
        // Other errors: continue with what we have
      }
    }
    return out;
  }

  // ── org rollup ──────────────────────────────────────────────────────

  async orgRollup(org: string): Promise<OrgRollup> {
    const cacheKey = `rollup:${org}`;
    return this.cached(cacheKey, 5 * 60_000, async () => {
      const first = await this.listRepos({ org, limit: 100 });
      const items = [...first.items];
      let cursor = first.nextCursor;
      // Cap at 5 pages (500 repos) to keep response time bounded.
      let pages = 1;
      while (cursor && pages < 5) {
        const next = await this.listRepos({ cursor });
        items.push(...next.items);
        cursor = next.nextCursor;
        pages++;
      }

      const byVis = { public: 0, private: 0, internal: 0 } as Record<
        "public" | "private" | "internal",
        number
      >;
      const byLang: Record<string, number> = {};
      let archived = 0;
      let stale30d = 0;
      const now = Date.now();
      for (const r of items) {
        byVis[r.visibility] += 1;
        if (r.language) byLang[r.language] = (byLang[r.language] ?? 0) + 1;
        if (r.isArchived) archived++;
        const pushed = Date.parse(r.pushedAt ?? r.updatedAt);
        if (now - pushed > 30 * 24 * 3600 * 1000) stale30d++;
      }
      return {
        totalRepos: items.length,
        byVisibility: byVis,
        byLanguage: byLang,
        archived,
        stale30d,
        totalOpenPRs: 0, // computed lazily; org-level aggregation is expensive
        totalOpenIssues: 0,
      };
    });
  }

  // ── webhooks (optional) ─────────────────────────────────────────────

  async listWebhooks(fqn: string): Promise<Webhook[]> {
    try {
      const { data } = await this.client.rest<
        Parameters<typeof mapWebhook>[0][]
      >(`/repos/${fqn}/hooks`);
      return data.map(mapWebhook);
    } catch {
      return [];
    }
  }
}

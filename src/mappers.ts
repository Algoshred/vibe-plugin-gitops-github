/**
 * Mappers — GitHub REST/GraphQL payloads → normalised GitOpsProvider types.
 */

import type {
  Branch,
  Contributor,
  IssueSummary,
  NormalisedRepo,
  Pipeline,
  PipelineJob,
  PipelineRun,
  PullRequest,
  SecurityAlert,
  Webhook,
} from "./types.js";

interface GhRepo {
  full_name: string;
  visibility?: string;
  private?: boolean;
  default_branch: string;
  description?: string | null;
  language?: string | null;
  topics?: string[];
  archived?: boolean;
  fork?: boolean;
  size?: number;
  stargazers_count?: number;
  forks_count?: number;
  watchers_count?: number;
  html_url: string;
  created_at: string;
  updated_at: string;
  pushed_at?: string | null;
}

export function mapRepo(r: GhRepo): NormalisedRepo {
  const visibility = r.visibility ?? (r.private ? "private" : "public");
  return {
    fqn: r.full_name,
    provider: "github",
    visibility:
      visibility === "private"
        ? "private"
        : visibility === "internal"
          ? "internal"
          : "public",
    defaultBranch: r.default_branch,
    description: r.description ?? undefined,
    language: r.language ?? undefined,
    topics: r.topics ?? [],
    isArchived: !!r.archived,
    isFork: !!r.fork,
    size: r.size,
    stars: r.stargazers_count,
    forks: r.forks_count,
    watchers: r.watchers_count,
    url: r.html_url,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    pushedAt: r.pushed_at ?? undefined,
  };
}

interface GhPull {
  id: number;
  number: number;
  title: string;
  state: "open" | "closed";
  merged_at?: string | null;
  draft?: boolean;
  user?: { login: string } | null;
  requested_reviewers?: Array<{ login: string }>;
  mergeable_state?: string;
  created_at: string;
  updated_at: string;
  html_url: string;
  labels?: Array<{ name: string }>;
}

export function mapPullRequest(p: GhPull): PullRequest {
  const merged = !!p.merged_at;
  return {
    id: String(p.id),
    number: p.number,
    title: p.title,
    state: merged ? "merged" : p.state,
    isDraft: !!p.draft,
    author: p.user?.login ?? "unknown",
    reviewers: (p.requested_reviewers ?? []).map((r) => r.login),
    mergeState: mapMergeState(p.mergeable_state),
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    mergedAt: p.merged_at ?? undefined,
    durationOpenSeconds: computeDuration(
      p.created_at,
      p.merged_at ?? p.updated_at,
    ),
    url: p.html_url,
    labels: (p.labels ?? []).map((l) => l.name),
  };
}

function mapMergeState(s?: string): PullRequest["mergeState"] {
  if (!s) return undefined;
  switch (s) {
    case "clean":
    case "dirty":
    case "blocked":
    case "unstable":
    case "behind":
      return s;
    default:
      return undefined;
  }
}

function computeDuration(start: string, end?: string): number | undefined {
  if (!end) return undefined;
  const dt = Date.parse(end) - Date.parse(start);
  return dt > 0 ? Math.floor(dt / 1000) : undefined;
}

interface GhWorkflow {
  id: number;
  name: string;
  path: string;
  state: string;
}

export function mapPipeline(w: GhWorkflow): Pipeline {
  return {
    id: String(w.id),
    name: w.name,
    state: w.state === "active" ? "active" : "disabled",
    path: w.path,
  };
}

interface GhRun {
  id: number;
  name?: string | null;
  display_title?: string | null;
  head_branch?: string | null;
  status: string;
  conclusion?: string | null;
  event?: string;
  run_started_at?: string;
  updated_at?: string;
  html_url: string;
  actor?: { login: string } | null;
  head_sha?: string;
  head_commit?: { message?: string };
}

export function mapRun(r: GhRun): PipelineRun {
  const startedAt = r.run_started_at;
  const completedAt =
    r.status === "completed" ? (r.updated_at ?? undefined) : undefined;
  const duration =
    startedAt && completedAt
      ? Math.max(
          0,
          Math.floor((Date.parse(completedAt) - Date.parse(startedAt)) / 1000),
        )
      : undefined;
  return {
    id: String(r.id),
    pipelineName: r.name ?? r.display_title ?? "ci",
    branch: r.head_branch ?? "unknown",
    status: mapRunStatus(r.status),
    conclusion: mapConclusion(r.conclusion),
    event: r.event,
    startedAt,
    completedAt,
    durationSeconds: duration,
    url: r.html_url,
    actor: r.actor?.login ?? "unknown",
    commitSha: r.head_sha,
    commitMessage: r.head_commit?.message,
  };
}

function mapRunStatus(s: string): PipelineRun["status"] {
  if (s === "queued") return "queued";
  if (s === "in_progress" || s === "running") return "running";
  if (s === "waiting") return "waiting";
  return "completed";
}

function mapConclusion(c?: string | null): PipelineRun["conclusion"] {
  if (!c) return undefined;
  switch (c) {
    case "success":
    case "failure":
    case "cancelled":
    case "skipped":
    case "timed_out":
    case "neutral":
      return c;
    default:
      return undefined;
  }
}

interface GhJob {
  id: number;
  name: string;
  status: string;
  conclusion?: string | null;
  started_at?: string;
  completed_at?: string;
}

export function mapJob(j: GhJob): PipelineJob {
  return {
    id: String(j.id),
    name: j.name,
    status: j.status,
    conclusion: j.conclusion ?? undefined,
    startedAt: j.started_at,
    completedAt: j.completed_at,
    durationSeconds:
      j.started_at && j.completed_at
        ? Math.max(
            0,
            Math.floor(
              (Date.parse(j.completed_at) - Date.parse(j.started_at)) / 1000,
            ),
          )
        : undefined,
  };
}

interface GhBranch {
  name: string;
  protected: boolean;
  commit: { sha: string };
}

export function mapBranch(b: GhBranch): Branch {
  return {
    name: b.name,
    isProtected: b.protected,
    lastCommitSha: b.commit.sha,
  };
}

interface GhContributor {
  login: string;
  contributions: number;
  avatar_url?: string;
}

export function mapContributor(c: GhContributor): Contributor {
  return {
    login: c.login,
    contributions: c.contributions,
    avatarUrl: c.avatar_url,
  };
}

interface GhIssue {
  id: number;
  number: number;
  title: string;
  state: string;
  labels?: Array<{ name: string } | string>;
  html_url: string;
  created_at: string;
  pull_request?: unknown; // present on PRs (we filter them out)
}

export function mapIssue(i: GhIssue): IssueSummary | null {
  if (i.pull_request) return null; // GitHub returns PRs in /issues too
  return {
    id: String(i.id),
    number: i.number,
    title: i.title,
    state: i.state,
    labels: (i.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)),
    url: i.html_url,
    createdAt: i.created_at,
  };
}

interface GhDependabotAlert {
  number: number;
  state: string;
  security_advisory?: {
    summary?: string;
    severity?: string;
    cve_id?: string | null;
  };
  security_vulnerability?: {
    package?: { ecosystem?: string; name?: string };
  };
  html_url: string;
  created_at: string;
  dismissed_at?: string | null;
  fixed_at?: string | null;
}

export function mapDependabotAlert(a: GhDependabotAlert): SecurityAlert {
  const sev = (
    a.security_advisory?.severity ?? "info"
  ).toLowerCase() as SecurityAlert["severity"];
  return {
    id: String(a.number),
    type: "dependency",
    severity: sev,
    state: a.fixed_at ? "fixed" : a.dismissed_at ? "dismissed" : "open",
    title:
      a.security_advisory?.summary ??
      `${a.security_vulnerability?.package?.name ?? "(unknown)"} vulnerability`,
    url: a.html_url,
    ecosystem: a.security_vulnerability?.package?.ecosystem,
    cve: a.security_advisory?.cve_id ?? undefined,
    createdAt: a.created_at,
  };
}

interface GhCodeScanAlert {
  number: number;
  state: string;
  rule?: { id?: string; description?: string; severity?: string };
  html_url: string;
  created_at: string;
}

export function mapCodeScanAlert(a: GhCodeScanAlert): SecurityAlert {
  const sev = (
    a.rule?.severity ?? "info"
  ).toLowerCase() as SecurityAlert["severity"];
  return {
    id: String(a.number),
    type: "code-scan",
    severity: sev,
    state:
      a.state === "fixed" || a.state === "closed"
        ? "fixed"
        : a.state === "dismissed"
          ? "dismissed"
          : "open",
    title: a.rule?.description ?? a.rule?.id ?? "Code scanning alert",
    url: a.html_url,
    ruleId: a.rule?.id,
    createdAt: a.created_at,
  };
}

interface GhSecretScanAlert {
  number: number;
  state: string;
  secret_type_display_name?: string;
  secret_type?: string;
  html_url: string;
  created_at: string;
}

export function mapSecretScanAlert(a: GhSecretScanAlert): SecurityAlert {
  return {
    id: String(a.number),
    type: "secret-scan",
    severity: "high",
    state: a.state === "resolved" ? "fixed" : "open",
    title: a.secret_type_display_name ?? a.secret_type ?? "Secret detected",
    url: a.html_url,
    createdAt: a.created_at,
  };
}

interface GhHook {
  id: number;
  config?: { url?: string };
  events?: string[];
  active?: boolean;
}

export function mapWebhook(h: GhHook): Webhook {
  return {
    id: String(h.id),
    url: h.config?.url ?? "",
    events: h.events ?? [],
    active: !!h.active,
  };
}

# @vibecontrols/vibe-plugin-gitops-github

GitHub provider for the [`@vibecontrols/vibe-plugin-gitops`](https://npmjs.com/package/@vibecontrols/vibe-plugin-gitops) meta plugin.

Talks to GitHub directly via REST v3 + GraphQL v4 — no `gh` CLI on the user box.

## Install

```bash
vibe plugin install @vibecontrols/vibe-plugin-gitops          # meta (once)
vibe plugin install @vibecontrols/vibe-plugin-gitops-github   # this provider
```

## Auth

Personal Access Token (classic or fine-grained). Required scopes:

- `repo` — repos, PRs, issues
- `workflow` — Actions runs
- `read:org` — org rollup
- `security_events` — Dependabot / code scanning alerts

```bash
vibe gitops auth set github ghp_xxxxxxxxxxxxxxxxxxxx
```

## Storage

PAT lives in the agent's Skalex encrypted SQLite at namespace `gitops-github`, key `pat:default`. Plaintext token never leaves the agent.

## License

Proprietary — see LICENSE.

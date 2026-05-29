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

<!-- VIBECONTROLS_OSS_FOOTER_START -->

---

## About VibeControls

**VibeControls** is the agentic engineering mission control for AI-native teams. Vibe-plugins extend the VibeControls agent with new providers, tools, sessions, tunnels, storage backends, and security stages.

- Website: <https://vibecontrols.com>
- Documentation: <https://docs.vibecontrols.com>
- Plugin SDK: <https://github.com/algoshred/vibecontrols-plugin-sdk>
- All plugins: <https://github.com/algoshred?q=vibe-plugin-&type=all>

## Credits

This plugin builds on the following upstream open-source projects. All trademarks and copyrights remain with their respective owners.

- **GitHub REST + GraphQL API** — <https://docs.github.com/rest>

## License

Released under the [MIT License](./LICENSE).

Copyright (c) 2026 Burdenoff Consultancy Services Private Limited, Algoshred Technologies Private Limited, and all its sister companies.

Maintainer: **Vignesh T.V** — <https://github.com/tvvignesh>

**Note**: this plugin is open source under MIT. The `@vibecontrols/agent` runtime that loads and orchestrates plugins is **closed source** and proprietary to Burdenoff Consultancy Services Pvt. Ltd. If you want a fully self-hostable agent, please open an issue or contact the maintainer.

<!-- VIBECONTROLS_OSS_FOOTER_END -->

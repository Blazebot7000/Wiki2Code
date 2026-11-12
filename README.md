# Wiki2Code

A wiki-first desktop IDE. You write the product in the repository wiki; Wiki2Code
compares that documentation with the actual source code, highlights every place
they disagree, and lets you fix either side with one click — update the docs, or
send an AI agent through a full GitHub development cycle (plan → branch → build →
test → commit → push → PR → merge).

Built as an Nx monorepo: a React + TypeScript UI inside Electron, talking over
TCP to NestJS microservices behind a small HTTP gateway.

## What it does

1. **Setup wizard** — connect one or more AI providers (keys are validated
   against the provider before they are saved), sign in to GitHub (device flow or
   a personal access token), and connect a repository.
2. **Workspace** — repositories in a left sidebar, the selected repository's wiki
   in the main pane, and a model switcher in the top right.
3. **Review** — the selected model reads the wiki block by block, pulls in the
   source files each block describes, and records only real contradictions as
   highlights anchored to the exact wiki lines.
4. **Hover details** — each highlight explains what the code does and how the
   documentation differs, with the file/line references it used.
5. **Two fixes** — *Update wiki to match code* rewrites that one markdown block
   and pushes a wiki commit. *Fix code to match wiki* plans the change, branches
   off the default branch, builds and tests, commits, pushes, opens a PR, and
   merges it.
6. **Commit watching** — a watcher polls the code and wiki repositories. Code
   changes mark affected highlights stale; wiki changes trigger an incremental
   review that replaces highlights for the pages that moved.

## Requirements

- Node.js 22+
- Git on `PATH`
- A GitHub account with access to the repository you want to open
- At least one AI provider API key (OpenAI, Anthropic, Google Gemini,
  OpenRouter, OpenCode Zen) or a local Ollama instance

## Install and run

```bash
npm install
npm start
```

`npm start` builds the web UI and every service, then opens the Electron window.
The Electron main process starts the five services and the gateway, waits for the
gateway to answer, and loads the UI from it.

On first launch the setup wizard appears. Once setup is complete the workspace
opens directly on later launches.

> If npm is configured to skip install scripts (some managed environments do),
> the Electron binary is downloaded on first `npm start` instead. You can also run
> `node tools/ensure-electron.mjs` manually.

### Development

```bash
npm run dev
```

Starts the gateway, the four microservices, and the Vite dev server at
<http://localhost:4200> (the web app proxies `/api` to the gateway). Open that URL
in a browser for fast UI iteration.

To run the Electron shell against the dev server:

```powershell
# PowerShell
$env:WIKI2CODE_DEV_URL = "http://localhost:4200"
$env:WIKI2CODE_EXTERNAL_SERVICES = "1"
npm run desktop
```

```bash
# bash
WIKI2CODE_DEV_URL=http://localhost:4200 WIKI2CODE_EXTERNAL_SERVICES=1 npm run desktop
```

### Useful commands

```bash
npm run build       # build all apps
npm run typecheck   # type-check every project
npm run smoke       # start the services on a temp data dir and hit the API
npm run seed:demo -- "<data dir>"  # add a fake wiki + highlights to a connected repo
npx nx serve web    # web only
npx nx build ai-svc # one project
```

## GitHub sign-in

The wizard supports both flows:

- **Device flow** — create a free OAuth App at
  <https://github.com/settings/applications/new>, tick **Enable Device Flow**, and
  paste its client ID into the wizard. You can also set
  `WIKI2CODE_GITHUB_CLIENT_ID` in the environment.
- **Personal access token** — paste a classic token with `repo` scope, or a
  fine-grained token with contents + pull request permissions.

The token is encrypted at rest (AES-256-GCM) under the app data directory.

## Architecture

```
apps/
  desktop/      Electron main process + preload
  web/          React UI (Vite)
  gateway/      HTTP API + SSE, serves the built UI in desktop mode
  github-svc/   auth, repo clones, wiki reads/writes, code search, dev cycle
  ai-svc/       provider validation, chat adapters, review engine, rewrites/plans
  review-svc/   highlight + review job persistence
  sync-svc/     commit watcher, staleness, incremental reviews
libs/
  contracts/    shared domain types + TCP message patterns + ports
  markdown/     markdown block parser shared by services and UI
  server/       data dir, JSON store, secret store, git helpers, GitHub client
```

Services communicate over NestJS TCP:

| Service    | Port |
| ---------- | ---- |
| gateway    | 3000 |
| github-svc | 4001 |
| ai-svc     | 4002 |
| review-svc | 4003 |
| sync-svc   | 4004 |

The gateway exposes REST under `/api` and a server-sent-events stream at
`/api/events?repoId=…` that the UI uses to refresh highlights, review progress,
watcher state, and dev-cycle status.

### Data

Everything lives in `%APPDATA%\Wiki2Code` on Windows (`$XDG_CONFIG_HOME` or
`~/.config` elsewhere), or in `WIKI2CODE_DATA_DIR` when set:

```
repos/<owner>__<name>/code   shallow clone of the repository
repos/<owner>__<name>/wiki   clone of the repository wiki
secrets/*.enc                encrypted provider keys and GitHub token
*.json                       service state
```

### Environment variables

| Variable                     | Purpose                                        |
| ---------------------------- | ---------------------------------------------- |
| `WIKI2CODE_DATA_DIR`         | Override the data directory                    |
| `WIKI2CODE_GITHUB_CLIENT_ID` | Default OAuth App client ID for device flow     |
| `WIKI2CODE_WEB_DIR`          | Directory of the built UI served by the gateway |
| `WIKI2CODE_DEV_URL`          | Load this URL in Electron instead of the gateway |
| `WIKI2CODE_EXTERNAL_SERVICES`| Set to `1` to stop Electron spawning services   |
| `PORT`, `*_SVC_PORT`         | Override service ports                          |

## Safety rails

- Provider keys and the GitHub token are encrypted at rest; the key file is
  written with owner-only permissions.
- The automated dev cycle refuses to run on a dirty checkout.
- File edits are rejected if the path escapes the repository or is not a plain
  relative path.
- Build/test commands must match a package-manager/test-runner allowlist and may
  not contain shell operators (`;`, `&`, `|`, `>`, `<`, backticks, `$`).
- The reviewer may only cite files that exist in the repository tree.
- PR creation and merging are explicit steps in the job timeline, and `dryRun` is
  available for trying a plan without committing.

## Notes and limitations

- GitHub wikis cannot be cloned until the first page exists. If a repository's
  wiki is empty, the workspace shows a link to create that page and a **Sync**
  button; after the page exists everything works normally.
- Reviews are capped per run (block budget and batch size) to keep token use
  predictable. Re-run a review after large wiki edits.
- Merging happens through the GitHub API as the signed-in user. Branch protection
  rules still apply.
- The JSON stores are single-writer by design: each service owns exactly one file.

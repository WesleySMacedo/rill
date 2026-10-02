# Rill Agent

Rill Agent is the local runtime for the Rill web platform. It runs on the user's Windows computer as a tray application. On loopback only (`http://localhost:7777`) it exposes a small authenticated API that lets Rill Web:

- read and write files in folders the user approved;
- run allow-listed commands;
- run Git operations;
- stream terminal output in real time.

The Agent has **no authority of its own**. Rill decides what is allowed, and the user approves every folder exposure and every push on their own computer. The browser never receives the Agent's personal token or any secret.

## Architecture

```text
Rill Web (browser) ── HTTPS ──► Rill Worker (/api/agent/*) ◄── HTTPS ── Rill Agent (Electron tray)
        │                                                                │
        └──── http://localhost:7777 (local session token) ──────────────┘
                                                                        ├─ Express API  /v1/*
                                                                        ├─ WebSocket    /v1/events
                                                                        ├─ Workspaces (approved folders)
                                                                        ├─ Files / Git / Jobs
                                                                        └─ DPAPI token vault (safeStorage)
```

| Folder | Responsibility |
| --- | --- |
| `src/core` | `AgentController` (pairing, heartbeat, browser-user verification), JSON state store, errors |
| `src/security` | Path guard, sensitive-file rules, local sessions, token vault interface |
| `src/workspaces` | Registry of user-approved folders and their permissions (`read`, `write`, `execute`) |
| `src/files` | Listing and reading files, plus conflict-safe atomic writes (`expectedSha256`) |
| `src/exec` | Command catalog (allow-list) and job manager (streaming, timeouts, process-tree kill) |
| `src/git` | `status`, `branch`, `commit`, `push` via `git` without a shell |
| `src/rill` | HTTP client for the Rill Worker agent API |
| `src/server` | Express app, Host and Origin checks, CORS / Private Network Access, WebSocket hub |
| `src/electron` | Tray, native approval dialogs, DPAPI vault, app bootstrap and login item |

## Pairing (device authorization)

1. On first start, the Agent calls `POST /api/agent/pairings` and receives a one-time `deviceCode` and a short `userCode` (`XXXX-XXXX`).
2. The Agent opens `https://rill.wesleysmacedo.com/agent/pair?code=XXXX-XXXX`. The signed-in user checks that the code matches the tray and clicks **Approve this computer**.
3. The Agent polls `POST /api/agent/pairings/poll`. After approval it receives a personal token (`rill_pat_…`) exactly once, through an atomic compare-and-swap. The Worker stores only the hashes of the codes and the token.
4. The Agent encrypts the token with Windows DPAPI (`safeStorage`). If encryption is unavailable, it refuses to store the token.
5. A heartbeat every 30 s keeps the machine **Connected** in Rill Web. Revoking the machine in Rill invalidates the token, and the Agent unpairs itself.

## Security model

- **Loopback only:** the server binds `127.0.0.1` and `::1` on port 7777. A `Host` header other than `localhost:7777`, `127.0.0.1:7777` or `[::1]:7777` is rejected (421), which blocks DNS rebinding.
- **Origin allow-list:**
  - Allowed by default: `https://rill.wesleysmacedo.com` and `https://rill-web.runai-systems-llc.workers.dev`.
  - Development origins must be loopback http, set via `RILL_AGENT_DEV_ORIGINS`.
  - Any other Origin gets 403.
- **Two layers of authentication:**
  1. The browser sends its Supabase access token once to `POST /v1/session`. The Agent asks the Worker (using its personal token) whether that user is the one who paired the machine. The answer is `SESSION_USER_MISMATCH` if not.
  2. On success the browser receives a local session token (`rill_ls_…`, 12 h, stored hashed). Every other endpoint and the WebSocket require it.
- **Explicit approval:** a folder is exposed only after a native dialog where the user picks the folder and the permission level. The default is **Deny**. `git push` asks again every time.
- **Path confinement:**
  - Every path is resolved with `realpath` inside the workspace root.
  - `..` and absolute paths are rejected, and so are symlink escapes.
  - Overlapping workspaces are not allowed.
  - System folders, the home folder root and drive roots are refused.
- **Sensitive files:** `.env*`, keys, certificates, `.npmrc`, credentials and the `.git` internals cannot be read, written or committed.
- **Commands:** only the catalog runs (`npm.install`, `npm.test`, `npm.build`, `npm.dev`). No free-form shell is accepted. Child processes don't inherit `ELECTRON_*` or `RILL_*` variables.
- **Git:**
  - `GIT_TERMINAL_PROMPT=0`;
  - commit messages are passed through stdin;
  - no force push;
  - commits that include sensitive files are refused.
- **Responses:** every response uses `{ ok: true, data }` or `{ ok: false, error: { code, message } }`.

## Local API (`http://localhost:7777`)

All `/v1/*` routes except `health` and `session` require `Authorization: Bearer <rill_ls_ session token>`.

| Method | Path | Permission | Purpose |
| --- | --- | --- | --- |
| `GET` | `/v1/health` | — | Detection: version, platform, paired, connected |
| `POST` | `/v1/session` | Supabase access token | Opens a local session after Worker verification |
| `DELETE` | `/v1/session` | session | Revokes the local session |
| `GET` | `/v1/status` | session | Agent status |
| `GET` | `/v1/workspaces` | session | Approved workspaces |
| `POST` | `/v1/workspaces/requests` | session + native approval | Asks the user to expose a folder |
| `DELETE` | `/v1/workspaces/:id` | session | Stops exposing a folder |
| `GET` | `/v1/workspaces/:id/tree?path=` | read | Lists one directory level |
| `GET` | `/v1/workspaces/:id/files?path=` | read | Reads a file (≤ 2 MB, utf8/base64, sha256) |
| `PUT` | `/v1/workspaces/:id/files` | write | Writes atomically (`path`, `content`, `encoding`, `expectedSha256`; `null` creates, 409 on conflict) |
| `POST` | `/v1/workspaces/:id/commands` | execute | Starts a catalog command (`{ command: "npm.test" }`) and returns a job |
| `GET` | `/v1/jobs`, `/v1/jobs/:id?since=` | session | Job list and output snapshot after sequence `since` |
| `POST` | `/v1/jobs/:id/cancel` | session | Kills the process tree |
| `GET` | `/v1/workspaces/:id/git/status`, `/git/branches` | read | Parsed `git status` (porcelain v2) and branches |
| `POST` | `/v1/workspaces/:id/git/branches` | write | Creates and switches to a branch |
| `POST` | `/v1/workspaces/:id/git/commit` | write | Commits the given paths or all changes |
| `POST` | `/v1/workspaces/:id/git/push` | execute + native confirmation | Pushes the current branch (upstream is set automatically) and returns a job |
| `WS` | `/v1/events` | session (first message `{type:"auth", token}` within 5 s) | `job.output`, `job.exit`, `agent.status` |

## Development

```powershell
npm install --prefix agent
npm run typecheck --prefix agent
npm test --prefix agent          # 64 tests: path guard, units, HTTP/WS integration (real npm + git)
npm run build --prefix agent
npm start --prefix agent         # electron . (pairs automatically unless started with --hidden)
```

Environment overrides:

- `RILL_APP_URL`: must be https, or loopback http for local development.
- `RILL_AGENT_DEV_ORIGINS`: comma-separated loopback origins, for example `http://localhost:5173`.

## Windows installer

```powershell
npm run dist --prefix agent           # NSIS + portable
npm run dist:nsis --prefix agent      # → agent/release/Rill-Agent-Setup.exe (NSIS, per-user, x64)
npm run dist:portable --prefix agent  # → agent/release/Rill-Agent-Portable.exe (no install)
```

The installer is one-click and per-user, and starts the Agent when it finishes. On first run the Agent registers itself to start at login (hidden, in the tray).

**Private beta: builds are unsigned.** `forceCodeSigning` is `false`, and no `CSC_LINK`, `CSC_KEY_PASSWORD` or Azure Trusted Signing is required. As a result:

- SmartScreen shows "Windows protected your PC". Click **More info → Run anyway**.
- Smart App Control or App Control for Business may block unsigned executables outright. On such machines, test on a machine without SAC, or build with the `Rill Agent build` GitHub Actions workflow.
- Before a public release, configure Authenticode signing (`CSC_LINK`/`CSC_KEY_PASSWORD` or Azure Trusted Signing) and set `forceCodeSigning: true`.

CI: `.github/workflows/rill-agent-build.yml` builds both artifacts on `windows-latest`. It runs on `workflow_dispatch`, or on a tag `agent-v*`, which also attaches them to a GitHub Release.

Publish `Rill-Agent-Setup.exe` as an asset of a GitHub Release in `WesleySMacedo/rill`. The Worker var `RILL_AGENT_DOWNLOAD_URL` points to `releases/latest/download/Rill-Agent-Setup.exe`.

## Rill Web integration

- The topbar polls `GET /v1/health` every 10 s and shows **Agent Connected / Disconnected / Not paired / Other account**.
- When no Agent answers, a **Rill Agent Required** dialog offers **Download Rill Agent**. It can be dismissed for the browser session.
- `/agent/pair?code=…` is the approval page for pairing.

## Future support

- Monaco integration: open and save files through the `file` endpoints with `expectedSha256`.
- File watching: `fs.watch` events over `/v1/events`.
- An interactive terminal: a PTY behind the governance catalog.
- Mission execution: the Executor applies only approved, hash-bound proposals.
- Governance approval workflow: Rill tickets mirrored as native confirmations.
- Auto-update via electron-updater, and macOS/Linux builds.

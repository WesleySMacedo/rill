# Rill Web

Premium web shell for Rill Mission Control. This app is isolated from the root `@rill/core` package and is built with React, Vite, Supabase Auth, and Cloudflare Workers Static Assets.

## Local setup

```powershell
npm install --prefix web
Copy-Item web/.env.example web/.env.local
```

Set the public project URL and publishable key in `web/.env.local`:

```dotenv
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

These values are embedded into the browser bundle and are not secrets. Never use a Supabase `service_role` or secret key in this frontend. Access to database data must be authorized separately with Supabase RLS policies.

In Supabase Authentication settings, configure the site URL and allowed redirect URLs for:

- `http://localhost:5173`
- `https://rill.wesleysmacedo.com`

The app supports email/password sign-in, sign-up with confirmation redirect, and password recovery. If the variables are absent, auth actions stay disabled and the authenticated workspace remains inaccessible.

## Commands

```powershell
npm run dev --prefix web
npm run typecheck --prefix web
npm run build --prefix web
npm run worker:types --prefix web
```

Local Vite URL: <http://localhost:5173>.

## Cloudflare Worker and hostname

`web/wrangler.jsonc` configures Workers Static Assets with SPA fallback, a `/health` Worker endpoint, and the Custom Domain `rill.wesleysmacedo.com`.

After configuring Supabase values for the production Vite build, authenticate Wrangler and deploy:

```powershell
npm run deploy --prefix web
```

Wrangler provisions the Custom Domain's DNS record and certificate when deploying, provided the `wesleysmacedo.com` zone is active in the authenticated Cloudflare account. A conflicting DNS CNAME must be removed first. Deployment was not performed as part of this setup because no Supabase project URL or publishable key is configured; deploying without them would publish a login page that cannot authenticate.

For a production build, make `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` available to the build command or CI environment. These are public client settings. Do not put Supabase secret/service-role credentials in Vite variables, Wrangler vars, or browser code.

## Runtime boundary

The Worker (`web/worker.ts`) serves `/health` and the authenticated mission API under `/api/missions`. Every request must send a Supabase access token (`Authorization: Bearer ...`). The Worker validates the token server-side and persists missions with the service-role key, which is never exposed to the browser.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/missions` | List the caller's missions |
| `POST` | `/api/missions` | Create a mission (`requestId`, `goal`). Classification and context resolution are deterministic |
| `GET` | `/api/missions/:id` | Mission, events, plan, proposal, and approval ticket |
| `POST` | `/api/missions/:id/decision` | HITL decision: `APPROVED`, `REJECTED`, or `REQUESTED_CHANGES`. Requires `proposalHash`; `justification` is required unless approving |
| `POST` | `/api/missions/:id/cancel` | Cancel a non-terminal mission |

Flows:

- **`PLAN_CHANGE` / `VALIDATE_CHANGE`:** The Estrategista produces a read-only plan through the OpenRouter gateway. If the model is unavailable or returns an invalid schema, a deterministic plan is used and recorded in the timeline.
- **`PATCH_UI`:**
  1. The Projetista produces a `PATCH_PROPOSAL`.
  2. The deterministic Auditor Técnico checks the scope, allowed and forbidden paths, and file limits. If the audit fails, the mission becomes `BLOCKED`.
  3. Otherwise the mission enters `AWAITING_HUMAN_APPROVAL` with a ticket bound to the proposal hash.
  4. `APPROVED` ends in `BLOCKED` with `EXECUTOR_NOT_CONFIGURED`, because no executor is wired. `REJECTED` and `REQUESTED_CHANGES` are terminal.
- **Terminal states:** No further model calls or decisions are accepted. Concurrent decisions lose with `409 MISSION_STATE_CHANGED`.

The dashboard timeline and control panel render the persisted workflow events, the proposal, the auditor findings, model routing, and cost. They also provide the decision and cancel controls.

### Worker configuration

Non-secret vars are in `web/wrangler.jsonc`. `wrangler deploy` overwrites dashboard vars with these values:

- `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `RILL_APP_URL`
- `LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_TRACING_ENVIRONMENT`
- `LANGFUSE_PROMPT_NAME`, `LANGFUSE_PROMPT_LABEL`
- `OPENROUTER_LOW_COST_MODEL`
- `RILL_AGENT_DOWNLOAD_URL` (the Rill Agent installer, a GitHub Release asset)

Required secrets (set with `npx wrangler secret put <NAME>` from `web/`):

- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENROUTER_API_KEY`
- `LANGFUSE_SECRET_KEY`

The mission tables come from `web/supabase/migrations/202610010001_rill_mission_runtime.sql`. Apply this migration to the Supabase project before using the API. Without it, mission creation fails with `MISSION_PERSISTENCE_FAILED`.

### Rill Agent API

The Worker also serves `/api/agent/*` for the local [Rill Agent](../agent/README.md). The tables come from `web/supabase/migrations/202610020001_rill_agent.sql`:

- `rill_agent_pairings`
- `rill_agent_machines`
- `rill_personal_tokens`

Pairing codes and personal tokens are stored only as sha256 hashes. Responses use the `{ ok, data }` / `{ ok: false, error: { code, message } }` envelope.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/agent/download` | — | 302 redirect to `RILL_AGENT_DOWNLOAD_URL` (503 if not configured) |
| `POST` | `/api/agent/pairings` | — | Agent starts device pairing: returns `deviceCode`, `userCode`, `verificationUriComplete` (10 min) |
| `POST` | `/api/agent/pairings/poll` | device code | Returns `PENDING`, `DENIED`, `410` (expired), or `APPROVED` with the personal token exactly once (`409` afterwards) |
| `GET` | `/api/agent/pairings/lookup?code=` | Supabase user | Shows the machine waiting for approval |
| `POST` | `/api/agent/pairings/confirm` | Supabase user | `{ userCode, decision: "APPROVE" \| "DENY" }` |
| `POST` | `/api/agent/heartbeat` | personal token | Updates presence (connected = seen within 90 s) |
| `POST` | `/api/agent/sessions/verify` | personal token + `accessToken` | Confirms that the browser user is the paired user (`SESSION_USER_MISMATCH` otherwise) |
| `GET` | `/api/agent/machines` | Supabase user | Lists the caller's machines |
| `DELETE` | `/api/agent/machines/:id` | Supabase user | Revokes the machine and its tokens |

In the browser:

- `/agent/pair?code=…` is the pairing approval page.
- The topbar shows the Agent status pill.
- When no Agent answers on `http://localhost:7777`, the **Rill Agent Required** dialog appears.

### Langfuse

- **Prompt:** A chat prompt named `rill-mission-intelligence` with label `production`. It has these variables:
  - `goal`, `action`, `domain`, `risk`
  - `context_manifest`, `approval_required`

  If the prompt cannot be fetched or compiled, the bundled local fallback is used. The `PROMPT_RESOLVED` event records the source and version.
- **Tracing:**
  - Spans are exported via OTel with `exportMode: "immediate"`. They are flushed with `ctx.waitUntil`, so tracing failures never block a mission.
  - Trace names are `rill-mission-create`, `rill-mission-decision`, and `rill-mission-cancel`. The `sessionId` is the mission id, and the user is the Supabase user id.
  - Generations are linked to the prompt version and include the guardrail observation, usage, and cost.
  - Human decisions are recorded as the `human-approval-decision` score.
  - Inputs and outputs are masked for secrets and personal data before export.
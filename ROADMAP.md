# Rill Roadmap

This roadmap describes repository evidence, current integration work, and possible future directions. It is not a release schedule or a guarantee. A module or test does not imply an end-to-end production capability.

## ✅ Implemented building blocks

- Deterministic classification for the currently registered AuditQ domain and supported actions.
- Engineering Registry JSON schema, resolver, and registry-focused tests.
- Explicit target and supporting-context resolution with path and context-limit checks.
- Architect planning, Builder proposal, and Reviewer proposal-audit modules.
- Agent Loop dry-run path with structured proposal validation and telemetry hooks.
- OpenRouter gateway primitives for model profiles, structured output, timeout/error classification, retry, fallback, and estimated-cost checks.
- Execution-state transition contract and proposal-hash approval gate.
- HITL ticket use cases and Supabase persistence adapters.
- Cloudflare Workflow orchestration scaffold with a human-decision wait.
- MCP stdio server with a health check and request/status/proposal/report tool definitions.
- Langfuse telemetry and redaction/sanitization primitives.

These items are implemented as code building blocks. Their presence does not mean that the request route currently wires all of them into one operational service.

## 🚧 In progress

- Connect authenticated request ingress to idempotent mission persistence and Workflow creation.
- Enforce service-account authentication and authorization on every protected HTTP route.
- Reconcile the Registry approval requirement with the Workflow's approval behavior.
- Connect human decisions to durable Workflow resumption and persisted terminal state.
- Replace the prototype Builder apply path with an isolated, integrity-checked executor that applies only approved patch content.
- Run post-execution tests and scope review before persisting `COMPLETED`.
- Implement and secure the MCP execution, proposal, and report endpoints advertised by the tool definitions.
- Persist proposal hash, decision actor, validation evidence, cost, and minimized audit events consistently.
- Align lifecycle documentation and contracts, including whether proposal-ready, retry, timeout, and approval-expiration conditions are states or events.
- Add an end-to-end test that proves the full authorization and approval boundary.

## 📋 Planned

- Expand the Registry and policy model beyond the initial AuditQ example.
- Define stable public API and compatibility/versioning policies.
- Add deployment, secrets, migration, backup, and operational runbooks for supported environments.
- Add provider adapters and capability conformance tests without making provider behavior interchangeable by assumption.
- Define a supported security reporting and vulnerability disclosure process with explicit maintainer response expectations.
- Add architecture diagram source files and exported images under `docs/architecture/`.
- Evaluate additional observability exporters and integrations based on community requirements.
- Establish release automation, signed artifacts, and a documented support policy.

## Proposing roadmap changes

Open an issue or discussion with the problem, affected trust boundary, expected policy behavior, operational tradeoffs, and acceptance evidence. Roadmap status is maintained by project contributors and can change as implementation and review progress.
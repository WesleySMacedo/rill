# ADR 0001: Rill Is a Control Plane

- Status: Accepted
- Date: 2026-10-01
- Decision owners: Rill maintainers

## Context

AI clients and agents can interpret requests, select tools, read context, call providers, and initiate changes. Relying on client prompts or model behavior alone does not provide a stable authorization boundary across clients, providers, or workflows.

Rill is intended to govern AI-assisted engineering missions while remaining independent of any one model or client. The repository has begun implementing this direction through deterministic classification, an Engineering Registry, context resolution, worker roles, policy modules, an execution gate, and workflow/persistence primitives. End-to-end enforcement is still in progress.

## Decision

Rill is a control plane, not an agent, model, chat interface, or code editor. Clients and models are subordinate participants. Rill policy is the authority for:

- whether a request is recognized and authorized;
- which domain, files, and data may be included;
- which action, model profile, and budget are permitted;
- whether human approval is required;
- which proposal may be executed and under what state;
- what evidence is required before a mission is complete.

Authorization decisions must be enforced in Rill's trusted runtime and not delegated to client instructions or model-generated explanations.

## Alternatives considered

### Client-side prompt rules

Rejected as the primary control. They are useful for user experience but do not create a consistent server-side authorization boundary and may differ by client.

### A single autonomous coding agent

Rejected as the core architecture. Combining planning, policy decisions, approval, and mutation in one agent makes authority and review boundaries difficult to inspect and independently enforce.

### A model-provider-specific orchestrator

Rejected as the governing abstraction. Provider SDKs can be useful adapters, but provider-specific orchestration alone does not define repository scope, organizational engineering policy, or cross-provider authorization.

## Consequences

### Positive

- Authorization can be deterministic, inspectable, and testable.
- Multiple clients and providers can share the same policy boundary.
- Scope, approval, cost, and validation rules can be versioned as engineering policy.
- Human decisions can be represented as explicit workflow inputs and audit events.

### Tradeoffs and obligations

- Rill must secure every ingress and effectful operation; a single unguarded route undermines the model.
- Registry, state, API, persistence, and client contracts require compatibility management.
- Durable execution, decision attribution, replay safety, and failure handling add operational complexity.
- The project must distinguish implemented controls from target architecture and avoid implying guarantees that are not enforced.
- A control plane can reduce risk but cannot guarantee that models, providers, or external systems are correct or safe.

## Implementation status

The decision is reflected in the repository's architecture and initial modules. The complete authenticated request-to-execution path, safe patch application, validation, and final audit/report flow are not yet implemented. Track those items in [ROADMAP.md](../../ROADMAP.md).

## References

- [Rill README](../../README.md)
- [Rill architecture](../../ARCHITECTURE.md)
- [Engineering Registry](../../engineering-registry.json)
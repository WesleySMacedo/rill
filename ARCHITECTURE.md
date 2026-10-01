# Rill Architecture

This document separates **current repository behavior** from the **target architecture**. Diagrams describe intended component relationships; they are not evidence that the current runtime is production-ready.

## Current implementation boundary

The repository contains deterministic classification, registry/context resolution, role modules, policy and gateway primitives, HITL persistence use cases, an MCP stdio process, telemetry adapters, and a Cloudflare Workflow class. The current `POST /api/internal/rill/requests` route calls the request classifier/context resolver only. It does not authenticate the service account, persist an execution, or start the Workflow. The Workflow executes an Agent Loop in dry-run mode and, after approval, currently returns a completed result without applying a change or running post-execution tests.

The executor is a prototype: its worker does not yet apply approved patch content safely. The MCP tool catalog includes execution/proposal/report reads, while the inspected HTTP server currently implements only request creation. These gaps are first-class roadmap items, not omitted diagram details.

## Target trust boundary

Rill is the authority boundary. Clients submit intent; models and specialists return candidate plans, proposals, or reviews. Deterministic policy code authorizes context and effects. Human decisions are external inputs. An executor must verify the exact approved proposal and current mission state before mutation.

## 1. High-Level Architecture

Target architecture:

```mermaid
flowchart LR
    U[User] --> C[Client: MCP / API]
    C --> I[Authenticated ingress]
    I --> MI[Mission Intelligence]
    MI --> MR[Mission Router]
    MR --> ER[Engineering Registry]
    MR --> CR[Context Resolver]
    ER --> PE[Policy evaluation]
    CR --> PE
    PE --> WF[Workflow Engine]
    WF --> A[Architect]
    A --> B[Builder]
    B --> R[Reviewer]
    R --> H{HITL required?}
    H -- yes --> HA[Human Approval]
    H -- no --> EG[Execution gate]
    HA -- approved --> EG
    HA -- rejected / changes --> END[Terminal or amendment]
    EG --> EX[Executor]
    EX --> V[Validation]
    V --> AU[Audit and report]
    PE -. model request .-> GW[OpenRouter Gateway]
    GW -. sanitized events .-> LF[Langfuse]
    WF -. state / tickets .-> DB[Supabase persistence]
```

**Caption:** The target separates request intake, deterministic authority, model-backed work, human decisions, and effectful execution. Dashed edges are supporting integrations, not policy authorities.

## 2. Mission Lifecycle

Target mission lifecycle. `PROPOSAL_READY` is a desired explicit milestone; it is not in the current `RillExecutionState` union.

```mermaid
flowchart TD
    A[CLASSIFIED] --> B[CONTEXT_READY]
    B --> C[PLANNED]
    C --> D[PROPOSAL_READY]
    D --> E[PROPOSAL_REVIEWED]
    E --> F{Registry approval required?}
    F -- yes --> G[AWAITING_HUMAN_APPROVAL]
    F -- no --> I[EXECUTING]
    G -- APPROVED --> I
    G -- REJECTED --> R[REJECTED]
    G -- REQUESTED_CHANGES --> M[REQUESTED_CHANGES]
    I --> J[VALIDATING]
    J --> K[COMPLETED]
    A --> X[BLOCKED]
    B --> X
    C --> Y[FAILED]
    I --> Y
    J --> Y
```

**Caption:** Approval is conditional on policy. A rejected or changed proposal does not proceed to execution.

## 3. State Machine

This state machine matches the values and transition table currently declared in `src/contracts/rill-transition.contract.ts`. It does not imply that the Workflow persists every transition correctly today.

```mermaid
stateDiagram-v2
    [*] --> CLASSIFIED
    CLASSIFIED --> CONTEXT_READY
    CLASSIFIED --> BLOCKED
    CLASSIFIED --> FAILED
    CONTEXT_READY --> PLANNED
    CONTEXT_READY --> BLOCKED
    CONTEXT_READY --> FAILED
    PLANNED --> PROPOSAL_REVIEWED
    PLANNED --> BLOCKED
    PLANNED --> FAILED
    PROPOSAL_REVIEWED --> AWAITING_HUMAN_APPROVAL
    PROPOSAL_REVIEWED --> BLOCKED
    PROPOSAL_REVIEWED --> FAILED
    AWAITING_HUMAN_APPROVAL --> EXECUTING: APPROVED
    AWAITING_HUMAN_APPROVAL --> REJECTED
    AWAITING_HUMAN_APPROVAL --> REQUESTED_CHANGES
    AWAITING_HUMAN_APPROVAL --> CANCELED
    AWAITING_HUMAN_APPROVAL --> FAILED
    EXECUTING --> VALIDATING
    EXECUTING --> FAILED
    EXECUTING --> BLOCKED
    VALIDATING --> COMPLETED
    VALIDATING --> FAILED
    VALIDATING --> BLOCKED
    COMPLETED --> [*]
    BLOCKED --> [*]
    FAILED --> [*]
    REJECTED --> [*]
    REQUESTED_CHANGES --> [*]
    CANCELED --> [*]
```

**Caption:** `EXECUTING` can begin from `AWAITING_HUMAN_APPROVAL` only with an `APPROVED` decision. `PROPOSAL_READY`, `MODEL_RETRY`, `MODEL_TIMEOUT`, `MODEL_FALLBACK`, `PROVIDER_DEGRADED`, `RETRY_BUILD`, and `APPROVAL_EXPIRED` are not current mission-state values.

## 4. Human Approval Flow

Target approval flow:

```mermaid
sequenceDiagram
    autonumber
    actor Human
    participant Client
    participant Rill
    participant Registry
    participant Reviewer
    participant Store as Persistence
    participant Workflow
    participant Executor

    Client->>Rill: Submit mission request
    Rill->>Registry: Resolve action, scope, approval policy
    Registry-->>Rill: Policy result and constraints
    Rill->>Reviewer: Review proposal against constraints
    Reviewer-->>Rill: Review outcome and proposal hash
    Rill->>Store: Persist proposal and pending decision
    Rill->>Workflow: Wait for decision
    Human->>Client: Approve, reject, or request changes
    Client->>Rill: Submit authenticated decision
    Rill->>Store: Persist actor, decision, timestamp
    Rill->>Workflow: Resume with decision
    alt Approved and hash/state still valid
        Workflow->>Executor: Execute approved proposal only
    else Rejected or changes requested
        Workflow-->>Client: Return non-execution outcome
    end
    Executor-->>Workflow: Execution evidence
```

**Caption:** The human decision is attributable, persisted, and separate from model output. Production API/UI wiring is not yet complete.

## 5. Runtime Governance Flow

```mermaid
flowchart TD
    REQ[Incoming request] --> VALID{Request schema valid?}
    VALID -- no --> BLOCK[Block and record reason]
    VALID -- yes --> CLASS[Deterministic intent and domain classification]
    CLASS --> REG{Registry match?}
    REG -- no --> BLOCK
    REG -- yes --> CTX[Resolve explicit targets and approved context]
    CTX --> SCOPE{Scope and context limits pass?}
    SCOPE -- no --> BLOCK
    SCOPE -- yes --> SAFE[Sanitize and minimize task DTO]
    SAFE --> MODEL{Model call permitted and budget available?}
    MODEL -- no --> BLOCK
    MODEL -- yes --> PROPOSE[Generate structured proposal]
    PROPOSE --> REVIEW[Review proposal and validate schema/scope]
    REVIEW --> APPROVAL{Approval required?}
    APPROVAL -- yes --> HUMAN[Wait for human decision]
    APPROVAL -- no --> GATE[Verify policy and proposal integrity]
    HUMAN -- reject / changes --> TERMINAL[Persist terminal or amendment outcome]
    HUMAN -- approve --> GATE
    GATE --> EXEC[Execute constrained operation]
    EXEC --> VALIDATE[Run required validations]
    VALIDATE --> AUDIT[Persist minimized audit and telemetry]
```

**Caption:** Every effectful operation is downstream of explicit authorization. The current request handler has not yet wired all these guards into one path.

## 6. Context Resolution Flow

```mermaid
flowchart TD
    TASK[Task and explicit target] --> ACTION[Resolve action/domain]
    ACTION --> MATCH{Registry entry exists?}
    MATCH -- no --> DENY[CONTEXT_BLOCKED]
    MATCH -- yes --> PARSE[Extract target paths]
    PARSE --> EXPLICIT{Target supplied?}
    EXPLICIT -- no --> EXPAND[CONTEXT_EXPANSION_REQUIRED]
    EXPLICIT -- yes --> FILE[Check existence and filesystem metadata]
    FILE --> PATH{Allowed, not forbidden, valid extension?}
    PATH -- no --> EXCLUDE[Exclude or block target with reason]
    PATH -- yes --> SUPPORT[Add registered domain context, playbook, and tests]
    SUPPORT --> LIMIT{File and token limits pass?}
    LIMIT -- no --> EXPAND
    LIMIT -- yes --> MANIFEST[Return context manifest]
```

**Caption:** The resolver decides context from policy data and file metadata; a model does not choose its own repository scope.

## 7. Sequence Diagram

Target end-to-end mission sequence:

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant Client as MCP Client
    participant API as Rill API
    participant Registry
    participant Context as Context Resolver
    participant Workflow
    participant Architect
    participant Builder
    participant Reviewer
    participant Gateway as Model Gateway
    participant HITL as Human Approval
    participant Executor
    participant Tests as Validator
    participant Audit

    User->>Client: Describe goal
    Client->>API: Create request with idempotency key
    API->>API: Authenticate client and validate request
    API->>Registry: Classify and resolve allowed action
    Registry-->>API: Policy entry
    API->>Context: Resolve explicit context
    Context-->>API: Context manifest or block
    API->>Workflow: Persist and start authorized mission
    Workflow->>Architect: Request read-only plan
    Architect->>Gateway: Sanitized planning DTO
    Gateway-->>Architect: Plan output
    Architect->>Builder: Plan and bounded targets
    Builder->>Gateway: Sanitized proposal DTO
    Gateway-->>Builder: Structured proposal
    Builder->>Reviewer: Proposal and policy constraints
    Reviewer-->>Workflow: Review outcome and proposal hash
    Workflow->>HITL: Request approval when required
    HITL-->>Workflow: Attributable decision
    Workflow->>Executor: Execute only approved hash
    Executor->>Tests: Changed files and validation plan
    Tests-->>Workflow: Test and scope evidence
    Workflow->>Audit: Persist outcome and telemetry references
    Audit-->>Client: Minimized report
```

**Caption:** This is the desired sequence, not the current request route behavior. See [ROADMAP.md](ROADMAP.md) for integration gaps.

## 8. Cost Governance Flow

```mermaid
flowchart TD
    REQ[Authorized model task] --> PROFILE[Resolve model profile from Registry]
    PROFILE --> LIMITS[Check context, output, and per-call limits]
    LIMITS --> ESTIMATE[Require finite cost estimate]
    ESTIMATE --> BUDGET{Estimated cost within remaining mission budget?}
    BUDGET -- no --> STOP[Block before provider call]
    BUDGET -- yes --> CALL[Call selected provider/model]
    CALL --> RESULT{Retryable failure?}
    RESULT -- yes --> RETRY[Check retry count and retry budget]
    RETRY --> BUDGET
    RESULT -- no --> USAGE[Record provider usage and reported cost]
    RETRY --> FALLBACK{Retry limit reached and fallback configured?}
    FALLBACK -- yes --> FALLBACK_BUDGET[Check fallback budget]
    FALLBACK_BUDGET --> CALL
    FALLBACK -- no --> FAIL[Return bounded failure]
    USAGE --> LEDGER[Update mission cost record]
    LEDGER --> TELEMETRY[Emit sanitized telemetry]
```

**Caption:** The code includes gateway-level estimated-budget checks and fallback/retry accounting. A durable mission-level cost ledger remains to be connected.

## 9. Mission Amendment Flow

An amendment is a new governed decision, not permission to silently mutate an already approved proposal.

```mermaid
flowchart TD
    CHANGE[Human or Reviewer requests changes] --> RECORD[Record REQUESTED_CHANGES and rationale]
    RECORD --> STOP[Do not execute prior proposal]
    STOP --> AMEND[Create amended proposal version]
    AMEND --> HASH[Compute new proposal hash]
    HASH --> REVIEW[Re-run registry, scope, and Reviewer checks]
    REVIEW --> APPROVAL{Policy requires approval?}
    APPROVAL -- yes --> WAIT[Request approval for amended hash]
    APPROVAL -- no --> GATE[Re-check execution gate]
    WAIT -- approved --> GATE
    WAIT -- rejected / changes --> CLOSED[Terminal outcome or another amendment]
    GATE --> EXEC[Execute amended proposal only]
```

**Caption:** Any semantic change invalidates the previous approval hash. Amendment/version persistence is a target capability and is not yet implemented end to end.

## Component map

| Concern | Source location | Current status |
| --- | --- | --- |
| Request classification | `src/classification/`, `src/runtime/rill-request-entrypoint.ts` | Implemented narrowly for AuditQ. |
| Registry and context | `engineering-registry.json`, `src/routing/` | Resolver and validation primitives implemented. |
| Model and cost routing | `src/gateway/`, `src/policies/budget.policy.ts` | Gateway capabilities implemented; mission wiring incomplete. |
| Specialists | `src/workers/` | Planning, proposal, and review modules exist. |
| Approval | `src/hitl/`, `src/infrastructure/` | Persistence/use-case primitives exist; end-to-end decision path incomplete. |
| Security | `src/security/` | Sanitizers, validators, authentication helper, and execution gate exist; ingress integration incomplete. |
| Workflow | `src/workflows/` | Workflow scaffold exists; no complete executor/validation lifecycle. |
| Observability | `src/telemetry/`, `src/runtime/` | Langfuse adapters and sanitization exist. |

## Diagram assets

The design material refers to `docs/architecture/*.png`, but that directory currently contains no PNGs in the repository checkout. This document keeps diagrams in Mermaid source so changes can be reviewed alongside code. Exported PNGs may be added later with source diagrams, captions, and an update path that avoids duplicated or stale architecture.
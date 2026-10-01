# Contributing to Rill

Thank you for helping improve Rill. Contributions should make AI-assisted work more governable, auditable, and constrained without giving authority to a model or client.

## Before you start

- Read the [README](README.md), [architecture guide](ARCHITECTURE.md), and [ADR 0001](docs/adr/0001-rill-is-a-control-plane.md).
- For a substantial feature or behavior change, open an issue or discussion first so scope and policy implications can be reviewed.
- For security vulnerabilities, do not open a public issue. Follow [SECURITY.md](SECURITY.md).
- Check the [roadmap](ROADMAP.md) for current implementation status. Existing modules do not necessarily imply an end-to-end production capability.

## Development setup

Requirements: Node.js and npm.

```bash
npm install
npm test
```

Useful commands:

```bash
npm run classify -- "Analise a tela em public/index.html"
npm run mcp
```

`npm run mcp` starts a stdio MCP server. It may call the configured `RILL_BASE_URL`; do not point it at a production service unless you understand the effects and have authorization.

## Contribution expectations

- Keep policy decisions deterministic where the system claims deterministic authorization.
- Fail closed on unknown domains, invalid scope, missing approval, malformed model output, or uncertain authorization.
- Never let a model approve its own proposal or expand its authorized scope.
- Keep proposed changes separate from effectful execution.
- Treat secrets and personal data as prohibited model context unless an explicit, reviewed policy permits otherwise.
- Update contracts, schema, tests, and documentation together when changing a public behavior or state transition.
- Do not claim production readiness based only on a unit-tested helper.
- Keep dependencies and generated files to the minimum needed for the change.
- Do not include credentials, real customer data, or sensitive traces in issues, commits, or tests.

## Pull requests

1. Keep the change focused and explain the user-visible or security-relevant behavior.
2. Add or update tests for changed policy, state, or security behavior.
3. Run `npm test` and report the result. If a test cannot be run, state why.
4. Update documentation and roadmap status where the implementation boundary changes.
5. Include migration notes for persisted schema or API changes.
6. Confirm that no secrets, unrelated generated output, or unreviewed scope expansion is included.

Pull requests are reviewed by maintainers. Maintainers may request changes, defer work, or close a proposal that conflicts with the project's security model or scope.

## Commit and review guidance

Write clear commit messages that describe the change. Avoid combining refactoring with behavior changes when separation improves review. Reviewers should prioritize correctness, authorization boundaries, backward compatibility, test evidence, and operational failure modes.

## Community standards

All contributors are expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md). By submitting a contribution, you agree that it may be distributed under the project's [Apache License 2.0](LICENSE).
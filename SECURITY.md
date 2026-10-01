# Security Policy

Rill is an early-stage project. Do not assume that the presence of a security module, workflow, policy, or test makes the current service safe for production use. In particular, the request endpoint's service-account authentication and the full approval-to-execution path are not yet wired end to end.

## Reporting a vulnerability

Please report suspected vulnerabilities privately. If GitHub private vulnerability reporting is enabled for this repository, use **Security → Report a vulnerability**. Otherwise, contact the maintainer through the contact channel published on the [Rill website](https://rill.wesleysmacedo.com). Do not disclose exploit details in a public issue or pull request.

Include, where safe:

- affected version, commit, or deployment;
- impact and prerequisites;
- a minimal reproduction or proof of concept;
- suggested mitigation, if known.

Do not include live credentials, personal data, customer payloads, or unredacted production traces. If a report contains sensitive data, tell the maintainer how to reach it without repeating the data in public channels.

## Scope

Security reports are welcome for vulnerabilities in Rill code, policy enforcement, authorization, context resolution, secret handling, execution gating, persistence, or telemetry redaction. Reports about third-party providers should be sent to the relevant provider as well; include only the Rill-specific impact in a report to this project.

## Response

The maintainer will acknowledge reports as capacity permits, assess severity and affected versions, coordinate a fix, and publish an advisory after a mitigation is available. This project does not currently promise a response-time SLA or a supported-version policy.

## Safe deployment guidance

- Do not expose the current request endpoint as an authorization boundary until authentication is enforced server-side.
- Use least-privilege credentials and keep secrets in runtime secret storage, never in source control.
- Do not send secrets, personal data, or unrestricted repository context to model providers.
- Restrict network access and provider permissions to the minimum required.
- Treat generated proposals and telemetry as potentially sensitive data.
- Review provider retention, processing, and residency terms before sending data.
- Do not enable autonomous mutation in production based solely on the current prototype executor.
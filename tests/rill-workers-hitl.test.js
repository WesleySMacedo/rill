import { describe, expect, it } from "vitest";
import { applyBuilderChanges, createBuilderProposal } from "../src/workers/builder.worker";
import { auditBuilderProposal, auditPostExecution } from "../src/workers/reviewer.worker";
import { promoteMemoryProposal, validateMemoryProposal } from "../src/memory/working-memory";
import { createReviewTicketService } from "../src/hitl/create-ticket";
import { approveTicketService } from "../src/hitl/approve-ticket";

describe("Rill Workers, Memory & HITL Services", () => {
	it("validates and promotes memory proposals safely", () => {
		const validProposal = {
			area: "frontend",
			status: "PROPOSED",
			knowledge: "Tabela AuditQ utiliza classes compactas.",
			evidence: "public/auditq-business.css",
		};
		expect(validateMemoryProposal(validProposal).valid).toBe(true);

		const promoted = promoteMemoryProposal(validProposal, true);
		expect(promoted.status).toBe("ACCEPTED");

		const sensitiveProposal = {
			area: "frontend",
			status: "PROPOSED",
			knowledge: "Secret key: api_key=12345678901234",
			evidence: "public/app.js",
		};
		expect(validateMemoryProposal(sensitiveProposal).valid).toBe(false);
	});

	it("creates builder proposals and audits them with reviewer worker", () => {
		const proposal = createBuilderProposal({
			action: "PATCH_UI",
			domain: "AuditQ",
			task: "Review UI",
			allowedPaths: ["public/index.html"],
			maxChangedFiles: 3,
			plan: ["Validar escopo"],
		});
		expect(proposal.status).toBe("PROPOSAL_CREATED");

		const audit = auditBuilderProposal({
			action: "PATCH_UI",
			domain: "AuditQ",
			proposal,
			allowedPaths: ["public/index.html"],
			forbiddenPaths: ["src/index.js"],
			maxChangedFiles: 3,
		});
		expect(audit.status).toBe("APPROVED_WITH_NOTES");
		expect(audit.approvedForHumanReview).toBe(true);
	});

	it("blocks application without human approval and permits when approved", () => {
		const proposal = createBuilderProposal({
			action: "PATCH_UI",
			domain: "AuditQ",
			task: "Review UI",
			allowedPaths: ["public/index.html"],
			maxChangedFiles: 3,
			plan: ["Validar escopo"],
		});

		const blockedResult = applyBuilderChanges({ proposal, allowedPaths: ["public/index.html"], humanApproved: false });
		expect(blockedResult.status).toBe("BLOCKED_NO_APPROVAL");

		const appliedResult = applyBuilderChanges({ proposal, allowedPaths: ["public/index.html"], humanApproved: true });
		expect(appliedResult.status).toBe("APPLIED");
		expect(appliedResult.filesChanged).toEqual(["public/index.html"]);

		const postAudit = auditPostExecution({ filesChanged: appliedResult.filesChanged, allowedPaths: ["public/index.html"] });
		expect(postAudit.status).toBe("PASSED");
	});

	it("manages HITL ticket creation and approval lifecycle", async () => {
		const ticket = await createReviewTicketService("exec-123", "Revisão de UI AuditQ", "HUMAN_APPROVAL_REQUIRED", ["public/index.html"]);
		expect(ticket.status).toBe("PENDING");

		const approved = await approveTicketService(ticket.ticketId, "Diretor da Obra", "Aprovado via VS Code");
		expect(approved?.status).toBe("APPROVED");
		expect(approved?.reviewer).toBe("Diretor da Obra");
	});
});

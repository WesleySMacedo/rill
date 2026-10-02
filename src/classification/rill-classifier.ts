import type { EngineeringAction } from "../routing/engineering-registry-resolver";

export type RillRequestSpecialist = "Planner" | "Builder" | "Reviewer";

export interface RillTaskClassification {
	action: EngineeringAction | null;
	domain: "AuditQ" | null;
	specialist: RillRequestSpecialist | null;
	reason: string;
}

export function classifyRillTask(task: string): RillTaskClassification {
	if (!/audit\s*q|auditq/i.test(task)) {
		return { action: null, domain: null, specialist: null, reason: "UNKNOWN_DOMAIN" };
	}
	if (/implement|implemente|corrija|altere|modifique|crie|patch/i.test(task)) {
		return { action: "PATCH_UI", domain: "AuditQ", specialist: "Builder", reason: "REGISTRY_CANDIDATE" };
	}
	if (/validat|valid[ae]|verifique os testes/i.test(task)) {
		return { action: "VALIDATE_CHANGE", domain: "AuditQ", specialist: "Reviewer", reason: "REGISTRY_CANDIDATE" };
	}
	if (/analy[sz]e|analise|verifique|revise|review|plan/i.test(task)) {
		return { action: "PLAN_CHANGE", domain: "AuditQ", specialist: "Planner", reason: "REGISTRY_CANDIDATE" };
	}
	return { action: null, domain: "AuditQ", specialist: null, reason: "UNKNOWN_ACTION" };
}
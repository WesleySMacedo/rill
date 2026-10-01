import type { MemoryEntry, MemoryValidationResult } from "./memory.contract";

const forbiddenMemoryPatterns = [
	/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/,
	/\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/,
	/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/,
	/\bBearer\s+[A-Za-z0-9._-]+\b/i,
	/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
	/(?:api[_-]?key|secret|password|access[_-]?token)\s*[:=]/i,
];

export function validateMemoryProposal(entry: MemoryEntry): MemoryValidationResult {
	if (!entry || typeof entry !== "object") {
		return { valid: false, errorCategory: "INVALID_MEMORY_ENTRY" };
	}
	if (!entry.area || !entry.knowledge || !entry.evidence) {
		return { valid: false, errorCategory: "MISSING_REQUIRED_FIELDS" };
	}
	const combinedText = `${entry.knowledge} ${entry.evidence}`;
	if (forbiddenMemoryPatterns.some((pattern) => pattern.test(combinedText))) {
		return { valid: false, errorCategory: "SECURITY_SENSITIVE_DATA_REJECTED" };
	}
	return { valid: true };
}

export function promoteMemoryProposal(entry: MemoryEntry, humanApproved: boolean): MemoryEntry {
	const validation = validateMemoryProposal(entry);
	if (!validation.valid || !humanApproved) {
		return { ...entry, status: "REJECTED" };
	}
	return {
		...entry,
		status: "ACCEPTED",
		date: entry.date ?? new Date().toISOString().slice(0, 10),
	};
}

export type MemoryArea = "frontend" | "backend" | "database" | "AuditQ";
export type MemoryStatus = "PROPOSED" | "ACCEPTED" | "REJECTED";

export interface MemoryEntry {
	area: MemoryArea;
	status: MemoryStatus;
	knowledge: string;
	evidence: string;
	origin?: string;
	confidence?: string;
	date?: string;
}

export interface MemoryValidationResult {
	valid: boolean;
	errorCategory?: string;
}

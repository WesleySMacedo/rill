export type ArchitectAction = "DISCOVER_CONTEXT" | "PLAN_CHANGE" | "PATCH_UI" | "VALIDATE_CHANGE";

export type ExecutionDecision = "ALLOWED" | "BLOCKED_BY_POLICY";

export interface ArchitectExecutionInput {
	action: ArchitectAction;
	domain: string;
	task: string;
	allowedPaths: string[];
}

export interface ArchitectExecutionResult {
	decision: ExecutionDecision;
	action: ArchitectAction;
	domain: string;
	plan: string[];
	reason?: string;
}

export interface BuilderProposalInput {
	action: string;
	domain: string;
	task: string;
	allowedPaths: string[];
	maxChangedFiles: number;
	plan: string[];
}

export interface BuilderProposalResult {
	status: "PROPOSAL_CREATED" | "BLOCKED_BY_SCOPE";
	summary: string;
	targetFiles: string[];
	proposedChanges: string[];
	acceptanceCriteria: string[];
	risks: string[];
	testsRecommended: string[];
}

export interface BuilderApplyInput {
	proposal: BuilderProposalResult;
	allowedPaths: string[];
	humanApproved: boolean;
}

export interface BuilderApplyResult {
	status: "APPLIED" | "BLOCKED_NO_APPROVAL" | "BLOCKED_BY_SCOPE";
	filesChanged: string[];
	changesReversible: boolean;
}

export interface ReviewerAuditInput {
	action: string;
	domain: string;
	proposal: BuilderProposalResult;
	allowedPaths: string[];
	forbiddenPaths: string[];
	maxChangedFiles: number;
}

export interface ReviewerAuditResult {
	status: "APPROVED_WITH_NOTES" | "CHANGES_REQUIRED" | "BLOCKED";
	findings: string[];
	approvedForHumanReview: boolean;
}

export interface ReviewerPostExecutionInput {
	filesChanged: string[];
	allowedPaths: string[];
	testResults?: { passed: number; failed: number };
}

export interface ReviewerPostExecutionResult {
	status: "PASSED" | "FAILED";
	findings: string[];
}


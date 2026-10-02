import type { WorkspacePermission } from "./state";

export interface WorkspaceApproval {
	rootPath: string;
	permissions: WorkspacePermission[];
}

export interface ConfirmationRequest {
	title: string;
	message: string;
	detail?: string;
	confirmLabel: string;
}

/**
 * Native user interaction. Every exposure of a folder and every remote-affecting
 * action goes through here; the default answer must always be "deny".
 */
export interface UserPrompter {
	approveWorkspace(request: { requestedBy: string; suggestedPath?: string; reason?: string }): Promise<WorkspaceApproval | null>;
	confirm(request: ConfirmationRequest): Promise<boolean>;
}

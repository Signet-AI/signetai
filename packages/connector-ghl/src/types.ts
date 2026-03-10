/**
 * GHL Signet Connector — Shared Types
 *
 * Entity models, OAuth token shapes, and connector config.
 */

// ============================================================================
// OAuth
// ============================================================================

export interface GHLOAuthTokens {
	access_token: string;
	refresh_token: string;
	token_type: "Bearer";
	expires_in: number; // seconds
	scope: string;
	locationId: string;
	userId: string;
	companyId: string;
	/** Unix ms when access_token expires */
	expires_at: number;
}

export interface GHLOAuthConfig {
	clientId: string;
	clientSecret: string;
	redirectUri: string;
	scopes: string[];
}

// ============================================================================
// Account / Location
// ============================================================================

export interface GHLLocation {
	id: string;
	name: string;
	email?: string;
	phone?: string;
	website?: string;
	address?: string;
	city?: string;
	state?: string;
	country?: string;
	timezone?: string;
	business?: {
		id: string;
		name: string;
	};
}

// ============================================================================
// Pipelines & Opportunities
// ============================================================================

export interface GHLPipeline {
	id: string;
	name: string;
	stages: GHLStage[];
	locationId: string;
	dateAdded: string;
	dateUpdated: string;
}

export interface GHLStage {
	id: string;
	name: string;
	position: number;
}

export interface GHLOpportunity {
	id: string;
	name: string;
	pipelineId: string;
	pipelineStageId: string;
	status: "open" | "won" | "lost" | "abandoned";
	monetaryValue?: number;
	contactId?: string;
	assignedTo?: string;
	createdAt: string;
	updatedAt: string;
}

// ============================================================================
// Contacts & Tags
// ============================================================================

export interface GHLContact {
	id: string;
	firstName?: string;
	lastName?: string;
	email?: string;
	phone?: string;
	tags?: string[];
	assignedTo?: string;
	locationId: string;
	createdAt: string;
	updatedAt: string;
}

export interface GHLTag {
	id: string;
	name: string;
}

// ============================================================================
// Workflows
// ============================================================================

export type WorkflowStatus = "published" | "draft" | "archived";

export interface GHLWorkflow {
	id: string;
	name: string;
	status: WorkflowStatus;
	version: number;
	createdAt: string;
	updatedAt: string;
	locationId: string;
}

// ============================================================================
// Calendars
// ============================================================================

export interface GHLCalendar {
	id: string;
	name: string;
	isActive: boolean;
	calendarType?: string;
	locationId: string;
}

// ============================================================================
// Funnels & Sites
// ============================================================================

export interface GHLFunnel {
	id: string;
	name: string;
	type: "funnel" | "website";
	isPublished: boolean;
	url?: string;
	locationId: string;
	dateAdded: string;
	dateUpdated: string;
}

// ============================================================================
// Custom Fields & Values
// ============================================================================

export interface GHLCustomField {
	id: string;
	name: string;
	fieldKey: string;
	dataType: string;
	locationId: string;
}

// ============================================================================
// Users
// ============================================================================

export interface GHLUser {
	id: string;
	name: string;
	email: string;
	phone?: string;
	role: string;
	locationIds: string[];
}

// ============================================================================
// Discovery Result
// ============================================================================

export interface GHLDiscoveryResult {
	locationId: string;
	locationName: string;
	discoveredAt: string;
	pipelines: GHLPipeline[];
	workflows: {
		total: number;
		published: number;
		draft: number;
		items: GHLWorkflow[];
	};
	contacts: {
		total: number;
		tagged: number;
		untagged: number;
	};
	tags: GHLTag[];
	calendars: {
		total: number;
		active: number;
		items: GHLCalendar[];
	};
	funnels: {
		total: number;
		published: number;
		items: GHLFunnel[];
	};
	users: GHLUser[];
	customFields: GHLCustomField[];
	opportunities: {
		total: number;
		open: number;
		won: number;
		lost: number;
		byPipeline: Record<string, { total: number; open: number }>;
	};
}

// ============================================================================
// Gap Analysis
// ============================================================================

export type GapSeverity = "critical" | "warning" | "info";
export type GapCategory =
	| "workflow"
	| "pipeline"
	| "contact"
	| "calendar"
	| "funnel"
	| "user"
	| "tag"
	| "custom-field";

export interface GHLGap {
	id: string;
	category: GapCategory;
	severity: GapSeverity;
	title: string;
	description: string;
	autoFixable: boolean;
	/** When autoFixable=true, the action to execute */
	fix?: GapFixAction;
	/** When autoFixable=false, human-readable instructions */
	humanInstructions?: string;
	entityId?: string;
	entityName?: string;
}

export type GapFixAction =
	| { type: "create_workflow"; payload: Record<string, unknown> }
	| { type: "add_tag"; payload: { name: string } }
	| { type: "create_pipeline"; payload: Record<string, unknown> }
	| { type: "update_workflow_status"; payload: { workflowId: string; status: WorkflowStatus } }
	| { type: "create_calendar"; payload: Record<string, unknown> };

export interface GHLGapAnalysisResult {
	locationId: string;
	analyzedAt: string;
	totalGaps: number;
	autoFixable: number;
	humanReview: number;
	critical: number;
	warning: number;
	info: number;
	gaps: GHLGap[];
}

// ============================================================================
// Connected Account (stored in DB)
// ============================================================================

export interface GHLConnectedAccount {
	id: string; // locationId
	locationName: string;
	companyId: string;
	userId: string;
	connectedAt: string;
	lastSyncAt: string | null;
	tokens: GHLOAuthTokens;
	healthScore: number | null;
	discoveryResult: GHLDiscoveryResult | null;
	gapAnalysis: GHLGapAnalysisResult | null;
}

// ============================================================================
// Connector Config
// ============================================================================

export interface GHLConnectorConfig {
	oauth: GHLOAuthConfig;
	/** Port of the Signet daemon (default 3850) */
	daemonPort?: number;
	/** Auto-sync interval in hours (default 24) */
	syncIntervalHours?: number;
	/** Whether to ingest memories on bootstrap (default true) */
	ingestOnBootstrap?: boolean;
}

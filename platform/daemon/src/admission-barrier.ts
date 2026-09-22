export {
	MigrationControlBoundary,
	WorkspaceAdmissionBarrier,
	MigrationWriterRegistry,
	WorkspaceMigrationRetryableError,
	withMigrationAdmission,
	type MigrationAdmission,
	WriterLease,
} from "./workspace-writer-barrier";
export type { AdmissionState, DrainBlockerReceipt, DrainResult } from "./workspace-writer-barrier";

/**
 * @signet/daemon
 * Background service for Signet
 */

export { createDbOwnerClient } from "./db-owner-client";
export type {
	DbOwnerClient,
	DbOwnerClientOptions,
	DbOwnerHealth,
	DbOwnerJobHandle,
	DbOwnerSubmitOptions,
} from "./db-owner-client";
export { recallThroughDbOwner } from "./db-owner-recall";

export {
	installService,
	uninstallService,
	startDaemon,
	stopDaemon,
	restartDaemon,
	isDaemonRunning,
	isServiceInstalled,
	getDaemonStatus,
	getDaemonLogs,
	type ServiceHealthStatus,
	type ServiceStatus,
} from "./service";

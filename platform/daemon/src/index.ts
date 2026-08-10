/**
 * @signet/daemon
 * Background service for Signet
 */

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

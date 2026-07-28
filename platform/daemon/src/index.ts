/**
 * @signet/daemon
 * Background service for Signet
 */

export {
	getDaemonLogs,
	getDaemonStatus,
	installService,
	isDaemonRunning,
	isServiceInstalled,
	restartDaemon,
	type ServiceStatus,
	startDaemon,
	stopDaemon,
	uninstallService,
} from "./service";

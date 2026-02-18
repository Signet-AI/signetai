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
  type ServiceStatus,
} from './service';

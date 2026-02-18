/**
 * Signet Daemon Service Installation
 * Handles systemd (Linux) and launchd (macOS) service management
 */

import { homedir, platform } from 'os';
import { join } from 'path';
import { 
  existsSync, 
  mkdirSync, 
  writeFileSync, 
  readFileSync, 
  unlinkSync,
  chmodSync
} from 'fs';
import { execSync, spawn } from 'child_process';

const AGENTS_DIR = join(homedir(), '.agents');
const DAEMON_DIR = join(AGENTS_DIR, '.daemon');
const PID_FILE = join(DAEMON_DIR, 'pid');
const LOG_DIR = join(DAEMON_DIR, 'logs');

// Platform-specific paths
const LAUNCHD_PLIST = join(homedir(), 'Library', 'LaunchAgents', 'ai.signet.daemon.plist');
const SYSTEMD_UNIT = join(homedir(), '.config', 'systemd', 'user', 'signet.service');

export interface ServiceStatus {
  installed: boolean;
  running: boolean;
  pid: number | null;
  uptime: number | null;
  port: number;
}

/**
 * Get the path to the daemon executable
 */
function getDaemonPath(): string {
  // Try to find the installed daemon
  const candidates = [
    join(__dirname, '..', '..', 'daemon', 'dist', 'daemon.js'),
    join(__dirname, '..', 'dist', 'daemon.js'),
    join(__dirname, 'daemon.js'),
  ];
  
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  
  // Fallback to npx/bunx
  return '@signet/daemon';
}

/**
 * Find bun executable (required - signet uses bun:sqlite)
 */
function getRuntime(): string {
  try {
    execSync('which bun', { encoding: 'utf-8' });
    return 'bun';
  } catch {
    console.error('Error: Bun is required to run Signet daemon (uses bun:sqlite)');
    console.error('Install Bun: curl -fsSL https://bun.sh/install | bash');
    process.exit(1);
  }
}

// ============================================================================
// macOS (launchd)
// ============================================================================

function generateLaunchdPlist(port: number = 3850): string {
  const runtime = getRuntime();
  const daemonPath = getDaemonPath();
  
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>ai.signet.daemon</string>
    
    <key>ProgramArguments</key>
    <array>
        <string>${runtime === 'bun' ? '/opt/homebrew/bin/bun' : '/usr/local/bin/node'}</string>
        <string>${daemonPath}</string>
    </array>
    
    <key>EnvironmentVariables</key>
    <dict>
        <key>SIGNET_PORT</key>
        <string>${port}</string>
        <key>SIGNET_PATH</key>
        <string>${AGENTS_DIR}</string>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    </dict>
    
    <key>RunAtLoad</key>
    <true/>
    
    <key>KeepAlive</key>
    <true/>
    
    <key>StandardOutPath</key>
    <string>${LOG_DIR}/daemon.out.log</string>
    
    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/daemon.err.log</string>
    
    <key>WorkingDirectory</key>
    <string>${AGENTS_DIR}</string>
</dict>
</plist>`;
}

async function installLaunchd(port: number = 3850): Promise<void> {
  const plistDir = join(homedir(), 'Library', 'LaunchAgents');
  mkdirSync(plistDir, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
  
  // Unload if already loaded
  try {
    execSync(`launchctl unload "${LAUNCHD_PLIST}" 2>/dev/null`);
  } catch {
    // Ignore - might not be loaded
  }
  
  // Write plist
  writeFileSync(LAUNCHD_PLIST, generateLaunchdPlist(port));
  
  // Load the service
  execSync(`launchctl load "${LAUNCHD_PLIST}"`);
}

async function uninstallLaunchd(): Promise<void> {
  if (!existsSync(LAUNCHD_PLIST)) {
    return;
  }
  
  try {
    execSync(`launchctl unload "${LAUNCHD_PLIST}"`);
  } catch {
    // Ignore
  }
  
  unlinkSync(LAUNCHD_PLIST);
}

function isLaunchdRunning(): boolean {
  try {
    const output = execSync('launchctl list ai.signet.daemon 2>/dev/null', { encoding: 'utf-8' });
    return !output.includes('Could not find');
  } catch {
    return false;
  }
}

// ============================================================================
// Linux (systemd)
// ============================================================================

function generateSystemdUnit(port: number = 3850): string {
  const runtime = getRuntime();
  const daemonPath = getDaemonPath();
  const runtimePath = runtime === 'bun' ? '/usr/bin/bun' : '/usr/bin/node';
  
  return `[Unit]
Description=Signet Daemon
After=network.target

[Service]
Type=simple
ExecStart=${runtimePath} ${daemonPath}
Environment=SIGNET_PORT=${port}
Environment=SIGNET_PATH=${AGENTS_DIR}
WorkingDirectory=${AGENTS_DIR}
Restart=on-failure
RestartSec=5

StandardOutput=append:${LOG_DIR}/daemon.out.log
StandardError=append:${LOG_DIR}/daemon.err.log

[Install]
WantedBy=default.target
`;
}

async function installSystemd(port: number = 3850): Promise<void> {
  const unitDir = join(homedir(), '.config', 'systemd', 'user');
  mkdirSync(unitDir, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
  
  // Stop if running
  try {
    execSync('systemctl --user stop signet.service 2>/dev/null');
  } catch {
    // Ignore
  }
  
  // Write unit file
  writeFileSync(SYSTEMD_UNIT, generateSystemdUnit(port));
  
  // Reload systemd
  execSync('systemctl --user daemon-reload');
  
  // Enable and start
  execSync('systemctl --user enable signet.service');
  execSync('systemctl --user start signet.service');
}

async function uninstallSystemd(): Promise<void> {
  try {
    execSync('systemctl --user stop signet.service 2>/dev/null');
    execSync('systemctl --user disable signet.service 2>/dev/null');
  } catch {
    // Ignore
  }
  
  if (existsSync(SYSTEMD_UNIT)) {
    unlinkSync(SYSTEMD_UNIT);
  }
  
  try {
    execSync('systemctl --user daemon-reload');
  } catch {
    // Ignore
  }
}

function isSystemdRunning(): boolean {
  try {
    const output = execSync('systemctl --user is-active signet.service 2>/dev/null', { encoding: 'utf-8' });
    return output.trim() === 'active';
  } catch {
    return false;
  }
}

// ============================================================================
// Direct Process Management (fallback)
// ============================================================================

async function startDirect(port: number = 3850): Promise<number> {
  mkdirSync(DAEMON_DIR, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
  
  const runtime = getRuntime();
  const daemonPath = getDaemonPath();
  
  const proc = spawn(runtime, [daemonPath], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      SIGNET_PORT: port.toString(),
      SIGNET_PATH: AGENTS_DIR,
    },
  });
  
  proc.unref();
  
  // Wait a moment for PID file to be written
  await new Promise(resolve => setTimeout(resolve, 500));
  
  return proc.pid || 0;
}

async function stopDirect(): Promise<void> {
  if (!existsSync(PID_FILE)) {
    return;
  }
  
  const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
  
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Process might already be dead
  }
  
  // Clean up PID file
  try {
    unlinkSync(PID_FILE);
  } catch {
    // Ignore
  }
}

function isDirectRunning(): boolean {
  if (!existsSync(PID_FILE)) {
    return false;
  }
  
  const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
  
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // Process doesn't exist, clean up stale PID file
    try {
      unlinkSync(PID_FILE);
    } catch {
      // Ignore
    }
    return false;
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Install the daemon as a system service
 */
export async function installService(port: number = 3850): Promise<void> {
  const os = platform();
  
  if (os === 'darwin') {
    await installLaunchd(port);
  } else if (os === 'linux') {
    await installSystemd(port);
  } else {
    // Windows or other - just start directly
    await startDirect(port);
  }
}

/**
 * Uninstall the daemon system service
 */
export async function uninstallService(): Promise<void> {
  const os = platform();
  
  if (os === 'darwin') {
    await uninstallLaunchd();
  } else if (os === 'linux') {
    await uninstallSystemd();
  }
  
  // Always stop direct process too
  await stopDirect();
}

/**
 * Start the daemon
 */
export async function startDaemon(port: number = 3850): Promise<void> {
  const os = platform();
  
  if (os === 'darwin' && existsSync(LAUNCHD_PLIST)) {
    execSync(`launchctl load "${LAUNCHD_PLIST}"`);
  } else if (os === 'linux' && existsSync(SYSTEMD_UNIT)) {
    execSync('systemctl --user start signet.service');
  } else {
    await startDirect(port);
  }
}

/**
 * Stop the daemon
 */
export async function stopDaemon(): Promise<void> {
  const os = platform();
  
  if (os === 'darwin' && existsSync(LAUNCHD_PLIST)) {
    try {
      execSync(`launchctl unload "${LAUNCHD_PLIST}"`);
    } catch {
      // Might not be loaded
    }
  } else if (os === 'linux' && existsSync(SYSTEMD_UNIT)) {
    try {
      execSync('systemctl --user stop signet.service');
    } catch {
      // Might not be running
    }
  }
  
  await stopDirect();
}

/**
 * Restart the daemon
 */
export async function restartDaemon(port: number = 3850): Promise<void> {
  await stopDaemon();
  await new Promise(resolve => setTimeout(resolve, 500));
  await startDaemon(port);
}

/**
 * Check if daemon is running
 */
export function isDaemonRunning(): boolean {
  const os = platform();
  
  if (os === 'darwin' && existsSync(LAUNCHD_PLIST)) {
    return isLaunchdRunning();
  } else if (os === 'linux' && existsSync(SYSTEMD_UNIT)) {
    return isSystemdRunning();
  }
  
  return isDirectRunning();
}

/**
 * Check if service is installed
 */
export function isServiceInstalled(): boolean {
  const os = platform();
  
  if (os === 'darwin') {
    return existsSync(LAUNCHD_PLIST);
  } else if (os === 'linux') {
    return existsSync(SYSTEMD_UNIT);
  }
  
  return false;
}

/**
 * Get comprehensive daemon status
 */
export async function getDaemonStatus(): Promise<ServiceStatus> {
  const running = isDaemonRunning();
  let pid: number | null = null;
  let uptime: number | null = null;
  
  if (running && existsSync(PID_FILE)) {
    try {
      pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
    } catch {
      // Ignore
    }
  }
  
  // Try to get uptime from the daemon API
  if (running) {
    try {
      const response = await fetch('http://localhost:3850/health');
      if (response.ok) {
        const data = await response.json() as { uptime?: number; pid?: number };
        uptime = data.uptime ?? null;
        if (!pid && data.pid) {
          pid = data.pid;
        }
      }
    } catch {
      // Daemon might be starting up
    }
  }
  
  return {
    installed: isServiceInstalled(),
    running,
    pid,
    uptime,
    port: 3850,
  };
}

/**
 * Get daemon logs
 */
export function getDaemonLogs(lines: number = 50): string[] {
  const logFile = join(LOG_DIR, `daemon-${new Date().toISOString().split('T')[0]}.log`);
  
  if (!existsSync(logFile)) {
    // Try stdout log
    const outLog = join(LOG_DIR, 'daemon.out.log');
    if (existsSync(outLog)) {
      const content = readFileSync(outLog, 'utf-8');
      return content.split('\n').slice(-lines);
    }
    return [];
  }
  
  const content = readFileSync(logFile, 'utf-8');
  return content.split('\n').slice(-lines);
}

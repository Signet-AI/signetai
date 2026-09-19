// src/index.ts
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  BaseConnector,
  atomicWriteJson,
  buildSignetRuntimeEnv,
  isChildOf,
  isJsonObject,
  isSignetGeneratedFile,
  readTrimmedEnv,
  resolveRemoteDaemonUrl,
  resolveSignetApiKey,
  resolveSignetWorkspacePath
} from "@signet/connector-base";
function expandHome(path) {
  if (path === "~")
    return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\"))
    return join(homedir(), path.slice(2));
  return path;
}
function loadIdentityMode(basePath) {
  const configPath = join(basePath, "agent.yaml");
  if (!existsSync(configPath))
    return "managed";
  try {
    const raw = readFileSync(configPath, "utf8");
    if (/^\s*(?:enabled|mode):\s*(?:false|off)\s*$/m.test(raw) || /identity:\s*\n(?:.|\n)*?mode:\s*off/m.test(raw))
      return "off";
    if (/mode:\s*passthrough\b/.test(raw))
      return "passthrough";
  } catch {}
  return "managed";
}
function hasValidIdentity(basePath) {
  if (loadIdentityMode(basePath) !== "managed")
    return true;
  return ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"].every((file) => existsSync(join(basePath, file)));
}
var SIGNET_FORGE_MARKER = "Managed by Signet (@signet/connector-forge)";
function getHomeDir() {
  const home = readTrimmedEnv("HOME");
  return home ?? homedir();
}
function readJsonObject(path) {
  if (!existsSync(path))
    return {};
  const parsed = JSON.parse(readFileSync(path, "utf-8"));
  if (!isJsonObject(parsed)) {
    throw new Error("Forge MCP config must be a top-level object");
  }
  return parsed;
}
function readMcpServers(config) {
  if (!("mcpServers" in config))
    return {};
  if (isJsonObject(config.mcpServers))
    return { ...config.mcpServers };
  throw new Error("Forge MCP config field 'mcpServers' must be an object");
}
function buildMcpServer(basePath) {
  const remoteDaemonUrl = resolveRemoteDaemonUrl();
  if (remoteDaemonUrl) {
    const apiKey = resolveSignetApiKey();
    return {
      url: `${remoteDaemonUrl}/mcp`,
      ...apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}
    };
  }
  return {
    command: "signet-mcp",
    env: buildSignetRuntimeEnv({ basePath })
  };
}

class ForgeConnector extends BaseConnector {
  name = "ForgeCode";
  harnessId = "forge";
  getIconAsset() {
    return "forge.svg";
  }
  getForgeHome() {
    const configured = readTrimmedEnv("FORGE_CONFIG");
    if (configured)
      return resolve(expandHome(configured));
    const legacyPath = join(getHomeDir(), "forge");
    if (existsSync(legacyPath))
      return legacyPath;
    return join(getHomeDir(), ".forge");
  }
  getConfigPath() {
    return this.getMcpConfigPath();
  }
  async install(basePath) {
    const filesWritten = [];
    const configsPatched = [];
    const expandedBasePath = expandHome(basePath || join(getHomeDir(), ".agents"));
    const identityMode = loadIdentityMode(expandedBasePath);
    if (!hasValidIdentity(expandedBasePath)) {
      return {
        success: false,
        message: `No valid Signet identity found at ${expandedBasePath}`,
        filesWritten,
        configsPatched
      };
    }
    let config;
    try {
      config = readJsonObject(this.getMcpConfigPath());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        message: `Failed to read ForgeCode MCP config: ${message}`,
        filesWritten,
        configsPatched
      };
    }
    const strippedAgentsPath = this.stripLegacySignetBlock(expandedBasePath);
    if (strippedAgentsPath !== null)
      filesWritten.push(strippedAgentsPath);
    const forgeHome = this.getForgeHome();
    mkdirSync(forgeHome, { recursive: true });
    if (identityMode === "managed") {
      const agentsPath = this.generateAgentsMd(expandedBasePath);
      if (agentsPath)
        filesWritten.push(agentsPath);
    } else {
      const staleAgentsPath = this.getAgentsPath();
      if (existsSync(staleAgentsPath)) {
        try {
          const raw = readFileSync(staleAgentsPath, "utf-8");
          if (isSignetGeneratedFile(raw) || raw.includes(SIGNET_FORGE_MARKER))
            rmSync(staleAgentsPath);
        } catch {}
      }
    }
    try {
      this.registerMcpServer(config, expandedBasePath);
      atomicWriteJson(this.getMcpConfigPath(), config);
      configsPatched.push(this.getMcpConfigPath());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        message: `ForgeCode integration install failed: ${message}`,
        filesWritten,
        configsPatched
      };
    }
    const skillsSource = join(expandedBasePath, "skills");
    if (existsSync(skillsSource)) {
      this.symlinkSkills(skillsSource, this.getSkillsPath());
    }
    return {
      success: true,
      message: "ForgeCode integration installed successfully",
      filesWritten,
      configsPatched
    };
  }
  async uninstall() {
    const filesRemoved = [];
    const configsPatched = [];
    const agentsPath = this.getAgentsPath();
    if (existsSync(agentsPath)) {
      try {
        const raw = readFileSync(agentsPath, "utf-8");
        if (isSignetGeneratedFile(raw) || raw.includes(SIGNET_FORGE_MARKER)) {
          rmSync(agentsPath, { force: true });
          filesRemoved.push(agentsPath);
        }
      } catch {}
    }
    let config = null;
    if (existsSync(this.getMcpConfigPath())) {
      try {
        config = readJsonObject(this.getMcpConfigPath());
      } catch {
        config = null;
      }
    }
    const signetPath = config ? this.extractSignetPath(config) : null;
    this.removeSkillSymlinks(filesRemoved, signetPath);
    if (config) {
      try {
        const patched = this.removeMcpServer(config);
        if (patched) {
          if (Object.keys(config).length === 0) {
            rmSync(this.getMcpConfigPath(), { force: true });
            filesRemoved.push(this.getMcpConfigPath());
          } else {
            atomicWriteJson(this.getMcpConfigPath(), config);
            configsPatched.push(this.getMcpConfigPath());
          }
        }
      } catch {}
    }
    return { filesRemoved, configsPatched };
  }
  isInstalled() {
    try {
      const config = readJsonObject(this.getMcpConfigPath());
      return "signet" in readMcpServers(config);
    } catch {
      return false;
    }
  }
  static isHarnessInstalled() {
    const home = getHomeDir();
    return existsSync(readTrimmedEnv("FORGE_CONFIG") ?? "") || existsSync(join(home, "forge", ".mcp.json")) || existsSync(join(home, ".forge", ".mcp.json")) || existsSync(join(home, "forge")) || existsSync(join(home, ".forge"));
  }
  getAgentsPath() {
    return join(this.getForgeHome(), "AGENTS.md");
  }
  getSkillsPath() {
    return join(this.getForgeHome(), "skills");
  }
  getMcpConfigPath() {
    return join(this.getForgeHome(), ".mcp.json");
  }
  generateAgentsMd(basePath) {
    const sourcePath = join(basePath, "AGENTS.md");
    if (!existsSync(sourcePath))
      return null;
    const raw = readFileSync(sourcePath, "utf-8");
    const userContent = this.stripSignetBlock(raw).trim();
    const extras = this.composeIdentityExtras(basePath);
    const body = extras ? `${userContent}${extras}` : userContent;
    const header = this.generateHeader(sourcePath, this.name);
    const targetPath = this.getAgentsPath();
    writeFileSync(targetPath, `# ${SIGNET_FORGE_MARKER}
${header}${body}
`, "utf-8");
    return targetPath;
  }
  registerMcpServer(config, basePath) {
    const servers = readMcpServers(config);
    servers.signet = buildMcpServer(basePath);
    config.mcpServers = servers;
  }
  removeMcpServer(config) {
    const servers = readMcpServers(config);
    if (!("signet" in servers))
      return false;
    const { signet: _, ...rest } = servers;
    if (Object.keys(rest).length === 0) {
      Reflect.deleteProperty(config, "mcpServers");
    } else {
      config.mcpServers = rest;
    }
    return true;
  }
  extractSignetPath(config) {
    const servers = config.mcpServers;
    if (!isJsonObject(servers))
      return null;
    const signet = servers.signet;
    if (!isJsonObject(signet))
      return null;
    const env = signet.env;
    if (!isJsonObject(env))
      return null;
    const value = env.SIGNET_PATH;
    return typeof value === "string" && value.length > 0 ? value : null;
  }
  removeSkillSymlinks(filesRemoved, signetPath) {
    const skillsDir = this.getSkillsPath();
    if (!existsSync(skillsDir))
      return;
    const skillsSource = resolve(signetPath ?? resolveSignetWorkspacePath(), "skills");
    let entries;
    try {
      entries = readdirSync(skillsDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = join(skillsDir, entry);
      try {
        if (!lstatSync(entryPath).isSymbolicLink())
          continue;
        const rawTarget = readlinkSync(entryPath);
        const target = resolve(skillsDir, rawTarget);
        if (!isChildOf(target, skillsSource))
          continue;
        unlinkSync(entryPath);
        filesRemoved.push(entryPath);
      } catch {}
    }
    try {
      if (readdirSync(skillsDir).length === 0)
        rmSync(skillsDir, { recursive: true, force: true });
    } catch {}
  }
}
var forgeConnector = new ForgeConnector;
var src_default = ForgeConnector;
export {
  forgeConnector,
  src_default as default,
  ForgeConnector
};

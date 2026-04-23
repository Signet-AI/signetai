/**
 * Widget HTML generation — uses an LLM to produce interactive HTML
 * widgets from MCP server probe results.
 *
 * Generated widgets render inside sandboxed iframes with Signet's
 * design tokens pre-injected. The LLM receives tool/resource metadata
 * and produces body-only HTML that uses the bridge API.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createEvent, eventBus } from "./event-bus";
import { logger } from "./logger";
import { loadProbeResult } from "./mcp-probe";
import { getWidgetProvider } from "./llm";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function agentsDir(): string {
	return process.env.SIGNET_PATH || join(homedir(), ".agents");
}

export function widgetDir(): string {
	return join(agentsDir(), "marketplace", "widgets");
}

function widgetPath(serverId: string): string {
	return join(widgetDir(), `${serverId}.html`);
}

function ensureWidgetDir(): void {
	const dir = widgetDir();
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const WIDGET_SYSTEM_PROMPT = `Generate an interactive HTML widget for an MCP server. The widget renders inside a sandboxed iframe with Signet's design tokens pre-injected.

## Available CSS Variables

--sig-bg              Background color
--sig-surface         Surface color (cards, panels)
--sig-surface-raised  Elevated surface color
--sig-border          Default border color
--sig-border-strong   Strong border color
--sig-text            Default text color
--sig-text-bright     Bright/emphasized text
--sig-text-muted      Muted/secondary text
--sig-accent          Accent color
--sig-highlight       Highlight background
--sig-highlight-text  Highlight text color
--sig-electric        Electric accent (glow effects)
--sig-font-mono       Monospace font family
--sig-font-display    Display font family
--sig-space-xs        Extra-small spacing (4px)
--sig-space-sm        Small spacing (8px)
--sig-space-md        Medium spacing (16px)
--sig-space-lg        Large spacing (24px)

## Available Utility Classes

.sig-panel            Bordered surface panel with padding
.sig-switch           Toggle switch element
.sig-badge            Small status badge
.sig-label            Form label
.sig-eyebrow          Small uppercase section label
.sig-heading          Section heading
.sig-readout          Numeric readout display
.sig-data             Data/value text (mono)
.sig-groove           Inset groove separator
.sig-divider          Horizontal divider line
.sig-glow             Glow effect on element
.sig-highlight-text   Highlighted text span
.sig-highlight-badge  Highlighted badge variant

## Bridge API

window.signet.callTool(toolName, args)  — Call an MCP tool. Returns Promise<{ content: unknown }>
window.signet.readResource(uri)         — Read an MCP resource. Returns Promise<{ contents: unknown }>

## AI Agent Cursor (Page-Agent)

Every widget automatically has an AI agent cursor that can visually click buttons and fill forms.
To make your widget work well with the agent cursor:

- Use semantic HTML: <button>, <input>, <select>, <textarea>, <a> — the agent identifies these automatically
- Add descriptive text content to buttons: <button>+ Add Contact</button> not <button><svg/></button>
- Add placeholder and name attributes to inputs: <input name="firstName" placeholder="First name">
- Use <label for="id"> to associate labels with form fields
- Keep forms simple and linear — avoid complex multi-step wizards
- Use data-action or aria-label on custom interactive elements that aren't standard HTML
- Avoid onclick on <div>/<span> — use <button> instead (agent detects buttons automatically)
- Don't rely on hover states for critical functionality — the agent can click but not hover-inspect

## Constraints

- No external URLs or fetch calls — all data comes through the bridge API
- No iframes
- Responsive to container width
- Use the provided CSS variables for ALL styling (colors, spacing, fonts)
- Generate ONLY the body content (no DOCTYPE, html, head, or body tags — those are added by the host)
- Use inline <style> tags for custom CSS; reference var(--sig-*) tokens
- Use <script> tags for interactivity

## Example

<style>
  .tool-grid { display: grid; gap: var(--sig-space-sm); padding: var(--sig-space-md); }
  .tool-btn {
    background: var(--sig-surface);
    border: 1px solid var(--sig-border);
    color: var(--sig-text-bright);
    padding: var(--sig-space-sm) var(--sig-space-md);
    border-radius: 6px;
    cursor: pointer;
    font-family: var(--sig-font-mono);
  }
  .tool-btn:hover { border-color: var(--sig-accent); }
  .result-area {
    background: var(--sig-surface);
    border: 1px solid var(--sig-border);
    border-radius: 6px;
    padding: var(--sig-space-md);
    font-family: var(--sig-font-mono);
    color: var(--sig-text);
    white-space: pre-wrap;
    min-height: 80px;
    margin-top: var(--sig-space-sm);
  }
</style>
<div class="tool-grid">
  <span class="sig-eyebrow">Tools</span>
  <button class="tool-btn" onclick="runTool('get_status')">Get Status</button>
  <button class="tool-btn" onclick="runTool('list_items')">List Items</button>
  <div class="sig-divider"></div>
  <span class="sig-eyebrow">Result</span>
  <div id="result" class="result-area">Click a tool to see output</div>
</div>
<script>
  async function runTool(name) {
    const el = document.getElementById('result');
    el.textContent = 'Loading...';
    try {
      const res = await window.signet.callTool(name, {});
      el.textContent = JSON.stringify(res.content, null, 2);
    } catch (err) {
      el.textContent = 'Error: ' + err.message;
    }
  }
</script>`;

// ---------------------------------------------------------------------------
// User prompt builder
// ---------------------------------------------------------------------------

function buildUserPrompt(
	name: string,
	tools: ReadonlyArray<{ name: string; description: string; inputSchema: unknown }>,
	resources: ReadonlyArray<{ uri: string; name: string; description?: string }>,
): string {
	const toolLines = tools.map((t) => {
		const schema = t.inputSchema ? ` (args: ${JSON.stringify(t.inputSchema)})` : "";
		return `- ${t.name}: ${t.description}${schema}`;
	});

	const resourceLines = resources.map((r) => `- ${r.uri}: ${r.name}${r.description ? ` - ${r.description}` : ""}`);

	const parts = [`Server: "${name}"\n`];

	if (toolLines.length > 0) {
		parts.push(`Tools:\n${toolLines.join("\n")}\n`);
	}

	if (resourceLines.length > 0) {
		parts.push(`Resources:\n${resourceLines.join("\n")}\n`);
	}

	parts.push(
		"Generate an interactive HTML widget for this server. Include buttons/forms to invoke each tool and display results.",
	);

	return parts.join("\n");
}

// ---------------------------------------------------------------------------
// HTML extraction from LLM response
// ---------------------------------------------------------------------------

const HTML_FENCE_RE = /```html\s*([\s\S]*?)```/;
const BODY_RE = /<body[^>]*>([\s\S]*?)<\/body>/i;
const TAG_RE = /<[a-z][^>]*>/i;

function extractHtml(raw: string): string | null {
	// 1. Check for ```html fences
	const fenced = raw.match(HTML_FENCE_RE);
	if (fenced) {
		const content = fenced[1].trim();
		if (content.length > 0) return content;
	}

	// 2. Check for <html>...</html> — extract body
	const body = raw.match(BODY_RE);
	if (body) {
		const content = body[1].trim();
		if (content.length > 0) return content;
	}

	// 3. Use raw response if it contains at least one HTML tag
	const trimmed = raw.trim();
	if (TAG_RE.test(trimmed)) return trimmed;

	return null;
}

// ---------------------------------------------------------------------------
// Disk cache operations
// ---------------------------------------------------------------------------

export function loadCachedWidget(serverId: string): string | null {
	const path = widgetPath(serverId);
	if (!existsSync(path)) return null;

	try {
		const content = readFileSync(path, "utf-8");
		return content.length > 0 ? content : null;
	} catch {
		return null;
	}
}

export function deleteCachedWidget(serverId: string): boolean {
	const path = widgetPath(serverId);
	if (!existsSync(path)) return false;

	try {
		unlinkSync(path);
		logger.info("widget", `Deleted cached widget for ${serverId}`);
		return true;
	} catch {
		logger.warn("widget", `Failed to delete widget for ${serverId}`);
		return false;
	}
}

// ---------------------------------------------------------------------------
// Main generation
// ---------------------------------------------------------------------------

export async function generateWidgetHtml(serverId: string): Promise<string> {
	const probe = loadProbeResult(serverId);
	if (!probe) {
		throw new Error(`No probe result found for server: ${serverId}`);
	}

	if (!probe.ok) {
		throw new Error(`Server probe failed for ${serverId}: ${probe.error ?? "unknown error"}`);
	}

	const tools = probe.autoCard.tools.map((t: { name: string; description: string; inputSchema: unknown }) => ({
		name: t.name,
		description: t.description,
		inputSchema: t.inputSchema,
	}));

	const resources = probe.autoCard.resources.map((r: { uri: string; name: string; description?: string }) => ({
		uri: r.uri,
		name: r.name,
		description: r.description,
	}));

	if (tools.length === 0 && resources.length === 0) {
		throw new Error(`Server ${serverId} has no tools or resources to generate a widget for`);
	}

	const name = probe.autoCard.name;
	const prompt = `${WIDGET_SYSTEM_PROMPT}\n\n---\n\n${buildUserPrompt(name, tools, resources)}`;

	logger.info("widget", `Generating widget for ${serverId}`, {
		tools: tools.length,
		resources: resources.length,
	});

	const provider = getWidgetProvider();
	let raw: string;
	try {
		raw = await provider.generate(prompt, { maxTokens: 4096 });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.warn("widget", `LLM generation failed for ${serverId}`, { error: msg });
		throw new Error(`Widget LLM generation failed: ${msg}`);
	}

	const html = extractHtml(raw);
	if (!html) {
		throw new Error("LLM response did not contain valid HTML");
	}

	// Write to disk
	ensureWidgetDir();
	await Bun.write(widgetPath(serverId), html);

	logger.info("widget", `Widget generated for ${serverId}`, {
		size: html.length,
	});

	// Emit success event
	eventBus.emit(
		createEvent("system", "widget.generated", {
			serverId,
			success: true,
		}),
	);

	return html;
}

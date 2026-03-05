/**
 * Suggested aspect names per entity type.
 *
 * Used in the structural classification prompt (pass 2a) to guide the
 * LLM toward consistent, useful aspect names.
 */

export const ASPECT_SUGGESTIONS: Readonly<Record<string, readonly string[]>> = {
	project: [
		"architecture", "dependencies", "deployment", "auth",
		"data model", "testing", "team", "configuration",
		"development workflow", "api", "frontend", "backend",
		"infrastructure", "security",
	],
	person: [
		"preferences", "communication style", "expertise",
		"projects", "decision patterns", "background",
		"boundaries", "work habits",
	],
	tool: [
		"capabilities", "configuration", "integration",
		"usage patterns", "limitations",
	],
	system: [
		"architecture", "endpoints", "configuration",
		"dependencies", "security", "monitoring",
	],
	concept: [
		"definition", "relationships", "applications",
		"constraints",
	],
	skill: [
		"capabilities", "usage", "configuration",
		"triggers", "limitations",
	],
	task: [
		"requirements", "dependencies", "status",
		"blockers", "deliverables",
	],
	unknown: [
		"general", "relationships", "properties",
	],
};

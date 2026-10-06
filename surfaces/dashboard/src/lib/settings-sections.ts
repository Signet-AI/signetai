export const SETTINGS_SECTIONS = [
	"workspace",
	"network",
	"inference",
	"secrets",
	"api-keys",
	"connectors",
	"logs",
	"advanced",
	"licenses",
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

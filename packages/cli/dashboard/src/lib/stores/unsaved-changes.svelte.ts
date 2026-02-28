export const unsaved = $state({
	configDirty: false,
	settingsDirty: false,
});

export function setConfigDirty(value: boolean): void {
	unsaved.configDirty = value;
}

export function setSettingsDirty(value: boolean): void {
	unsaved.settingsDirty = value;
}

export function hasUnsavedChanges(): boolean {
	return unsaved.configDirty || unsaved.settingsDirty;
}

function changedAreas(): string {
	const areas: string[] = [];
	if (unsaved.configDirty) areas.push("Config");
	if (unsaved.settingsDirty) areas.push("Settings");
	return areas.join(" and ");
}

export function confirmDiscardChanges(action: string): boolean {
	if (!hasUnsavedChanges()) return true;
	if (typeof window === "undefined") return true;

	const areaLabel = changedAreas();
	return window.confirm(
		`You have unsaved changes in ${areaLabel}. Leave anyway to ${action}?`,
	);
}

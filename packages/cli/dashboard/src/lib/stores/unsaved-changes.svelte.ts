export const unsaved = $state({
	settingsDirty: false,
});

export function setConfigDirty(_value: boolean): void {
	// No-op: identity file dirty state is now tracked within IdentityPanel
	// and rolled up into settingsDirty via the unified SettingsTab.
}

export function setSettingsDirty(value: boolean): void {
	unsaved.settingsDirty = value;
}

export function hasUnsavedChanges(): boolean {
	return unsaved.settingsDirty;
}

export function confirmDiscardChanges(action: string): boolean {
	if (!hasUnsavedChanges()) return true;
	if (typeof window === "undefined") return true;

	return window.confirm(
		`You have unsaved changes in Settings. Leave anyway to ${action}?`,
	);
}

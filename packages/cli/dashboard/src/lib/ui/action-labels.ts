export const ActionLabels = {
	Save: "Save",
	Reset: "Reset",
	Clear: "Clear",
	Refresh: "Refresh",
	Add: "Add",
	Delete: "Delete",
	Cancel: "Cancel",
	Close: "Close",
	Back: "Back",
	Copy: "Copy",
	CopyJson: "Copy JSON",
	Search: "Search",
	Filter: "Filter",
	Unlock: "Unlock",
} as const;

export type ActionKey = keyof typeof ActionLabels;

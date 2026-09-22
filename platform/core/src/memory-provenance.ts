export const DAEMON_DERIVED_MEMORY_SOURCE_TYPES = [
	"extract",
	"aggregate-recall",
	"session_end",
	"checkpoint",
	"dreaming",
] as const;

export function isDaemonDerivedMemorySourceType(sourceType: string | null | undefined): boolean {
	return (
		sourceType !== null &&
		sourceType !== undefined &&
		(DAEMON_DERIVED_MEMORY_SOURCE_TYPES as readonly string[]).includes(sourceType)
	);
}

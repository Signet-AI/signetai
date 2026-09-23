export const FRESH_RUST_CORE_EVIDENCE_MARKER = "backend=fresh-rust artifact=signet-core-test-driver process=transport";

type FreshRustCoreEvidence = {
	backend: string;
	artifact: string;
	process: string;
	driver: string;
	operation: string;
	status: string;
};

export function formatFreshRustCoreEvidence(driver: string, operation: string): string {
	const record: FreshRustCoreEvidence = {
		backend: "fresh-rust",
		artifact: "signet-core-test-driver",
		process: "transport",
		driver,
		operation,
		status: "ok",
	};
	return `${JSON.stringify(record)}\n`;
}

export function isFreshRustCoreEvidenceLine(line: string, driver: string): boolean {
	try {
		const record = JSON.parse(line) as Partial<FreshRustCoreEvidence>;
		return (
			record.backend === "fresh-rust" &&
			record.artifact === "signet-core-test-driver" &&
			record.process === "transport" &&
			record.driver === driver &&
			typeof record.operation === "string" &&
			record.operation.length > 0 &&
			record.status === "ok"
		);
	} catch {
		return false;
	}
}

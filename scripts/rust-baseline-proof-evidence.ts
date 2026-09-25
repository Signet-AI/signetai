export const FRESH_RUST_CORE_EVIDENCE_MARKER = "backend=fresh-rust artifact=signet-core-test-driver process=transport";

type FreshRustCoreEvidence = {
	backend: "fresh-rust";
	artifact: "signet-core-test-driver";
	process: "transport";
	driver: string;
	operation: string;
	status: "ok";
	marker: string;
	callerStack: string;
};

export function formatFreshRustCoreEvidence(driver: string, operation: string, callerStack: string): string {
	const record: FreshRustCoreEvidence = {
		backend: "fresh-rust",
		artifact: "signet-core-test-driver",
		process: "transport",
		driver,
		operation,
		status: "ok",
		marker: FRESH_RUST_CORE_EVIDENCE_MARKER,
		callerStack,
	};
	return `${JSON.stringify(record)}\n`;
}

export function parseFreshRustCoreEvidenceLine(line: string, driver: string): FreshRustCoreEvidence | undefined {
	try {
		const record: unknown = JSON.parse(line);
		if (
			!record ||
			typeof record !== "object" ||
			!("backend" in record) ||
			!("artifact" in record) ||
			!("process" in record) ||
			!("driver" in record) ||
			!("operation" in record) ||
			!("status" in record) ||
			!("marker" in record) ||
			!("callerStack" in record) ||
			record.backend !== "fresh-rust" ||
			record.artifact !== "signet-core-test-driver" ||
			record.process !== "transport" ||
			record.driver !== driver ||
			typeof record.operation !== "string" ||
			record.operation.length === 0 ||
			record.status !== "ok" ||
			record.marker !== FRESH_RUST_CORE_EVIDENCE_MARKER ||
			typeof record.callerStack !== "string" ||
			record.callerStack.length === 0
		)
			return undefined;
		return {
			backend: record.backend,
			artifact: record.artifact,
			process: record.process,
			driver: record.driver,
			operation: record.operation,
			status: record.status,
			marker: record.marker,
			callerStack: record.callerStack,
		};
	} catch {
		return undefined;
	}
}

export function isFreshRustCoreEvidenceLine(line: string, driver: string): boolean {
	return parseFreshRustCoreEvidenceLine(line, driver) !== undefined;
}

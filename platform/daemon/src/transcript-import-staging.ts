import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

export interface StagedTranscriptFile {
	readonly managedPath: string;
	readonly sizeBytes: number;
	readonly contentHash: string;
}

/** Stream raw bytes into a managed path, then fsync and atomically publish it. */
export async function stageTranscriptStream(
	root: string,
	sourceId: string,
	body: AsyncIterable<Uint8Array>,
): Promise<StagedTranscriptFile> {
	if (!/^[A-Za-z0-9_-]+$/.test(sourceId)) throw new Error("invalid source id");
	const managedRelativePath = join("imports", "transcripts", sourceId, "source.jsonl");
	const destination = resolve(root, managedRelativePath);
	const rootResolved = resolve(root);
	if (!relative(rootResolved, destination) || relative(rootResolved, destination).startsWith(".."))
		throw new Error("managed path escapes root");
	await mkdir(dirname(destination), { recursive: true });
	const partial = `${destination}.partial`;
	const hash = createHash("sha256");
	let sizeBytes = 0;
	const stream = createWriteStream(partial, { flags: "w" });
	try {
		for await (const chunk of body) {
			if (!(chunk instanceof Uint8Array)) throw new Error("stream chunk must be bytes");
			sizeBytes += chunk.byteLength;
			hash.update(chunk);
			if (!stream.write(chunk)) {
				await new Promise<void>((resolvePromise, reject) => {
					const cleanup = (): void => {
						stream.removeListener("drain", onDrain);
						stream.removeListener("error", onError);
					};
					const onDrain = (): void => {
						cleanup();
						resolvePromise();
					};
					const onError = (error: Error): void => {
						cleanup();
						reject(error);
					};
					stream.once("drain", onDrain);
					stream.once("error", onError);
				});
			}
		}
		await new Promise<void>((resolvePromise, reject) => {
			const cleanup = (): void => {
				stream.removeListener("finish", onFinish);
				stream.removeListener("error", onError);
			};
			const onFinish = (): void => {
				cleanup();
				resolvePromise();
			};
			const onError = (error: Error): void => {
				cleanup();
				reject(error);
			};
			stream.once("finish", onFinish);
			stream.once("error", onError);
			stream.end();
		});
		const fd = await import("node:fs/promises").then((fs) => fs.open(partial, "r+"));
		try {
			await fd.sync();
		} finally {
			await fd.close();
		}
		const actual = await stat(partial);
		if (actual.size !== sizeBytes) throw new Error("staged size verification failed");
		await rename(partial, destination);
		return { managedPath: managedRelativePath, sizeBytes, contentHash: hash.digest("hex") };
	} catch (error) {
		stream.destroy();
		throw error;
	}
}

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createInflateRaw } from "node:zlib";
import type { PinnedZipMember } from "./manifest.js";

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export type ProgressSink = (bytes: number) => void;

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_EOCD_SEARCH = 65_557;

export interface ZipEntry {
	readonly name: string;
	readonly method: number;
	readonly compressedSize: number;
	readonly uncompressedSize: number;
	readonly localHeaderOffset: number;
}

async function fetchRange(fetcher: Fetcher, url: string, start: number, endInclusive: number): Promise<Uint8Array> {
	const response = await fetcher(url, { headers: { range: `bytes=${start}-${endInclusive}` }, redirect: "follow" });
	if (response.status !== 206) {
		throw new Error(`${url} did not honor a byte range request (HTTP ${response.status})`);
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.length !== endInclusive - start + 1) {
		throw new Error(`${url} returned ${bytes.length} bytes for a ${endInclusive - start + 1}-byte range`);
	}
	return bytes;
}

async function remoteSize(fetcher: Fetcher, url: string): Promise<number> {
	const response = await fetcher(url, { headers: { range: "bytes=0-0" }, redirect: "follow" });
	const contentRange = response.headers.get("content-range");
	await response.body?.cancel();
	const total = contentRange?.match(/\/(\d+)$/)?.[1];
	if (response.status !== 206 || total === undefined) {
		throw new Error(`${url} does not support byte ranges (HTTP ${response.status})`);
	}
	return Number(total);
}

function u16(view: DataView, offset: number): number {
	return view.getUint16(offset, true);
}

function u32(view: DataView, offset: number): number {
	return view.getUint32(offset, true);
}

function u64(view: DataView, offset: number): number {
	const value = view.getBigUint64(offset, true);
	if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("zip offset exceeds the safe integer range");
	return Number(value);
}

export async function readRemoteZipDirectory(fetcher: Fetcher, url: string): Promise<Map<string, ZipEntry>> {
	const size = await remoteSize(fetcher, url);
	const tailLength = Math.min(size, MAX_EOCD_SEARCH);
	const tail = await fetchRange(fetcher, url, size - tailLength, size - 1);
	const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
	let eocd = -1;
	for (let offset = tail.length - 22; offset >= 0; offset--) {
		if (u32(tailView, offset) === EOCD_SIGNATURE) {
			eocd = offset;
			break;
		}
	}
	if (eocd < 0) throw new Error(`${url} is not a zip archive`);
	let entryCount = u16(tailView, eocd + 10);
	let directorySize = u32(tailView, eocd + 12);
	let directoryOffset = u32(tailView, eocd + 16);
	if (directoryOffset === 0xffffffff || directorySize === 0xffffffff || entryCount === 0xffff) {
		const locator = eocd - 20;
		if (locator < 0 || u32(tailView, locator) !== ZIP64_LOCATOR_SIGNATURE) {
			throw new Error(`${url} declares zip64 sizes without a zip64 locator`);
		}
		const zip64Offset = u64(tailView, locator + 8);
		const zip64 = await fetchRange(fetcher, url, zip64Offset, zip64Offset + 55);
		const view = new DataView(zip64.buffer, zip64.byteOffset, zip64.byteLength);
		if (u32(view, 0) !== ZIP64_EOCD_SIGNATURE) throw new Error(`${url} has a corrupt zip64 directory record`);
		entryCount = u64(view, 32);
		directorySize = u64(view, 40);
		directoryOffset = u64(view, 48);
	}
	const directory = await fetchRange(fetcher, url, directoryOffset, directoryOffset + directorySize - 1);
	const view = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);
	const decoder = new TextDecoder();
	const entries = new Map<string, ZipEntry>();
	let offset = 0;
	for (let index = 0; index < entryCount; index++) {
		if (u32(view, offset) !== CENTRAL_SIGNATURE) throw new Error(`${url} has a corrupt central directory`);
		const method = u16(view, offset + 10);
		let compressedSize = u32(view, offset + 20);
		let uncompressedSize = u32(view, offset + 24);
		const nameLength = u16(view, offset + 28);
		const extraLength = u16(view, offset + 30);
		const commentLength = u16(view, offset + 32);
		let localHeaderOffset = u32(view, offset + 42);
		const name = decoder.decode(directory.subarray(offset + 46, offset + 46 + nameLength));
		let extra = offset + 46 + nameLength;
		const extraEnd = extra + extraLength;
		while (extra + 4 <= extraEnd) {
			const id = u16(view, extra);
			const length = u16(view, extra + 2);
			if (id === 0x0001) {
				let field = extra + 4;
				if (uncompressedSize === 0xffffffff) {
					uncompressedSize = u64(view, field);
					field += 8;
				}
				if (compressedSize === 0xffffffff) {
					compressedSize = u64(view, field);
					field += 8;
				}
				if (localHeaderOffset === 0xffffffff) localHeaderOffset = u64(view, field);
			}
			extra += 4 + length;
		}
		entries.set(name, { name, method, compressedSize, uncompressedSize, localHeaderOffset });
		offset = extraEnd + commentLength;
	}
	return entries;
}

function digestCheck(expected: { readonly sha256: string; readonly size: number }, label: string) {
	const hash = createHash("sha256");
	let size = 0;
	const meter = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			hash.update(chunk);
			size += chunk.length;
			callback(null, chunk);
		},
	});
	return {
		meter,
		verify(): void {
			if (size !== expected.size) throw new Error(`${label}: expected ${expected.size} bytes, got ${size}`);
			const actual = hash.digest("hex");
			if (actual !== expected.sha256) throw new Error(`${label}: sha256 ${actual} does not match ${expected.sha256}`);
		},
	};
}

export async function extractRemoteZipMember(
	fetcher: Fetcher,
	url: string,
	entries: ReadonlyMap<string, ZipEntry>,
	member: PinnedZipMember,
	destination: string,
	onProgress?: ProgressSink,
): Promise<void> {
	const entry = entries.get(member.path);
	if (!entry) throw new Error(`${url} has no member ${member.path}`);
	if (entry.method !== 0 && entry.method !== 8)
		throw new Error(`${member.path} uses unsupported zip method ${entry.method}`);
	const header = await fetchRange(fetcher, url, entry.localHeaderOffset, entry.localHeaderOffset + 29);
	const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);
	if (u32(headerView, 0) !== LOCAL_SIGNATURE) throw new Error(`${url} has a corrupt local header for ${member.path}`);
	const dataStart = entry.localHeaderOffset + 30 + u16(headerView, 26) + u16(headerView, 28);
	const response = await fetcher(url, {
		headers: { range: `bytes=${dataStart}-${dataStart + entry.compressedSize - 1}` },
		redirect: "follow",
	});
	if (response.status !== 206 || !response.body) {
		throw new Error(`${url} did not honor the byte range for ${member.path} (HTTP ${response.status})`);
	}
	mkdirSync(dirname(destination), { recursive: true });
	const partial = `${destination}.partial`;
	const check = digestCheck(member, member.name);
	const counter = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			onProgress?.(chunk.length);
			callback(null, chunk);
		},
	});
	try {
		const source = Readable.fromWeb(response.body as never);
		if (entry.method === 8) {
			await pipeline(source, counter, createInflateRaw(), check.meter, createWriteStream(partial));
		} else {
			await pipeline(source, counter, check.meter, createWriteStream(partial));
		}
		check.verify();
		renameSync(partial, destination);
	} catch (error) {
		rmSync(partial, { force: true });
		throw error;
	}
}

export async function downloadVerified(
	fetcher: Fetcher,
	url: string,
	integrity: string,
	destination: string,
	onProgress?: ProgressSink,
): Promise<void> {
	const [algorithm, expected] = integrity.split("-", 2);
	if (algorithm !== "sha512" || !expected) throw new Error(`unsupported integrity ${integrity}`);
	const response = await fetcher(url, { redirect: "follow" });
	if (!response.ok || !response.body) throw new Error(`${url} returned HTTP ${response.status}`);
	mkdirSync(dirname(destination), { recursive: true });
	const partial = `${destination}.partial`;
	const hash = createHash("sha512");
	const meter = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			hash.update(chunk);
			onProgress?.(chunk.length);
			callback(null, chunk);
		},
	});
	try {
		await pipeline(Readable.fromWeb(response.body as never), meter, createWriteStream(partial));
		const actual = hash.digest("base64");
		if (actual !== expected) throw new Error(`${url}: sha512 ${actual} does not match the pinned integrity`);
		renameSync(partial, destination);
	} catch (error) {
		rmSync(partial, { force: true });
		throw error;
	}
}

interface TarEntryState {
	readonly kind: "file" | "skip" | "longname";
	readonly target: string | null;
	remaining: number;
	padding: number;
	readonly chunks: Buffer[];
}

export async function extractTarGzEntries(
	archive: string,
	wanted: ReadonlyMap<string, string>,
): Promise<ReadonlySet<string>> {
	const written = new Set<string>();
	const decoder = new TextDecoder();
	let buffer = Buffer.alloc(0);
	let entry: TarEntryState | null = null;
	let longName: string | null = null;
	const complete = (done: TarEntryState): void => {
		if (done.kind === "longname") {
			longName = decoder.decode(Buffer.concat(done.chunks)).replace(/\0.*$/s, "");
			return;
		}
		if (done.kind !== "file" || done.target === null) return;
		mkdirSync(dirname(done.target), { recursive: true });
		const partial = `${done.target}.partial`;
		writeFileSync(partial, Buffer.concat(done.chunks));
		renameSync(partial, done.target);
		written.add(done.target);
	};
	const startEntry = (header: Buffer): TarEntryState | null => {
		if (header.every((byte) => byte === 0)) return null;
		const field = (start: number, length: number) =>
			decoder.decode(header.subarray(start, start + length)).replace(/\0.*$/s, "");
		const size = Number.parseInt(field(124, 12).trim() || "0", 8);
		const type = field(156, 1);
		const prefix = field(345, 155);
		const name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
		longName = null;
		const padding = (512 - (size % 512)) % 512;
		if (type === "L") return { kind: "longname", target: null, remaining: size, padding, chunks: [] };
		const target = type === "0" || type === "" ? (wanted.get(name) ?? null) : null;
		return { kind: target ? "file" : "skip", target, remaining: size, padding, chunks: [] };
	};
	const sink = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
			try {
				for (;;) {
					if (entry === null) {
						if (buffer.length < 512) break;
						entry = startEntry(buffer.subarray(0, 512));
						buffer = buffer.subarray(512);
						continue;
					}
					if (entry.remaining > 0) {
						if (buffer.length === 0) break;
						const take = Math.min(entry.remaining, buffer.length);
						if (entry.kind !== "skip") entry.chunks.push(Buffer.from(buffer.subarray(0, take)));
						buffer = buffer.subarray(take);
						entry.remaining -= take;
						if (entry.remaining > 0) break;
					}
					if (entry.padding > 0) {
						if (buffer.length === 0) break;
						const skip = Math.min(entry.padding, buffer.length);
						buffer = buffer.subarray(skip);
						entry.padding -= skip;
						if (entry.padding > 0) break;
					}
					complete(entry);
					entry = null;
				}
				callback();
			} catch (error) {
				callback(error as Error);
			}
		},
	});
	await pipeline(createReadStream(archive), createGunzip(), sink);
	return written;
}

export function fileMatchesSize(path: string, size: number): boolean {
	try {
		return statSync(path).size === size;
	} catch {
		return false;
	}
}

export function joinDestination(dir: string, name: string): string {
	return join(dir, name);
}

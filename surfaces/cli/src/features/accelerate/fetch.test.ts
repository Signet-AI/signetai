import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync, gzipSync } from "node:zlib";
import { downloadVerified, extractRemoteZipMember, extractTarGzEntries, readRemoteZipDirectory } from "./fetch.js";

interface ZipInput {
	readonly name: string;
	readonly data: Buffer;
	readonly deflate: boolean;
}

function crc32(data: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of data) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(entries: readonly ZipInput[], zip64: boolean): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const entry of entries) {
		const name = Buffer.from(entry.name);
		const body = entry.deflate ? deflateRawSync(entry.data) : entry.data;
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(entry.deflate ? 8 : 0, 8);
		local.writeUInt32LE(crc32(entry.data), 14);
		local.writeUInt32LE(body.length, 18);
		local.writeUInt32LE(entry.data.length, 22);
		local.writeUInt16LE(name.length, 26);
		locals.push(local, name, body);
		const extra = Buffer.alloc(zip64 ? 28 : 0);
		if (zip64) {
			extra.writeUInt16LE(0x0001, 0);
			extra.writeUInt16LE(24, 2);
			extra.writeBigUInt64LE(BigInt(entry.data.length), 4);
			extra.writeBigUInt64LE(BigInt(body.length), 12);
			extra.writeBigUInt64LE(BigInt(offset), 20);
		}
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(entry.deflate ? 8 : 0, 10);
		central.writeUInt32LE(crc32(entry.data), 16);
		central.writeUInt32LE(zip64 ? 0xffffffff : body.length, 20);
		central.writeUInt32LE(zip64 ? 0xffffffff : entry.data.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt16LE(extra.length, 30);
		central.writeUInt32LE(zip64 ? 0xffffffff : offset, 42);
		centrals.push(central, name, extra);
		offset += 30 + name.length + body.length;
	}
	const directory = Buffer.concat(centrals);
	const tail: Buffer[] = [];
	if (zip64) {
		const record = Buffer.alloc(56);
		record.writeUInt32LE(0x06064b50, 0);
		record.writeBigUInt64LE(44n, 4);
		record.writeBigUInt64LE(BigInt(entries.length), 24);
		record.writeBigUInt64LE(BigInt(entries.length), 32);
		record.writeBigUInt64LE(BigInt(directory.length), 40);
		record.writeBigUInt64LE(BigInt(offset), 48);
		const locator = Buffer.alloc(20);
		locator.writeUInt32LE(0x07064b50, 0);
		locator.writeBigUInt64LE(BigInt(offset + directory.length), 8);
		tail.push(record, locator);
	}
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(zip64 ? 0xffff : entries.length, 8);
	eocd.writeUInt16LE(zip64 ? 0xffff : entries.length, 10);
	eocd.writeUInt32LE(zip64 ? 0xffffffff : directory.length, 12);
	eocd.writeUInt32LE(zip64 ? 0xffffffff : offset, 16);
	return Buffer.concat([...locals, directory, ...tail, eocd]);
}

function tarEntry(name: string, data: Buffer, prefix = ""): Buffer {
	const header = Buffer.alloc(512);
	header.write(name, 0, "utf8");
	header.write("0000644\0", 100);
	header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
	header.write("0", 156);
	header.write("ustar\0", 257);
	header.write(prefix, 345, "utf8");
	header.fill(" ", 148, 156);
	let sum = 0;
	for (const byte of header) sum += byte;
	header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
	const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
	return Buffer.concat([header, data, padding]);
}

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const files = new Map<string, Buffer>();
let server: ReturnType<typeof Bun.serve>;
let base = "";
let dir = "";

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "signet-accelerate-fetch-"));
	server = Bun.serve({
		port: 0,
		fetch(request) {
			const body = files.get(new URL(request.url).pathname);
			if (!body) return new Response("missing", { status: 404 });
			const range = request.headers.get("range")?.match(/^bytes=(\d+)-(\d+)$/);
			if (!range) return new Response(body);
			const start = Number(range[1]);
			const end = Math.min(Number(range[2]), body.length - 1);
			return new Response(body.subarray(start, end + 1), {
				status: 206,
				headers: { "content-range": `bytes ${start}-${end}/${body.length}` },
			});
		},
	});
	base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
	server.stop(true);
	rmSync(dir, { recursive: true, force: true });
});

describe("remote zip member extraction", () => {
	const library = Buffer.from("cuda library bytes ".repeat(5000));
	const loader = Buffer.from("small loader");
	for (const zip64 of [false, true]) {
		it(`fetches only the named members by byte range${zip64 ? " (zip64)" : ""}`, async () => {
			const path = zip64 ? "/wheel64.whl" : "/wheel.whl";
			files.set(
				path,
				buildZip(
					[
						{ name: "nvidia/big/lib/libunused.so.1", data: Buffer.alloc(200_000, 7), deflate: true },
						{ name: "nvidia/x/lib/libx.so.12", data: library, deflate: true },
						{ name: "nvidia/x/lib/loader.so.9", data: loader, deflate: false },
					],
					zip64,
				),
			);
			const requested: string[] = [];
			const fetcher = (input: string, init?: RequestInit) => {
				requested.push(new Headers(init?.headers).get("range") ?? "full");
				return fetch(input, init);
			};
			const entries = await readRemoteZipDirectory(fetcher, `${base}${path}`);
			const target = join(dir, zip64 ? "64" : "32", "libx.so.12");
			await extractRemoteZipMember(
				fetcher,
				`${base}${path}`,
				entries,
				{
					path: "nvidia/x/lib/libx.so.12",
					name: "libx.so.12",
					sha256: sha256(library),
					size: library.length,
				},
				target,
			);
			expect(readFileSync(target).equals(library)).toBe(true);
			const stored = join(dir, zip64 ? "64" : "32", "loader.so.9");
			await extractRemoteZipMember(
				fetcher,
				`${base}${path}`,
				entries,
				{
					path: "nvidia/x/lib/loader.so.9",
					name: "loader.so.9",
					sha256: sha256(loader),
					size: loader.length,
				},
				stored,
			);
			expect(readFileSync(stored).equals(loader)).toBe(true);
			expect(requested.every((range) => range !== "full")).toBe(true);
		});
	}

	it("refuses a member whose hash does not match the pin and leaves nothing behind", async () => {
		files.set("/bad.whl", buildZip([{ name: "lib/libz.so", data: Buffer.from("tampered"), deflate: true }], false));
		const entries = await readRemoteZipDirectory(fetch, `${base}/bad.whl`);
		const target = join(dir, "bad", "libz.so");
		await expect(
			extractRemoteZipMember(
				fetch,
				`${base}/bad.whl`,
				entries,
				{
					path: "lib/libz.so",
					name: "libz.so",
					sha256: sha256(Buffer.from("original")),
					size: 8,
				},
				target,
			),
		).rejects.toThrow(/sha256/);
		expect(existsSync(target)).toBe(false);
		expect(readdirSync(join(dir, "bad")).filter((name) => name.endsWith(".partial"))).toEqual([]);
	});
});

describe("verified tarball download and extraction", () => {
	it("checks the sha512 integrity and extracts only the requested entries", async () => {
		const binding = Buffer.from("binding");
		const runtime = Buffer.alloc(700, 3);
		const tgz = gzipSync(
			Buffer.concat([
				tarEntry("package/package.json", Buffer.from('{"version":"1.24.3"}')),
				tarEntry("libonnxruntime.so.1", runtime, "package/bin/napi-v6/linux/x64"),
				tarEntry("package/bin/napi-v6/linux/x64/onnxruntime_binding.node", binding),
				tarEntry("package/bin/napi-v6/win32/x64/onnxruntime.dll", Buffer.alloc(900, 1)),
				Buffer.alloc(1024),
			]),
		);
		files.set("/ort.tgz", tgz);
		const integrity = `sha512-${createHash("sha512").update(tgz).digest("base64")}`;
		const archive = join(dir, "dl", "ort.tgz");
		await downloadVerified(fetch, `${base}/ort.tgz`, integrity, archive);
		const out = join(dir, "pkg");
		const written = await extractTarGzEntries(
			archive,
			new Map([
				["package/package.json", join(out, "package.json")],
				["package/bin/napi-v6/linux/x64/libonnxruntime.so.1", join(out, "libonnxruntime.so.1")],
				["package/bin/napi-v6/linux/x64/onnxruntime_binding.node", join(out, "onnxruntime_binding.node")],
			]),
		);
		expect(written.size).toBe(3);
		expect(readFileSync(join(out, "libonnxruntime.so.1")).equals(runtime)).toBe(true);
		expect(readFileSync(join(out, "onnxruntime_binding.node")).equals(binding)).toBe(true);
		expect(existsSync(join(out, "onnxruntime.dll"))).toBe(false);

		await expect(
			downloadVerified(
				fetch,
				`${base}/ort.tgz`,
				`sha512-${createHash("sha512").update("other").digest("base64")}`,
				join(dir, "dl", "bad.tgz"),
			),
		).rejects.toThrow(/sha512/);
		expect(existsSync(join(dir, "dl", "bad.tgz"))).toBe(false);
		writeFileSync(join(dir, "marker"), "");
	});
});

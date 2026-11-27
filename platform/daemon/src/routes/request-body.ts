export type BoundedBody = { readonly ok: true; readonly bytes: Buffer } | { readonly ok: false };

export async function readBoundedBody(request: Request, limit: number): Promise<BoundedBody> {
	const body = request.body;
	if (body === null) return { ok: true, bytes: Buffer.alloc(0) };
	const reader = body.getReader();
	const parts: Uint8Array[] = [];
	let length = 0;
	try {
		while (true) {
			const item = await reader.read();
			if (item.done) return { ok: true, bytes: Buffer.concat(parts) };
			length += item.value.byteLength;
			if (length > limit) {
				await reader.cancel();
				return { ok: false };
			}
			parts.push(item.value);
		}
	} finally {
		reader.releaseLock();
	}
}

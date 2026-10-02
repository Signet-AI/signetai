export function decodeSecretMasterKey(value: string | undefined): Uint8Array {
	if (value === undefined) throw new Error("Keyring returned no master key");
	const key = Buffer.from(value, "base64");
	if (key.length !== 32 || key.toString("base64") !== value) {
		key.fill(0);
		throw new Error("master key is not valid canonical base64");
	}
	return key;
}

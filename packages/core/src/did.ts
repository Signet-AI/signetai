/**
 * @module did
 *
 * Decentralized Identifier (DID) utilities for Signet Web3.
 *
 * Implements W3C did:key method for Ed25519 public keys.
 * See: https://w3c-ccg.github.io/did-method-key/
 *      https://www.w3.org/TR/did-core/
 *
 * No external dependencies — base58btc is implemented inline.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Prefix for all did:key identifiers. */
export const DID_KEY_PREFIX = 'did:key:';

/**
 * Multicodec varint prefix for ed25519-pub (0xed).
 * Encoded as a two-byte varint: [0xed, 0x01].
 */
const ED25519_MULTICODEC_PREFIX = new Uint8Array([0xed, 0x01]);

/** Expected length of a raw Ed25519 public key in bytes. */
const ED25519_PUBLIC_KEY_LENGTH = 32;

/** Base58btc alphabet (Bitcoin variant). */
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Multibase prefix for base58btc. */
const MULTIBASE_BASE58BTC_PREFIX = 'z';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single verification method entry in a DID Document. */
export interface VerificationMethod {
  id: string;
  type: 'Ed25519VerificationKey2020';
  controller: string;
  publicKeyMultibase: string;
}

/** W3C DID Document (did:key profile). */
export interface DidDocument {
  '@context': string[];
  id: string;
  verificationMethod: VerificationMethod[];
  authentication: string[];
  assertionMethod: string[];
  capabilityInvocation: string[];
  capabilityDelegation: string[];
}

// ---------------------------------------------------------------------------
// Base58btc codec (zero-dependency)
// ---------------------------------------------------------------------------

/**
 * Encode a byte array to a base58btc string.
 *
 * Uses the standard big-integer division approach:
 *   1. Count and preserve leading zero bytes (→ leading '1's).
 *   2. Repeatedly divmod the byte array by 58.
 *
 * @param bytes - The input byte array.
 * @returns The base58btc-encoded string (no multibase prefix).
 */
function base58btcEncode(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';

  // Count leading zeros — each maps to a leading '1' in base58.
  let leadingZeros = 0;
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) {
    leadingZeros++;
  }

  // Work on a mutable copy so we don't corrupt the caller's buffer.
  const input = new Uint8Array(bytes);

  // Upper-bound on output size: log(256)/log(58) ≈ 1.366 per byte.
  const encoded: number[] = [];

  let start = leadingZeros;
  while (start < input.length) {
    let remainder = 0;
    let newStart = start;
    let allZero = true;

    for (let i = start; i < input.length; i++) {
      const digit = input[i] + remainder * 256;
      input[i] = (digit / 58) | 0;
      remainder = digit % 58;

      if (input[i] !== 0 && allZero) {
        newStart = i;
        allZero = false;
      }
    }

    encoded.push(remainder);
    if (allZero) break;
    start = newStart;
  }

  // Build result: leading '1's + encoded digits in reverse.
  let result = BASE58_ALPHABET[0].repeat(leadingZeros);
  for (let i = encoded.length - 1; i >= 0; i--) {
    result += BASE58_ALPHABET[encoded[i]];
  }

  return result;
}

/**
 * Decode a base58btc string back to bytes.
 *
 * @param str - A base58btc-encoded string (no multibase prefix).
 * @returns The decoded byte array.
 * @throws {Error} If the string contains invalid base58 characters.
 */
function base58btcDecode(str: string): Uint8Array {
  if (str.length === 0) return new Uint8Array(0);

  // Build reverse lookup on first use.
  const alphabetMap = new Map<string, number>();
  for (let i = 0; i < BASE58_ALPHABET.length; i++) {
    alphabetMap.set(BASE58_ALPHABET[i], i);
  }

  // Count leading '1's — each maps to a leading 0x00 byte.
  let leadingOnes = 0;
  for (let i = 0; i < str.length && str[i] === '1'; i++) {
    leadingOnes++;
  }

  // Convert base58 digits to a big-endian byte array via multiply-and-add.
  // Upper bound: each base58 char ≈ 0.733 bytes.
  const size = Math.ceil(str.length * 733 / 1000) + 1;
  const output = new Uint8Array(size);

  for (let i = leadingOnes; i < str.length; i++) {
    const charValue = alphabetMap.get(str[i]);
    if (charValue === undefined) {
      throw new Error(`Invalid base58 character '${str[i]}' at position ${i}`);
    }

    let carry = charValue;
    for (let j = size - 1; j >= 0; j--) {
      carry += output[j] * 58;
      output[j] = carry & 0xff;
      carry >>>= 8;
    }
  }

  // Skip leading zeros in the output buffer.
  let outputStart = 0;
  while (outputStart < size && output[outputStart] === 0) {
    outputStart++;
  }

  // Assemble: leading zero bytes + significant bytes.
  const result = new Uint8Array(leadingOnes + (size - outputStart));
  // Leading zeros are already 0 in a fresh Uint8Array.
  result.set(output.subarray(outputStart), leadingOnes);

  return result;
}

// ---------------------------------------------------------------------------
// DID functions
// ---------------------------------------------------------------------------

/**
 * Convert a raw Ed25519 public key to a `did:key` identifier.
 *
 * The encoding follows the did:key method specification:
 *   did:key:z<base58btc(multicodec_prefix + public_key)>
 *
 * @param publicKey - A 32-byte Ed25519 public key.
 * @returns The did:key string.
 * @throws {TypeError} If `publicKey` is not a Uint8Array.
 * @throws {Error} If `publicKey` is not exactly 32 bytes.
 *
 * @example
 * ```ts
 * const did = publicKeyToDid(myPublicKey);
 * // "did:key:z6MkhaXg..."
 * ```
 */
export function publicKeyToDid(publicKey: Uint8Array): string {
  if (!(publicKey instanceof Uint8Array)) {
    throw new TypeError('publicKey must be a Uint8Array');
  }
  if (publicKey.length !== ED25519_PUBLIC_KEY_LENGTH) {
    throw new Error(
      `Invalid Ed25519 public key length: expected ${ED25519_PUBLIC_KEY_LENGTH} bytes, got ${publicKey.length}`,
    );
  }

  // multicodec prefix (2 bytes) + raw key (32 bytes) = 34 bytes
  const prefixed = new Uint8Array(ED25519_MULTICODEC_PREFIX.length + publicKey.length);
  prefixed.set(ED25519_MULTICODEC_PREFIX, 0);
  prefixed.set(publicKey, ED25519_MULTICODEC_PREFIX.length);

  // multibase base58btc: 'z' prefix + base58btc encoding
  const multibaseEncoded = MULTIBASE_BASE58BTC_PREFIX + base58btcEncode(prefixed);

  return DID_KEY_PREFIX + multibaseEncoded;
}

/**
 * Extract the raw Ed25519 public key from a `did:key` identifier.
 *
 * @param did - A valid did:key string (Ed25519).
 * @returns The 32-byte Ed25519 public key.
 * @throws {Error} If the DID is malformed, has an unsupported multibase encoding,
 *                  or does not contain an Ed25519 multicodec prefix.
 *
 * @example
 * ```ts
 * const pubKey = didToPublicKey("did:key:z6MkhaXg...");
 * // Uint8Array(32) [...]
 * ```
 */
export function didToPublicKey(did: string): Uint8Array {
  if (typeof did !== 'string') {
    throw new TypeError('did must be a string');
  }
  if (!did.startsWith(DID_KEY_PREFIX)) {
    throw new Error(`Invalid DID: must start with "${DID_KEY_PREFIX}"`);
  }

  const multibaseValue = did.slice(DID_KEY_PREFIX.length);

  if (multibaseValue.length === 0) {
    throw new Error('Invalid DID: missing multibase-encoded key');
  }

  if (multibaseValue[0] !== MULTIBASE_BASE58BTC_PREFIX) {
    throw new Error(
      `Unsupported multibase encoding '${multibaseValue[0]}': only base58btc ('z') is supported`,
    );
  }

  const base58Str = multibaseValue.slice(1);
  let decoded: Uint8Array;
  try {
    decoded = base58btcDecode(base58Str);
  } catch (err) {
    throw new Error(`Invalid DID: base58btc decoding failed — ${(err as Error).message}`);
  }

  // Verify multicodec prefix
  if (decoded.length < ED25519_MULTICODEC_PREFIX.length) {
    throw new Error('Invalid DID: decoded value too short for multicodec prefix');
  }
  if (
    decoded[0] !== ED25519_MULTICODEC_PREFIX[0] ||
    decoded[1] !== ED25519_MULTICODEC_PREFIX[1]
  ) {
    throw new Error(
      `Unsupported multicodec: expected [0x${ED25519_MULTICODEC_PREFIX[0].toString(16)}, 0x${ED25519_MULTICODEC_PREFIX[1].toString(16)}] (ed25519-pub), ` +
      `got [0x${decoded[0].toString(16)}, 0x${decoded[1].toString(16)}]`,
    );
  }

  const publicKey = decoded.slice(ED25519_MULTICODEC_PREFIX.length);

  if (publicKey.length !== ED25519_PUBLIC_KEY_LENGTH) {
    throw new Error(
      `Invalid Ed25519 public key length in DID: expected ${ED25519_PUBLIC_KEY_LENGTH} bytes, got ${publicKey.length}`,
    );
  }

  return publicKey;
}

/**
 * Generate a W3C DID Document for a did:key identifier.
 *
 * Produces a document conforming to the DID Core specification with:
 * - A single Ed25519VerificationKey2020 verification method
 * - The key referenced in authentication, assertionMethod,
 *   capabilityInvocation, and capabilityDelegation
 *
 * @param did - A valid did:key string.
 * @param publicKey - The corresponding 32-byte Ed25519 public key.
 * @returns A fully-formed DID Document.
 * @throws {Error} If the DID is invalid or the public key doesn't match.
 *
 * @example
 * ```ts
 * const doc = generateDidDocument(did, publicKey);
 * console.log(JSON.stringify(doc, null, 2));
 * ```
 */
export function generateDidDocument(did: string, publicKey: Uint8Array): DidDocument {
  if (!isValidDid(did)) {
    throw new Error(`Invalid DID: "${did}" is not a valid did:key identifier`);
  }
  if (!(publicKey instanceof Uint8Array)) {
    throw new TypeError('publicKey must be a Uint8Array');
  }
  if (publicKey.length !== ED25519_PUBLIC_KEY_LENGTH) {
    throw new Error(
      `Invalid Ed25519 public key length: expected ${ED25519_PUBLIC_KEY_LENGTH} bytes, got ${publicKey.length}`,
    );
  }

  // Verify consistency: the DID must encode this exact public key.
  const derivedDid = publicKeyToDid(publicKey);
  if (derivedDid !== did) {
    throw new Error(
      'DID / public key mismatch: the provided DID does not encode the given public key',
    );
  }

  // Build the multibase-encoded public key for the verification method.
  // This is the same multibase value from the DID itself.
  const multibasePublicKey = did.slice(DID_KEY_PREFIX.length);

  const verificationMethodId = `${did}#key-1`;

  const verificationMethod: VerificationMethod = {
    id: verificationMethodId,
    type: 'Ed25519VerificationKey2020',
    controller: did,
    publicKeyMultibase: multibasePublicKey,
  };

  return {
    '@context': [
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/suites/ed25519-2020/v1',
    ],
    id: did,
    verificationMethod: [verificationMethod],
    authentication: [verificationMethodId],
    assertionMethod: [verificationMethodId],
    capabilityInvocation: [verificationMethodId],
    capabilityDelegation: [verificationMethodId],
  };
}

/**
 * Validate whether a string is a well-formed did:key identifier (Ed25519).
 *
 * Performs structural validation:
 * 1. Starts with `did:key:`
 * 2. Uses base58btc multibase encoding (`z` prefix)
 * 3. Decodes to a valid Ed25519 multicodec-prefixed key (34 bytes)
 *
 * @param did - The string to validate.
 * @returns `true` if valid, `false` otherwise.
 *
 * @example
 * ```ts
 * isValidDid("did:key:z6MkhaXg..."); // true
 * isValidDid("not-a-did");            // false
 * ```
 */
export function isValidDid(did: string): boolean {
  try {
    if (typeof did !== 'string') return false;
    if (!did.startsWith(DID_KEY_PREFIX)) return false;

    const multibaseValue = did.slice(DID_KEY_PREFIX.length);
    if (multibaseValue.length === 0) return false;
    if (multibaseValue[0] !== MULTIBASE_BASE58BTC_PREFIX) return false;

    const base58Str = multibaseValue.slice(1);
    if (base58Str.length === 0) return false;

    const decoded = base58btcDecode(base58Str);

    // Must be exactly 2 (prefix) + 32 (key) = 34 bytes
    if (decoded.length !== ED25519_MULTICODEC_PREFIX.length + ED25519_PUBLIC_KEY_LENGTH) {
      return false;
    }

    // Must have the ed25519-pub multicodec prefix
    if (
      decoded[0] !== ED25519_MULTICODEC_PREFIX[0] ||
      decoded[1] !== ED25519_MULTICODEC_PREFIX[1]
    ) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Format a DID as an abbreviated, human-readable string.
 *
 * Useful for display in UIs and logs where the full DID is too long.
 *
 * @param did - A valid did:key string.
 * @returns An abbreviated form, e.g. `did:key:z6Mk...QN`.
 * @throws {Error} If the DID is not a valid did:key identifier.
 *
 * @example
 * ```ts
 * formatDidShort("did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK");
 * // "did:key:z6Mk...doK"
 * ```
 */
export function formatDidShort(did: string): string {
  if (!isValidDid(did)) {
    throw new Error(`Invalid DID: cannot format "${did}"`);
  }

  const multibaseValue = did.slice(DID_KEY_PREFIX.length);

  // Show first 4 chars + last 3 chars of the multibase portion.
  const prefixChars = 4;
  const suffixChars = 3;

  if (multibaseValue.length <= prefixChars + suffixChars) {
    // Short enough to show in full (shouldn't happen with real Ed25519 keys).
    return did;
  }

  const start = multibaseValue.slice(0, prefixChars);
  const end = multibaseValue.slice(-suffixChars);

  return `${DID_KEY_PREFIX}${start}...${end}`;
}

/**
 * DID setup integration — auto-generates keypair and DID during signet setup.
 *
 * Called during initial setup or via `signet did init` to bootstrap the
 * agent's cryptographic identity.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { parse, stringify } from "yaml";
import {
	generateSigningKeypair,
	hasSigningKeypair,
	getPublicKeyBytes,
} from "./crypto";
import { publicKeyToDid, generateDidDocument, formatDidShort } from "./did";

const AGENTS_DIR = process.env.SIGNET_PATH || join(require("os").homedir(), ".agents");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DidSetupResult {
	/** Whether a new keypair was generated (false if one already existed) */
	keypairGenerated: boolean;
	/** The agent's DID (did:key:z6Mk...) */
	did: string;
	/** Shortened DID for display */
	didShort: string;
	/** Whether agent.yaml was updated with the DID */
	yamlUpdated: boolean;
	/** Path to the DID Document file */
	didDocumentPath: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the agent's DID identity.
 *
 * 1. Generates Ed25519 keypair if none exists
 * 2. Derives DID from public key
 * 3. Updates agent.yaml with the DID
 * 4. Writes DID Document to ~/.agents/did.json
 *
 * Safe to call multiple times — skips steps already completed.
 */
export async function initializeAgentDid(): Promise<DidSetupResult> {
	let keypairGenerated = false;

	// Step 1: Ensure keypair exists
	if (!hasSigningKeypair()) {
		await generateSigningKeypair();
		keypairGenerated = true;
	}

	// Step 2: Derive DID from public key
	const publicKey = await getPublicKeyBytes();
	const did = publicKeyToDid(publicKey);
	const didShort = formatDidShort(did);

	// Step 3: Update agent.yaml
	const yamlPath = join(AGENTS_DIR, "agent.yaml");
	let yamlUpdated = false;

	if (existsSync(yamlPath)) {
		try {
			const raw = readFileSync(yamlPath, "utf-8");
			const config = parse(raw) as Record<string, unknown>;

			if (config.did !== did) {
				config.did = did;

				// Ensure signing config exists
				if (!config.signing) {
					config.signing = { autoSign: true };
				}

				writeFileSync(yamlPath, stringify(config));
				yamlUpdated = true;
			}
		} catch (err) {
			console.warn(
				"[did-setup] Failed to update agent.yaml:",
				err instanceof Error ? err.message : String(err),
			);
		}
	}

	// Step 4: Write DID Document
	const didDocument = generateDidDocument(did, publicKey);
	const didDocPath = join(AGENTS_DIR, "did.json");

	try {
		writeFileSync(didDocPath, JSON.stringify(didDocument, null, 2));
	} catch (err) {
		console.warn(
			"[did-setup] Failed to write did.json:",
			err instanceof Error ? err.message : String(err),
		);
	}

	return {
		keypairGenerated,
		did,
		didShort,
		yamlUpdated,
		didDocumentPath: didDocPath,
	};
}

/**
 * Get the agent's current DID from agent.yaml.
 * Returns null if no DID is configured.
 */
export function getConfiguredDid(): string | null {
	const yamlPath = join(AGENTS_DIR, "agent.yaml");
	if (!existsSync(yamlPath)) return null;

	try {
		const raw = readFileSync(yamlPath, "utf-8");
		const config = parse(raw) as Record<string, unknown>;
		return typeof config.did === "string" ? config.did : null;
	} catch {
		return null;
	}
}

/**
 * Check if the agent has a DID configured.
 */
export function hasConfiguredDid(): boolean {
	return getConfiguredDid() !== null;
}

/**
 * Check if auto-signing is enabled in agent.yaml.
 */
export function isAutoSignEnabled(): boolean {
	const yamlPath = join(AGENTS_DIR, "agent.yaml");
	if (!existsSync(yamlPath)) return false;

	try {
		const raw = readFileSync(yamlPath, "utf-8");
		const config = parse(raw) as Record<string, unknown>;
		const signing = config.signing as Record<string, unknown> | undefined;
		return signing?.autoSign === true;
	} catch {
		return false;
	}
}

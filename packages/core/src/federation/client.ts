/**
 * @module federation/client
 * @description WebSocket federation client — connect to peers, handshake, sync, push memories.
 *
 * Handles outbound connections with:
 * - DID-verified handshake on connect
 * - Auto-reconnect with exponential backoff
 * - Signed message sending
 */

import { WebSocket } from "ws";
import sodium from "libsodium-wrappers";
import { didToPublicKey } from "../did";
import { signContent } from "../crypto";
import {
	parseMessage,
	verifyMessage,
	serializeMessage,
	createMessage,
} from "./protocol";
import {
	initiateHandshake,
	completeHandshake,
	signCounterChallenge,
} from "./handshake";
import type {
	FederationConfig,
	PeerMessage,
	HandshakeAckPayload,
	SyncRequest,
	SyncResponse,
	SyncMemory,
	MemoryPushPayload,
	MemoryAckPayload,
	ErrorPayload,
} from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FederationClientConnection {
	/** The peer's verified DID */
	peerDid: string;
	/** The peer's base64 public key */
	peerPublicKey: string;
	/** Send a raw signed message */
	send(message: PeerMessage): void;
	/** Request sync from peer */
	syncWithPeer(since?: string): Promise<SyncResponse>;
	/** Push a single memory to peer */
	pushMemory(memory: SyncMemory): Promise<boolean>;
	/** Send a ping */
	ping(): Promise<void>;
	/** Close the connection */
	close(): void;
	/** Whether the connection is open */
	isConnected(): boolean;
	/** The underlying WebSocket */
	ws: WebSocket;
}

// ---------------------------------------------------------------------------
// Connect to peer
// ---------------------------------------------------------------------------

/**
 * Connect to a peer's federation server and perform DID handshake.
 *
 * @param url - WebSocket URL of the peer (ws:// or wss://)
 * @param config - Local identity configuration
 * @returns Connected and authenticated client
 * @throws If connection or handshake fails
 */
export async function connectToPeer(
	url: string,
	config: FederationConfig,
): Promise<FederationClientConnection> {
	await sodium.ready;

	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url);
		let handshakeTimeout: ReturnType<typeof setTimeout>;
		let challenge: string;
		let peerDid: string;
		let peerPublicKey: Uint8Array;
		let peerPublicKeyB64: string;
		let authenticated = false;

		// Pending response handlers (for request-response patterns)
		const pendingResponses = new Map<string, {
			resolve: (value: unknown) => void;
			reject: (reason: unknown) => void;
			timeout: ReturnType<typeof setTimeout>;
		}>();

		// Timeout the handshake after 15 seconds
		handshakeTimeout = setTimeout(() => {
			ws.close(1008, "Handshake timeout");
			reject(new Error("Handshake timeout — peer did not respond within 15 seconds"));
		}, 15_000);

		ws.on("open", async () => {
			try {
				// Step 1: Send HANDSHAKE
				const result = await initiateHandshake(
					config.did,
					config.publicKey,
					{ displayName: config.displayName, chainAddress: config.chainAddress },
				);
				challenge = result.challenge;
				ws.send(serializeMessage(result.message));
			} catch (err) {
				clearTimeout(handshakeTimeout);
				ws.close();
				reject(err);
			}
		});

		ws.on("message", async (data: Buffer | string) => {
			try {
				const raw = typeof data === "string" ? data : data.toString("utf-8");
				const message = parseMessage(raw);

				if (!authenticated) {
					// Expecting HANDSHAKE_ACK
					if (message.type === "HANDSHAKE_ACK") {
						const ackPayload = message.payload as HandshakeAckPayload;

						// Step 3: Complete handshake — verify ACK
						const result = await completeHandshake(
							message as PeerMessage<HandshakeAckPayload>,
							challenge,
						);

						peerDid = result.peerDid;
						peerPublicKey = result.peerPublicKey;
						peerPublicKeyB64 = result.peerPublicKeyB64;
						authenticated = true;

						clearTimeout(handshakeTimeout);

						// Sign the counter-challenge to prove our identity to the peer
						const counterResponse = await signCounterChallenge(result.counterChallenge);
						// Send as PING with counter-challenge response (lightweight)
						const pingMsg = await createMessage("PING", {
							counterChallengeResponse: counterResponse,
						}, config.did);
						ws.send(serializeMessage(pingMsg));

						// Connection established — resolve with client interface
						resolve(buildClientInterface(
							ws, peerDid, peerPublicKey, peerPublicKeyB64,
							config, pendingResponses,
						));
					} else if (message.type === "ERROR") {
						const err = message.payload as ErrorPayload;
						clearTimeout(handshakeTimeout);
						ws.close();
						reject(new Error(`Handshake rejected: ${err.message}`));
					}
					return;
				}

				// Authenticated — route to pending response handlers
				if (message.type === "SYNC_RESPONSE") {
					const pending = pendingResponses.get("sync");
					if (pending) {
						pendingResponses.delete("sync");
						clearTimeout(pending.timeout);
						// Verify signature
						const valid = await verifyMessage(message, peerPublicKey);
						if (valid) {
							pending.resolve(message.payload);
						} else {
							pending.reject(new Error("Invalid sync response signature"));
						}
					}
				} else if (message.type === "MEMORY_ACK") {
					const ackPayload = message.payload as MemoryAckPayload;
					const pending = pendingResponses.get(`push:${ackPayload.memoryId}`);
					if (pending) {
						pendingResponses.delete(`push:${ackPayload.memoryId}`);
						clearTimeout(pending.timeout);
						pending.resolve(ackPayload.accepted);
					}
				} else if (message.type === "ERROR") {
					const errPayload = message.payload as ErrorPayload;
					// Reject any pending requests
					for (const [key, pending] of pendingResponses) {
						clearTimeout(pending.timeout);
						pending.reject(new Error(`Peer error: ${errPayload.message}`));
					}
					pendingResponses.clear();
				}
			} catch (err) {
				// Protocol error on received message — log but don't crash
				if (process.env.SIGNET_DEBUG) {
					console.warn("[federation/client] Error handling message:", err);
				}
			}
		});

		ws.on("error", (err) => {
			clearTimeout(handshakeTimeout);
			reject(err);
		});

		ws.on("close", () => {
			clearTimeout(handshakeTimeout);
			// Reject all pending requests
			for (const [key, pending] of pendingResponses) {
				clearTimeout(pending.timeout);
				pending.reject(new Error("Connection closed"));
			}
			pendingResponses.clear();
		});
	});
}

// ---------------------------------------------------------------------------
// Client interface builder
// ---------------------------------------------------------------------------

function buildClientInterface(
	ws: WebSocket,
	peerDid: string,
	peerPublicKey: Uint8Array,
	peerPublicKeyB64: string,
	config: FederationConfig,
	pendingResponses: Map<string, {
		resolve: (value: unknown) => void;
		reject: (reason: unknown) => void;
		timeout: ReturnType<typeof setTimeout>;
	}>,
): FederationClientConnection {
	return {
		peerDid,
		peerPublicKey: peerPublicKeyB64,
		ws,

		send(message: PeerMessage) {
			if (ws.readyState !== WebSocket.OPEN) {
				throw new Error("Connection is not open");
			}
			ws.send(serializeMessage(message));
		},

		async syncWithPeer(since?: string): Promise<SyncResponse> {
			if (ws.readyState !== WebSocket.OPEN) {
				throw new Error("Connection is not open");
			}

			const request: SyncRequest = { since };
			const msg = await createMessage<SyncRequest>("SYNC_REQUEST", request, config.did);
			ws.send(serializeMessage(msg));

			return new Promise((resolve, reject) => {
				const timeout = setTimeout(() => {
					pendingResponses.delete("sync");
					reject(new Error("Sync request timed out (30s)"));
				}, 30_000);

				pendingResponses.set("sync", {
					resolve: resolve as (value: unknown) => void,
					reject,
					timeout,
				});
			});
		},

		async pushMemory(memory: SyncMemory): Promise<boolean> {
			if (ws.readyState !== WebSocket.OPEN) {
				throw new Error("Connection is not open");
			}

			const payload: MemoryPushPayload = { memory };
			const msg = await createMessage<MemoryPushPayload>("MEMORY_PUSH", payload, config.did);
			ws.send(serializeMessage(msg));

			return new Promise((resolve, reject) => {
				const timeout = setTimeout(() => {
					pendingResponses.delete(`push:${memory.id}`);
					reject(new Error("Memory push timed out (15s)"));
				}, 15_000);

				pendingResponses.set(`push:${memory.id}`, {
					resolve: resolve as (value: unknown) => void,
					reject,
					timeout,
				});
			});
		},

		async ping(): Promise<void> {
			if (ws.readyState !== WebSocket.OPEN) {
				throw new Error("Connection is not open");
			}
			const msg = await createMessage("PING", {}, config.did);
			ws.send(serializeMessage(msg));
		},

		close() {
			ws.close(1000, "Client disconnect");
		},

		isConnected() {
			return ws.readyState === WebSocket.OPEN;
		},
	};
}

// ---------------------------------------------------------------------------
// Auto-reconnecting client
// ---------------------------------------------------------------------------

export interface ReconnectingClient {
	/** Get the current connection (null if disconnected) */
	getConnection(): FederationClientConnection | null;
	/** Stop reconnection attempts and close */
	stop(): void;
	/** Whether currently connected */
	isConnected(): boolean;
	/** Event handlers */
	onConnect?: (conn: FederationClientConnection) => void;
	onDisconnect?: (reason: string) => void;
	onError?: (err: Error) => void;
}

/**
 * Create a client that auto-reconnects on disconnect.
 *
 * @param url - WebSocket URL of the peer
 * @param config - Local identity configuration
 * @returns ReconnectingClient handle
 */
export function createReconnectingClient(
	url: string,
	config: FederationConfig,
): ReconnectingClient {
	let connection: FederationClientConnection | null = null;
	let stopped = false;
	let reconnectAttempts = 0;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	const maxAttempts = config.maxReconnectAttempts ?? 10;
	const baseDelay = config.reconnectDelayMs ?? 2000;

	const client: ReconnectingClient = {
		getConnection: () => connection,
		isConnected: () => connection?.isConnected() ?? false,
		stop() {
			stopped = true;
			if (reconnectTimer) clearTimeout(reconnectTimer);
			connection?.close();
			connection = null;
		},
	};

	async function connect() {
		if (stopped) return;

		try {
			connection = await connectToPeer(url, config);
			reconnectAttempts = 0;

			client.onConnect?.(connection);

			// Watch for disconnect
			connection.ws.on("close", () => {
				connection = null;
				if (!stopped) {
					client.onDisconnect?.("Connection closed");
					scheduleReconnect();
				}
			});

			connection.ws.on("error", (err) => {
				client.onError?.(err as Error);
			});
		} catch (err) {
			connection = null;
			client.onError?.(err as Error);
			if (!stopped) {
				scheduleReconnect();
			}
		}
	}

	function scheduleReconnect() {
		if (stopped || reconnectAttempts >= maxAttempts) return;

		reconnectAttempts++;
		// Exponential backoff with jitter
		const delay = Math.min(
			baseDelay * Math.pow(2, reconnectAttempts - 1),
			60_000, // max 60s
		) + Math.random() * 1000;

		reconnectTimer = setTimeout(connect, delay);
	}

	// Start initial connection
	connect();

	return client;
}

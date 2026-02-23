/**
 * @module federation/server
 * @description WebSocket federation server — accepts peer connections,
 * verifies DID handshakes, routes messages, manages heartbeat/keepalive.
 *
 * Uses the `ws` npm package for WebSocket implementation.
 */

import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import sodium from "libsodium-wrappers";
import { didToPublicKey, isValidDid } from "../did";
import { verifySignature } from "../crypto";
import {
	parseMessage,
	verifyMessage,
	serializeMessage,
	createMessage,
} from "./protocol";
import {
	respondToHandshake,
	verifyCounterChallengeResponse,
} from "./handshake";
import {
	getPeerByDid,
	addPeer,
	updatePeerLastSeen,
	updatePeerTrust,
	blockPeer,
} from "./peer-manager";
import {
	handleSyncRequest,
	processSyncResponse,
} from "./sync";
import { autoPublish } from "./publisher";
import type {
	FederationDb,
	FederationConfig,
	PeerMessage,
	HandshakePayload,
	HandshakeCompletePayload,
	SyncRequest,
	SyncResponse,
	MemoryPushPayload,
	MemoryAckPayload,
	PeerConnection,
	TrustLevel,
} from "./types";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ConnectedPeer {
	ws: WebSocket;
	did?: string;
	publicKey?: Uint8Array;
	publicKeyB64?: string;
	peerId?: string;
	trustLevel?: TrustLevel;
	authenticated: boolean;
	counterChallenge?: string;
	messageCount: number;
	lastMessageTime: number;
}

export interface FederationServer {
	/** Stop the server and close all connections */
	close(): void;
	/** Get connected peer info */
	getConnections(): PeerConnection[];
	/** The underlying WebSocket server */
	wss: WebSocketServer;
	/** Port the server is listening on */
	port: number;
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

function isRateLimited(peer: ConnectedPeer, maxPerMinute: number): boolean {
	const now = Date.now();
	const elapsed = now - peer.lastMessageTime;

	// Reset counter every minute
	if (elapsed > 60_000) {
		peer.messageCount = 0;
		peer.lastMessageTime = now;
	}

	peer.messageCount++;
	return peer.messageCount > maxPerMinute;
}

// ---------------------------------------------------------------------------
// Create federation server
// ---------------------------------------------------------------------------

/**
 * Create and start a WebSocket federation server.
 *
 * @param port - Port to listen on
 * @param db - Database instance
 * @param config - Federation configuration (DID, publicKey, etc.)
 * @returns FederationServer handle for management
 */
export function createFederationServer(
	port: number,
	db: FederationDb,
	config: FederationConfig,
): FederationServer {
	const connectedPeers = new Map<WebSocket, ConnectedPeer>();
	const pingIntervalMs = config.pingIntervalMs ?? 30_000;
	const maxMessagesPerMinute = config.maxMessagesPerMinute ?? 120;

	const wss = new WebSocketServer({ port });

	// Heartbeat interval
	const heartbeatInterval = setInterval(() => {
		for (const [ws, peer] of connectedPeers) {
			if (ws.readyState === WebSocket.OPEN) {
				ws.ping();
			} else {
				connectedPeers.delete(ws);
			}
		}
	}, pingIntervalMs);

	wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
		const peer: ConnectedPeer = {
			ws,
			authenticated: false,
			messageCount: 0,
			lastMessageTime: Date.now(),
		};
		connectedPeers.set(ws, peer);

		ws.on("message", async (data: Buffer | string) => {
			try {
				const raw = typeof data === "string" ? data : data.toString("utf-8");

				// Rate limiting
				if (isRateLimited(peer, maxMessagesPerMinute)) {
					const errMsg = await createMessage("ERROR", {
						code: "RATE_LIMITED",
						message: "Too many messages — slow down",
					}, config.did);
					ws.send(serializeMessage(errMsg));
					return;
				}

				const message = parseMessage(raw);

				// Before authentication, only accept HANDSHAKE messages
				if (!peer.authenticated && message.type !== "HANDSHAKE") {
					// Exception: after handshake sent, accept the counter-challenge response
					// which comes as a MEMORY_PUSH with type containing the signed challenge
					if (message.type === "PING") {
						const pong = await createMessage("PONG", {}, config.did);
						ws.send(serializeMessage(pong));
						return;
					}
					const errMsg = await createMessage("ERROR", {
						code: "NOT_AUTHENTICATED",
						message: "Complete handshake before sending messages",
					}, config.did);
					ws.send(serializeMessage(errMsg));
					return;
				}

				await handleMessage(ws, peer, message, db, config);

			} catch (err) {
				try {
					const errMsg = await createMessage("ERROR", {
						code: "PROTOCOL_ERROR",
						message: err instanceof Error ? err.message : String(err),
					}, config.did);
					ws.send(serializeMessage(errMsg));
				} catch {
					// Can't even send error — close connection
					ws.close(1008, "Protocol error");
				}
			}
		});

		ws.on("close", () => {
			connectedPeers.delete(ws);
		});

		ws.on("error", () => {
			connectedPeers.delete(ws);
		});
	});

	function close() {
		clearInterval(heartbeatInterval);
		for (const [ws] of connectedPeers) {
			ws.close(1000, "Server shutting down");
		}
		connectedPeers.clear();
		wss.close();
	}

	function getConnections(): PeerConnection[] {
		const connections: PeerConnection[] = [];
		for (const [ws, peer] of connectedPeers) {
			if (peer.authenticated && peer.did && peer.peerId) {
				connections.push({
					peerId: peer.peerId,
					did: peer.did,
					publicKey: peer.publicKeyB64 ?? "",
					trustLevel: peer.trustLevel ?? "pending",
					connected: ws.readyState === WebSocket.OPEN,
				});
			}
		}
		return connections;
	}

	return { close, getConnections, wss, port };
}

// ---------------------------------------------------------------------------
// Message routing
// ---------------------------------------------------------------------------

async function handleMessage(
	ws: WebSocket,
	peer: ConnectedPeer,
	message: PeerMessage,
	db: FederationDb,
	config: FederationConfig,
): Promise<void> {
	switch (message.type) {
		case "HANDSHAKE":
			await handleHandshake(ws, peer, message as PeerMessage<HandshakePayload>, db, config);
			break;

		case "SYNC_REQUEST":
			await handleSyncRequestMsg(ws, peer, message as PeerMessage<SyncRequest>, db, config);
			break;

		case "SYNC_RESPONSE":
			await handleSyncResponseMsg(ws, peer, message as PeerMessage<SyncResponse>, db);
			break;

		case "MEMORY_PUSH":
			await handleMemoryPush(ws, peer, message as PeerMessage<MemoryPushPayload>, db, config);
			break;

		case "MEMORY_ACK":
			// Acknowledgment received — no action needed on server
			break;

		case "PING":
			const pong = await createMessage("PONG", {}, config.did);
			ws.send(serializeMessage(pong));
			break;

		case "PONG":
			// Pong received — update last seen
			if (peer.peerId) {
				updatePeerLastSeen(db, peer.peerId);
			}
			break;

		case "ERROR":
			// Log peer errors but don't disconnect
			break;

		default:
			const errMsg = await createMessage("ERROR", {
				code: "UNKNOWN_TYPE",
				message: `Unknown message type: ${message.type}`,
			}, config.did);
			ws.send(serializeMessage(errMsg));
	}

	// Update last seen on any valid message from authenticated peer
	if (peer.authenticated && peer.peerId) {
		updatePeerLastSeen(db, peer.peerId);
	}
}

// ---------------------------------------------------------------------------
// Handler: HANDSHAKE
// ---------------------------------------------------------------------------

async function handleHandshake(
	ws: WebSocket,
	peer: ConnectedPeer,
	message: PeerMessage<HandshakePayload>,
	db: FederationDb,
	config: FederationConfig,
): Promise<void> {
	await sodium.ready;

	const { did: peerDid, publicKey: peerPubKeyB64 } = message.payload;

	// Check if this peer is blocked
	const existingPeer = getPeerByDid(db, peerDid);
	if (existingPeer?.trustLevel === "blocked") {
		const errMsg = await createMessage("ERROR", {
			code: "BLOCKED",
			message: "Connection rejected — peer is blocked",
		}, config.did);
		ws.send(serializeMessage(errMsg));
		ws.close(1008, "Blocked peer");
		return;
	}

	// Verify DID and respond with handshake ACK
	const { message: ackMsg, counterChallenge } = await respondToHandshake(
		message,
		config.did,
		config.publicKey,
		{ displayName: config.displayName, chainAddress: config.chainAddress },
	);

	// Store peer info on the connection
	const peerPublicKey = sodium.from_base64(peerPubKeyB64, sodium.base64_variants.ORIGINAL);
	peer.did = peerDid;
	peer.publicKey = peerPublicKey;
	peer.publicKeyB64 = peerPubKeyB64;
	peer.counterChallenge = counterChallenge;

	// Register or update the peer in the database
	if (existingPeer) {
		peer.peerId = existingPeer.id;
		peer.trustLevel = existingPeer.trustLevel;
	} else {
		const newPeerId = `peer_${Date.now()}_${randomBytes(4).toString("hex")}`;
		const created = addPeer(db, {
			id: newPeerId,
			did: peerDid,
			publicKey: peerPubKeyB64,
			displayName: message.payload.displayName,
			chainAddress: message.payload.chainAddress,
			trustLevel: "pending",
		});
		peer.peerId = created.id;
		peer.trustLevel = "pending";
	}

	// Mark as authenticated (handshake verified peer's DID)
	peer.authenticated = true;

	ws.send(serializeMessage(ackMsg));
}

// ---------------------------------------------------------------------------
// Handler: SYNC_REQUEST
// ---------------------------------------------------------------------------

async function handleSyncRequestMsg(
	ws: WebSocket,
	peer: ConnectedPeer,
	message: PeerMessage<SyncRequest>,
	db: FederationDb,
	config: FederationConfig,
): Promise<void> {
	if (!peer.peerId) return;

	// Verify message signature
	if (peer.publicKey) {
		const valid = await verifyMessage(message, peer.publicKey);
		if (!valid) {
			const errMsg = await createMessage("ERROR", {
				code: "INVALID_SIGNATURE",
				message: "Sync request signature verification failed",
			}, config.did);
			ws.send(serializeMessage(errMsg));
			return;
		}
	}

	// Only trusted peers can sync
	if (peer.trustLevel !== "trusted") {
		const errMsg = await createMessage("ERROR", {
			code: "NOT_TRUSTED",
			message: "Sync requires trusted peer status. Ask the node operator to trust your peer.",
		}, config.did);
		ws.send(serializeMessage(errMsg));
		return;
	}

	const response = handleSyncRequest(db, peer.peerId, message.payload);
	const responseMsg = await createMessage<SyncResponse>("SYNC_RESPONSE", response, config.did);
	ws.send(serializeMessage(responseMsg));
}

// ---------------------------------------------------------------------------
// Handler: SYNC_RESPONSE
// ---------------------------------------------------------------------------

async function handleSyncResponseMsg(
	_ws: WebSocket,
	peer: ConnectedPeer,
	message: PeerMessage<SyncResponse>,
	db: FederationDb,
): Promise<void> {
	if (!peer.peerId || !peer.publicKey) return;

	const valid = await verifyMessage(message, peer.publicKey);
	if (!valid) return;

	processSyncResponse(db, peer.peerId, message.payload.memories);
}

// ---------------------------------------------------------------------------
// Handler: MEMORY_PUSH
// ---------------------------------------------------------------------------

async function handleMemoryPush(
	ws: WebSocket,
	peer: ConnectedPeer,
	message: PeerMessage<MemoryPushPayload>,
	db: FederationDb,
	config: FederationConfig,
): Promise<void> {
	if (!peer.peerId || !peer.publicKey) return;

	const valid = await verifyMessage(message, peer.publicKey);
	if (!valid) {
		const ack = await createMessage<MemoryAckPayload>("MEMORY_ACK", {
			memoryId: message.payload.memory?.id ?? "unknown",
			accepted: false,
			reason: "Invalid signature",
		}, config.did);
		ws.send(serializeMessage(ack));
		return;
	}

	// Only trusted peers can push memories
	if (peer.trustLevel !== "trusted") {
		const ack = await createMessage<MemoryAckPayload>("MEMORY_ACK", {
			memoryId: message.payload.memory?.id ?? "unknown",
			accepted: false,
			reason: "Not trusted",
		}, config.did);
		ws.send(serializeMessage(ack));
		return;
	}

	const imported = processSyncResponse(db, peer.peerId, [message.payload.memory]);

	const ack = await createMessage<MemoryAckPayload>("MEMORY_ACK", {
		memoryId: message.payload.memory.id,
		accepted: imported > 0,
		reason: imported > 0 ? undefined : "Already received",
	}, config.did);
	ws.send(serializeMessage(ack));
}

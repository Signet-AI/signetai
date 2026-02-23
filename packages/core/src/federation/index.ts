/**
 * @module federation
 * @description P2P federation protocol with DID-verified handshakes,
 * selective memory publishing, and WebSocket transport.
 *
 * Phase 5 — Federation & Marketplace
 */

// Types
export {
	TRUST_LEVELS,
	MESSAGE_TYPES,
} from "./types";
export type {
	TrustLevel,
	FederationPeer,
	MessageType,
	PeerMessage,
	HandshakePayload,
	HandshakeAckPayload,
	HandshakeCompletePayload,
	SyncRequest,
	SyncMemory,
	SyncResponse,
	MemoryPushPayload,
	MemoryAckPayload,
	ErrorPayload,
	SharedMemory,
	ReceivedMemory,
	PublishRule,
	FederationConfig,
	FederationDb,
	PeerConnection,
} from "./types";

// Protocol
export {
	createMessage,
	verifyMessage,
	parseMessage,
	serializeMessage,
	buildMessageSignable,
} from "./protocol";

// Handshake
export {
	generateChallenge,
	initiateHandshake,
	respondToHandshake,
	completeHandshake,
	signCounterChallenge,
	verifyCounterChallengeResponse,
} from "./handshake";

// Peer Manager
export {
	addPeer,
	getPeerById,
	getPeerByDid,
	getPeers,
	getTrustedPeers,
	updatePeerTrust,
	blockPeer,
	removePeer,
	updatePeerLastSeen,
	updatePeerLastSync,
	incrementMemoriesShared,
	incrementMemoriesReceived,
	updatePeerEndpoint,
} from "./peer-manager";

// Sync
export {
	requestSync,
	handleSyncRequest,
	processSyncResponse,
	getSharedMemories,
	getReceivedMemories,
} from "./sync";

// Publisher
export {
	createPublishRule,
	getPublishRules,
	getPublishRuleById,
	updatePublishRule,
	deletePublishRule,
	getPublishableMemories,
	autoPublish,
} from "./publisher";

// Server
export {
	createFederationServer,
} from "./server";
export type {
	FederationServer,
} from "./server";

// Client
export {
	connectToPeer,
	createReconnectingClient,
} from "./client";
export type {
	FederationClientConnection,
	ReconnectingClient,
} from "./client";

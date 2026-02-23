// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title SignetIdentity
 * @notice ERC-8004 compatible identity registry for Signet AI agents.
 *
 * Each agent identity is minted as an ERC-721 NFT containing:
 * - A DID (did:signet:base:0x...)
 * - A metadata URI (IPFS or HTTP) pointing to the full agent manifest
 * - A hash of the agent's Ed25519 public key (for DID verification)
 * - A Merkle root of the agent's memory tree (on-chain anchoring)
 *
 * Memory anchoring allows anyone to verify: "Did this agent know X at time Y?"
 * by providing a Merkle inclusion proof against the on-chain root hash.
 */
contract SignetIdentity is ERC721, Ownable {
    struct AgentIdentity {
        string did;              // did:signet:base:0x...
        string metadataURI;     // IPFS URI for full agent manifest
        bytes32 publicKeyHash;  // Hash of Ed25519 public key
        uint256 registeredAt;
        uint256 lastAnchored;   // Last memory anchor timestamp
        bytes32 memoryRoot;     // Merkle root of memory tree
        uint64 memoryCount;     // Total memories anchored
    }

    mapping(uint256 => AgentIdentity) public identities;
    mapping(bytes32 => uint256) public didToTokenId;  // DID hash → token
    mapping(bytes32 => bool) public publicKeyRegistered;  // Prevent duplicate keys

    uint256 private _nextTokenId;

    // Events
    event IdentityRegistered(uint256 indexed tokenId, string did, bytes32 publicKeyHash);
    event MemoryAnchored(uint256 indexed tokenId, bytes32 memoryRoot, uint64 memoryCount);
    event MetadataUpdated(uint256 indexed tokenId, string metadataURI);

    constructor() ERC721("Signet Identity", "SIGNET") Ownable(msg.sender) {}

    /**
     * @notice Register a new agent identity and mint an NFT.
     * @param did The agent's DID string (e.g., did:signet:base:0x...)
     * @param metadataURI URI pointing to the agent's full manifest (IPFS preferred)
     * @param publicKeyHash keccak256 hash of the agent's Ed25519 public key
     * @return tokenId The minted NFT token ID
     */
    function register(
        string calldata did,
        string calldata metadataURI,
        bytes32 publicKeyHash
    ) external returns (uint256) {
        require(!publicKeyRegistered[publicKeyHash], "Key already registered");
        require(didToTokenId[keccak256(bytes(did))] == 0, "DID already registered");

        uint256 tokenId = ++_nextTokenId;
        _mint(msg.sender, tokenId);

        identities[tokenId] = AgentIdentity({
            did: did,
            metadataURI: metadataURI,
            publicKeyHash: publicKeyHash,
            registeredAt: block.timestamp,
            lastAnchored: 0,
            memoryRoot: bytes32(0),
            memoryCount: 0
        });

        didToTokenId[keccak256(bytes(did))] = tokenId;
        publicKeyRegistered[publicKeyHash] = true;

        emit IdentityRegistered(tokenId, did, publicKeyHash);
        return tokenId;
    }

    /**
     * @notice Anchor a memory Merkle root on-chain.
     * @dev Only the NFT owner can anchor memories for their identity.
     * @param tokenId The identity NFT token ID
     * @param memoryRoot The Merkle root of the agent's signed memory tree
     * @param memoryCount Total number of memories in the tree
     */
    function anchorMemory(
        uint256 tokenId,
        bytes32 memoryRoot,
        uint64 memoryCount
    ) external {
        require(ownerOf(tokenId) == msg.sender, "Not owner");

        identities[tokenId].memoryRoot = memoryRoot;
        identities[tokenId].memoryCount = memoryCount;
        identities[tokenId].lastAnchored = block.timestamp;

        emit MemoryAnchored(tokenId, memoryRoot, memoryCount);
    }

    /**
     * @notice Update the metadata URI for an agent identity.
     * @param tokenId The identity NFT token ID
     * @param metadataURI New metadata URI
     */
    function updateMetadata(uint256 tokenId, string calldata metadataURI) external {
        require(ownerOf(tokenId) == msg.sender, "Not owner");
        identities[tokenId].metadataURI = metadataURI;
        emit MetadataUpdated(tokenId, metadataURI);
    }

    /**
     * @notice Look up an agent identity by DID.
     * @param did The DID string to look up
     * @return The AgentIdentity struct
     */
    function getIdentityByDID(string calldata did) external view returns (AgentIdentity memory) {
        uint256 tokenId = didToTokenId[keccak256(bytes(did))];
        require(tokenId != 0, "DID not found");
        return identities[tokenId];
    }

    /**
     * @notice Override tokenURI to return the agent's metadata URI.
     */
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return identities[tokenId].metadataURI;
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title SignetIdentity
 * @notice ERC-8004 compatible identity registry for Signet AI agents.
 *
 * Each agent identity is minted as a **soulbound** (non-transferable) ERC-721
 * NFT. Registration uses commit-reveal to prevent front-running (C-1 audit fix).
 */
contract SignetIdentity is ERC721, Ownable {
    struct AgentIdentity {
        string did;
        string metadataURI;
        bytes32 publicKeyHash;
        uint256 registeredAt;
        uint256 lastAnchored;
        bytes32 memoryRoot;
        uint64 memoryCount;
    }

    mapping(uint256 => AgentIdentity) public identities;
    mapping(bytes32 => uint256) public didToTokenId;
    mapping(bytes32 => bool) public publicKeyRegistered;

    // Commit-reveal for front-running protection (C-1)
    mapping(bytes32 => uint256) public commitTimestamps;
    uint256 public constant COMMIT_DELAY = 1;
    uint256 public constant COMMIT_EXPIRY = 86400;

    uint256 private _nextTokenId;

    event IdentityRegistered(uint256 indexed tokenId, string did, bytes32 publicKeyHash);
    event MemoryAnchored(uint256 indexed tokenId, bytes32 memoryRoot, uint64 memoryCount);
    event MetadataUpdated(uint256 indexed tokenId, string metadataURI);
    event RegistrationCommitted(address indexed sender, bytes32 commitment);

    constructor() ERC721("Signet Identity", "SIGNET") Ownable(msg.sender) {}

    /// @notice H-1: Soulbound — block all transfers, allow mints
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0)) {
            revert("Soulbound: identity NFTs are non-transferable");
        }
        return super._update(to, tokenId, auth);
    }

    /// @notice Phase 1: commit a registration hash
    function commitRegistration(bytes32 commitment) external {
        commitTimestamps[commitment] = block.timestamp;
        emit RegistrationCommitted(msg.sender, commitment);
    }

    /// @notice Phase 2: register with revealed data + salt
    function register(
        string calldata did,
        string calldata metadataURI,
        bytes32 publicKeyHash,
        bytes32 salt
    ) external returns (uint256) {
        require(publicKeyHash != bytes32(0), "Invalid public key hash");       // H-2
        require(bytes(did).length > 0, "DID cannot be empty");                 // H-3
        require(!publicKeyRegistered[publicKeyHash], "Key already registered");
        require(didToTokenId[keccak256(bytes(did))] == 0, "DID already registered");

        // Verify commit-reveal (C-1)
        bytes32 commitment = keccak256(abi.encodePacked(did, metadataURI, publicKeyHash, msg.sender, salt));
        uint256 commitTime = commitTimestamps[commitment];
        require(commitTime != 0, "No commitment found");
        require(block.timestamp >= commitTime + COMMIT_DELAY, "Commitment too recent");
        require(block.timestamp <= commitTime + COMMIT_EXPIRY, "Commitment expired");
        delete commitTimestamps[commitment];

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

    function anchorMemory(
        uint256 tokenId,
        bytes32 memoryRoot,
        uint64 memoryCount
    ) external {
        require(ownerOf(tokenId) == msg.sender, "Not owner");
        require(memoryCount >= identities[tokenId].memoryCount, "Memory count cannot decrease"); // M-9

        identities[tokenId].memoryRoot = memoryRoot;
        identities[tokenId].memoryCount = memoryCount;
        identities[tokenId].lastAnchored = block.timestamp;

        emit MemoryAnchored(tokenId, memoryRoot, memoryCount);
    }

    function updateMetadata(uint256 tokenId, string calldata metadataURI) external {
        require(ownerOf(tokenId) == msg.sender, "Not owner");
        identities[tokenId].metadataURI = metadataURI;
        emit MetadataUpdated(tokenId, metadataURI);
    }

    function getIdentityByDID(string calldata did) external view returns (AgentIdentity memory) {
        uint256 tokenId = didToTokenId[keccak256(bytes(did))];
        require(tokenId != 0, "DID not found");
        return identities[tokenId];
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return identities[tokenId].metadataURI;
    }
}

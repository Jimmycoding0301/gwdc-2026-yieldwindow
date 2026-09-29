// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

/// @notice Minimal event registry shared by GWDC testnet receipt demos.
/// @dev Compile with optimizer enabled and 200 runs for TRONSCAN verification.
contract ReceiptRegistry {
    event ReceiptCommitted(
        address indexed submitter,
        bytes32 indexed kind,
        bytes32 digest,
        uint256 timestamp
    );

    function commit(bytes32 kind, bytes32 digest) external {
        require(kind != bytes32(0), "kind=0");
        require(digest != bytes32(0), "digest=0");
        emit ReceiptCommitted(msg.sender, kind, digest, block.timestamp);
    }
}

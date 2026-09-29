# ReceiptRegistry deployment

`ReceiptRegistry.sol` is the same minimal event-only contract used by the verified EnergyDesk and YieldWindow Nile receipts. It stores no funds.

The confirmed GWDC demo deployment is:

- Contract: [`TSqoRAmu4qviTuscsakTWdYRZQjpiTjP2u`](https://nile.tronscan.org/#/contract/TSqoRAmu4qviTuscsakTWdYRZQjpiTjP2u)
- Deployment transaction: [`7f481964…b091`](https://nile.tronscan.org/#/transaction/7f48196490dccdda47e1ca0166d99c7b9b583d4cc5ea5c3b802838c26fd0b091)

To deploy another Nile instance, compile with Solidity `0.8.20`, optimizer enabled for `200` runs, and the settings in [`compiler-settings.json`](compiler-settings.json). The constructor has no arguments. Use zero call value and verify the same source and settings on Nile TRONSCAN.

```solidity
function commit(bytes32 kind, bytes32 digest) external;
event ReceiptCommitted(address indexed submitter, bytes32 indexed kind, bytes32 digest, uint256 timestamp);
```

YieldWindow sends a zero-value call whose `kind` is the fixed `yieldwindow.plan.v1` bytes32 value and whose `digest` is the SHA-256 hash of canonical plan JSON. The verifier independently matches the transaction, receipt, event, wallet, Registry and calldata before reporting `confirmed`.

This receipt proves a plan payload was committed. It does not execute or prove a JustLend deposit.

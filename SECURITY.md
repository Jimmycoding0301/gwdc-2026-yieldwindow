# Security policy

## Reporting

Use GitHub private vulnerability reporting or a private Security Advisory after publication. Do not publish credentials or exploit details in an issue.

## Secrets and signing

- Never commit `.env`, `.data`, Kiln keys, TronGrid keys, wallet files, seed phrases or private keys.
- Qwen credentials remain on the local API server and must never use a `VITE_` variable.
- The application never requests a wallet private key. TronLink signs only an explicit zero-value Nile receipt call.
- The optional standalone JustLend canary reads a dedicated Nile-only test key from an ignored local wallet file. It verifies the Nile chain ID and fixed official jTRX address, persists signed bytes with mode `0600`, broadcasts each transaction once, and publishes no key or signature.
- Use a dedicated Nile test wallet and verify account, network, Registry, method, digest and fee limit before signing.

## Financial boundary

Planning is informational. Stablecoins can depeg, protocol rates change, liquidity can disappear, and estimated yield is not guaranteed. Deposit, redemption and rebalance steps are simulated in this version.

This is a local single-user prototype and has not received a production smart-contract or application audit.

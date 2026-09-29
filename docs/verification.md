# YieldWindow verification record

Updated: **2026-09-29 KST**.

## Automated verification

- `npm test`: 98 tests passed and one platform-conditional test skipped in the source workspace before packaging.
- `npm run build`: TypeScript and Vite production build passed.
- Coverage includes reserve invariants, plan comparison, market fallbacks, OCR safety, action restrictions, persistence, receipt construction, transaction durability and Nile receipt verification.
- The standalone submission package is revalidated with `npm ci`, `npm test` and `npm run build` before handoff.

## Integration verification

- A real `qwen3-32b` intake request returned `modelMode: kiln` and reported 98 input / 451 output tokens. The model only rewrote the deterministic next question; it did not calculate balances or authorize actions.
- A live JustLend/USDD sample was read on 2026-09-28. Those values were observation-time samples, not future rates or guarantees.
- A synthetic Apple Vision image produced five candidate fields. No field was applied until explicitly selected.
- The browser flow generated two plans, preserved the settlement reserve, replayed a refund shock, created per-step simulated actions and restored local state after restart.

Representative project-owned screenshots:

- [Desktop flow](verification-desktop.png)
- [Mobile flow](verification-mobile.png)
- [Mobile stress replay](bai-mobile-stress.png)

## Nile evidence

- Registry deployment transaction: [`7f481964…b091`](https://nile.tronscan.org/#/transaction/7f48196490dccdda47e1ca0166d99c7b9b583d4cc5ea5c3b802838c26fd0b091)
- Registry: [`TSqoRAmu4qviTuscsakTWdYRZQjpiTjP2u`](https://nile.tronscan.org/#/contract/TSqoRAmu4qviTuscsakTWdYRZQjpiTjP2u)
- YieldWindow receipt: [`4adaf2cf…a51`](https://nile.tronscan.org/#/transaction/4adaf2cfc03e80c36533cad6024e17de463eedc2efef66da3c1873602c1fca51)
- Independent verifier status: `confirmed`; transaction, zero-value call, Registry, kind, digest, event and execution result matched.
- Evidence JSON: [deployment](evidence/registry-deployment.json) and [receipt](evidence/yieldwindow-receipt.json).

The committed payload is a demo plan whose saved market sources were unavailable and labeled fallback data. The receipt does not prove JustLend execution or realized yield.

## Known boundaries

Wallet holdings, approve/deposit/withdraw actions, positions and review results remain local simulations. There is no background monitoring, production deployment, real protocol execution, financial advice or security audit.


# GWDC 2026 Korea submission

| Field | Value |
|---|---|
| Ecosystem / Challenge | TRON · Challenge B |
| Project | YieldWindow |
| Repository name | `gwdc-2026-yieldwindow` |
| Team name | **TODO: team leader** |
| Team leader | **TODO: team leader** |
| Contact email | **TODO: personal submission email** |
| Telegram | **TODO: Telegram handle** |
| Repository URL | <https://github.com/Jimmycoding0301/gwdc-2026-yieldwindow> |
| Demo video, ≤3 minutes | <https://github.com/Jimmycoding0301/gwdc-2026-yieldwindow/raw/refs/heads/main/docs/submission/demo.mp4> |
| Pitch deck | <https://github.com/Jimmycoding0301/gwdc-2026-yieldwindow/raw/refs/heads/main/docs/submission/pitch-deck.pptx> |
| Local demo | `npm ci && npm run dev` → <http://127.0.0.1:5176> |

## Short description

**English:** YieldWindow protects Friday seller-settlement reserves before comparing JustLend and USDD plans. It captures needs conversationally, separates base yield, incentives and costs, replays a refund shock, and anchors the confirmed demo plan on Nile.

**中文：** YieldWindow 先锁定周五卖家款和退款缓冲，再比较 JustLend 与 USDD 方案，分开基础收益、激励与成本，并在退款压力变化时重算和复盘。

## Challenge mapping

- Conversational needs intake and explicit confirmation.
- JustLend and USDD source labeling and update times.
- Two plans with allocations, estimated yield, costs, exit conditions and risk.
- Simulated action construction, stress replay and plan review.

## Evidence and validation

- Registry: <https://nile.tronscan.org/#/contract/TSqoRAmu4qviTuscsakTWdYRZQjpiTjP2u>
- Receipt: <https://nile.tronscan.org/#/transaction/4adaf2cfc03e80c36533cad6024e17de463eedc2efef66da3c1873602c1fca51>
- JustLend V1 live mint: <https://nile.tronscan.org/#/transaction/9b2098a8751d002bc80ca139737db0ded3cbd64770f71644ab4520aadf30b663>
- JustLend V1 live redeem: <https://nile.tronscan.org/#/transaction/9546eb310aa71bd514a9709b3082e4c525a744539ae6f541069b4a27d36128ff>
- Public JSON: [docs/evidence](docs/evidence)
- Clean-package validation: `npm ci` passed; 98 tests passed, one platform-conditional test skipped; production build passed.
- Commands: `npm test`, `npm run build`

## Disclosure

The plan receipt commits a demo plan. A separate 1 test TRX jTRX mint/redeem canary is real and Solidity-confirmed. The product's USDT/USDD allocation, rebalance and realized yield remain simulated. See [HACKATHON_SCOPE.md](HACKATHON_SCOPE.md).

No open-source license has been selected. The public repository is available to reviewers without sign-in.

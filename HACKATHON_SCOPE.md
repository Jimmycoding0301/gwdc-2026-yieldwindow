# Hackathon scope disclosure

## English

This repository is the GWDC 2026 Korea TRON Challenge B submission snapshot assembled on **2026-09-29 KST**. The original workspace did not preserve a usable pre-submission Git history. This disclosure therefore avoids unsupported file-level timing claims.

### Existing work and reused foundations

- React, Vite, Express, TypeScript, Vitest and Zod are third-party open-source dependencies.
- JustLend and USDD market interfaces, product documentation and names belong to their respective projects.
- Reserve accounting, scenario analysis and yield comparison are established financial-planning methods.

### GWDC-specific implementation and verification

- The product was focused on a cross-border merchant's Friday seller-settlement reserve.
- Conversational intake, deterministic reserve enforcement, two-plan comparison, Thursday refund-shock replay, OCR draft input, local persistence and management summaries were integrated.
- Optional Qwen3-32B clarification wording and read-only JustLend/USDD data adapters were implemented with explicit fallback labeling.
- A Nile plan receipt was confirmed on 2026-09-29 and independently matched to the saved demo payload.
- A separate 1 test TRX JustLend V1 canary completed a real `mint()` and `redeemUnderlying()` on Nile on 2026-09-30. Both transactions reached Solidity confirmation and the jTRX balance returned to zero.
- Automated tests, security checks, responsive UI verification and standalone submission packaging were completed.

The live canary proves the JustLend write path for TRX only. Execution of the product's USDT/USDD treasury plan, rebalancing, realized yield and production monitoring was not completed and is not claimed.

### AI assistance

OpenAI Codex assisted implementation, testing, review, documentation and packaging. The participant remains responsible for every submitted claim.

## 中文

本仓库是 2026-09-29 KST 整理的 TRON B 提交快照。项目使用通用开源依赖与公开生态资料；GWDC 场景整合了周五结算准备金、两套方案、退款压力重算、Qwen 可选追问和 Nile 计划存证。2026-09-30 又完成了 1 测试 TRX 的真实 JustLend V1 存入与赎回探针；它只证明写入链路，不代表 USDT/USDD 金库方案已经执行。

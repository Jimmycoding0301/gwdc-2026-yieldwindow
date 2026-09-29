import { describe, expect, it } from "vitest";
import { buildPlans, initialActions } from "../shared/planner";
import {
  applyThursdayRefundShock,
  attemptSummaryCopy,
  idleMicros,
  managerSummary,
  quickHorizon,
  quickReserve,
  reviewStressScenarios,
} from "../shared/workflows";
import { demoSnapshot } from "../server/market";
import type { Portfolio, Profile } from "../shared/types";
const profile: Profile = {
  usdtMicros: 6e9,
  usddMicros: 4e9,
  horizonDays: 30,
  sellerSettlementMicros: 2e9,
  bufferMicros: 1e9,
  reserveInDays: 7,
  reserveMicros: 3e9,
  risk: "cautious",
  hasDebt: false,
  allowUSDD: true,
  perActionCostMicros: 200000,
};
describe("small workflow operations", () => {
  it("changes only requested horizon and does not move the payment deadline", () => {
    expect(quickHorizon(profile, 7)).toEqual({ ...profile, horizonDays: 7 });
    expect(profile.horizonDays).toBe(30);
    expect(() => quickHorizon(profile, 5)).toThrow();
  });
  it("reserves exact fraction without changing risk/fees/time", () => {
    expect(quickReserve(profile, 0.25)).toEqual({
      ...profile,
      reserveMicros: 1.5e9,
    });
    expect(() => quickReserve({}, 0.5)).toThrow();
    expect(() => quickReserve(profile, 0.9)).toThrow();
  });
  it("recalculates Thursday refund pressure without mutating the confirmed brief", () => {
    const revised = applyThursdayRefundShock(profile, 1e9);
    expect(revised.bufferMicros).toBe(2e9);
    expect(revised.reserveMicros).toBe(4e9);
    expect(idleMicros(revised)).toBe(6e9);
    expect(profile.bufferMicros).toBe(1e9);
    expect(() =>
      applyThursdayRefundShock(
        { ...profile, reserveMicros: 6e9, bufferMicros: 4e9 },
        1,
      ),
    ).toThrow();
  });
  it("summary names seller reserve, both plans, sources, costs and simulation boundary", () => {
    const plans = buildPlans(profile, demoSnapshot("2026-09-28T12:00:00Z"));
    const summary = managerSummary(plans);
    for (const text of [
      "方案 A",
      "方案 B",
      "卖家款 2,000.00",
      "退款/物流缓冲 1,000.00",
      "第 7 天",
      "2026-09-28T12:00:00Z",
      "https://",
      "全周期成本",
      "未发送链上交易",
      "演示后备参数",
    ])
      expect(summary).toContain(text);
  });
  it("returns a visible manual-copy fallback for permission failure or unavailable clipboard", async () => {
    for (const writer of [
      undefined,
      async () => {
        throw new Error("NotAllowedError");
      },
    ]) {
      const result = await attemptSummaryCopy("safe summary", writer);
      expect(result.copied).toBe(false);
      expect(result.message).toContain("手动复制");
    }
    let received = "";
    expect(
      (
        await attemptSummaryCopy("safe summary", async (value) => {
          received = value;
        })
      ).copied,
    ).toBe(true);
    expect(received).toBe("safe summary");
  });
  it("does not manufacture a second plan for summary", () => {
    expect(() => managerSummary([])).toThrow();
  });
  it("runs three scenarios on the same snapshot and principal without mutating the plan, positions or actions", () => {
    const latest = demoSnapshot();
    const plan = buildPlans(profile, latest)[0];
    const portfolio: Portfolio = {
      plan,
      actions: initialActions(plan),
      positions: { USDT: 1.5e9, USDD: 1e9 },
      confirmedAt: plan.createdAt,
      logs: [],
    };
    const before = JSON.stringify(portfolio);
    const results = reviewStressScenarios(portfolio, latest, 7);
    expect(results.map((r) => r.scenario)).toEqual([
      "incentive-end",
      "rate-drop",
      "depeg",
    ]);
    expect(new Set(results.map((r) => r.snapshotId)).size).toBe(1);
    expect(
      results.every((r) => r.days === 7 && r.mode === "simulated-position"),
    ).toBe(true);
    expect(results[2].priceImpactMicros).toBe(-80e6);
    expect(JSON.stringify(portfolio)).toBe(before);
  });
  it("stress batch rejects a horizon beyond the confirmed plan", () => {
    const plan = buildPlans(profile, demoSnapshot())[0];
    expect(() =>
      reviewStressScenarios(
        {
          plan,
          actions: [],
          positions: { USDT: 0, USDD: 0 },
          confirmedAt: plan.createdAt,
          logs: [],
        },
        demoSnapshot(),
        31,
      ),
    ).toThrow();
  });
});

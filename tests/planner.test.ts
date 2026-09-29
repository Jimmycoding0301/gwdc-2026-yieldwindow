import { describe, expect, it } from "vitest";
import {
  applySimulation,
  buildPlans,
  initialActions,
  micros,
  parseIntake,
  profileFields,
  profileSchema,
  reviewPortfolio,
} from "../shared/planner";
import type { Portfolio, Profile } from "../shared/types";
import { demoSnapshot } from "../server/market";
const profile: Profile = {
  usdtMicros: 6_000_000_000,
  usddMicros: 4_000_000_000,
  horizonDays: 30,
  sellerSettlementMicros: 2_000_000_000,
  bufferMicros: 1_000_000_000,
  reserveMicros: 3_000_000_000,
  reserveInDays: 7,
  risk: "cautious",
  allowUSDD: true,
  hasDebt: false,
  perActionCostMicros: 200_000,
};
const make = () => {
  const plan = buildPlans(profile, demoSnapshot())[0];
  return {
    plan,
    confirmedAt: new Date().toISOString(),
    actions: initialActions(plan),
    positions: { USDT: 0, USDD: 0 },
    logs: [],
  } satisfies Portfolio;
};
describe("exact bounded input and follow-up", () => {
  it("parses six decimals exactly and rejects precision loss/unsafe values", () => {
    expect(micros("1.000001")).toBe(1_000_001);
    expect(micros("0.0000001")).toBeUndefined();
    expect(micros("100000.000001")).toBeUndefined();
    expect(micros("-3")).toBeUndefined();
    expect(micros("1e3")).toBeUndefined();
  });
  it("does not invent missing holdings, liquidity, risk or fees", () => {
    const result = parseIntake("USDT 6000");
    expect(result.draft).toEqual({ usdtMicros: 6_000_000_000 });
    expect(result.missing).toHaveLength(9);
    expect(result.question).toContain("USDD");
  });
  it("collects seller settlement and buffer but still asks for confirmation", () => {
    const result = parseIntake(
      "USDT 6000，USDD 4000，规划 30 天，卖家款 2000 USDT，退款/物流缓冲 1000 USDT，7 天后需要 3000 USDT，风险谨慎，无借款，允许 USDD，每次费用 0.2。",
    );
    expect(result.draft).toEqual(profile);
    expect(result.missing).toHaveLength(0);
    expect(result.question).toContain("确认");
  });
  it("does not truncate overprecision during conversation", () => {
    expect(parseIntake("USDT 6.1234567").draft.usdtMicros).toBeUndefined();
  });
  it("explicitly disallows new USDD allocation", () => {
    expect(parseIntake("不允许 USDD", profile).draft.allowUSDD).toBe(false);
  });
  it("accepts a partial input schema without applying complete-profile refinements", () => {
    expect(profileFields.partial().safeParse({ usdtMicros: 5 }).success).toBe(
      true,
    );
  });
  it.each([
    { hasDebt: true },
    { reserveMicros: 7_000_000_000 },
    { bufferMicros: 2_000_000_000 },
    { horizonDays: 91 },
    { reserveInDays: 31 },
    { perActionCostMicros: 10_000_001 },
    { risk: "safe" },
    { usdtMicros: "6000" },
    { allowUSDD: false, reserveMicros: 6_000_000_000 },
  ])("rejects infeasible or unsupported brief %j", (invalid) => {
    expect(profileSchema.safeParse({ ...profile, ...invalid }).success).toBe(
      false,
    );
  });
});
describe("two feasible plans and honest yield composition", () => {
  it("preserves each token and keeps the whole required USDT reserve in both plans", () => {
    const plans = buildPlans(profile, demoSnapshot());
    expect(plans).toHaveLength(2);
    expect(plans[0].allocations).not.toEqual(plans[1].allocations);
    for (const plan of plans) {
      for (const asset of ["USDT", "USDD"] as const)
        expect(
          plan.allocations
            .filter((a) => a.asset === asset)
            .reduce((sum, a) => sum + a.amountMicros, 0),
        ).toBe(asset === "USDT" ? profile.usdtMicros : profile.usddMicros);
      expect(
        plan.allocations.find(
          (a) => a.asset === "USDT" && a.destination === "wallet",
        )!.amountMicros,
      ).toBeGreaterThanOrEqual(profile.reserveMicros);
    }
  });
  it("excludes incentive with unverified term from net forecast", () => {
    const plan = buildPlans(profile, demoSnapshot())[0];
    expect(plan.incentiveYieldMicros).toBe(0);
    expect(plan.indicativeBonusMicros).toBeGreaterThan(0);
    expect(plan.netMicros).toBe(plan.baseYieldMicros - plan.costMicros);
  });
  it("caps verified incentive by its verified period, not the whole horizon", () => {
    const snapshot = demoSnapshot();
    snapshot.incentiveDaysVerified = 2;
    const plan = buildPlans(profile, snapshot)[0];
    expect(plan.incentiveYieldMicros).toBeLessThan(plan.indicativeBonusMicros);
    expect(plan.incentiveYieldMicros).toBe(
      Math.round((1_000_000_000 * 0.04 * 2) / 365),
    );
  });
  it("includes approve, supply and eventual redemption costs", () => {
    expect(buildPlans(profile, demoSnapshot())[0].costMicros).toBe(
      6 * profile.perActionCostMicros,
    );
  });
  it("never supplies USDD when the user forbids it", () => {
    for (const plan of buildPlans(
      { ...profile, allowUSDD: false },
      demoSnapshot(),
    ))
      expect(
        plan.allocations.some(
          (a) => a.asset === "USDD" && a.destination === "justlend",
        ),
      ).toBe(false);
  });
  it("snapshots original assumptions against later mutations", () => {
    const snapshot = demoSnapshot();
    const input = { ...profile };
    const plan = buildPlans(input, snapshot)[0];
    snapshot.markets.USDT.baseRate = 5;
    input.reserveMicros = 0;
    expect(plan.profile.reserveMicros).toBe(profile.reserveMicros);
    expect(plan.snapshot.markets.USDT.baseRate).toBe(0.02);
  });
  it("different confirmed inputs create distinct ids from one market snapshot", () => {
    const snapshot = demoSnapshot();
    expect(buildPlans(profile, snapshot)[0].id).not.toBe(
      buildPlans({ ...profile, horizonDays: 7 }, snapshot)[0].id,
    );
  });
});
describe("confirmed simulation and frozen-plan review", () => {
  it("requires approval before deposit and forbids repeats", () => {
    const p = make();
    expect(() => applySimulation(p, p.actions[1].id)).toThrow();
    const approved = applySimulation(p, p.actions[0].id);
    expect(approved.positions.USDT).toBe(0);
    expect(() => applySimulation(approved, p.actions[0].id)).toThrow();
    const deposited = applySimulation(approved, p.actions[1].id);
    expect(deposited.positions.USDT).toBe(p.actions[1].amountMicros);
    expect(p.positions.USDT).toBe(0);
    expect(JSON.stringify(deposited)).not.toContain("txHash");
  });
  it("guards the reserve even if a draft action is tampered", () => {
    const p = make();
    const approved = applySimulation(p, p.actions[0].id);
    approved.actions[1].amountMicros = profile.usdtMicros;
    expect(() => applySimulation(approved, p.actions[1].id)).toThrow();
  });
  it("does not accept approval for a smaller amount or a different spender", () => {
    const p = make();
    const approved = applySimulation(p, p.actions[0].id);
    approved.actions[0].amountMicros = 1;
    expect(() => applySimulation(approved, p.actions[1].id)).toThrow();
    approved.actions[0].amountMicros = p.actions[1].amountMicros;
    approved.actions[0].spender = "different";
    expect(() => applySimulation(approved, p.actions[1].id)).toThrow();
  });
  it("cannot withdraw more than simulated position", () => {
    const p = make();
    p.actions.push({
      ...p.actions[0],
      id: "withdraw",
      kind: "withdraw",
      amountMicros: 1,
    });
    expect(() => applySimulation(p, "withdraw")).toThrow();
  });
  it("a depeg affects existing USDD in wallet too, and never claims actual profit", () => {
    const p = make();
    const original = JSON.stringify(p.plan);
    const result = reviewPortfolio(p, demoSnapshot(), 7, "depeg");
    expect(result.priceImpactMicros).toBe(-80_000_000);
    expect(result.mode).toBe("simulated-position");
    expect(result.suggestions.join("")).toContain("不能消除");
    expect(JSON.stringify(p.plan)).toBe(original);
  });
  it("uses original and latest rate on the same simulated principal", () => {
    const p = make();
    p.positions.USDT = 1_000_000_000;
    const latest = demoSnapshot();
    latest.markets.USDT.baseRate = 0.01;
    const result = reviewPortfolio(p, latest, 30, "current");
    expect(result.expectedMicros).toBe(
      Math.round((1_000_000_000 * 0.02 * 30) / 365),
    );
    expect(result.observedBaseMicros).toBe(
      Math.round((1_000_000_000 * 0.01 * 30) / 365),
    );
    expect(result.deltaMicros).toBeLessThan(0);
  });
  it("surfaces material rate changes and low cash without auto-rebalancing", () => {
    const p = make();
    p.positions.USDT = 1_000_000_000;
    const latest = demoSnapshot();
    latest.markets.USDT.baseRate = 0.001;
    latest.markets.USDT.cash = "1";
    const result = reviewPortfolio(p, latest, 7, "current");
    expect(result.suggestions.join("")).toContain("基础年化从");
    expect(result.suggestions.join("")).toContain("全额赎回可能无法完成");
    expect(p.actions.every((a) => a.status === "ready")).toBe(true);
  });
  it("rejects a review beyond the original horizon", () => {
    expect(() =>
      reviewPortfolio(make(), demoSnapshot(), 31, "current"),
    ).toThrow();
  });
});

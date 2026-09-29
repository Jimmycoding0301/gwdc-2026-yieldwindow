import { z } from "zod";
import type {
  Action,
  Asset,
  Intake,
  Plan,
  Portfolio,
  Profile,
  Review,
  Snapshot,
} from "./types";
const moneySchema = z.number().int().safe().nonnegative().max(100_000_000_000);
export const profileFields = z
  .object({
    usdtMicros: moneySchema,
    usddMicros: moneySchema,
    horizonDays: z.number().int().min(1).max(90),
    sellerSettlementMicros: moneySchema,
    bufferMicros: moneySchema,
    reserveMicros: moneySchema,
    reserveInDays: z.number().int().min(1).max(90),
    risk: z.enum(["cautious", "balanced"]),
    allowUSDD: z.boolean(),
    hasDebt: z.boolean(),
    perActionCostMicros: moneySchema.max(10_000_000),
  })
  .strict();
export const profileSchema = profileFields.superRefine((p, ctx) => {
  if (p.usdtMicros + p.usddMicros === 0)
    ctx.addIssue({ code: "custom", message: "请输入非零持仓。" });
  if (p.sellerSettlementMicros + p.bufferMicros !== p.reserveMicros)
    ctx.addIssue({
      code: "custom",
      message: "周五预留必须等于卖家款与退款/物流缓冲之和。",
    });
  if (p.reserveMicros > p.usdtMicros)
    ctx.addIssue({
      code: "custom",
      message: "当前 USDT 不足以覆盖用款预留；本版不自动换币。",
    });
  if (p.reserveInDays > p.horizonDays)
    ctx.addIssue({ code: "custom", message: "用款日期须在规划期内。" });
  if (p.usdtMicros - p.reserveMicros < 2 && (!p.allowUSDD || p.usddMicros < 4))
    ctx.addIssue({
      code: "custom",
      message: "没有可配置的闲置余额；请调整预留或允许配置已有 USDD。",
    });
  if (p.hasDebt)
    ctx.addIssue({
      code: "custom",
      message: "本版只支持无借款持仓；已有债务需先评估抵押与清算风险。",
    });
});
export const money = (amount: number) =>
  (amount / 1_000_000).toLocaleString("en-US", {
    maximumFractionDigits: 6,
    minimumFractionDigits: 2,
  });
export function micros(text: string): number | undefined {
  if (!/^\d+(?:\.\d{1,6})?$/.test(text)) return;
  const [whole, fraction = ""] = text.split(".");
  const result = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  return result <= 100_000_000_000n ? Number(result) : undefined;
}
const yieldFor = (principal: number, rate: number, days: number) =>
  Math.round((principal * rate * days) / 365);
export function buildPlans(
  raw: unknown,
  snapshot: Snapshot,
  now = new Date().toISOString(),
): Plan[] {
  const p = profileSchema.parse(raw);
  const spare = p.usdtMicros - p.reserveMicros;
  const variants = [
    {
      id: "liquid",
      title: "周五结算优先",
      subtitle: "锁定卖家款与缓冲，只配置一半闲置资金",
      fraction: 0.5,
    },
    {
      id: "balanced",
      title: "闲置资金增强",
      subtitle: "锁定结算准备金，其余按确认范围配置",
      fraction: 1,
    },
  ];
  return variants.map((v) => {
    const usdt = Math.floor(spare * v.fraction);
    const usdd = p.allowUSDD
      ? Math.floor(
          p.usddMicros * (p.risk === "cautious" ? 0.5 : 1) * v.fraction,
        )
      : 0;
    const allocations = (["USDT", "USDD"] as const).flatMap((asset) => {
      const supplied = asset === "USDT" ? usdt : usdd;
      const held = asset === "USDT" ? p.usdtMicros : p.usddMicros;
      const m = snapshot.markets[asset];
      return [
        {
          asset,
          amountMicros: held - supplied,
          destination: "wallet" as const,
          baseYieldMicros: 0,
          incentiveYieldMicros: 0,
        },
        {
          asset,
          amountMicros: supplied,
          destination: "justlend" as const,
          baseYieldMicros: yieldFor(supplied, m.baseRate, p.horizonDays),
          incentiveYieldMicros: yieldFor(
            supplied,
            m.incentiveRate,
            Math.min(p.horizonDays, snapshot.incentiveDaysVerified),
          ),
        },
      ].filter((a) => a.amountMicros > 0);
    });
    const baseYieldMicros = allocations.reduce(
      (s, a) => s + a.baseYieldMicros,
      0,
    );
    const incentiveYieldMicros = allocations.reduce(
      (s, a) => s + a.incentiveYieldMicros,
      0,
    );
    // Approve + deposit + eventual withdrawal; fee assumptions include the exit.
    const costMicros =
      allocations.filter((a) => a.destination === "justlend").length *
      3 *
      p.perActionCostMicros;
    const indicativeBonusMicros = allocations
      .filter((a) => a.destination === "justlend")
      .reduce(
        (sum, a) =>
          sum +
          yieldFor(
            a.amountMicros,
            snapshot.markets[a.asset].incentiveRate,
            p.horizonDays,
          ),
        0,
      );
    return {
      id: `${snapshot.id}-${p.usdtMicros}-${p.usddMicros}-${p.sellerSettlementMicros}-${p.bufferMicros}-${p.reserveMicros}-${p.horizonDays}-${p.reserveInDays}-${p.risk}-${p.allowUSDD}-${p.perActionCostMicros}-${v.id}`,
      title: v.title,
      subtitle: v.subtitle,
      profile: structuredClone(p),
      snapshot: structuredClone(snapshot),
      allocations,
      costMicros,
      baseYieldMicros,
      incentiveYieldMicros,
      indicativeBonusMicros,
      netMicros: baseYieldMicros + incentiveYieldMicros - costMicros,
      reasons: [
        `周五卖家款 ${money(p.sellerSettlementMicros)} + 缓冲 ${money(p.bufferMicros)} USDT，全部留在钱包。`,
        v.fraction === 0.5
          ? "再留一半闲置资金在手，减少临时退款压力。"
          : "配置全部闲置余额，接受协议与可变利率风险。",
        p.allowUSDD
          ? "只配置已经持有的 USDD，不换币、不借款。"
          : "USDD 全部留在钱包。",
      ],
      risks: [
        "USDT / USDD 都有脱锚风险，不能把稳定币等同于保本现金。",
        "供应利率随市场变化；协议、合约和治理存在风险。",
        "可赎回不等于任意时刻保证到账，受市场可用流动性约束。",
        "激励利率不保证延续；奖励领取时点及条件须另行核实。",
      ],
      exitConditions: [
        "钱包中的用款预留可直接支配；仍需支付链上转账成本。",
        "JustLend 赎回前检查可用 liquidity、账户无债务限制及交易资源。",
        "本版不跨链、不换币，不使用 Ethereum / BNB 的 sUSDD 条款代替 TRON 退出条件。",
      ],
      assumptions: [
        "以 1 USDT / USDD = 1 USD 估值，仅用于场景比较，不是汇率承诺。",
        "基础收益按当前年化利率做线性期限估算，不是已到账收益。",
        "运营成本为用户输入的每次操作费用假设，含 approve / deposit / withdraw，非实时 gas 报价。",
        snapshot.incentiveDaysVerified === 0
          ? "奖励期时区 / 完整条款尚未确认，保守净收益不计激励；另列持续激励情景。"
          : "激励只计入已核验的有效天数，不延伸到活动结束之后。",
      ],
      createdAt: now,
    };
  });
}
export function initialActions(
  plan: Plan,
  now = new Date().toISOString(),
): Action[] {
  return plan.allocations
    .filter((a) => a.destination === "justlend")
    .flatMap((a) =>
      (["approve", "deposit"] as const).map((kind) => ({
        id: `${plan.id}-${a.asset}-${kind}`,
        planId: plan.id,
        kind,
        asset: a.asset,
        amountMicros: a.amountMicros,
        feeMicros: plan.profile.perActionCostMicros,
        spender: plan.snapshot.markets[a.asset].address,
        status: "ready" as const,
        createdAt: now,
      })),
    );
}
export function applySimulation(
  portfolio: Portfolio,
  id: string,
  now = new Date().toISOString(),
): Portfolio {
  const next = structuredClone(portfolio);
  const action = next.actions.find((a) => a.id === id);
  if (
    !action ||
    action.status !== "ready" ||
    !Number.isSafeInteger(action.amountMicros) ||
    action.amountMicros <= 0
  )
    throw new Error("这条动作不存在或已模拟完成，不能重复执行。");
  if (action.kind === "deposit") {
    if (
      !next.actions.some(
        (a) =>
          a.asset === action.asset &&
          a.kind === "approve" &&
          a.status === "simulated" &&
          a.amountMicros >= action.amountMicros &&
          a.spender === action.spender,
      )
    )
      throw new Error("请先完成本次限额授权的演示。");
    const owned =
      action.asset === "USDT"
        ? next.plan.profile.usdtMicros
        : next.plan.profile.usddMicros;
    if (
      next.positions[action.asset] + action.amountMicros >
      owned - (action.asset === "USDT" ? next.plan.profile.reserveMicros : 0)
    )
      throw new Error("动作将侵占用款预留或超过原始持仓。");
    next.positions[action.asset] += action.amountMicros;
  }
  if (action.kind === "withdraw") {
    if (action.amountMicros > next.positions[action.asset])
      throw new Error("赎回金额超过当前模拟持仓。");
    next.positions[action.asset] -= action.amountMicros;
  }
  action.status = "simulated";
  action.completedAt = now;
  next.logs.push({
    id: `log-${next.logs.length}`,
    at: now,
    title: `${action.kind === "approve" ? "限额授权" : action.kind === "deposit" ? "存入" : "赎回"}演示完成`,
    detail: `${money(action.amountMicros)} ${action.asset}；仅更新本地模拟状态，无签名、广播或交易哈希。`,
    mode: "simulation",
  });
  return next;
}
export function reviewPortfolio(
  p: Portfolio,
  latest: Snapshot,
  days: number,
  scenario: Review["scenario"],
): Review {
  if (!Number.isInteger(days) || days < 1 || days > p.plan.profile.horizonDays)
    throw new Error("复盘日期不在原计划内。");
  // Normalize both estimates to current simulated principal; this is not realized P&L.
  let observedBaseMicros = 0,
    observedIncentiveMicros = 0,
    expectedMicros = 0;
  for (const asset of ["USDT", "USDD"] as const) {
    const amount = p.positions[asset];
    observedBaseMicros += yieldFor(
      amount,
      latest.markets[asset].baseRate * (scenario === "rate-drop" ? 0.5 : 1),
      days,
    );
    observedIncentiveMicros += yieldFor(
      amount,
      scenario === "incentive-end" ? 0 : latest.markets[asset].incentiveRate,
      Math.min(days, latest.incentiveDaysVerified),
    );
    expectedMicros +=
      yieldFor(amount, p.plan.snapshot.markets[asset].baseRate, days) +
      yieldFor(
        amount,
        p.plan.snapshot.markets[asset].incentiveRate,
        Math.min(days, p.plan.snapshot.incentiveDaysVerified),
      );
  }
  const costMicros = p.actions
    .filter((a) => a.status === "simulated")
    .reduce((s, a) => s + a.feeMicros, 0);
  const priceImpactMicros =
    scenario === "depeg" ? -Math.round(p.plan.profile.usddMicros * 0.02) : 0;
  const netMicros =
    observedBaseMicros +
    observedIncentiveMicros +
    priceImpactMicros -
    costMicros;
  const changes = (["USDT", "USDD"] as const)
    .filter((asset) => p.positions[asset] > 0)
    .flatMap((asset) => {
      const before = p.plan.snapshot.markets[asset],
        after = latest.markets[asset];
      const notes: string[] = [];
      if (
        Math.abs(after.baseRate - before.baseRate) >
        Math.max(before.baseRate * 0.05, 0.00001)
      )
        notes.push(
          `${asset} 基础年化从 ${(before.baseRate * 100).toFixed(4)}% 变为 ${(after.baseRate * 100).toFixed(4)}%。先检查剩余收益能否覆盖迁移与退出成本，不自动再平衡。`,
        );
      if (after.incentiveRate < before.incentiveRate)
        notes.push(`${asset} 激励年化下降，独立重估奖励，不覆盖原活动假设。`);
      if (Number(after.cash) * 1_000_000 < p.positions[asset])
        notes.push(
          `${asset} 当前市场 cash 低于模拟仓位；实际全额赎回可能无法完成，应先核实可用流动性。`,
        );
      return notes;
    });
  const suggestions = [
    ...changes,
    "比较口径：同一当前模拟本金、同一期限、同一已模拟费用；原计划利率与最新情景利率分别计算，不是实际入账。",
    scenario === "depeg"
      ? "当前是 USDD 下跌 2% 的模拟情景。赎回只改变协议仓位，不能消除仍持有 USDD 的脱锚敞口。"
      : scenario === "rate-drop"
        ? "利率下降情景：先比较剩余期限可增加的收益与退出成本，再决定是否移动。"
        : scenario === "incentive-end"
          ? "激励归零情景：不要把旧奖励利率续算到未来。基础收益与奖励分开复核。"
          : "本次只读刷新不改动原计划；最新利率差异应由你确认后才生成动作。",
    `${money(p.plan.profile.reserveMicros)} USDT 用款仍保留钱包。`,
    latest.mode === "live"
      ? "市场数据已刷新；持仓及收益仍是模拟，不是链上已实现损益。"
      : "当前市场数据为演示后备，不能据此决定真实资金操作。",
  ];
  return {
    at: new Date().toISOString(),
    positionBasis: structuredClone(p.positions),
    days,
    scenario,
    expectedMicros: expectedMicros - costMicros,
    observedBaseMicros,
    observedIncentiveMicros,
    priceImpactMicros,
    costMicros,
    netMicros,
    deltaMicros: netMicros - (expectedMicros - costMicros),
    suggestions,
    mode: "simulated-position",
    snapshotId: latest.id,
  };
}
export function parseIntake(
  message: string,
  existing: Partial<Profile> = {},
): Intake {
  const draft = { ...existing };
  for (const asset of ["USDT", "USDD"] as const) {
    const match = new RegExp(
      `${asset}\\s*[:：]?\\s*(\\d+(?:\\.\\d+)?)`,
      "i",
    ).exec(message);
    if (match) {
      const value = micros(match[1]);
      draft[asset === "USDT" ? "usdtMicros" : "usddMicros"] = value;
    }
  }
  const horizon = /(?:规划|期限|持有)\s*(\d+)\s*天/.exec(message);
  if (horizon) draft.horizonDays = Number(horizon[1]);
  const reserve =
    /(\d+)\s*天后.{0,8}(?:需要|用|预留)\s*(\d+(?:\.\d+)?)\s*USDT/i.exec(
      message,
    );
  if (reserve) {
    draft.reserveInDays = Number(reserve[1]);
    draft.reserveMicros = micros(reserve[2]);
  }
  const seller =
    /(?:卖家款|卖家结算|结算卖家)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*USDT/i.exec(
      message,
    );
  if (seller) draft.sellerSettlementMicros = micros(seller[1]);
  const buffer =
    /(?:退款(?:\s*\/\s*物流)?缓冲|退款和物流缓冲|物流缓冲)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*USDT/i.exec(
      message,
    );
  if (buffer) draft.bufferMicros = micros(buffer[1]);
  if (
    draft.sellerSettlementMicros !== undefined &&
    draft.bufferMicros !== undefined
  )
    draft.reserveMicros = draft.sellerSettlementMicros + draft.bufferMicros;
  if (/(谨慎|保守)/.test(message)) draft.risk = "cautious";
  else if (/(均衡|平衡)/.test(message)) draft.risk = "balanced";
  if (/(无借款|不借款|没有债务)/.test(message)) draft.hasDebt = false;
  else if (/已有借款|有债务/.test(message)) draft.hasDebt = true;
  if (/不允许\s*USDD|不存\s*USDD/i.test(message)) draft.allowUSDD = false;
  else if (/允许\s*USDD|可以存\s*USDD/i.test(message)) draft.allowUSDD = true;
  const cost = /(?:每次费用|单次费用)\s*[:：]?\s*(\d+(?:\.\d+)?)/.exec(message);
  if (cost) draft.perActionCostMicros = micros(cost[1]);
  const questions: [keyof Profile, string][] = [
    ["usdtMicros", "结算金库有多少 USDT？例如“USDT 90000”。"],
    ["usddMicros", "另有多少 USDD？例如“USDD 10000”；不会自动换币。"],
    ["horizonDays", "这次周结算规划几天？例如“规划 4 天”。"],
    [
      "sellerSettlementMicros",
      "周五要付卖家多少 USDT？例如“卖家款 68000 USDT”。",
    ],
    ["bufferMicros", "退款和物流缓冲留多少？例如“退款/物流缓冲 12000 USDT”。"],
    ["reserveInDays", "距周五结算还有几天？例如“4 天后需要 80000 USDT”。"],
    ["risk", "风险选谨慎还是均衡？"],
    ["hasDebt", "金库有借款吗？回答“无借款”或“已有借款”。"],
    [
      "allowUSDD",
      "已持有的 USDD 可以存入 JustLend 吗？回答“允许 USDD”或“不允许 USDD”。",
    ],
    [
      "perActionCostMicros",
      "单次操作成本按多少 USD 估算？例如“每次费用 0.2”。",
    ],
  ];
  const missing = questions.filter(([key]) => draft[key] === undefined);
  return {
    draft,
    missing: missing.map(([key]) => key),
    question:
      missing[0]?.[1] || "信息已齐。请核对右侧摘要；你确认后才会生成两套计划。",
    modelMode: "local-guided",
  };
}

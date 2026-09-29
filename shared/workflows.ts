import { money, reviewPortfolio } from "./planner";
import type { Plan, Portfolio, Profile, Review, Snapshot } from "./types";
export const STRESS_NAMES: Record<string, string> = {
  "incentive-end": "激励结束",
  "rate-drop": "基础利率减半",
  depeg: "USDD 脱锚 −2%",
};
export const SELLER_DEMO = {
  totalMicros: 100_000_000_000,
  sellerMicros: 68_000_000_000,
  bufferMicros: 12_000_000_000,
  extraRefundMicros: 6_000_000_000,
} as const;
export function idleMicros(
  profile: Pick<Profile, "usdtMicros" | "usddMicros" | "reserveMicros">,
): number {
  return profile.usdtMicros + profile.usddMicros - profile.reserveMicros;
}
export function applyThursdayRefundShock(
  profile: Profile,
  extraMicros: number = SELLER_DEMO.extraRefundMicros,
): Profile {
  if (!Number.isSafeInteger(extraMicros) || extraMicros <= 0)
    throw new Error("新增退款必须是正数。");
  const next = {
    ...profile,
    bufferMicros: profile.bufferMicros + extraMicros,
    reserveMicros: profile.reserveMicros + extraMicros,
  };
  if (next.reserveMicros > next.usdtMicros)
    throw new Error("USDT 不足以覆盖新增退款；请暂停收益配置。");
  return next;
}
export function reviewStressScenarios(
  portfolio: Portfolio,
  latest: Snapshot,
  days: number,
): Review[] {
  return (["incentive-end", "rate-drop", "depeg"] as const).map((scenario) =>
    reviewPortfolio(structuredClone(portfolio), latest, days, scenario),
  );
}
export function quickHorizon(
  current: Partial<Profile>,
  days: number,
): Partial<Profile> {
  if (![7, 14, 30, 60, 90].includes(days))
    throw new Error("Unsupported planning horizon.");
  return { ...current, horizonDays: days };
}
export function quickReserve(
  current: Partial<Profile>,
  fraction: number,
): Partial<Profile> {
  if (![0.25, 0.5, 1].includes(fraction) || current.usdtMicros === undefined)
    throw new Error("请先填写 USDT 持仓。");
  return {
    ...current,
    reserveMicros: Math.floor(current.usdtMicros * fraction),
  };
}
export function managerSummary(plans: readonly Plan[]): string {
  if (plans.length !== 2) throw new Error("请先生成两套计划。");
  const profile = plans[0].profile;
  const snapshot = plans[0].snapshot;
  return [
    "YieldWindow｜周五卖家结算",
    `金库：${money(profile.usdtMicros)} USDT + ${money(profile.usddMicros)} USDD。`,
    `硬预留：卖家款 ${money(profile.sellerSettlementMicros)} + 退款/物流缓冲 ${money(profile.bufferMicros)} = ${money(profile.reserveMicros)} USDT。第 ${profile.reserveInDays} 天支付。`,
    `可配置：${money(idleMicros(profile))} USD 等值。`,
    ...plans.map(
      (plan, index) =>
        `方案 ${index === 0 ? "A" : "B"}：${plan.title}\n  ${plan.allocations.map((a) => `${a.asset} ${a.destination === "wallet" ? "钱包" : "JustLend"} ${money(a.amountMicros)}`).join("；")}\n  基础 ${money(plan.baseYieldMicros)} + 已核验激励 ${money(plan.incentiveYieldMicros)} − 全周期成本 ${money(plan.costMicros)} = ${money(plan.netMicros)} USD 等值。`,
    ),
    `数据：${snapshot.fetchedAt}；${snapshot.mode === "live" ? "官方实时只读" : "演示后备参数"}。`,
    ...snapshot.sources.map(
      (source) =>
        `  ${source.name}：${source.url}（${source.status === "live" ? "已读取" : "未读通"}）`,
    ),
    "边界：稳定币、可变利率与流动性均有风险。费用为用户假设。",
    "执行：本机模拟，未发送链上交易。",
  ].join("\n\n");
}
export async function attemptSummaryCopy(
  text: string,
  writeText?: (value: string) => Promise<void>,
): Promise<{ copied: boolean; message: string }> {
  try {
    if (!writeText) throw new Error("Clipboard unavailable.");
    await writeText(text);
    return { copied: true, message: "已复制负责人摘要。" };
  } catch {
    return {
      copied: false,
      message: "浏览器未允许写入剪贴板，请在下方选中文本手动复制。",
    };
  }
}

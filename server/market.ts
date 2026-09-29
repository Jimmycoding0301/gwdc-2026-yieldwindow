import { randomUUID } from 'node:crypto';
import { REGISTRY } from '../shared/types.js';
import type { Snapshot, Source } from '../shared/types.js';
const BASE = 'https://openapi.just.network';
const USDD_DOC = 'https://docs.usdd.io/introduction/readme.md';
async function read(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(8_000), headers: { Accept: 'application/json, text/plain;q=0.9' } });
  if (!response.ok) throw new Error('Official source unavailable.');
  const text = await response.text(); if (text.length > 2_000_000) throw new Error('Oversized official response.');
  return text;
}
export function demoSnapshot(now = new Date().toISOString()): Snapshot {
  return { id: `demo-${randomUUID()}`, fetchedAt: now, mode: 'demo', markets: { USDT: { asset: 'USDT', ...REGISTRY.USDT, baseRate: 0.02, incentiveRate: 0, cash: '1000000' }, USDD: { asset: 'USDD', ...REGISTRY.USDD, baseRate: 0.00001, incentiveRate: 0.04, cash: '1000000' } }, phaseEnd: null, incentiveDaysVerified: 0,
    sources: [{ name: 'JustLend 市场与激励 API', url: `${BASE}/lend/jtoken`, fetchedAt: now, status: 'unavailable', note: '读取失败；下列 2% / 4% 是明确标注的演示参数。' }, { name: 'USDD 官方协议说明', url: USDD_DOC, fetchedAt: now, status: 'unavailable', note: '未能实时读取，保留官方链接供核查。' }], warnings: ['演示后备数据：不能据此生成真实资金建议。', '奖励截止时间与时区未核验，保守预期不计激励。'] };
}
export async function loadMarket(): Promise<Snapshot> {
  const now = new Date().toISOString();
  const settled = await Promise.allSettled([read(`${BASE}/lend/jtoken`), read(`${BASE}/mining/apy`), read(`${BASE}/mining/reward?address=T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb`), read(USDD_DOC).then(text => { if (!/USDD/i.test(text) || text.length < 200) throw new Error('Invalid official document.'); return text; })]);
  const sources: Source[] = [
    { name: 'JustLend 市场', url: `${BASE}/lend/jtoken`, fetchedAt: now, status: settled[0].status === 'fulfilled' ? 'live' : 'unavailable', note: '基础年化、市场 cash、底层 token 精度。时间是本机抓取时间，不冒充源数据更新时间。' },
    { name: 'JustLend USDD 激励', url: `${BASE}/mining/apy`, fetchedAt: now, status: settled[1].status === 'fulfilled' ? 'live' : 'unavailable', note: '独立激励利率；不能并入基础收益后延续整个持有期。' },
    { name: 'USDD 官方协议说明', url: USDD_DOC, fetchedAt: now, status: settled[3].status === 'fulfilled' ? 'live' : 'unavailable', note: 'USDD 为加密资产抵押的稳定币。目标锚定不等于保本；这里只配置 TRON 上已有持仓。' },
  ];
  try {
    if (settled[0].status !== 'fulfilled' || settled[1].status !== 'fulfilled') throw new Error('Source missing.');
    const tokens = JSON.parse(settled[0].value); const incentives = JSON.parse(settled[1].value);
    if (tokens.code !== 0 || incentives.code !== 0 || !Array.isArray(tokens.data?.tokenList)) throw new Error('Source shape invalid.');
    const markets = {} as Snapshot['markets'];
    for (const asset of ['USDT', 'USDD'] as const) {
      const item = tokens.data.tokenList.find((entry: { address?: string }) => entry.address === REGISTRY[asset].address);
      const rate = Number(item?.supplyRate); const bonus = Number(incentives.data?.[REGISTRY[asset].address]?.USDD ?? 0);
      if (!item || item.underlyingSymbol !== asset || item.underlyingAddress !== REGISTRY[asset].underlyingAddress || item.underlyingDecimal !== REGISTRY[asset].decimals
        || !Number.isFinite(rate) || rate < 0 || rate > 5 || !Number.isFinite(bonus) || bonus < 0 || bonus > 5 || !Number.isFinite(Number(item.cash)) || Number(item.cash) < 0) throw new Error('Market identity or units mismatch.');
      markets[asset] = { asset, ...REGISTRY[asset], baseRate: rate, incentiveRate: bonus, cash: String(item.cash) };
    }
    let phaseEnd: string | null = null;
    if (settled[2].status === 'fulfilled') {
      const phase = JSON.parse(settled[2].value);
      const end = phase.code === 0 ? phase.data?.[REGISTRY.USDD.address]?.USDD?.currEndTime : null;
      if (typeof end === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(end)) phaseEnd = end;
    }
    return { id: `live-${randomUUID()}`, fetchedAt: now, mode: 'live', markets, sources, phaseEnd, incentiveDaysVerified: 0,
      warnings: ['当前 API 奖励期缺少明确时区，未来激励不计入保守预期；持续激励只作单独情景。', ...(settled[3].status !== 'fulfilled' ? ['USDD 官方条款本次未读通，请在真实操作前手动核对。'] : [])] };
  } catch { const demo = demoSnapshot(now); demo.sources = sources.map(s => ({ ...s, status: 'unavailable', note: `${s.note} 当前计划使用演示后备，不是实时报价。` })); return demo; }
}

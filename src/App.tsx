import { useEffect, useState } from "react";
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  Download,
  ExternalLink,
  Leaf,
  LockKeyhole,
  MessageSquare,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Wallet,
  Waves,
} from "lucide-react";
import IntakeScreenshot from "./IntakeScreenshot";
import ManagerSummary from "./ManagerSummary";
import ChainReceipt from "./ChainReceipt";
import {
  applyThursdayRefundShock,
  idleMicros,
  quickHorizon,
  SELLER_DEMO,
  STRESS_NAMES,
} from "../shared/workflows";
import {
  initialActions,
  micros,
  money,
  profileSchema,
} from "../shared/planner";
import type {
  Action,
  Asset,
  Intake,
  Plan,
  Portfolio,
  Profile,
  Review,
  Snapshot,
} from "../shared/types";
const SAMPLE =
  "USDT 90000，USDD 10000，规划 4 天，卖家款 68000 USDT，退款/物流缓冲 12000 USDT，4 天后需要 80000 USDT，风险均衡，无借款，允许 USDD，每次费用 0.2。";
const steps = ["需求确认", "两套计划", "操作清单", "跟踪复盘"];
const usd = (n: number) =>
  (n / 1e6).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
const pct = (n: number) => `${(n * 100).toFixed(n < 0.001 ? 4 : 2)}%`;
const timestamp = (s: string) =>
  new Date(s).toLocaleString("zh-CN", { hour12: false });
const actionNames = {
  approve: "限额授权",
  deposit: "存入 JustLend",
  withdraw: "赎回到钱包",
};
async function api<T>(path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method: body === undefined ? "GET" : "POST",
      signal: AbortSignal.timeout(60000),
      headers:
        body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error(
      "无法连接本地服务，请确认 API 8790 已启动后重试。没有发送链上交易。",
    );
  }
  let value;
  try {
    value = await response.json();
  } catch {
    throw new Error(
      "本地服务未返回完整结果；如刚重启，请刷新市场并重新确认计划。",
    );
  }
  if (!response.ok)
    throw new Error(
      [value.error, ...(value.issues || [])].filter(Boolean).join(" "),
    );
  return value;
}
function Label({ children }: { children: React.ReactNode }) {
  return <span className="eyebrow">{children}</span>;
}
function CheckLabel({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="check-label">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{children}</span>
    </label>
  );
}
function SourcePanel({ snapshot }: { snapshot: Snapshot | null }) {
  if (!snapshot)
    return <div className="source-panel">正在读取官方市场与协议说明…</div>;
  return (
    <div className="source-panel">
      <div className="section-heading">
        <div>
          <Label>DATA & TERMS</Label>
          <h3>每一个数字，都有出处。</h3>
        </div>
        <span
          className={`pill ${snapshot.mode === "live" ? "green" : "amber"}`}
        >
          {snapshot.mode === "live" ? "实时只读数据" : "演示后备数据"}
        </span>
      </div>
      <div className="rates-grid">
        {(["USDT", "USDD"] as const).map((asset) => (
          <div className="rate-card" key={asset}>
            <b>
              {asset} <span>· JustLend</span>
            </b>
            <div>
              <strong>{pct(snapshot.markets[asset].baseRate)}</strong>
              <small>基础年化</small>
            </div>
            <p>
              激励年化 <b>{pct(snapshot.markets[asset].incentiveRate)}</b>
              <span> 独立计算</span>
            </p>
            <small>
              市场 cash ≈{" "}
              {Number(snapshot.markets[asset].cash).toLocaleString("en-US", {
                maximumFractionDigits: 0,
              })}{" "}
              {asset}
            </small>
          </div>
        ))}
      </div>
      <details>
        <summary>
          查看来源、采集时间与条款 <ExternalLink size={13} />
        </summary>
        <p className="subtle">
          采集：{timestamp(snapshot.fetchedAt)}。源更新时间未提供。奖励期原文：
          {snapshot.phaseEnd || "未核验"}；时区未明确，保守预期不计激励。
        </p>
        {snapshot.sources.map((source) => (
          <a
            className="source-item"
            key={source.url}
            href={source.url}
            target="_blank"
            rel="noreferrer"
          >
            <span>
              <b>{source.name} ↗</b>
              <small>{source.note}</small>
            </span>
            <span
              className={source.status === "live" ? "text-green" : "text-amber"}
            >
              {source.status === "live" ? "本次已读取" : "未读通"}
            </span>
          </a>
        ))}
        <p className="subtle">
          退出条款：
          <a
            href="https://docs.justlend.org/getting_started/concepts/withdraw/"
            target="_blank"
            rel="noreferrer"
          >
            JustLend 赎回说明 ↗
          </a>{" "}
          ·{" "}
          <a
            href="https://docs.usdd.io/user-guide/usdd-savings"
            target="_blank"
            rel="noreferrer"
          >
            USDD Savings 链别说明 ↗
          </a>
          。后者为 Ethereum / BNB 产品，本版不将其作为 TRON 收益来源。
        </p>
      </details>
    </div>
  );
}
function PlanCard({
  plan,
  index,
  onSelect,
}: {
  plan: Plan;
  index: number;
  onSelect: () => void;
}) {
  const total = plan.profile.usdtMicros + plan.profile.usddMicros;
  return (
    <article className={`plan-card ${index === 0 ? "recommended" : ""}`}>
      <div className="plan-top">
        <span className="plan-letter">{index === 0 ? "A" : "B"}</span>
        <span className="pill">
          {index === 0 ? "只配一半闲置" : "配置全部闲置"}
        </span>
      </div>
      <h2>{plan.title}</h2>
      <p className="subtle">{plan.subtitle}</p>
      <div className="plan-return">
        <Label>{plan.profile.horizonDays} 天 · 保守净收益估算</Label>
        <strong className={plan.netMicros >= 0 ? "" : "text-amber"}>
          {usd(plan.netMicros)}
        </strong>
        <small>USD 等值 · 可变利率 · 非保证收益</small>
      </div>
      <div className="allocation-bar" aria-label="资产分配">
        {plan.allocations.map((a) => (
          <span
            key={`${a.asset}-${a.destination}`}
            style={{ width: `${(a.amountMicros / total) * 100}%` }}
            className={`${a.asset.toLowerCase()} ${a.destination}`}
          />
        ))}
      </div>
      <div className="allocation-list">
        {plan.allocations.map((a) => (
          <div key={`${a.asset}-${a.destination}`}>
            <span>
              <i className={`${a.asset.toLowerCase()} ${a.destination}`} />
              {a.asset} · {a.destination === "wallet" ? "留在钱包" : "JustLend"}
            </span>
            <b>{money(a.amountMicros)}</b>
          </div>
        ))}
      </div>
      <div className="yield-breakdown">
        <div>
          <span>基础收益</span>
          <b>+ ${money(plan.baseYieldMicros)}</b>
        </div>
        <div>
          <span>已核验激励</span>
          <b>+ ${money(plan.incentiveYieldMicros)}</b>
        </div>
        <div>
          <span>操作成本，包含退出</span>
          <b>− ${money(plan.costMicros)}</b>
        </div>
      </div>
      <p className="hint">
        若激励持续 {plan.profile.horizonDays} 天，另有约 $
        {money(plan.indicativeBonusMicros)}
        。未核实，不计入净收益。
      </p>
      <ul className="reason-list">
        {plan.reasons.map((reason) => (
          <li key={reason}>
            <Check size={15} />
            {reason}
          </li>
        ))}
      </ul>
      <details>
        <summary>风险、退出与估算假设</summary>
        {[
          ["风险", plan.risks],
          ["退出条件", plan.exitConditions],
          ["原始假设", plan.assumptions],
        ].map(([name, items]) => (
          <div key={name as string}>
            <b>{name}</b>
            <ul>
              {(items as string[]).map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        ))}
      </details>
      <button
        className={index === 0 ? "primary full" : "secondary full"}
        onClick={onSelect}
      >
        查看方案 {index === 0 ? "A" : "B"} 操作预览 <ArrowRight size={17} />
      </button>
    </article>
  );
}
function ActionCard({
  action,
  portfolio,
  busy,
  onRun,
}: {
  action: Action;
  portfolio: Portfolio;
  busy: boolean;
  onRun: () => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const authorized =
    action.kind !== "deposit" ||
    portfolio.actions.some(
      (a) =>
        a.asset === action.asset &&
        a.kind === "approve" &&
        a.status === "simulated",
    );
  const done = action.status === "simulated";
  return (
    <article className={`action-card ${done ? "done" : ""}`}>
      <div className="action-icon">
        {done ? (
          <CheckCircle2 size={22} />
        ) : action.kind === "approve" ? (
          <LockKeyhole size={22} />
        ) : action.kind === "deposit" ? (
          <ArrowUpRight size={22} />
        ) : (
          <ArrowDownLeft size={22} />
        )}
      </div>
      <div className="action-body">
        <div className="section-heading">
          <h3>
            {actionNames[action.kind]} · {action.asset}
          </h3>
          <span className={`pill ${done ? "green" : ""}`}>
            {done ? "模拟完成" : "待逐笔确认"}
          </span>
        </div>
        <div className="action-values">
          <b>
            {money(action.amountMicros)} {action.asset}
          </b>
          <span>费用假设 ${money(action.feeMicros)}</span>
        </div>
        <p className="subtle">
          {action.kind === "approve"
            ? "仅此币种、此合约、此金额。无无限授权。"
            : action.kind === "withdraw"
              ? "实际赎回需足够 cash 与链上资源。"
              : "可变收益；不得侵占周五准备金。"}
        </p>
        <code>{action.spender}</code>
        {!done ? (
          <>
            <CheckLabel checked={confirmed} onChange={setConfirmed}>
              金额与费用已核对。仅模拟。
            </CheckLabel>
            <button
              className="small-button"
              disabled={busy || !confirmed || !authorized}
              onClick={onRun}
            >
              {authorized
                ? `模拟${actionNames[action.kind]}`
                : "先完成本次限额授权"}{" "}
              <ArrowRight size={14} />
            </button>
          </>
        ) : (
          <small className="subtle">
            {action.completedAt ? timestamp(action.completedAt) : ""} ·
            无钱包签名、无交易广播
          </small>
        )}
      </div>
    </article>
  );
}
const defaultChat = [
  {
    role: "assistant",
    text: "周五要付多少卖家款？再留多少退款与物流缓冲？",
    mode: "本地引导",
  },
];
export default function App() {
  const [tab, setTab] = useState(0);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [draft, setDraft] = useState<Partial<Profile>>({});
  const [messages, setMessages] = useState(defaultChat);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [profileConfirmed, setProfileConfirmed] = useState(false);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [selected, setSelected] = useState<Plan | null>(null);
  const [planConfirmed, setPlanConfirmed] = useState(false);
  const [reforecast, setReforecast] = useState<{
    profile: Profile;
    plans: Plan[];
  } | null>(null);
  const [portfolios, setPortfolios] = useState<Portfolio[]>([]);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [latestReviewSnapshot, setLatestReviewSnapshot] =
    useState<Snapshot | null>(null);
  const [stress, setStress] = useState<{
    reviews: Review[];
    latest: Snapshot;
  } | null>(null);
  const [days, setDays] = useState(4);
  const [scenario, setScenario] = useState<Review["scenario"]>("current");
  const [withdrawAsset, setWithdrawAsset] = useState<Asset>("USDT");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [withdrawConfirmed, setWithdrawConfirmed] = useState(false);
  const [aiConfigured, setAiConfigured] = useState(false);
  useEffect(() => {
    let active = true;
    Promise.allSettled([
      api<Snapshot>("/markets"),
      api<{ portfolios: Portfolio[] }>("/portfolios"),
      api<{ aiConfigured: boolean }>("/health"),
    ]).then((results) => {
      if (!active) return;
      const [markets, saved, health] = results;
      if (markets.status === "fulfilled") setSnapshot(markets.value);
      else setError("市场读取失败，请确认 API 8790 已启动后刷新。");
      if (saved.status === "fulfilled") setPortfolios(saved.value.portfolios);
      if (health.status === "fulfilled")
        setAiConfigured(health.value.aiConfigured);
    });
    return () => {
      active = false;
    };
  }, []);
  async function task(name: string, run: () => Promise<void>) {
    if (busy) return;
    setBusy(name);
    setError("");
    try {
      await run();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败，请稍后重试。");
    } finally {
      setBusy("");
    }
  }
  function updateDraft(next: Partial<Profile>) {
    setDraft(next);
    setProfileConfirmed(false);
    setPlans([]);
    setSelected(null);
    setPlanConfirmed(false);
    setReforecast(null);
  }
  function updatePortfolio(value: Portfolio) {
    setPortfolio(value);
    setPortfolios((old) => [
      value,
      ...old.filter((p) => p.plan.id !== value.plan.id),
    ]);
  }
  function go(next: number) {
    setTab(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  async function send(message = input) {
    if (!message.trim()) return;
    await task("intake", async () => {
      const result = await api<Intake>("/intake", { message, draft });
      setMessages((old) => [
        ...old,
        { role: "user", text: message, mode: "" },
        {
          role: "assistant",
          text: result.question,
          mode:
            result.modelMode === "kiln"
              ? `Kiln 模型响应${result.usage ? ` · ${result.usage.inputTokens + result.usage.outputTokens} tokens` : ""}`
              : "本地引导",
        },
      ]);
      updateDraft(result.draft);
      setInput("");
      if (result.warning) setError(result.warning);
    });
  }
  function openPortfolio(p: Portfolio) {
    setStress(null);
    updatePortfolio(p);
    setSelected(p.plan);
    setDays(Math.min(4, p.plan.profile.horizonDays));
    const last = p.reviews?.at(-1);
    setReview(last?.result || null);
    setLatestReviewSnapshot(last?.snapshot || null);
    setPlanConfirmed(false);
    go(2);
  }
  const valid = profileSchema.safeParse(draft);
  const activePlan = portfolio?.plan || selected;
  const formMoney = (
    key:
      | "usdtMicros"
      | "usddMicros"
      | "sellerSettlementMicros"
      | "bufferMicros"
      | "perActionCostMicros",
    title: string,
  ) => (
    <label className="field">
      <span>{title}</span>
      <input
        aria-label={title}
        type="number"
        step="0.000001"
        min="0"
        value={draft[key] === undefined ? "" : draft[key]! / 1e6}
        onChange={(e) => {
          const value = micros(e.target.value);
          const next = { ...draft, [key]: value };
          if (key === "sellerSettlementMicros" || key === "bufferMicros") {
            const seller =
              key === "sellerSettlementMicros"
                ? value
                : next.sellerSettlementMicros;
            const buffer = key === "bufferMicros" ? value : next.bufferMicros;
            next.reserveMicros =
              seller === undefined || buffer === undefined
                ? undefined
                : seller + buffer;
          }
          updateDraft(next);
        }}
        placeholder="待确认"
      />
    </label>
  );
  function download() {
    if (!portfolio) return;
    const blob = new Blob(
      [
        JSON.stringify(
          {
            product: "YieldWindow",
            execution: "simulation",
            exportedAt: new Date().toISOString(),
            portfolio,
          },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `yieldwindow-${portfolio.plan.createdAt.slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <>
      <div className="announcement">
        <span>YIELDWINDOW</span>
        <i />
        SELLER RESERVE / JustLend + USDD
        <span className="announcement-end">官方数据只读 · 资金操作模拟</span>
      </div>
      <header className="header">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            go(0);
          }}
        >
          <span className="brand-symbol">
            <Waves size={26} />
          </span>
          <b>
            YieldWindow<span>留有余地，计划下一步。</span>
          </b>
        </a>
        <div className="header-right">
          <span className="header-source">
            TRON / {aiConfigured ? "Qwen 在线" : "本地引导"}
          </span>
          <a className="header-cta" href="#workspace" onClick={() => setTab(0)}>
            开始规划 <ArrowUpRight size={14} />
          </a>
        </div>
      </header>
      <main>
        <section className="hero">
          <span className="iridescent-badge">
            <Sparkles size={13} />
            先留够，再生息 <span>↗</span>
          </span>
          <div>
            <Label>FRIDAY SETTLEMENT, PROTECTED</Label>
            <h1>
              周五要付的钱，
              <br />
              <em>今天先锁住。</em>
            </h1>
            <p>
              卖家款和退款缓冲先留够。
              <br />
              只有闲置资金进入收益计划。
            </p>
          </div>
          <div className="hero-actions">
            <a href="#workspace" className="primary" onClick={() => setTab(0)}>
              规划周五结算 <ArrowRight size={17} />
            </a>
            <span>无钱包连接 · 不自动执行交易</span>
          </div>
          <div className="hero-proof">
            <span>
              <ShieldCheck size={14} />
              预留先于收益
            </span>
            <span>
              <Clock3 size={14} />
              周四可重算
            </span>
            <span>
              <Check size={14} />
              每一步由你确认
            </span>
          </div>
        </section>
        <nav id="workspace" className="step-nav" aria-label="规划流程">
          {steps.map((name, i) => (
            <button
              key={name}
              className={tab === i ? "active" : ""}
              aria-current={tab === i ? "step" : undefined}
              onClick={() => go(i)}
            >
              <span>{String(i + 1).padStart(2, "0")}</span>
              {name}
              <ChevronRight size={15} />
            </button>
          ))}
        </nav>
        {error ? (
          <div className="error" role="alert">
            {error}
            <button aria-label="关闭提示" onClick={() => setError("")}>
              ×
            </button>
          </div>
        ) : null}
        {tab === 0 ? (
          <>
            <div className="intro-row">
              <div>
                <Label>01 / UNDERSTAND</Label>
                <h2>先锁结算，再看收益。</h2>
              </div>
              <span className="pill">演示场景 · 100,000 USD 等值</span>
            </div>
            <section className="seller-scenario">
              <div className="seller-scenario-copy">
                <Label>ONE REAL WORKFLOW</Label>
                <h3>跨境电商周五结算</h3>
                <p>周一规划，周四吸收退款变化，周五付款。</p>
              </div>
              <div className="seller-metrics">
                <div>
                  <small>结算金库</small>
                  <strong>$100,000</strong>
                </div>
                <div>
                  <small>卖家款</small>
                  <strong>$68,000</strong>
                </div>
                <div>
                  <small>退款 / 物流缓冲</small>
                  <strong>$12,000</strong>
                </div>
                <div className="idle">
                  <small>可配置闲置</small>
                  <strong>$20,000</strong>
                </div>
              </div>
              <button
                className="primary"
                disabled={!!busy}
                onClick={() => send(SAMPLE)}
              >
                一键填入 <ArrowRight size={15} />
              </button>
            </section>
            <IntakeScreenshot
              draft={draft}
              onApply={updateDraft}
              disabled={!!busy}
            />
            <div className="intake-grid">
              <section className="chat-panel">
                <div className="panel-caption">
                  <MessageSquare size={17} />
                  <b>周结算问答</b>
                  <span>
                    {aiConfigured
                      ? "Qwen · 每次响应有标记"
                      : "本地引导 · 未调用模型"}
                  </span>
                </div>
                <div className="chat-history" aria-live="polite">
                  {messages.map((message, i) => (
                    <div className={`message ${message.role}`} key={i}>
                      {message.role === "assistant" ? (
                        <span className="assistant-icon">
                          <Leaf size={16} />
                        </span>
                      ) : null}
                      <div>
                        <p>{message.text}</p>
                        {message.mode ? <small>{message.mode}</small> : null}
                      </div>
                    </div>
                  ))}
                </div>
                <form
                  className="composer"
                  onSubmit={(e) => {
                    e.preventDefault();
                    send();
                  }}
                >
                  <textarea
                    aria-label="描述你的持仓与用款安排"
                    placeholder="例如：周五卖家款 68000，缓冲 12000…"
                    disabled={!!busy}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    maxLength={1500}
                    rows={3}
                  />
                  <div>
                    <small>代码校验金额；模型不碰资金。</small>
                    <button
                      className="icon-button"
                      aria-label="发送需求"
                      disabled={!!busy || !input.trim()}
                    >
                      {busy === "intake" ? (
                        <RefreshCw className="spin" size={19} />
                      ) : (
                        <ArrowUpRight size={19} />
                      )}
                    </button>
                  </div>
                </form>
              </section>
              <section className="summary-panel">
                <div className="section-heading">
                  <div>
                    <Label>YOUR BRIEF</Label>
                    <h3>确认周五底线</h3>
                  </div>
                  <span className="summary-count">
                    {Object.values(draft).filter((v) => v !== undefined).length}
                    /11
                  </span>
                </div>
                <div className="quick-brief">
                  <span>规划多久</span>
                  <div>
                    {[4, 7, 14, 30].map((value) => (
                      <button
                        key={value}
                        disabled={!!busy}
                        className={
                          draft.horizonDays === value ? "selected" : ""
                        }
                        onClick={() => updateDraft(quickHorizon(draft, value))}
                      >
                        {value} 天
                      </button>
                    ))}
                  </div>
                  <span>距周五</span>
                  <div>
                    {[1, 2, 3, 4].map((value) => (
                      <button
                        key={value}
                        disabled={!!busy}
                        className={
                          draft.reserveInDays === value ? "selected" : ""
                        }
                        onClick={() =>
                          updateDraft({ ...draft, reserveInDays: value })
                        }
                      >
                        第 {value} 天
                      </button>
                    ))}
                  </div>
                  <span>结算模板</span>
                  <div>
                    <button
                      disabled={!!busy}
                      onClick={() =>
                        updateDraft({
                          ...draft,
                          sellerSettlementMicros: SELLER_DEMO.sellerMicros,
                          bufferMicros: SELLER_DEMO.bufferMicros,
                          reserveMicros:
                            SELLER_DEMO.sellerMicros + SELLER_DEMO.bufferMicros,
                        })
                      }
                    >
                      68k 卖家 + 12k 缓冲
                    </button>
                  </div>
                  <small>修改后须重新确认。日期不会自动移动。</small>
                </div>
                <fieldset className="form-grid" disabled={!!busy}>
                  {formMoney("usdtMicros", "金库 USDT")}
                  {formMoney("usddMicros", "已持有 USDD")}
                  <label className="field">
                    <span>周结算窗口（天）</span>
                    <input
                      type="number"
                      min="1"
                      max="90"
                      value={draft.horizonDays ?? ""}
                      onChange={(e) =>
                        updateDraft({
                          ...draft,
                          horizonDays: e.target.value
                            ? Number(e.target.value)
                            : undefined,
                        })
                      }
                      placeholder="1–90"
                    />
                  </label>
                  <label className="field">
                    <span>距周五结算（天）</span>
                    <input
                      type="number"
                      min="1"
                      max="90"
                      value={draft.reserveInDays ?? ""}
                      onChange={(e) =>
                        updateDraft({
                          ...draft,
                          reserveInDays: e.target.value
                            ? Number(e.target.value)
                            : undefined,
                        })
                      }
                      placeholder="待确认"
                    />
                  </label>
                  {formMoney("sellerSettlementMicros", "周五卖家款")}
                  {formMoney("bufferMicros", "退款 / 物流缓冲")}
                  <div className="field reserve-field">
                    <span>不可挪用准备金</span>
                    <strong>
                      {draft.reserveMicros === undefined
                        ? "待确认"
                        : `${money(draft.reserveMicros)} USDT`}
                    </strong>
                  </div>
                  {formMoney("perActionCostMicros", "单次费用假设（USD）")}
                  <label className="field">
                    <span>风险偏好</span>
                    <select
                      value={draft.risk ?? ""}
                      onChange={(e) =>
                        updateDraft({
                          ...draft,
                          risk: e.target.value as Profile["risk"],
                        })
                      }
                    >
                      <option value="" disabled>
                        请选择
                      </option>
                      <option value="cautious">谨慎 · 多留现金</option>
                      <option value="balanced">均衡 · 配置全部闲置</option>
                    </select>
                  </label>
                  <label className="field">
                    <span>是否已有借款</span>
                    <select
                      value={
                        draft.hasDebt === undefined ? "" : String(draft.hasDebt)
                      }
                      onChange={(e) =>
                        updateDraft({
                          ...draft,
                          hasDebt: e.target.value === "true",
                        })
                      }
                    >
                      <option value="" disabled>
                        请选择
                      </option>
                      <option value="false">无借款</option>
                      <option value="true">已有借款</option>
                    </select>
                  </label>
                  <label className="field wide">
                    <span>已持有 USDD 的配置范围</span>
                    <select
                      value={
                        draft.allowUSDD === undefined
                          ? ""
                          : String(draft.allowUSDD)
                      }
                      onChange={(e) =>
                        updateDraft({
                          ...draft,
                          allowUSDD: e.target.value === "true",
                        })
                      }
                    >
                      <option value="" disabled>
                        请选择
                      </option>
                      <option value="true">
                        允许部分存入 JustLend，不新增 USDD
                      </option>
                      <option value="false">全部留在钱包</option>
                    </select>
                  </label>
                </fieldset>
                <p className="hint">
                  无借款；不自动换币。费用覆盖授权、存入和退出。
                </p>
                <CheckLabel
                  checked={profileConfirmed}
                  onChange={setProfileConfirmed}
                >
                  我确认卖家款、缓冲、期限和风险。
                </CheckLabel>
                <button
                  className="primary full"
                  disabled={
                    !!busy || !valid.success || !profileConfirmed || !snapshot
                  }
                  onClick={() =>
                    task("plans", async () => {
                      const result = await api<{ plans: Plan[] }>("/plans", {
                        profile: draft,
                        snapshotId: snapshot!.id,
                        confirmed: true,
                      });
                      setPlans(result.plans);
                      setSelected(null);
                      setPortfolio(null);
                      go(1);
                    })
                  }
                >
                  {busy === "plans" ? "正在比较…" : "比较两套计划"}{" "}
                  <ArrowRight size={18} />
                </button>
                {!valid.success &&
                Object.values(draft).filter((v) => v !== undefined).length >=
                  11 ? (
                  <p className="text-amber">{valid.error.issues[0]?.message}</p>
                ) : null}
              </section>
            </div>
            <SourcePanel snapshot={snapshot} />
            {portfolios.length ? (
              <section className="history-panel">
                <h3>继续本机已确认的计划</h3>
                {portfolios.slice(0, 5).map((p) => (
                  <button key={p.plan.id} onClick={() => openPortfolio(p)}>
                    <span>
                      {p.plan.title} · {p.plan.profile.horizonDays} 天
                      <span>{timestamp(p.confirmedAt)}</span>
                    </span>
                    <ArrowRight size={17} />
                  </button>
                ))}
              </section>
            ) : null}
          </>
        ) : null}
        {tab === 1 ? (
          <>
            <div className="intro-row">
              <div>
                <Label>02 / COMPARE</Label>
                <h2>先锁 80,000，再比较。</h2>
              </div>
              <span className="pill green">
                <ShieldCheck size={15} />
                准备金不可挪用
              </span>
            </div>
            {plans.length ? (
              <>
                <div className="reserve-banner">
                  <ShieldCheck size={25} />
                  <div>
                    <b>{money(plans[0].profile.reserveMicros)} USDT</b>
                    <span>
                      卖家 {money(plans[0].profile.sellerSettlementMicros)} +
                      缓冲 {money(plans[0].profile.bufferMicros)} · 第{" "}
                      {plans[0].profile.reserveInDays} 天
                    </span>
                  </div>
                  <p>
                    留在钱包
                    <br />
                    不靠到期赎回
                  </p>
                </div>
                <section className="refund-shock">
                  <div className="section-heading">
                    <div>
                      <Label>THURSDAY CHANGE</Label>
                      <h3>周四多了 6,000 退款。</h3>
                      <p>原计划不覆盖。重算准备金与两套配置。</p>
                    </div>
                    <button
                      className="secondary"
                      disabled={!!busy}
                      onClick={() =>
                        task("reforecast", async () => {
                          const revised = applyThursdayRefundShock(
                            plans[0].profile,
                          );
                          const result = await api<{ plans: Plan[] }>(
                            "/plans",
                            {
                              profile: revised,
                              snapshotId: plans[0].snapshot.id,
                              confirmed: true,
                            },
                          );
                          setReforecast({
                            profile: revised,
                            plans: result.plans,
                          });
                        })
                      }
                    >
                      {busy === "reforecast" ? (
                        <RefreshCw size={15} className="spin" />
                      ) : (
                        <CircleDollarSign size={15} />
                      )}
                      {busy === "reforecast" ? "重算中…" : "模拟退款增加"}
                    </button>
                  </div>
                  <div className="shock-flow">
                    <div>
                      <small>周一可配置</small>
                      <strong>{money(idleMicros(plans[0].profile))}</strong>
                    </div>
                    <ArrowRight size={18} />
                    <div className={reforecast ? "changed" : "pending"}>
                      <small>周四可配置</small>
                      <strong>
                        {reforecast
                          ? money(idleMicros(reforecast.profile))
                          : "—"}
                      </strong>
                    </div>
                    <div>
                      <small>新准备金</small>
                      <strong>
                        {reforecast
                          ? money(reforecast.profile.reserveMicros)
                          : "—"}
                      </strong>
                    </div>
                  </div>
                  {reforecast ? (
                    <div className="reforecast-result">
                      <div>
                        {reforecast.plans.map((plan, index) => {
                          const supplied = plan.allocations
                            .filter((item) => item.destination === "justlend")
                            .reduce((sum, item) => sum + item.amountMicros, 0);
                          return (
                            <span key={plan.id}>
                              <b>方案 {index === 0 ? "A" : "B"}</b>
                              JustLend {money(supplied)} · 净估算{" "}
                              {usd(plan.netMicros)}
                            </span>
                          );
                        })}
                      </div>
                      <button
                        className="text-button"
                        onClick={() => {
                          const next = reforecast.plans[1];
                          setSelected(next);
                          setPortfolio(null);
                          setReview(null);
                          setStress(null);
                          setPlanConfirmed(false);
                          go(2);
                        }}
                      >
                        采用重算方案 B <ArrowRight size={15} />
                      </button>
                    </div>
                  ) : (
                    <small className="scenario-boundary">
                      压力假设 · 不调用模型，不执行交易。
                    </small>
                  )}
                </section>
                <div className="plans-grid">
                  {plans.map((plan, i) => (
                    <PlanCard
                      key={plan.id}
                      plan={plan}
                      index={i}
                      onSelect={() => {
                        setSelected(plan);
                        setPortfolio(null);
                        setReview(null);
                        setStress(null);
                        setPlanConfirmed(false);
                        go(2);
                      }}
                    />
                  ))}
                </div>
                <ManagerSummary plans={plans} />
                <SourcePanel snapshot={plans[0].snapshot} />
              </>
            ) : (
              <Empty
                title="先确认周五底线。"
                detail="确认后再比较。"
                onClick={() => go(0)}
                label="填写需求"
              />
            )}
          </>
        ) : null}
        {tab === 2 ? (
          <>
            <div className="intro-row">
              <div>
                <Label>03 / ACT WITH INTENT</Label>
                <h2>逐笔确认。</h2>
              </div>
              <span className="pill amber">资金模拟 · 收据可上链</span>
            </div>
            {selected || portfolio ? (
              <>
                <div className="execution-banner">
                  <LockKeyhole size={24} />
                  <div>
                    <b>{(portfolio?.plan || selected)!.title}</b>
                    <p>资金步骤本地模拟；计划收据可用 TronLink 提交到 Nile。</p>
                  </div>
                </div>
                {!portfolio && selected ? (
                  <section className="preview-panel">
                    <h3>先看，再生成。</h3>
                    <p className="subtle">金额、费用与授权范围如下。</p>
                    {initialActions(selected).map((action) => (
                      <div className="preview-row" key={action.id}>
                        <span>
                          {actionNames[action.kind]} · {action.asset}
                          <small>
                            {action.kind === "approve"
                              ? "精确限额，不使用无限授权"
                              : "供应至 JustLend 指定市场"}
                          </small>
                        </span>
                        <b>
                          {money(action.amountMicros)}
                          <small>费用假设 ${money(action.feeMicros)}</small>
                        </b>
                        <code>{action.spender}</code>
                      </div>
                    ))}
                    <p className="hint">
                      可变利率、脱锚与流动性风险。全周期成本：$
                      {money(selected.costMicros)}。
                    </p>
                    <CheckLabel
                      checked={planConfirmed}
                      onChange={setPlanConfirmed}
                    >
                      已核对金额、费用和限额。保存为模拟计划。
                    </CheckLabel>
                    <button
                      className="primary"
                      disabled={!!busy || !planConfirmed}
                      onClick={() =>
                        task("confirm", async () => {
                          const result = await api<Portfolio>(
                            `/plans/${encodeURIComponent(selected.id)}/confirm`,
                            { acknowledged: true },
                          );
                          updatePortfolio(result);
                          setDays(Math.min(4, result.plan.profile.horizonDays));
                        })
                      }
                    >
                      保存并生成步骤 <ArrowRight size={17} />
                    </button>
                  </section>
                ) : null}
                {portfolio ? (
                  <>
                    <div className="action-list">
                      {portfolio.actions.map((action) => (
                        <ActionCard
                          key={action.id}
                          action={action}
                          portfolio={portfolio}
                          busy={!!busy}
                          onRun={() =>
                            task("action", async () => {
                              updatePortfolio(
                                await api<Portfolio>(
                                  `/portfolios/${encodeURIComponent(portfolio.plan.id)}/actions/${encodeURIComponent(action.id)}/simulate`,
                                  { acknowledged: true },
                                ),
                              );
                            })
                          }
                        />
                      ))}
                    </div>
                    <ChainReceipt
                      portfolio={portfolio}
                      onPortfolio={updatePortfolio}
                    />
                    <div className="bottom-actions">
                      <button className="secondary" onClick={download}>
                        <Download size={16} />
                        导出记录
                      </button>
                      <button className="primary" onClick={() => go(3)}>
                        查看模拟持仓 <ArrowRight size={17} />
                      </button>
                    </div>
                    <LogPanel portfolio={portfolio} />
                  </>
                ) : null}
              </>
            ) : (
              <Empty
                title="还没有计划。"
                detail="先比较，再选择。"
                onClick={() => go(plans.length ? 1 : 0)}
                label={plans.length ? "比较计划" : "填写需求"}
              />
            )}
          </>
        ) : null}
        {tab === 3 ? (
          <>
            <div className="intro-row">
              <div>
                <Label>04 / KEEP THE ORIGINAL IN VIEW</Label>
                <h2>变化，留痕。</h2>
              </div>
              <span className="pill amber">模拟持仓 · 非实际损益</span>
            </div>
            {portfolio && activePlan ? (
              <>
                <div className="position-grid">
                  {(["USDT", "USDD"] as const).map((asset) => (
                    <div className="position-card" key={asset}>
                      <Label>{asset} / 当前模拟状态</Label>
                      <strong>{money(portfolio.positions[asset])}</strong>
                      <p>JustLend 模拟仓位</p>
                      <div>
                        <Wallet size={15} />
                        钱包仍有{" "}
                        {money(
                          (asset === "USDT"
                            ? activePlan.profile.usdtMicros
                            : activePlan.profile.usddMicros) -
                            portfolio.positions[asset],
                        )}{" "}
                        {asset}
                      </div>
                    </div>
                  ))}
                  <div className="position-card reserve">
                    <ShieldCheck size={23} />
                    <strong>{money(activePlan.profile.reserveMicros)}</strong>
                    <p>周五结算准备金</p>
                    <div>
                      第 {activePlan.profile.reserveInDays} 天 · 仍在钱包
                    </div>
                  </div>
                </div>
                <section className="review-panel">
                  <div className="section-heading">
                    <div>
                      <Label>WHAT CHANGED?</Label>
                      <h3>按原计划复盘。</h3>
                    </div>
                    <Clock3 size={22} />
                  </div>
                  <p className="subtle">
                    冻结于 {timestamp(activePlan.createdAt)}
                    。同本金、同期限；模拟结果。
                  </p>
                  <div
                    className="scenario-row"
                    role="group"
                    aria-label="复盘情景"
                  >
                    {(
                      [
                        ["current", "刷新当前利率"],
                        ["incentive-end", "激励结束"],
                        ["rate-drop", "基础利率减半"],
                        ["depeg", "USDD 脱锚 −2%"],
                      ] as const
                    ).map(([value, title]) => (
                      <button
                        key={value}
                        className={scenario === value ? "selected" : ""}
                        aria-pressed={scenario === value}
                        onClick={() => setScenario(value)}
                      >
                        {title}
                      </button>
                    ))}
                  </div>
                  <div className="review-toolbar">
                    <label>
                      复盘期{" "}
                      <input
                        aria-label="复盘天数"
                        type="number"
                        min="1"
                        max={activePlan.profile.horizonDays}
                        value={days}
                        onChange={(e) => setDays(Number(e.target.value))}
                      />{" "}
                      天
                    </label>
                    <button
                      className="primary"
                      disabled={!!busy}
                      onClick={() =>
                        task("review", async () => {
                          const result = await api<{
                            review: Review;
                            latest: Snapshot;
                            portfolio: Portfolio;
                          }>(
                            `/portfolios/${encodeURIComponent(portfolio.plan.id)}/review`,
                            { days, scenario },
                          );
                          setReview(result.review);
                          setLatestReviewSnapshot(result.latest);
                          updatePortfolio(result.portfolio);
                        })
                      }
                    >
                      {busy === "review" ? "正在读取官方数据…" : "刷新并保存"}{" "}
                      <RefreshCw
                        size={16}
                        className={busy === "review" ? "spin" : ""}
                      />
                    </button>
                  </div>
                  {review ? (
                    <>
                      <p className="saved-review-label">
                        已保存结果 · 第 {review.days} 天 ·{" "}
                        {
                          {
                            current: "刷新当前利率",
                            "incentive-end": "激励结束",
                            "rate-drop": "基础利率减半",
                            depeg: "USDD 脱锚 −2%",
                          }[review.scenario]
                        }
                        <br />
                        复盘本金：USDT {money(
                          review.positionBasis?.USDT ?? 0,
                        )}{" "}
                        / USDD {money(review.positionBasis?.USDD ?? 0)} ·{" "}
                        {review.at ? timestamp(review.at) : "历史记录"}
                      </p>
                      <div className="comparison-grid">
                        <div>
                          <small>原利率 · 同本金净变化</small>
                          <strong>{usd(review.expectedMicros)}</strong>
                        </div>
                        <ArrowRight size={22} />
                        <div>
                          <small>情景模拟净变化</small>
                          <strong
                            className={review.netMicros < 0 ? "text-amber" : ""}
                          >
                            {usd(review.netMicros)}
                          </strong>
                        </div>
                        <div className="variance">
                          <small>差异</small>
                          <strong>
                            {review.deltaMicros >= 0 ? "+" : ""}
                            {usd(review.deltaMicros)}
                          </strong>
                        </div>
                      </div>
                      <div className="review-breakdown">
                        <span>
                          基础收益 ${money(review.observedBaseMicros)}
                        </span>
                        <span>
                          激励 ${money(review.observedIncentiveMicros)}
                        </span>
                        <span>价格影响 ${money(review.priceImpactMicros)}</span>
                        <span>已模拟费用 −${money(review.costMicros)}</span>
                      </div>
                      <div className="recommendation">
                        <Leaf size={21} />
                        <div>
                          <b>现在更值得做的事</b>
                          {review.suggestions.map((suggestion) => (
                            <p key={suggestion}>{suggestion}</p>
                          ))}
                          <small>
                            原计划未覆盖。数据采集：
                            {latestReviewSnapshot
                              ? timestamp(latestReviewSnapshot.fetchedAt)
                              : "—"}
                            。
                          </small>
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="review-placeholder">
                      选择一个情景，查看净变化。
                    </div>
                  )}
                </section>
                <section className="stress-panel">
                  <div className="section-heading">
                    <div>
                      <Label>THREE WHAT-IFS. ONE SNAPSHOT.</Label>
                      <h3>三个坏情况。</h3>
                      <p>同本金 · 同快照 · {days} 天。</p>
                    </div>
                    <button
                      className="primary"
                      disabled={
                        !!busy ||
                        !Number.isInteger(days) ||
                        days < 1 ||
                        days > activePlan.profile.horizonDays
                      }
                      onClick={() =>
                        task("stress", async () => {
                          const result = await api<{
                            reviews: Review[];
                            latest: Snapshot;
                            portfolio: Portfolio;
                          }>(
                            `/portfolios/${encodeURIComponent(portfolio.plan.id)}/stress`,
                            { days },
                          );
                          setStress({
                            reviews: result.reviews,
                            latest: result.latest,
                          });
                          updatePortfolio(result.portfolio);
                        })
                      }
                    >
                      {busy === "stress" ? (
                        <RefreshCw size={15} className="spin" />
                      ) : (
                        <Sparkles size={15} />
                      )}
                      {busy === "stress" ? "正在对照…" : "跑三种压力"}
                    </button>
                  </div>
                  {stress ? (
                    <>
                      <p className="stress-basis">
                        已保存结果：{stress.reviews[0].days} 天 · USDT{" "}
                        {money(stress.reviews[0].positionBasis.USDT)} / USDD{" "}
                        {money(stress.reviews[0].positionBasis.USDD)} 模拟仓位 ·
                        数据采集 {timestamp(stress.latest.fetchedAt)} ·{" "}
                        {stress.latest.mode === "live"
                          ? "官方实时只读"
                          : "演示后备"}
                      </p>
                      <div className="stress-grid">
                        {stress.reviews.map((item) => (
                          <article key={item.scenario}>
                            <span className="stress-number">
                              0{stress.reviews.indexOf(item) + 1}
                            </span>
                            <h4>{STRESS_NAMES[item.scenario]}</h4>
                            <small>情景模拟净变化</small>
                            <strong>{usd(item.netMicros)}</strong>
                            <p>
                              相对原利率差异 <b>{usd(item.deltaMicros)}</b>
                            </p>
                            <span>
                              {item.scenario === "depeg"
                                ? "覆盖全部已持有 USDD。"
                                : item.scenario === "incentive-end"
                                  ? "未核验激励归零。"
                                  : "基础利率按半数模拟。"}
                            </span>
                          </article>
                        ))}
                      </div>
                      <p className="privacy-note">
                        压力假设 · 不调仓 · 不交易。
                      </p>
                    </>
                  ) : (
                    <div className="stress-preview">
                      <span>01 激励结束</span>
                      <span>02 基础利率减半</span>
                      <span>03 USDD 脱锚 −2%</span>
                    </div>
                  )}
                </section>
                <div className="tracking-bottom">
                  <section className="withdraw-panel">
                    <Label>ADJUST, WITH CONSENT</Label>
                    <h3>先预览，再赎回。</h3>
                    <p className="subtle">模拟步骤；不会自动执行。</p>
                    <div className="withdraw-inputs">
                      <select
                        aria-label="赎回币种"
                        value={withdrawAsset}
                        onChange={(e) => {
                          setWithdrawAsset(e.target.value as Asset);
                          setWithdrawConfirmed(false);
                        }}
                      >
                        <option>USDT</option>
                        <option>USDD</option>
                      </select>
                      <input
                        aria-label="赎回金额"
                        placeholder="赎回金额"
                        type="number"
                        min="0"
                        step="0.000001"
                        value={withdrawAmount}
                        onChange={(e) => {
                          setWithdrawAmount(e.target.value);
                          setWithdrawConfirmed(false);
                        }}
                      />
                      <button
                        className="text-button"
                        onClick={() => {
                          setWithdrawAmount(
                            String(portfolio.positions[withdrawAsset] / 1e6),
                          );
                          setWithdrawConfirmed(false);
                        }}
                      >
                        全部
                      </button>
                    </div>
                    <p className="hint">
                      费用假设 ${money(activePlan.profile.perActionCostMicros)}
                      ；目标：{withdrawAsset}。实际赎回需足够 cash 与链上资源。
                    </p>
                    <CheckLabel
                      checked={withdrawConfirmed}
                      onChange={setWithdrawConfirmed}
                    >
                      金额与风险已核对。生成模拟步骤。
                    </CheckLabel>
                    <button
                      className="secondary"
                      disabled={
                        !!busy || !withdrawConfirmed || !micros(withdrawAmount)
                      }
                      onClick={() =>
                        task("withdraw", async () => {
                          updatePortfolio(
                            await api<Portfolio>(
                              `/portfolios/${encodeURIComponent(portfolio.plan.id)}/withdraw`,
                              {
                                asset: withdrawAsset,
                                amountMicros: micros(withdrawAmount),
                                acknowledged: true,
                              },
                            ),
                          );
                          setWithdrawConfirmed(false);
                          go(2);
                        })
                      }
                    >
                      生成待确认赎回 <ArrowRight size={16} />
                    </button>
                  </section>
                  <section className="original-panel">
                    <Label>ORIGINAL SNAPSHOT</Label>
                    <h3>原计划，保持不变。</h3>
                    <p>
                      {activePlan.title} · {activePlan.profile.horizonDays} 天
                    </p>
                    <div className="yield-breakdown">
                      <div>
                        <span>原 USDT 基础年化</span>
                        <b>{pct(activePlan.snapshot.markets.USDT.baseRate)}</b>
                      </div>
                      <div>
                        <span>原 USDD 基础 / 激励年化</span>
                        <b>
                          {pct(activePlan.snapshot.markets.USDD.baseRate)} /{" "}
                          {pct(activePlan.snapshot.markets.USDD.incentiveRate)}
                        </b>
                      </div>
                      <div>
                        <span>原计划净收益估算</span>
                        <b>{usd(activePlan.netMicros)}</b>
                      </div>
                      <div>
                        <span>已保存复盘</span>
                        <b>{portfolio.reviews?.length || 0} 次</b>
                      </div>
                    </div>
                    <button className="text-button" onClick={download}>
                      <Download size={16} />
                      下载快照与复盘
                    </button>
                  </section>
                </div>
                <LogPanel portfolio={portfolio} />
              </>
            ) : (
              <Empty
                title="先完成一套计划。"
                detail="确认后才能复盘。"
                onClick={() => go(selected ? 2 : 0)}
                label={selected ? "查看操作清单" : "开始规划"}
              />
            )}
          </>
        ) : null}
        <footer>
          <span>
            YieldWindow <i>·</i> 留有余地，计划下一步。
          </span>
          <span>
            TRON B 原型 / 真实只读数据 + 模拟资金 + Nile 收据{" "}
            <button
              onClick={() =>
                task("refresh", async () =>
                  setSnapshot(await api<Snapshot>("/markets")),
                )
              }
              disabled={!!busy}
            >
              刷新市场 ↻
            </button>
          </span>
        </footer>
      </main>
    </>
  );
}
function Empty({
  title,
  detail,
  onClick,
  label,
}: {
  title: string;
  detail: string;
  onClick: () => void;
  label: string;
}) {
  return (
    <section className="empty">
      <Waves size={36} />
      <h3>{title}</h3>
      <p>{detail}</p>
      <button className="primary" onClick={onClick}>
        {label}
        <ArrowRight size={16} />
      </button>
    </section>
  );
}
function LogPanel({ portfolio }: { portfolio: Portfolio }) {
  return (
    <section className="log-panel">
      <h3>每一步的记录</h3>
      {portfolio.logs.map((log) => (
        <div className="log-row" key={log.id}>
          <span className="log-dot" />
          <div>
            <b>{log.title}</b>
            <p>{log.detail}</p>
          </div>
          <small>{timestamp(log.at)}</small>
        </div>
      ))}
    </section>
  );
}

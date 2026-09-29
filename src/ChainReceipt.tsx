import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  CircleAlert,
  Copy,
  ExternalLink,
  FileCheck2,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import {
  canonicalJson,
  expectedCommitData,
  RECEIPT_KIND_HEX,
} from "../shared/proof";
import type {
  CommitmentEnvelope,
  PlanChainProof,
} from "../shared/proof";
import type { Portfolio } from "../shared/types";

const NILE_CHAIN_ID = "0xcd8690dc";
const MAX_FEE_LIMIT = 30_000_000;

interface TronWebLike {
  defaultAddress?: { base58?: string };
  fullNode?: { host?: string };
  isAddress?: (value: string) => boolean;
  address: {
    fromHex(value: string): string;
    toHex(value: string): string;
  };
  transactionBuilder: {
    triggerSmartContract(
      contractAddress: string,
      selector: string,
      options: Record<string, unknown>,
      parameters: Array<{ type: string; value: string }>,
      ownerAddress: string,
    ): Promise<{
      result?: { result?: boolean; message?: string };
      transaction?: Record<string, any>;
    }>;
  };
  trx: {
    sign(transaction: Record<string, any>): Promise<Record<string, any>>;
  };
}

interface TronProvider {
  isTronLink?: boolean;
  tronWeb?: TronWebLike | false;
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

declare global {
  interface Window {
    tron?: TronProvider;
    tronLink?: TronProvider;
    tronWeb?: TronWebLike;
  }
}

async function proofApi<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    signal: AbortSignal.timeout(20_000),
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let value: any;
  try {
    value = await response.json();
  } catch {
    throw new Error("本地服务未返回完整的收据结果。");
  }
  if (!response.ok) throw new Error(value.error || "链上收据操作失败。");
  return value;
}

function normalizeChainId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value))
    return `0x${value.toString(16)}`;
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if (/^0x[0-9a-f]+$/.test(lower)) return `0x${BigInt(lower).toString(16)}`;
    if (/^\d+$/.test(lower)) return `0x${BigInt(lower).toString(16)}`;
  }
  if (value && typeof value === "object" && "chainId" in value)
    return normalizeChainId((value as { chainId: unknown }).chainId);
  return null;
}

async function readChainId(provider: TronProvider) {
  try {
    return normalizeChainId(await provider.request({ method: "eth_chainId" }));
  } catch {
    return null;
  }
}

async function connectNileWallet(): Promise<{
  provider: TronProvider;
  tronWeb: TronWebLike;
  address: string;
}> {
  const modern = window.tron;
  const provider = modern || window.tronLink;
  if (!provider)
    throw new Error("未检测到 TronLink。请安装并解锁扩展后重试。");
  try {
    await provider.request({ method: modern ? "eth_requestAccounts" : "tron_requestAccounts" });
  } catch {
    throw new Error("未获得 TronLink 账户授权；没有签名或广播交易。");
  }

  let chainId = await readChainId(provider);
  if (chainId !== NILE_CHAIN_ID) {
    try {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: NILE_CHAIN_ID }],
      });
    } catch {
      // The host check below still permits older TronLink versions that expose
      // Nile through TronWeb but do not implement TIP-3326 switching.
    }
    chainId = await readChainId(provider);
  }

  let tronWeb: TronWebLike | undefined =
    provider.tronWeb || window.tronWeb || undefined;
  for (let attempt = 0; !tronWeb && attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    tronWeb = provider.tronWeb || window.tronWeb || undefined;
  }
  if (!tronWeb) throw new Error("TronLink 已连接，但 TronWeb 尚未就绪。");
  const host = tronWeb.fullNode?.host || "";
  if (chainId ? chainId !== NILE_CHAIN_ID : !/nile/i.test(host))
    throw new Error("已拦截非 Nile 交易。请在 TronLink 中切换到 Nile 测试网。");
  const address = tronWeb.defaultAddress?.base58;
  if (!address || !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address))
    throw new Error("TronLink 没有返回可用的 TRON 地址。");
  return { provider, tronWeb, address };
}

async function browserSha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `0x${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

function addressMatches(tronWeb: TronWebLike, chainValue: unknown, base58: string) {
  if (typeof chainValue !== "string") return false;
  if (chainValue === base58) return true;
  return chainValue.toLowerCase() === tronWeb.address.toHex(base58).toLowerCase();
}

function validateUnsignedCommit(
  tronWeb: TronWebLike,
  transaction: Record<string, any>,
  envelope: CommitmentEnvelope,
  submitter: string,
) {
  if (!/^[0-9a-fA-F]{64}$/.test(transaction.txID || ""))
    throw new Error("节点未返回真实交易 ID，已停止签名。");
  const contracts = transaction.raw_data?.contract;
  if (!Array.isArray(contracts) || contracts.length !== 1)
    throw new Error("待签交易不是单一合约调用。");
  const contract = contracts[0];
  const value = contract?.parameter?.value;
  if (
    contract?.type !== "TriggerSmartContract" ||
    !addressMatches(tronWeb, value?.owner_address, submitter) ||
    !addressMatches(tronWeb, value?.contract_address, envelope.registryAddress)
  )
    throw new Error("待签交易的调用者或收据合约不匹配。");
  if (Number(value?.call_value || 0) !== 0 || Number(value?.call_token_value || 0) !== 0)
    throw new Error("已拦截附带 TRX / Token 的交易。");
  if (String(value?.data || "").toLowerCase() !== expectedCommitData(envelope.digestHex))
    throw new Error("待签 calldata 与当前计划哈希不一致。");
  const feeLimit = Number(transaction.raw_data?.fee_limit || 0);
  if (!Number.isSafeInteger(feeLimit) || feeLimit <= 0 || feeLimit > MAX_FEE_LIMIT)
    throw new Error("待签交易的费用上限不在 30 TRX 安全阈值内。");
}

const statusCopy: Record<PlanChainProof["status"], { title: string; detail: string }> = {
  prepared_signed: {
    title: "签名已保存",
    detail: "txID 与完整签名字节已持久化，尚未声称广播。",
  },
  broadcast_unknown: {
    title: "广播待确认",
    detail: "保留原 txID；重试会先查链，只重播同一份签名交易。",
  },
  broadcast: { title: "已广播", detail: "等待 Nile 固化与二次校验。" },
  confirmed: { title: "已固化", detail: "交易、零价值调用与收据事件全部匹配。" },
  reverted: { title: "执行失败", detail: "合约回滚，这份收据未生效。" },
  mismatch: { title: "校验不一致", detail: "链上内容与当前冻结计划不匹配。" },
};

export default function ChainReceipt({
  portfolio,
  onPortfolio,
}: {
  portfolio: Portfolio;
  onPortfolio: (portfolio: Portfolio) => void;
}) {
  const [envelope, setEnvelope] = useState<CommitmentEnvelope | null>(null);
  const [proof, setProof] = useState<PlanChainProof | null>(
    portfolio.chainProof || null,
  );
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState<
    "load" | "sign" | "broadcast" | "verify" | ""
  >("load");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const path = `/portfolios/${encodeURIComponent(portfolio.plan.id)}/commitment`;
  useEffect(() => {
    let active = true;
    setProof(portfolio.chainProof || null);
    setBusy("load");
    setError("");
    proofApi<{ envelope: CommitmentEnvelope; proof: PlanChainProof | null }>(path)
      .then((result) => {
        if (!active) return;
        setEnvelope(result.envelope);
        setProof(result.proof);
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : "无法生成收据。");
      })
      .finally(() => {
        if (active) setBusy("");
      });
    return () => {
      active = false;
    };
  }, [portfolio.plan.id, portfolio.chainProof?.transactionId]);

  async function verify(silent = false) {
    if (!proof || busy) return;
    if (!silent) setBusy("verify");
    setError("");
    try {
      const result = await proofApi<{
        envelope: CommitmentEnvelope;
        proof: PlanChainProof;
        portfolio: Portfolio;
      }>(`${path}/verify`, {});
      setEnvelope(result.envelope);
      setProof(result.proof);
      onPortfolio(result.portfolio);
    } catch (reason) {
      if (!silent)
        setError(reason instanceof Error ? reason.message : "Nile 核验失败。");
    } finally {
      if (!silent) setBusy("");
    }
  }

  useEffect(() => {
    if (proof?.status !== "broadcast") return;
    const timer = window.setTimeout(() => void verify(true), 8_000);
    return () => window.clearTimeout(timer);
  }, [proof?.status, proof?.verifiedAt]);

  async function signAndBroadcast() {
    if (!envelope || !acknowledged || busy) return;
    setBusy("sign");
    setError("");
    setNotice("");
    try {
      const localCanonical = canonicalJson(envelope.receipt);
      if (localCanonical !== envelope.canonicalJson)
        throw new Error("浏览器重建的收据与服务端不一致，已停止。");
      if ((await browserSha256(localCanonical)) !== envelope.digestHex)
        throw new Error("浏览器独立计算的 SHA-256 不匹配，已停止。");
      const { tronWeb, address } = await connectNileWallet();
      if (!tronWeb.isAddress?.(envelope.registryAddress))
        throw new Error("配置的 Nile ReceiptRegistry 地址无效。");
      const built = await tronWeb.transactionBuilder.triggerSmartContract(
        envelope.registryAddress,
        "commit(bytes32,bytes32)",
        { callValue: 0, feeLimit: MAX_FEE_LIMIT },
        [
          { type: "bytes32", value: RECEIPT_KIND_HEX },
          { type: "bytes32", value: envelope.digestHex },
        ],
        address,
      );
      if (!built.result?.result || !built.transaction)
        throw new Error("官方 Nile 节点未生成收据交易。");
      validateUnsignedCommit(tronWeb, built.transaction, envelope, address);
      const signed = await tronWeb.trx.sign(built.transaction);
      validateUnsignedCommit(tronWeb, signed, envelope, address);
      if (!Array.isArray(signed.signature) || signed.signature.length === 0)
        throw new Error("TronLink 未返回交易签名。");
      if (signed.txID !== built.transaction.txID)
        throw new Error("签名后交易 ID 发生变化，已停止广播。");
      const prepared = await proofApi<{
        envelope: CommitmentEnvelope;
        proof: PlanChainProof;
        portfolio: Portfolio;
      }>(`${path}/prepare-signed`, {
        submitter: address,
        signedTransaction: signed,
      });
      setEnvelope(prepared.envelope);
      setProof(prepared.proof);
      onPortfolio(prepared.portfolio);
      const result = await proofApi<{
        envelope: CommitmentEnvelope;
        proof: PlanChainProof;
        portfolio: Portfolio;
      }>(`${path}/broadcast`, {});
      setEnvelope(result.envelope);
      setProof(result.proof);
      onPortfolio(result.portfolio);
      setAcknowledged(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "收据交易未完成。");
    } finally {
      setBusy("");
    }
  }

  async function resumeOriginalBroadcast() {
    if (!proof || busy) return;
    setBusy("broadcast");
    setError("");
    try {
      const result = await proofApi<{
        envelope: CommitmentEnvelope;
        proof: PlanChainProof;
        portfolio: Portfolio;
      }>(`${path}/broadcast`, {});
      setEnvelope(result.envelope);
      setProof(result.proof);
      onPortfolio(result.portfolio);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? `${reason.message} 原 txID 和签名字节仍保存在本地服务。`
          : "无法查询或重播原签名交易。",
      );
    } finally {
      setBusy("");
    }
  }

  const allocationLabel = useMemo(() => {
    if (!envelope) return "";
    return envelope.receipt.allocations
      .filter((item) => item.destination === "justlend")
      .map((item) => `${item.asset} ${(item.amountMicros / 1e6).toLocaleString("en-US")}`)
      .join(" / ");
  }, [envelope]);

  async function copyDigest() {
    if (!envelope) return;
    try {
      await navigator.clipboard.writeText(envelope.digestHex);
      setNotice("哈希已复制。");
    } catch {
      setNotice("复制权限不可用，可直接选中下方哈希。");
    }
  }

  return (
    <section className="chain-receipt">
      <div className="section-heading">
        <div>
          <span className="eyebrow">NILE / AUDIT RECEIPT</span>
          <h3>计划上链收据。</h3>
          <p>存证，不入金。</p>
        </div>
        <span className={`pill ${proof?.status === "confirmed" ? "green" : "amber"}`}>
          {proof ? statusCopy[proof.status].title : "待签名"}
        </span>
      </div>

      {busy === "load" ? (
        <div className="receipt-loading">
          <LoaderCircle className="spin" size={18} /> 生成确定性收据…
        </div>
      ) : envelope ? (
        <>
          <div className="receipt-facts">
            <div>
              <span>市场快照</span>
              <b>{new Date(envelope.receipt.marketSnapshot.fetchedAt).toLocaleString("zh-CN", { hour12: false })}</b>
              <small>{envelope.receipt.marketSnapshot.mode === "live" ? "官方实时只读" : "演示后备数据"}</small>
            </div>
            <div>
              <span>确认时间</span>
              <b>{new Date(envelope.receipt.plan.confirmedAt).toLocaleString("zh-CN", { hour12: false })}</b>
              <small>已冻结计划</small>
            </div>
            <div>
              <span>结算准备金</span>
              <b>{(envelope.receipt.reserveConstraints.reserveMicros / 1e6).toLocaleString("en-US")} USDT</b>
              <small>不进入 JustLend</small>
            </div>
            <div>
              <span>计划配置</span>
              <b>{allocationLabel || "全部留在钱包"}</b>
              <small>只记录分配意图</small>
            </div>
          </div>
          <div className="digest-row">
            <FileCheck2 size={18} />
            <div>
              <span>SHA-256 / {envelope.receipt.schema}</span>
              <code>{envelope.digestHex}</code>
            </div>
            <button aria-label="复制收据哈希" onClick={copyDigest}>
              <Copy size={15} />
            </button>
          </div>
          {notice ? <p className="receipt-notice">{notice}</p> : null}

          {proof ? (
            <div className={`proof-state ${proof.status}`}>
              {proof.status === "confirmed" ? (
                <CheckCircle2 size={24} />
              ) : proof.status === "broadcast" ||
                proof.status === "prepared_signed" ||
                proof.status === "broadcast_unknown" ? (
                <LoaderCircle className="spin" size={24} />
              ) : (
                <CircleAlert size={24} />
              )}
              <div>
                <b>{statusCopy[proof.status].title}</b>
                <p>{proof.reason || statusCopy[proof.status].detail}</p>
                <small>
                  {proof.blockNumber ? `Block ${proof.blockNumber} · ` : ""}
                  {proof.chainTimestamp
                    ? new Date(proof.chainTimestamp).toLocaleString("zh-CN", { hour12: false })
                    : "Nile 零价值合约调用"}
                </small>
              </div>
              {proof.status !== "prepared_signed" ? (
                <a href={proof.explorerUrl} target="_blank" rel="noreferrer">
                  TRONSCAN <ExternalLink size={14} />
                </a>
              ) : null}
            </div>
          ) : (
            <div className="receipt-consent">
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />
                <span>
                  我确认这是分配计划审计收据。交易只向 ReceiptRegistry 提交哈希，callValue = 0；不是 JustLend 存入。
                </span>
              </label>
              <button
                className="primary"
                disabled={!acknowledged || !!busy}
                onClick={signAndBroadcast}
              >
                {busy === "sign" ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <Wallet size={16} />
                )}
                {busy === "sign" ? "等待 TronLink…" : "用 TronLink 签名存证"}
              </button>
            </div>
          )}
          <div className="receipt-bottom">
            <span>
              <ShieldCheck size={14} /> Nile 强制校验 · 0 TRX 转移 · 最高费用上限 30 Nile TRX
            </span>
            {proof?.status === "prepared_signed" ||
            proof?.status === "broadcast_unknown" ? (
              <button
                className="text-button"
                disabled={!!busy}
                onClick={() => void resumeOriginalBroadcast()}
              >
                <RefreshCw
                  size={14}
                  className={busy === "broadcast" ? "spin" : ""}
                />
                查原 txID 并重播原签名
              </button>
            ) : proof ? (
              <button className="text-button" disabled={!!busy} onClick={() => void verify()}>
                <RefreshCw size={14} className={busy === "verify" ? "spin" : ""} />
                重新核验
              </button>
            ) : null}
          </div>
        </>
      ) : (
        <div className="receipt-unavailable">
          <CircleAlert size={20} />
          <div>
            <b>还差一个 Nile 合约地址。</b>
            <p>{error}</p>
            <small>收据未配置时，页面不会伪造交易哈希。</small>
          </div>
        </div>
      )}
      {error && envelope ? <p className="receipt-error">{error}</p> : null}
      <details>
        <summary>查看收据边界与合约</summary>
        <p className="subtle">
          收据绑定数据源、采集时间、准备金、分配、预期范围、假设与确认时间。链上仅存 kind + digest，原始业务数据不公开。
        </p>
        {envelope ? <code className="registry-address">{envelope.registryAddress}</code> : null}
      </details>
    </section>
  );
}

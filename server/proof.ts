import { createHash, timingSafeEqual } from "node:crypto";
import {
  buildPlanCommitmentReceipt,
  canonicalJson,
  expectedCommitData,
  RECEIPT_EVENT_TOPIC,
  RECEIPT_KIND_HEX,
} from "../shared/proof.js";
import type {
  CommitmentEnvelope,
  PlanChainProof,
} from "../shared/proof.js";
import type { Portfolio } from "../shared/types.js";

const NILE_EXPLORER = "https://nile.tronscan.org/#/transaction/" as const;
const DEFAULT_NILE_RPC = "https://nile.trongrid.io";
export const MAX_RECEIPT_FEE_LIMIT = 30_000_000;
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest();
}

export function decodeTronAddress(address: string): string {
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address))
    throw new Error("TRON address format is invalid.");
  let value = 0n;
  for (const character of address) {
    const index = BASE58.indexOf(character);
    if (index < 0) throw new Error("TRON address contains invalid Base58 data.");
    value = value * 58n + BigInt(index);
  }
  const decoded: number[] = [];
  while (value > 0n) {
    decoded.push(Number(value % 256n));
    value /= 256n;
  }
  decoded.reverse();
  for (const character of address) {
    if (character !== "1") break;
    decoded.unshift(0);
  }
  const bytes = Uint8Array.from(decoded);
  if (bytes.length !== 25) throw new Error("TRON address length is invalid.");
  const payload = bytes.slice(0, 21);
  const checksum = bytes.slice(21);
  const expected = sha256(sha256(payload)).subarray(0, 4);
  if (!timingSafeEqual(checksum, expected))
    throw new Error("TRON address checksum is invalid.");
  if (payload[0] !== 0x41) throw new Error("Address is not a TRON account.");
  return Buffer.from(payload).toString("hex").toLowerCase();
}

export function configuredRegistryAddress(): string | null {
  const address = process.env.NILE_RECEIPT_REGISTRY_ADDRESS?.trim();
  if (!address) return null;
  decodeTronAddress(address);
  return address;
}

export function commitmentEnvelope(
  portfolio: Portfolio,
  registryAddress: string,
): CommitmentEnvelope {
  decodeTronAddress(registryAddress);
  const receipt = buildPlanCommitmentReceipt(portfolio);
  const serialized = canonicalJson(receipt);
  return {
    receipt,
    canonicalJson: serialized,
    digestHex: `0x${createHash("sha256").update(serialized).digest("hex")}`,
    kindHex: RECEIPT_KIND_HEX,
    registryAddress,
    network: "nile",
    explorerBaseUrl: NILE_EXPLORER,
  };
}

export interface RpcPost {
  (path: string, body: Record<string, unknown>): Promise<Record<string, any>>;
}

function nileRpcBase(): string {
  const raw = process.env.NILE_RPC_URL || DEFAULT_NILE_RPC;
  const parsed = new URL(raw);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/" ||
    !["nile.trongrid.io", "api.nileex.io"].includes(parsed.hostname)
  )
    throw new Error("NILE_RPC_URL must be an official HTTPS Nile endpoint.");
  return parsed.origin;
}

export const postNileRpc: RpcPost = async (path, body) => {
  return postNileRpcBody(path, { ...body, visible: true });
};

export const postNileRpcBody: RpcPost = async (path, body) => {
  const response = await fetch(`${nileRpcBase()}${path}`, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: {
      "Content-Type": "application/json",
      ...(process.env.TRONGRID_API_KEY
        ? { "TRON-PRO-API-KEY": process.env.TRONGRID_API_KEY }
        : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Nile RPC returned HTTP ${response.status}.`);
  const value = await response.json();
  if (!value || typeof value !== "object") throw new Error("Invalid Nile RPC response.");
  return value;
};

function nonnegativeInteger(value: unknown): bigint | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return BigInt(value);
  if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value))
    return BigInt(value);
  return null;
}

function chainAddressMatches(value: unknown, expected: string): boolean {
  if (typeof value !== "string") return false;
  if (value === expected) return true;
  try {
    return value.toLowerCase() === decodeTronAddress(expected);
  } catch {
    return false;
  }
}

export function transactionMismatch(
  transaction: Record<string, any>,
  envelope: CommitmentEnvelope,
  submitter: string,
): string | null {
  if (typeof transaction.txID !== "string") return "交易没有可核验的 txID。";
  const contracts = transaction.raw_data?.contract;
  if (!Array.isArray(contracts) || contracts.length !== 1)
    return "交易并非单一合约调用。";
  const contract = contracts[0];
  if (contract?.type !== "TriggerSmartContract")
    return "交易类型不是 ReceiptRegistry 合约调用。";
  const value = contract.parameter?.value;
  if (!chainAddressMatches(value?.owner_address, submitter))
    return "链上签名地址与提交地址不一致。";
  if (!chainAddressMatches(value?.contract_address, envelope.registryAddress))
    return "交易调用的不是本次配置的 ReceiptRegistry。";
  if (Number(value?.call_value || 0) !== 0 || Number(value?.call_token_value || 0) !== 0)
    return "交易附带了 TRX 或 TRC-10 价值。";
  if (String(value?.data || "").toLowerCase() !== expectedCommitData(envelope.digestHex))
    return "交易 calldata 与当前计划收据不一致。";
  const feeLimit = nonnegativeInteger(transaction.raw_data?.fee_limit);
  if (
    feeLimit === null ||
    feeLimit <= 0n ||
    feeLimit > BigInt(MAX_RECEIPT_FEE_LIMIT)
  )
    return "交易 fee_limit 缺失、为零或超过 30 Nile TRX 上限。";
  return null;
}

export function validateSignedCommitTransaction(
  transaction: Record<string, any>,
  envelope: CommitmentEnvelope,
  submitter: string,
): {
  transactionId: string;
  signedTransactionDigest: `0x${string}`;
  signedTransaction: Record<string, unknown>;
} {
  const serialized = JSON.stringify(transaction);
  if (serialized.length > 90_000) throw new Error("签名交易超过大小上限。");
  const transactionId =
    typeof transaction.txID === "string" ? transaction.txID.toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(transactionId))
    throw new Error("签名交易没有有效 txID。");
  const rawDataHex =
    typeof transaction.raw_data_hex === "string"
      ? transaction.raw_data_hex.toLowerCase()
      : "";
  if (!/^(?:[0-9a-f]{2})+$/.test(rawDataHex))
    throw new Error("签名交易缺少完整 raw_data_hex。");
  const computedId = createHash("sha256")
    .update(Buffer.from(rawDataHex, "hex"))
    .digest("hex");
  if (computedId !== transactionId)
    throw new Error("txID 不是 raw_data_hex 的 SHA-256。");
  if (
    !Array.isArray(transaction.signature) ||
    transaction.signature.length < 1 ||
    transaction.signature.length > 5 ||
    transaction.signature.some(
      (signature: unknown) =>
        typeof signature !== "string" || !/^[0-9a-fA-F]{130}$/.test(signature),
    )
  )
    throw new Error("签名交易没有完整的 TRON 签名。");
  const mismatch = transactionMismatch(transaction, envelope, submitter);
  if (mismatch) throw new Error(mismatch);
  const signedTransaction = JSON.parse(serialized) as Record<string, unknown>;
  return {
    transactionId,
    signedTransaction,
    signedTransactionDigest: `0x${createHash("sha256")
      .update(canonicalJson(signedTransaction))
      .digest("hex")}`,
  };
}

function pendingStatus(proof: PlanChainProof): PlanChainProof["status"] {
  return proof.status === "prepared_signed" || proof.status === "broadcast_unknown"
    ? proof.status
    : "broadcast";
}

function matchingReceiptLog(
  info: Record<string, any>,
  envelope: CommitmentEnvelope,
  submitter: string,
): { timestamp: bigint } | null {
  const registryHex = decodeTronAddress(envelope.registryAddress).slice(2);
  const submitterHex = decodeTronAddress(submitter).slice(2);
  const digest = envelope.digestHex.slice(2).toLowerCase();
  const kind = envelope.kindHex.slice(2).toLowerCase();
  for (const log of Array.isArray(info.log) ? info.log : []) {
    const rawAddress = String(log.address || "");
    let address = rawAddress.replace(/^0x/, "").toLowerCase();
    if (rawAddress.startsWith("T")) {
      try {
        address = decodeTronAddress(rawAddress).slice(2);
      } catch {
        continue;
      }
    }
    const topics = Array.isArray(log.topics)
      ? log.topics.map((topic: unknown) => String(topic).replace(/^0x/, "").toLowerCase())
      : [];
    const data = String(log.data || "").replace(/^0x/, "").toLowerCase();
    if (
      address !== registryHex ||
      topics[0] !== RECEIPT_EVENT_TOPIC ||
      topics[1]?.slice(-40) !== submitterHex ||
      topics[2] !== kind ||
      data.slice(0, 64) !== digest ||
      !/^[0-9a-f]{128}$/.test(data)
    )
      continue;
    const timestamp = BigInt(`0x${data.slice(64, 128)}`);
    if (timestamp <= 0n) continue;
    return { timestamp };
  }
  return null;
}

export async function verifyNileProof(
  portfolio: Portfolio,
  proof: PlanChainProof,
  rpc: RpcPost = postNileRpc,
  now = new Date().toISOString(),
): Promise<PlanChainProof> {
  const envelope = commitmentEnvelope(portfolio, proof.registryAddress);
  const base: PlanChainProof = {
    ...proof,
    digestHex: envelope.digestHex,
    kindHex: envelope.kindHex,
    explorerUrl: `${NILE_EXPLORER}${proof.transactionId}`,
    verifiedAt: now,
  };
  if (
    proof.digestHex !== envelope.digestHex ||
    proof.kindHex !== envelope.kindHex ||
    proof.registryAddress !== envelope.registryAddress
  )
    return { ...base, status: "mismatch", reason: "本机保存的证明与当前冻结计划不一致。" };

  const body = await rpc("/walletsolidity/gettransactionbyid", {
    value: proof.transactionId,
  });
  if (!body.txID)
    return {
      ...base,
      status: pendingStatus(proof),
      reason:
        proof.status === "prepared_signed"
          ? "已安全保存签名交易，尚未确认广播。"
          : "等待 Nile 区块固化。",
    };
  if (body.txID !== proof.transactionId)
    return { ...base, status: "mismatch", reason: "Nile 返回了不同的交易标识。" };
  const mismatch = transactionMismatch(body, envelope, proof.submitter);
  if (mismatch) return { ...base, status: "mismatch", reason: mismatch };

  const info = await rpc("/walletsolidity/gettransactioninfobyid", {
    value: proof.transactionId,
  });
  if (!info.id)
    return { ...base, status: "broadcast", reason: "交易已出现，等待固化回执。" };
  if (info.id !== proof.transactionId)
    return { ...base, status: "mismatch", reason: "固化回执 id 与原始 txID 不一致。" };
  if (
    !Number.isSafeInteger(info.blockNumber) ||
    info.blockNumber <= 0 ||
    !Number.isSafeInteger(info.blockTimeStamp) ||
    info.blockTimeStamp <= 0 ||
    !Number.isFinite(new Date(info.blockTimeStamp).getTime())
  )
    return {
      ...base,
      status: "mismatch",
      reason: "固化回执缺少安全整数 blockNumber / blockTimeStamp。",
    };
  const contractRet = body.ret?.[0]?.contractRet;
  const executionResult = info.receipt?.result;
  if (
    contractRet !== "SUCCESS" ||
    executionResult !== "SUCCESS" ||
    info.result === "FAILED"
  )
    return {
      ...base,
      status: "reverted",
      blockNumber: info.blockNumber,
      reason: `合约执行未通过三重成功校验（contractRet=${contractRet || "missing"}, receipt.result=${executionResult || "missing"}, result=${info.result || "not_failed"}）。`,
    };
  const event = matchingReceiptLog(info, envelope, proof.submitter);
  if (!event)
    return {
      ...base,
      status: "mismatch",
      blockNumber: info.blockNumber,
      reason: "固化交易没有发出与当前计划匹配的 ReceiptCommitted 事件。",
    };
  if (
    event.timestamp > BigInt(Number.MAX_SAFE_INTEGER) ||
    Number(event.timestamp) !== Math.floor(info.blockTimeStamp / 1000)
  )
    return {
      ...base,
      status: "mismatch",
      blockNumber: info.blockNumber,
      reason: "ReceiptCommitted 时间与固化区块时间不一致。",
    };
  return {
    ...base,
    status: "confirmed",
    blockNumber: info.blockNumber,
    chainTimestamp: new Date(info.blockTimeStamp).toISOString(),
    reason: "Nile 固化交易、零价值调用与 ReceiptCommitted 事件均已匹配。",
  };
}

async function lookupFullNode(
  proof: PlanChainProof,
  envelope: CommitmentEnvelope,
  rpc: RpcPost,
): Promise<"absent" | "present" | string> {
  const transaction = await rpc("/wallet/gettransactionbyid", {
    value: proof.transactionId,
  });
  if (!transaction.txID) return "absent";
  if (transaction.txID !== proof.transactionId)
    return "FullNode 返回的 txID 与已签名 txID 不一致。";
  return transactionMismatch(transaction, envelope, proof.submitter) || "present";
}

export async function broadcastSavedProof(
  portfolio: Portfolio,
  proof: PlanChainProof,
  query: RpcPost = postNileRpc,
  broadcast: RpcPost = postNileRpcBody,
  now = new Date().toISOString(),
): Promise<PlanChainProof> {
  const envelope = commitmentEnvelope(portfolio, proof.registryAddress);
  let validated: ReturnType<typeof validateSignedCommitTransaction>;
  try {
    validated = validateSignedCommitTransaction(
      proof.signedTransaction,
      envelope,
      proof.submitter,
    );
  } catch {
    return {
      ...proof,
      status: "mismatch",
      verifiedAt: now,
      reason: "已保存的签名交易无法通过完整性校验，已停止广播。",
    };
  }
  if (
    validated.transactionId !== proof.transactionId ||
    validated.signedTransactionDigest !== proof.signedTransactionDigest
  )
    return {
      ...proof,
      status: "mismatch",
      verifiedAt: now,
      reason: "已保存签名字节与原 txID / 指纹不一致。",
    };

  let before: "absent" | "present" | string;
  try {
    before = await lookupFullNode(proof, envelope, query);
  } catch {
    return {
      ...proof,
      status: "broadcast_unknown",
      verifiedAt: now,
      reason: "重播前无法查询原 txID；为避免产生不确定性，本次没有重播。",
    };
  }
  if (before === "present")
    return {
      ...proof,
      status: "broadcast",
      broadcastAt: proof.broadcastAt || now,
      verifiedAt: now,
      reason: "FullNode 已找到原 txID，未重复广播。",
    };
  if (before !== "absent")
    return { ...proof, status: "mismatch", verifiedAt: now, reason: before };

  let broadcastFailureCode = "unknown";
  try {
    const result = await broadcast(
      "/wallet/broadcasttransaction",
      proof.signedTransaction,
    );
    const returnedId =
      typeof result.txid === "string"
        ? result.txid
        : typeof result.transaction?.txID === "string"
          ? result.transaction.txID
          : undefined;
    if (returnedId && returnedId !== proof.transactionId)
      return {
        ...proof,
        status: "mismatch",
        verifiedAt: now,
        reason: "广播节点返回了不同的 txID。",
      };
    if (result.result === true)
      return {
        ...proof,
        status: "broadcast",
        broadcastAt: proof.broadcastAt || now,
        verifiedAt: now,
        reason: "已广播服务端保存的原始签名交易，等待 Nile 固化。",
      };
    broadcastFailureCode = String(result.code || "unknown");
  } catch {
    // A timeout can happen after the node accepted the transaction. Query the
    // original txID below before deciding whether the result is unknown.
  }

  try {
    const after = await lookupFullNode(proof, envelope, query);
    if (after === "present")
      return {
        ...proof,
        status: "broadcast",
        broadcastAt: proof.broadcastAt || now,
        verifiedAt: now,
        reason: "广播回复不确定，但 FullNode 已找到原 txID。",
      };
    if (after !== "absent")
      return { ...proof, status: "mismatch", verifiedAt: now, reason: after };
  } catch {
    // Preserve unknown: both the broadcast response and the follow-up lookup
    // were unavailable. The exact signed transaction remains persisted.
  }
  return {
    ...proof,
    status: "broadcast_unknown",
    verifiedAt: now,
    reason:
      broadcastFailureCode === "unknown"
        ? "广播结果未知；已保留原 txID 和同一份签名字节，重试前会先查原 txID。"
        : `Nile 未确认接受广播（${broadcastFailureCode}）；回查原 txID 仍未出现，已保留同一份签名交易。`,
  };
}

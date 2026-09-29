import type { Plan, Portfolio } from "./types";

export const RECEIPT_SCHEMA = "yieldwindow/allocation-plan-commitment@1" as const;
export const RECEIPT_KIND = "allocation-plan-commitment" as const;
export const RECEIPT_KIND_HEX =
  "0x7969656c6477696e646f772e706c616e2e763100000000000000000000000000" as const;
export const RECEIPT_COMMIT_SELECTOR = "e3ce094d" as const;
export const RECEIPT_EVENT_TOPIC =
  "526b0215a1feceef438c76047ff384086ffa3766495d3f00f9a538de1bfc8ae7" as const;

export const RECEIPT_REGISTRY_ABI = [
  {
    inputs: [
      { internalType: "bytes32", name: "kind", type: "bytes32" },
      { internalType: "bytes32", name: "digest", type: "bytes32" },
    ],
    name: "commit",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "address",
        name: "submitter",
        type: "address",
      },
      {
        indexed: true,
        internalType: "bytes32",
        name: "kind",
        type: "bytes32",
      },
      {
        indexed: false,
        internalType: "bytes32",
        name: "digest",
        type: "bytes32",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "timestamp",
        type: "uint256",
      },
    ],
    name: "ReceiptCommitted",
    type: "event",
  },
] as const;

export interface PlanCommitmentReceipt {
  schema: typeof RECEIPT_SCHEMA;
  kind: typeof RECEIPT_KIND;
  network: "TRON Nile";
  product: "YieldWindow";
  plan: {
    id: string;
    title: string;
    createdAt: string;
    confirmedAt: string;
  };
  marketSnapshot: {
    id: string;
    mode: Plan["snapshot"]["mode"];
    fetchedAt: string;
    phaseEnd: string | null;
    incentiveDaysVerified: number;
    markets: Plan["snapshot"]["markets"];
    sources: Plan["snapshot"]["sources"];
  };
  reserveConstraints: {
    usdtMicros: number;
    usddMicros: number;
    sellerSettlementMicros: number;
    bufferMicros: number;
    reserveMicros: number;
    reserveInDays: number;
    horizonDays: number;
    allowUSDD: boolean;
    hasDebt: boolean;
  };
  allocations: Plan["allocations"];
  expectedRangeMicros: {
    conservativeNet: number;
    indicativeIfCurrentBonusPersists: number;
    minimum: number;
    maximum: number;
    costIncludingExit: number;
    guarantee: false;
  };
  assumptions: string[];
  risks: string[];
  exitConditions: string[];
}

export interface CommitmentEnvelope {
  receipt: PlanCommitmentReceipt;
  canonicalJson: string;
  digestHex: `0x${string}`;
  kindHex: typeof RECEIPT_KIND_HEX;
  registryAddress: string;
  network: "nile";
  explorerBaseUrl: "https://nile.tronscan.org/#/transaction/";
}

export type ChainProofStatus =
  | "prepared_signed"
  | "broadcast_unknown"
  | "broadcast"
  | "confirmed"
  | "reverted"
  | "mismatch";

export interface PlanChainProof {
  network: "nile";
  registryAddress: string;
  kindHex: typeof RECEIPT_KIND_HEX;
  digestHex: `0x${string}`;
  transactionId: string;
  submitter: string;
  preparedAt: string;
  broadcastAt?: string;
  status: ChainProofStatus;
  explorerUrl: string;
  verifiedAt?: string;
  blockNumber?: number;
  chainTimestamp?: string;
  reason?: string;
  signedTransaction: Record<string, unknown>;
  signedTransactionDigest: `0x${string}`;
}

function canonicalValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Receipt contains a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalValue(item)}`)
      .join(",")}}`;
  }
  throw new Error("Receipt contains an unsupported value.");
}

export function canonicalJson(value: unknown): string {
  return canonicalValue(value);
}

export function buildPlanCommitmentReceipt(
  portfolio: Portfolio,
): PlanCommitmentReceipt {
  const plan = portfolio.plan;
  const indicative =
    plan.baseYieldMicros + plan.indicativeBonusMicros - plan.costMicros;
  return {
    schema: RECEIPT_SCHEMA,
    kind: RECEIPT_KIND,
    network: "TRON Nile",
    product: "YieldWindow",
    plan: {
      id: plan.id,
      title: plan.title,
      createdAt: plan.createdAt,
      confirmedAt: portfolio.confirmedAt,
    },
    marketSnapshot: {
      id: plan.snapshot.id,
      mode: plan.snapshot.mode,
      fetchedAt: plan.snapshot.fetchedAt,
      phaseEnd: plan.snapshot.phaseEnd,
      incentiveDaysVerified: plan.snapshot.incentiveDaysVerified,
      markets: structuredClone(plan.snapshot.markets),
      sources: structuredClone(plan.snapshot.sources),
    },
    reserveConstraints: {
      usdtMicros: plan.profile.usdtMicros,
      usddMicros: plan.profile.usddMicros,
      sellerSettlementMicros: plan.profile.sellerSettlementMicros,
      bufferMicros: plan.profile.bufferMicros,
      reserveMicros: plan.profile.reserveMicros,
      reserveInDays: plan.profile.reserveInDays,
      horizonDays: plan.profile.horizonDays,
      allowUSDD: plan.profile.allowUSDD,
      hasDebt: plan.profile.hasDebt,
    },
    allocations: structuredClone(plan.allocations),
    expectedRangeMicros: {
      conservativeNet: plan.netMicros,
      indicativeIfCurrentBonusPersists: indicative,
      minimum: Math.min(plan.netMicros, indicative),
      maximum: Math.max(plan.netMicros, indicative),
      costIncludingExit: plan.costMicros,
      guarantee: false,
    },
    assumptions: structuredClone(plan.assumptions),
    risks: structuredClone(plan.risks),
    exitConditions: structuredClone(plan.exitConditions),
  };
}

export function expectedCommitData(digestHex: string): string {
  const digest = digestHex.replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error("Invalid receipt digest.");
  return `${RECEIPT_COMMIT_SELECTOR}${RECEIPT_KIND_HEX.slice(2)}${digest}`;
}

export type Asset = "USDT" | "USDD";
export interface Profile {
  usdtMicros: number;
  usddMicros: number;
  horizonDays: number;
  sellerSettlementMicros: number;
  bufferMicros: number;
  reserveMicros: number;
  reserveInDays: number;
  risk: "cautious" | "balanced";
  allowUSDD: boolean;
  hasDebt: boolean;
  perActionCostMicros: number;
}
export interface Source {
  name: string;
  url: string;
  fetchedAt: string;
  status: "live" | "unavailable";
  note: string;
}
export interface Market {
  asset: Asset;
  address: string;
  underlyingAddress: string;
  decimals: number;
  baseRate: number;
  incentiveRate: number;
  cash: string;
}
export interface Snapshot {
  id: string;
  fetchedAt: string;
  mode: "live" | "demo";
  markets: Record<Asset, Market>;
  sources: Source[];
  phaseEnd: string | null;
  incentiveDaysVerified: number;
  warnings: string[];
}
export interface Allocation {
  asset: Asset;
  amountMicros: number;
  destination: "wallet" | "justlend";
  baseYieldMicros: number;
  incentiveYieldMicros: number;
}
export interface Plan {
  id: string;
  title: string;
  subtitle: string;
  profile: Profile;
  snapshot: Snapshot;
  allocations: Allocation[];
  costMicros: number;
  baseYieldMicros: number;
  incentiveYieldMicros: number;
  indicativeBonusMicros: number;
  netMicros: number;
  reasons: string[];
  risks: string[];
  exitConditions: string[];
  assumptions: string[];
  createdAt: string;
}
export interface Action {
  id: string;
  planId: string;
  kind: "approve" | "deposit" | "withdraw";
  asset: Asset;
  amountMicros: number;
  feeMicros: number;
  spender: string;
  status: "ready" | "simulated";
  createdAt: string;
  completedAt?: string;
}
export interface Log {
  id: string;
  at: string;
  title: string;
  detail: string;
  mode: "simulation" | "read-only" | "on-chain";
}
export interface Portfolio {
  plan: Plan;
  confirmedAt: string;
  actions: Action[];
  positions: Record<Asset, number>;
  logs: Log[];
  reviews?: { at: string; result: Review; snapshot: Snapshot }[];
  chainProof?: import("./proof").PlanChainProof;
}
export interface Review {
  at: string;
  positionBasis: Record<Asset, number>;
  days: number;
  scenario: "current" | "incentive-end" | "rate-drop" | "depeg";
  expectedMicros: number;
  observedBaseMicros: number;
  observedIncentiveMicros: number;
  priceImpactMicros: number;
  costMicros: number;
  netMicros: number;
  deltaMicros: number;
  suggestions: string[];
  mode: "simulated-position";
  snapshotId: string;
}
export interface Intake {
  draft: Partial<Profile>;
  missing: string[];
  question: string;
  modelMode: "local-guided" | "kiln";
  usage?: { inputTokens: number; outputTokens: number };
  warning?: string;
}
export const REGISTRY = {
  USDT: {
    address: "TXJgMdjVX5dKiQaUi9QobwNxtSQaFqccvd",
    underlyingAddress: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    decimals: 6,
  },
  USDD: {
    address: "TKFRELGGoRgiayhwJTNNLqCNjFoLBh3Mnf",
    underlyingAddress: "TXDk8mbtRbXeYuMNS83CfKPaYYT8XWv9Hz",
    decimals: 18,
  },
} as const;

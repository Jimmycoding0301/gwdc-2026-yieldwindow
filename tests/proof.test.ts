import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildPlans, initialActions } from "../shared/planner";
import {
  buildPlanCommitmentReceipt,
  canonicalJson,
  expectedCommitData,
  RECEIPT_EVENT_TOPIC,
  RECEIPT_KIND_HEX,
} from "../shared/proof";
import { REGISTRY } from "../shared/types";
import type { PlanChainProof } from "../shared/proof";
import type { Portfolio, Profile } from "../shared/types";
import { demoSnapshot } from "../server/market";
import {
  broadcastSavedProof,
  commitmentEnvelope,
  decodeTronAddress,
  validateSignedCommitTransaction,
  verifyNileProof,
} from "../server/proof";

const submitter = "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb";
const registry = REGISTRY.USDT.underlyingAddress;
const rawDataHex = "0a00";
const txid = createHash("sha256").update(Buffer.from(rawDataHex, "hex")).digest("hex");
const profile: Profile = {
  usdtMicros: 90_000e6,
  usddMicros: 10_000e6,
  horizonDays: 4,
  sellerSettlementMicros: 68_000e6,
  bufferMicros: 12_000e6,
  reserveMicros: 80_000e6,
  reserveInDays: 4,
  risk: "balanced",
  allowUSDD: true,
  hasDebt: false,
  perActionCostMicros: 200_000,
};

function portfolio(): Portfolio {
  const plan = buildPlans(
    profile,
    demoSnapshot("2026-09-29T00:00:00.000Z"),
    "2026-09-29T00:01:00.000Z",
  )[1];
  return {
    plan,
    confirmedAt: "2026-09-29T00:02:00.000Z",
    actions: initialActions(plan),
    positions: { USDT: 0, USDD: 0 },
    logs: [],
  };
}

function proof(value: Portfolio): PlanChainProof {
  const envelope = commitmentEnvelope(value, registry);
  const signedTransaction = transaction(value);
  const validated = validateSignedCommitTransaction(
    signedTransaction,
    envelope,
    submitter,
  );
  return {
    network: "nile",
    registryAddress: registry,
    kindHex: RECEIPT_KIND_HEX,
    digestHex: envelope.digestHex,
    transactionId: txid,
    submitter,
    preparedAt: "2026-09-29T00:03:00.000Z",
    broadcastAt: "2026-09-29T00:03:01.000Z",
    status: "broadcast",
    explorerUrl: `https://nile.tronscan.org/#/transaction/${txid}`,
    signedTransaction: validated.signedTransaction,
    signedTransactionDigest: validated.signedTransactionDigest,
  };
}

function transaction(
  value: Portfolio,
  overrides: Record<string, unknown> = {},
  feeLimit: number | string = 30_000_000,
) {
  const envelope = commitmentEnvelope(value, registry);
  return {
    txID: txid,
    raw_data_hex: rawDataHex,
    signature: ["11".repeat(65)],
    ret: [{ contractRet: "SUCCESS" }],
    raw_data: {
      fee_limit: feeLimit,
      contract: [
        {
          type: "TriggerSmartContract",
          parameter: {
            value: {
              owner_address: submitter,
              contract_address: registry,
              call_value: 0,
              data: expectedCommitData(envelope.digestHex),
              ...overrides,
            },
          },
        },
      ],
    },
  };
}

function receiptInfo(value: Portfolio) {
  const envelope = commitmentEnvelope(value, registry);
  const timestamp = 1_796_000_000n;
  return {
    id: txid,
    blockNumber: 71_000_001,
    blockTimeStamp: Number(timestamp) * 1000,
    receipt: { result: "SUCCESS" },
    log: [
      {
        address: decodeTronAddress(registry).slice(2),
        topics: [
          RECEIPT_EVENT_TOPIC,
          decodeTronAddress(submitter).slice(2).padStart(64, "0"),
          RECEIPT_KIND_HEX.slice(2),
        ],
        data: `${envelope.digestHex.slice(2)}${timestamp.toString(16).padStart(64, "0")}`,
      },
    ],
  };
}

describe("allocation plan commitment", () => {
  it("builds a deterministic canonical receipt bound to snapshot, constraints, allocations and confirmation", () => {
    const value = portfolio();
    const receipt = buildPlanCommitmentReceipt(value);
    expect(receipt.marketSnapshot.fetchedAt).toBe("2026-09-29T00:00:00.000Z");
    expect(receipt.plan.confirmedAt).toBe("2026-09-29T00:02:00.000Z");
    expect(receipt.reserveConstraints.reserveMicros).toBe(80_000e6);
    expect(receipt.allocations.some((item) => item.destination === "justlend")).toBe(true);
    expect(receipt.assumptions.length).toBeGreaterThan(0);
    expect(receipt.expectedRangeMicros.guarantee).toBe(false);
    const first = canonicalJson(receipt);
    const second = canonicalJson(JSON.parse(JSON.stringify(receipt)));
    expect(second).toBe(first);
    expect(commitmentEnvelope(value, registry).digestHex).toBe(
      `0x${createHash("sha256").update(first).digest("hex")}`,
    );
  });

  it("rejects malformed or checksum-invalid TRON addresses", () => {
    expect(decodeTronAddress(submitter)).toBe(`41${"00".repeat(20)}`);
    expect(() => decodeTronAddress(`${submitter.slice(0, -1)}c`)).toThrow(/checksum/i);
    expect(() => decodeTronAddress("0x1234")).toThrow(/format/i);
  });

  it("confirms only after the solidified body, zero-value calldata and event all match", async () => {
    const value = portfolio();
    const result = await verifyNileProof(
      value,
      proof(value),
      async (path) =>
        path.endsWith("gettransactionbyid")
          ? transaction(value)
          : receiptInfo(value),
      "2026-09-29T00:04:00.000Z",
    );
    expect(result.status).toBe("confirmed");
    expect(result.blockNumber).toBe(71_000_001);
    expect(result.chainTimestamp).toBe("2026-11-30T00:53:20.000Z");
  });

  it("keeps a broadcast pending when the transaction is not solidified", async () => {
    const value = portfolio();
    const result = await verifyNileProof(value, proof(value), async () => ({}));
    expect(result.status).toBe("broadcast");
    expect(result.reason).toContain("等待");
  });

  it("shows mismatch instead of accepting different calldata", async () => {
    const value = portfolio();
    const result = await verifyNileProof(
      value,
      proof(value),
      async () => transaction(value, { data: `e3ce094d${"00".repeat(64)}` }),
    );
    expect(result.status).toBe("mismatch");
    expect(result.reason).toContain("calldata");
  });

  it("shows reverted instead of manufacturing a receipt", async () => {
    const value = portfolio();
    const failed = transaction(value);
    failed.ret[0].contractRet = "REVERT";
    const result = await verifyNileProof(
      value,
      proof(value),
      async (path) =>
        path.endsWith("gettransactionbyid")
          ? failed
          : {
              id: txid,
              result: "FAILED",
              blockNumber: 71_000_002,
              blockTimeStamp: 1_796_000_000_000,
              receipt: { result: "REVERT" },
            },
    );
    expect(result.status).toBe("reverted");
  });

  it("requires exact receipt id and safe block coordinates", async () => {
    const value = portfolio();
    for (const info of [
      { ...receiptInfo(value), id: txid.toUpperCase() },
      { ...receiptInfo(value), blockNumber: Number.MAX_SAFE_INTEGER + 1 },
      { ...receiptInfo(value), blockTimeStamp: "1796000000000" },
      { ...receiptInfo(value), blockTimeStamp: Number.MAX_SAFE_INTEGER },
    ]) {
      const result = await verifyNileProof(value, proof(value), async (path) =>
        path.endsWith("gettransactionbyid") ? transaction(value) : info,
      );
      expect(result.status).toBe("mismatch");
    }
  });

  it("requires SUCCESS in transaction ret and receipt result", async () => {
    const value = portfolio();
    for (const [body, info] of [
      [transaction(value), { ...receiptInfo(value), receipt: {} }],
      [
        { ...transaction(value), ret: [{ contractRet: "REVERT" }] },
        receiptInfo(value),
      ],
      [transaction(value), { ...receiptInfo(value), result: "FAILED" }],
    ] as const) {
      const result = await verifyNileProof(value, proof(value), async (path) =>
        path.endsWith("gettransactionbyid") ? body : info,
      );
      expect(result.status).toBe("reverted");
    }
  });

  it("enforces a positive server-side fee limit no greater than 30 TRX", async () => {
    const value = portfolio();
    for (const fee of [0, 30_000_001, "9007199254740993", -1]) {
      const result = await verifyNileProof(
        value,
        proof(value),
        async () => transaction(value, {}, fee),
      );
      expect(result.status).toBe("mismatch");
      expect(result.reason).toContain("fee_limit");
    }
    expect(() =>
      validateSignedCommitTransaction(
        transaction(value, {}, 0),
        commitmentEnvelope(value, registry),
        submitter,
      ),
    ).toThrow(/fee_limit/);
  });

  it("persists and fingerprints the exact signed transaction before broadcast", () => {
    const value = portfolio();
    const envelope = commitmentEnvelope(value, registry);
    const signed = transaction(value);
    const result = validateSignedCommitTransaction(signed, envelope, submitter);
    expect(result.transactionId).toBe(txid);
    expect(result.signedTransaction).toEqual(signed);
    expect(result.signedTransactionDigest).toMatch(/^0x[a-f0-9]{64}$/);
    expect(() =>
      validateSignedCommitTransaction(
        { ...signed, txID: "ab".repeat(32) },
        envelope,
        submitter,
      ),
    ).toThrow(/raw_data_hex/);
  });

  it("broadcasts only the persisted signed transaction", async () => {
    const value = portfolio();
    const saved = proof(value);
    saved.status = "prepared_signed";
    delete saved.broadcastAt;
    let broadcastBody: Record<string, unknown> | null = null;
    const result = await broadcastSavedProof(
      value,
      saved,
      async () => ({}),
      async (_path, body) => {
        broadcastBody = body;
        return { result: true, txid };
      },
      "2026-09-29T00:05:00.000Z",
    );
    expect(result.status).toBe("broadcast");
    expect(result.transactionId).toBe(txid);
    expect(broadcastBody).toEqual(saved.signedTransaction);
    expect(result.signedTransactionDigest).toBe(saved.signedTransactionDigest);
  });

  it("checks the original txID before retry and never rebroadcasts when found", async () => {
    const value = portfolio();
    const saved = proof(value);
    saved.status = "broadcast_unknown";
    let broadcasts = 0;
    const result = await broadcastSavedProof(
      value,
      saved,
      async () => transaction(value),
      async () => {
        broadcasts += 1;
        return { result: true };
      },
    );
    expect(result.status).toBe("broadcast");
    expect(broadcasts).toBe(0);
    expect(result.reason).toContain("未重复广播");
  });

  it("resolves a broadcast timeout by querying the same txID", async () => {
    const value = portfolio();
    const saved = proof(value);
    saved.status = "prepared_signed";
    let lookups = 0;
    const result = await broadcastSavedProof(
      value,
      saved,
      async () => (++lookups === 1 ? {} : transaction(value)),
      async () => {
        throw new Error("timeout");
      },
    );
    expect(result.status).toBe("broadcast");
    expect(lookups).toBe(2);
    expect(result.transactionId).toBe(txid);
  });

  it("checks the original txID after a negative broadcast response", async () => {
    const value = portfolio();
    const saved = proof(value);
    saved.status = "prepared_signed";
    let lookups = 0;
    const result = await broadcastSavedProof(
      value,
      saved,
      async () => (++lookups === 1 ? {} : transaction(value)),
      async () => ({ result: false, code: "SERVER_BUSY" }),
    );
    expect(result.status).toBe("broadcast");
    expect(lookups).toBe(2);
    expect(result.transactionId).toBe(txid);
  });

  it("never broadcasts a corrupted persisted signed transaction", async () => {
    const value = portfolio();
    const saved = proof(value);
    saved.signedTransaction = {
      ...saved.signedTransaction,
      raw_data_hex: "0a01",
    };
    let lookups = 0;
    let broadcasts = 0;
    const result = await broadcastSavedProof(
      value,
      saved,
      async () => {
        lookups += 1;
        return {};
      },
      async () => {
        broadcasts += 1;
        return { result: true };
      },
    );
    expect(result.status).toBe("mismatch");
    expect(result.reason).toContain("完整性");
    expect(lookups).toBe(0);
    expect(broadcasts).toBe(0);
  });

  it("keeps broadcast_unknown and the same signed bytes when lookup is unavailable", async () => {
    const value = portfolio();
    const saved = proof(value);
    saved.status = "broadcast_unknown";
    let broadcasts = 0;
    const result = await broadcastSavedProof(
      value,
      saved,
      async () => {
        throw new Error("rpc unavailable");
      },
      async () => {
        broadcasts += 1;
        return { result: true };
      },
    );
    expect(result.status).toBe("broadcast_unknown");
    expect(result.transactionId).toBe(saved.transactionId);
    expect(result.signedTransaction).toEqual(saved.signedTransaction);
    expect(broadcasts).toBe(0);
  });
});

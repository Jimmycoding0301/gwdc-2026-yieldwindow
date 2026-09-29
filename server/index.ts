import express from "express";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  applySimulation,
  buildPlans,
  initialActions,
  parseIntake,
  profileFields,
  profileSchema,
  reviewPortfolio,
} from "../shared/planner.js";
import type { Plan, Portfolio, Snapshot } from "../shared/types.js";
import { loadMarket } from "./market.js";
import {
  extractIntakeScreenshot,
  IntakeOcrExtractionError,
} from "./intake-ocr.js";
import { reviewStressScenarios } from "../shared/workflows.js";
import {
  broadcastSavedProof,
  commitmentEnvelope,
  configuredRegistryAddress,
  decodeTronAddress,
  validateSignedCommitTransaction,
  verifyNileProof,
} from "./proof.js";
import { RECEIPT_KIND_HEX } from "../shared/proof.js";
import type { PlanChainProof } from "../shared/proof.js";

const app = express();
const directory = fileURLToPath(new URL("../.data/", import.meta.url));
const statePath = `${directory}/state.json`;
let portfolios: Portfolio[] = [];
let snapshots = new Map<string, Snapshot>();
const drafts = new Map<string, Plan>();
await mkdir(directory, { recursive: true });
try {
  const state = JSON.parse(await readFile(statePath, "utf8"));
  if (Array.isArray(state.portfolios)) portfolios = state.portfolios;
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT")
    throw new Error(
      "YieldWindow state could not be read. Preserve .data and inspect it before restarting.",
    );
}
let persistence = Promise.resolve();
const persist = () => {
  const json = JSON.stringify({ portfolios }, null, 2);
  persistence = persistence.then(async () => {
    await writeFile(`${statePath}.tmp`, json, { mode: 0o600 });
    await rename(`${statePath}.tmp`, statePath);
  });
  return persistence;
};
app.disable("x-powered-by");
app.use((req, res, next) => {
  if (
    !/^(localhost|127\.0\.0\.1):(8790|5176)$/.test(req.get("host") || "") ||
    (req.get("origin") &&
      !/^http:\/\/(localhost|127\.0\.0\.1):(5176|8790)$/.test(
        req.get("origin")!,
      ))
  )
    return res.status(403).json({ error: "仅支持本机访问。" });
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.post(
  "/api/intake/extract",
  express.json({ limit: "1500kb" }),
  async (req, res) => {
    try {
      res.json(
        await extractIntakeScreenshot(req.body, {
          protectedValues: Object.entries(process.env)
            .filter(([name]) => /KEY|SECRET|TOKEN|PASSWORD|PRIVATE/i.test(name))
            .flatMap(([, value]) => (value ? [value] : [])),
        }),
      );
    } catch (error) {
      if (error instanceof IntakeOcrExtractionError)
        return res
          .status(error.status)
          .json({ error: error.message, code: error.code });
      res.status(422).json({ error: "本机无法识别这张截图，请手动填写需求。" });
    }
  },
);
app.use(express.json({ limit: "100kb" }));
app.get("/api/health", (_req, res) =>
  {
    let registryAddress: string | null = null;
    let proofConfigurationError: string | null = null;
    try {
      registryAddress = configuredRegistryAddress();
    } catch {
      proofConfigurationError = "NILE_RECEIPT_REGISTRY_ADDRESS 格式无效。";
    }
    res.json({
    name: "YieldWindow",
    execution: "simulation",
    aiConfigured: Boolean(process.env.KILN_API_KEY),
    model: process.env.KILN_MODEL || "qwen3-32b",
    network: "TRON mainnet read-only + Nile audit receipt",
    nileProof: {
      configured: Boolean(registryAddress),
      registryAddress,
      error: proofConfigurationError,
    },
  });
  },
);
app.get("/api/markets", async (_req, res) => {
  const snapshot = await loadMarket();
  snapshots.set(snapshot.id, snapshot);
  if (snapshots.size > 40) snapshots.delete(snapshots.keys().next().value!);
  res.json(snapshot);
});
app.post("/api/intake", async (req, res) => {
  const input = z
    .object({
      message: z.string().min(1).max(1500),
      draft: z.record(z.string(), z.unknown()).optional(),
    })
    .strict()
    .parse(req.body);
  const draft = profileFields.partial().safeParse(input.draft || {});
  if (!draft.success)
    return res.status(400).json({ error: "需求草稿格式无效，请重新填写。" });
  const result = parseIntake(input.message, draft.data);
  if (process.env.KILN_API_KEY && result.missing.length > 0) {
    try {
      const base = new URL(
        process.env.KILN_BASE_URL || "https://api.bricksum.com/v1",
      );
      if (
        base.protocol !== "https:" ||
        base.username ||
        base.password ||
        base.search ||
        base.hash
      )
        throw new Error("Unsupported AI URL.");
      const maxTokens = Number(process.env.KILN_MAX_TOKENS || 4096);
      const response = await fetch(
        `${base.toString().replace(/\/$/, "")}/chat/completions`,
        {
          method: "POST",
          signal: AbortSignal.timeout(45_000),
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.KILN_API_KEY}`,
          },
          body: JSON.stringify({
            model: process.env.KILN_MODEL || "qwen3-32b",
            temperature: 0.1,
            max_tokens:
              Number.isInteger(maxTokens) &&
              maxTokens >= 256 &&
              maxTokens <= 8192
                ? maxTokens
                : 4096,
            stream: false,
            messages: [
              {
                role: "system",
                content:
                  "你是跨境电商周结算需求采集助手。只用一句简短中文重述 nextQuestion。不要重复已知值或任何数字，不要总结上下文。不得生成投资建议、收益率、交易或额外字段。",
              },
              {
                role: "user",
                content: JSON.stringify({
                  nextQuestion: result.question,
                  confirmedFieldNames: Object.keys(result.draft),
                }),
              },
            ],
          }),
        },
      );
      const body = await response.json();
      const text = body.choices?.[0]?.message?.content;
      if (
        !response.ok ||
        typeof text !== "string" ||
        !text.trim() ||
        text.length > 1500
      )
        throw new Error("AI unavailable.");
      // Numerical parsing and required next step remain authoritative deterministic values.
      result.question = `${text.trim()}\n\n${result.question}`;
      result.modelMode = "kiln";
      if (
        Number.isSafeInteger(body.usage?.prompt_tokens) &&
        Number.isSafeInteger(body.usage?.completion_tokens)
      )
        result.usage = {
          inputTokens: body.usage.prompt_tokens,
          outputTokens: body.usage.completion_tokens,
        };
    } catch {
      result.warning =
        "本次 AI 未返回可用结果，继续本地明确追问；不伪装模型调用成功。";
    }
  }
  res.json(result);
});
app.post("/api/plans", (req, res) => {
  const input = z
    .object({
      profile: profileSchema,
      snapshotId: z.string(),
      confirmed: z.literal(true),
    })
    .strict()
    .parse(req.body);
  const snapshot = snapshots.get(input.snapshotId);
  if (!snapshot || Date.now() - Date.parse(snapshot.fetchedAt) > 15 * 60_000)
    return res
      .status(409)
      .json({ error: "市场快照已过期，请刷新后重新确认。" });
  const plans = buildPlans(input.profile, snapshot);
  plans.forEach((plan) => drafts.set(plan.id, plan));
  while (drafts.size > 100) drafts.delete(drafts.keys().next().value!);
  res.json({ plans });
});
app.get("/api/portfolios", (_req, res) => res.json({ portfolios }));

function portfolioById(id: string) {
  return portfolios.find((item) => item.plan.id === id);
}

function proofEnvelopeFor(portfolio: Portfolio) {
  const registryAddress = configuredRegistryAddress();
  if (!registryAddress) return null;
  return commitmentEnvelope(portfolio, registryAddress);
}

app.get("/api/portfolios/:id/commitment", (req, res) => {
  const portfolio = portfolioById(req.params.id);
  if (!portfolio) return res.status(404).json({ error: "找不到已确认计划。" });
  const envelope = proofEnvelopeFor(portfolio);
  if (!envelope)
    return res.status(503).json({
      error:
        "Nile 收据合约尚未配置。部署 ReceiptRegistry 后填写 NILE_RECEIPT_REGISTRY_ADDRESS。",
      code: "NILE_REGISTRY_NOT_CONFIGURED",
    });
  res.json({ envelope, proof: portfolio.chainProof || null });
});

app.post("/api/portfolios/:id/commitment/prepare-signed", async (req, res) => {
  const input = z
    .object({
      submitter: z.string().min(34).max(34),
      signedTransaction: z.record(z.string(), z.unknown()),
    })
    .strict()
    .parse(req.body);
  const portfolio = portfolioById(req.params.id);
  if (!portfolio) return res.status(404).json({ error: "找不到已确认计划。" });
  const envelope = proofEnvelopeFor(portfolio);
  if (!envelope)
    return res.status(503).json({ error: "Nile 收据合约尚未配置。" });
  try {
    decodeTronAddress(input.submitter);
  } catch {
    return res.status(400).json({ error: "TronLink 返回的地址无效。" });
  }
  let validated: ReturnType<typeof validateSignedCommitTransaction>;
  try {
    validated = validateSignedCommitTransaction(
      input.signedTransaction,
      envelope,
      input.submitter,
    );
  } catch (error) {
    return res.status(400).json({
      error:
        error instanceof Error
          ? error.message
          : "签名交易无法通过服务端校验。",
    });
  }
  if (portfolio.chainProof)
    if (
      portfolio.chainProof.transactionId !== validated.transactionId ||
      portfolio.chainProof.signedTransactionDigest !==
        validated.signedTransactionDigest
    )
      return res.status(409).json({
        error:
          "这个冻结计划已绑定另一份签名字节，不允许重建或覆盖。",
      });
    else
      return res.json({
        envelope,
        proof: portfolio.chainProof,
        portfolio,
      });

  const preparedAt = new Date().toISOString();
  const proof: PlanChainProof = {
    network: "nile",
    registryAddress: envelope.registryAddress,
    kindHex: RECEIPT_KIND_HEX,
    digestHex: envelope.digestHex,
    transactionId: validated.transactionId,
    submitter: input.submitter,
    preparedAt,
    status: "prepared_signed",
    explorerUrl: `${envelope.explorerBaseUrl}${validated.transactionId}`,
    reason:
      "已在广播前保存 txID 与完整签名交易；尚未声称链上存在。",
    signedTransaction: validated.signedTransaction,
    signedTransactionDigest: validated.signedTransactionDigest,
  };
  portfolio.chainProof = proof;
  portfolio.logs.push({
    id: randomUUID(),
    at: preparedAt,
    title: "已保存原始签名交易",
    detail: `${proof.transactionId} · 尚未确认广播；后续只能查询或重播这一份签名字节。`,
    mode: "on-chain",
  });
  await persist();
  res.status(201).json({ envelope, proof, portfolio });
});

app.post("/api/portfolios/:id/commitment/broadcast", async (req, res) => {
  z.object({}).strict().parse(req.body);
  const portfolio = portfolioById(req.params.id);
  if (!portfolio) return res.status(404).json({ error: "找不到已确认计划。" });
  const envelope = proofEnvelopeFor(portfolio);
  if (!envelope)
    return res.status(503).json({ error: "Nile 收据合约尚未配置。" });
  if (
    !portfolio.chainProof?.signedTransaction ||
    !portfolio.chainProof.signedTransactionDigest
  )
    return res.status(409).json({
      error:
        "必须先安全保存 TronLink 返回的完整签名交易。",
    });
  const previous = portfolio.chainProof.status;
  let proof = portfolio.chainProof;
  try {
    proof = await broadcastSavedProof(portfolio, proof);
  } catch {
    proof = {
      ...proof,
      status: "broadcast_unknown",
      verifiedAt: new Date().toISOString(),
      reason:
        "广播结果未知；原 txID 和同一份签名字节已保留。",
    };
  }
  portfolio.chainProof = proof;
  if (previous !== proof.status)
    portfolio.logs.push({
      id: randomUUID(),
      at: proof.verifiedAt || new Date().toISOString(),
      title:
        proof.status === "broadcast"
          ? "已找到或广播原签名交易"
          : proof.status === "mismatch"
            ? "签名交易核验不一致"
            : "广播结果待确认",
      detail: proof.reason || "状态已更新。",
      mode: "on-chain",
    });
  await persist();
  res.json({ envelope, proof, portfolio });
});

app.post("/api/portfolios/:id/commitment/verify", async (req, res) => {
  const portfolio = portfolioById(req.params.id);
  if (!portfolio) return res.status(404).json({ error: "找不到已确认计划。" });
  if (!portfolio.chainProof)
    return res.status(409).json({ error: "还没有已广播的计划承诺。" });
  const previous = portfolio.chainProof.status;
  try {
    portfolio.chainProof = await verifyNileProof(portfolio, portfolio.chainProof);
  } catch {
    return res.status(502).json({
      error: "Nile 节点暂时无法核验。已保留原交易哈希，没有生成替代结果。",
    });
  }
  if (previous !== portfolio.chainProof.status)
    portfolio.logs.push({
      id: randomUUID(),
      at: portfolio.chainProof.verifiedAt || new Date().toISOString(),
      title:
        portfolio.chainProof.status === "confirmed"
          ? "Nile 收据已固化"
          : portfolio.chainProof.status === "reverted"
            ? "Nile 交易执行失败"
            : "Nile 收据校验不一致",
      detail: portfolio.chainProof.reason || "状态已由 Nile RPC 独立核验。",
      mode: "on-chain",
    });
  await persist();
  res.json({
    envelope: proofEnvelopeFor(portfolio),
    proof: portfolio.chainProof,
    portfolio,
  });
});
app.post("/api/plans/:id/confirm", async (req, res) => {
  z.object({ acknowledged: z.literal(true) })
    .strict()
    .parse(req.body);
  const plan = drafts.get(req.params.id);
  if (!plan)
    return res
      .status(404)
      .json({ error: "计划不存在或服务已重启，请重新生成并确认。" });
  if (Date.now() - Date.parse(plan.snapshot.fetchedAt) > 15 * 60_000)
    return res.status(409).json({ error: "计划数据已过期，请重新生成。" });
  if (portfolios.some((p) => p.plan.id === plan.id))
    return res
      .status(409)
      .json({ error: "该计划已经确认，不重复创建执行步骤。" });
  const now = new Date().toISOString();
  const portfolio: Portfolio = {
    plan: structuredClone(plan),
    confirmedAt: now,
    actions: initialActions(plan),
    positions: { USDT: 0, USDD: 0 },
    logs: [
      {
        id: randomUUID(),
        at: now,
        title: "用户确认原计划",
        detail:
          "保存原始需求、费率、来源与收益假设；仅生成演示操作清单，尚无付款或链上操作。",
        mode: "simulation",
      },
    ],
  };
  portfolios.unshift(portfolio);
  await persist();
  res.status(201).json(portfolio);
});
app.post("/api/portfolios/:id/actions/:action/simulate", async (req, res) => {
  z.object({ acknowledged: z.literal(true) })
    .strict()
    .parse(req.body);
  const index = portfolios.findIndex((p) => p.plan.id === req.params.id);
  if (index < 0) return res.status(404).json({ error: "找不到已确认计划。" });
  try {
    const result = applySimulation(portfolios[index], req.params.action);
    portfolios[index] = result;
    await persist();
    res.json(result);
  } catch {
    res.status(409).json({
      error: "动作不满足执行条件：请检查已授权、剩余余额及是否重复执行。",
    });
  }
});
app.post("/api/portfolios/:id/withdraw", async (req, res) => {
  const input = z
    .object({
      asset: z.enum(["USDT", "USDD"]),
      amountMicros: z.number().int().safe().positive(),
      acknowledged: z.literal(true),
    })
    .strict()
    .parse(req.body);
  const portfolio = portfolios.find((p) => p.plan.id === req.params.id);
  if (!portfolio) return res.status(404).json({ error: "找不到已确认计划。" });
  const reserved = portfolio.actions
    .filter(
      (a) =>
        a.kind === "withdraw" &&
        a.asset === input.asset &&
        a.status === "ready",
    )
    .reduce((sum, a) => sum + a.amountMicros, 0);
  if (input.amountMicros + reserved > portfolio.positions[input.asset])
    return res
      .status(409)
      .json({ error: "当前模拟持仓不足，或已有待处理赎回。" });
  portfolio.actions.push({
    id: randomUUID(),
    planId: portfolio.plan.id,
    kind: "withdraw",
    asset: input.asset,
    amountMicros: input.amountMicros,
    spender: portfolio.plan.snapshot.markets[input.asset].address,
    feeMicros: portfolio.plan.profile.perActionCostMicros,
    status: "ready",
    createdAt: new Date().toISOString(),
  });
  portfolio.logs.push({
    id: randomUUID(),
    at: new Date().toISOString(),
    title: "确认赎回演示意图",
    detail: "仅生成待处理步骤；协议仓位仍未改变。",
    mode: "simulation",
  });
  await persist();
  res.json(portfolio);
});
app.post("/api/portfolios/:id/stress", async (req, res) => {
  const input = z
    .object({ days: z.number().int().min(1).max(90) })
    .strict()
    .parse(req.body);
  const portfolio = portfolios.find((p) => p.plan.id === req.params.id);
  if (!portfolio) return res.status(404).json({ error: "找不到已确认计划。" });
  if (input.days > portfolio.plan.profile.horizonDays)
    return res.status(400).json({ error: "复盘期限不能超过原计划。" });
  const frozen = structuredClone(portfolio);
  const fingerprint = JSON.stringify([portfolio.positions, portfolio.actions]);
  const latest = await loadMarket();
  if (
    portfolios.find((p) => p.plan.id === req.params.id) !== portfolio ||
    JSON.stringify([portfolio.positions, portfolio.actions]) !== fingerprint
  )
    return res
      .status(409)
      .json({ error: "模拟持仓在读取数据期间发生变化，请重新运行压力情景。" });
  const reviews = reviewStressScenarios(frozen, latest, input.days);
  portfolio.reviews = [
    ...(portfolio.reviews || []),
    ...reviews.map((result) => ({ at: result.at, result, snapshot: latest })),
  ].slice(-50);
  await persist();
  res.json({ reviews, latest, portfolio });
});
app.post("/api/portfolios/:id/review", async (req, res) => {
  const input = z
    .object({
      days: z.number().int().min(1).max(90),
      scenario: z.enum(["current", "incentive-end", "rate-drop", "depeg"]),
    })
    .strict()
    .parse(req.body);
  const portfolio = portfolios.find((p) => p.plan.id === req.params.id);
  if (!portfolio) return res.status(404).json({ error: "找不到已确认计划。" });
  const latest = await loadMarket();
  try {
    const review = reviewPortfolio(
      portfolio,
      latest,
      input.days,
      input.scenario,
    );
    portfolio.reviews = [
      ...(portfolio.reviews || []),
      { at: new Date().toISOString(), result: review, snapshot: latest },
    ].slice(-50);
    await persist();
    res.json({ review, latest, portfolio });
  } catch {
    res.status(400).json({ error: "复盘参数超出原计划范围。" });
  }
});
app.use(
  (
    error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    if ((error as { type?: string }).type === "entity.too.large")
      return res
        .status(413)
        .json({ error: "图片须不超过 1 MiB，请裁剪后重试。" });
    if (error instanceof SyntaxError)
      return res.status(400).json({ error: "请求格式无效，请重新提交。" });
    if (error instanceof z.ZodError)
      return res.status(400).json({
        error: "请完整确认金额、期限、流动性、风险与费用。",
        issues: error.issues.map((i) => i.message),
      });
    res
      .status(500)
      .json({ error: "本地服务暂时无法完成操作，没有发送链上交易。" });
  },
);
app.listen(8790, "127.0.0.1", () =>
  console.log(
    "YieldWindow API http://127.0.0.1:8790 — read-only markets / simulated funds / optional Nile receipt",
  ),
);

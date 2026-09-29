import { micros } from "./planner";
import type { Profile } from "./types";
export type IntakeOcrKey =
  | "usdtMicros"
  | "usddMicros"
  | "horizonDays"
  | "sellerSettlementMicros"
  | "bufferMicros"
  | "reserveMicros"
  | "reserveInDays";
export interface RecognizedLine {
  text: string;
  confidence?: number;
}
export interface IntakeOcrCandidate {
  id: string;
  key: IntakeOcrKey;
  label: string;
  value: number;
  displayValue: string;
  confidence: "high" | "medium" | "low";
  conflict: boolean;
  evidence: string;
}
export interface IntakeOcrExtraction {
  source: "local-ocr";
  candidates: IntakeOcrCandidate[];
  warnings: string[];
}
export const OCR_LABELS: Record<IntakeOcrKey, string> = {
  usdtMicros: "USDT 持仓",
  usddMicros: "USDD 持仓",
  horizonDays: "规划期限",
  sellerSettlementMicros: "周五卖家款",
  bufferMicros: "退款 / 物流缓冲",
  reserveMicros: "结算准备金 USDT",
  reserveInDays: "距结算日",
};
const sensitive =
  /api[\s_-]*key|secret|private[\s_-]*key|bearer|password|密码|私钥|密钥|seed[\s_-]*phrase|助记词|sk[-_][a-z0-9_-]{8,}|[a-z0-9_+/=-]{32,}|https?:\/\//iu;
const amountPattern = "([0-9]+(?:,[0-9]{3})*(?:\\.[0-9]+)?)";
function amount(text: string): number | undefined {
  if (text.includes(",") && !/^\d{1,3}(?:,\d{3})+(?:\.\d{1,6})?$/.test(text))
    return;
  return micros(text.replaceAll(",", ""));
}
/** Recognized text is untrusted data, never instructions; only numeric allowlisted candidates leave this parser. */
export function parseIntakeOcrText(
  input: readonly RecognizedLine[] | string,
  protectedValues: readonly string[] = [],
): IntakeOcrExtraction {
  const raw: readonly RecognizedLine[] =
    typeof input === "string"
      ? input.split(/\r?\n/).map((text) => ({ text }))
      : input;
  if (!Array.isArray(raw) || raw.length > 256)
    throw new Error("Invalid OCR result.");
  const lines = raw.map((line) => {
    if (
      !line ||
      typeof line.text !== "string" ||
      line.text.length > 2000 ||
      (line.confidence !== undefined &&
        (!Number.isFinite(line.confidence) ||
          line.confidence < 0 ||
          line.confidence > 1))
    )
      throw new Error("Invalid OCR result.");
    return {
      text: line.text
        .normalize("NFKC")
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
        .trim(),
      confidence: line.confidence,
    };
  });
  if (lines.reduce((n, line) => n + line.text.length, 0) > 24000)
    throw new Error("Invalid OCR result.");
  const result: IntakeOcrExtraction = {
    source: "local-ocr",
    candidates: [],
    warnings: [],
  };
  const excluded = new Set<number>();
  lines.forEach((line, index) => {
    if (
      sensitive.test(line.text) ||
      protectedValues.some(
        (value) =>
          value &&
          line.text.replace(/\s/g, "").includes(value.replace(/\s/g, "")),
      )
    ) {
      excluded.add(index);
      if (/[:：=]\s*$/.test(line.text)) excluded.add(index + 1);
    }
  });
  if (excluded.size)
    result.warnings.push(
      "已忽略疑似凭据的文字；只返回金额和期限候选，不返回整段识别原文。",
    );
  function candidate(
    key: IntakeOcrKey,
    value: number | undefined,
    evidence: string,
    confidence?: number,
  ) {
    if (
      value === undefined ||
      !Number.isSafeInteger(value) ||
      (key.endsWith("Days") && (value < 1 || value > 90))
    ) {
      result.warnings.push(
        `${OCR_LABELS[key]}格式或范围不明确，请手动填写；不会四舍五入或放宽期限。`,
      );
      return;
    }
    const existing = result.candidates.find(
      (item) => item.key === key && item.value === value,
    );
    if (existing) return;
    result.candidates.push({
      id: `${key}-${result.candidates.length}`,
      key,
      label: OCR_LABELS[key],
      value,
      displayValue: key.endsWith("Days")
        ? `${value} 天`
        : `${value / 1e6} ${key === "usddMicros" ? "USDD" : "USDT"}`,
      evidence: evidence.slice(0, 180),
      confidence:
        confidence === undefined
          ? "medium"
          : confidence >= 0.9
            ? "high"
            : confidence >= 0.6
              ? "medium"
              : "low",
      conflict: false,
    });
  }
  lines.forEach((line, index) => {
    if (!line.text || excluded.has(index)) return;
    let text = line.text,
      confidence = line.confidence;
    // Wallet/table labels on a line of their own may be paired only with one adjacent numeric line.
    if (
      /^(USDT|USDD)\s*(?:余额|持仓|balance)?\s*[:：]?$/i.test(text) &&
      lines[index + 1] &&
      !excluded.has(index + 1) &&
      new RegExp(`^${amountPattern}$`).test(lines[index + 1].text)
    ) {
      text += ` ${lines[index + 1].text}`;
      confidence = Math.min(
        confidence ?? 0.7,
        lines[index + 1].confidence ?? 0.7,
      );
    }
    const reserveLine = /预留|用款|需要|reserve|need|payment|due/iu.test(text);
    const horizon =
      /(?:规划(?:期限)?|期限|持有|horizon|duration)\s*[:：]?\s*(\d+)\s*(?:天|days?)/iu;
    const horizonMatch = horizon.exec(text);
    if (horizonMatch)
      candidate("horizonDays", Number(horizonMatch[1]), text, confidence);
    const seller = new RegExp(
      `(?:卖家款|卖家结算|seller\\s+payment)\\s*[:：]?\\s*${amountPattern}\\s*USDT`,
      "iu",
    ).exec(text);
    if (seller) {
      candidate("sellerSettlementMicros", amount(seller[1]), text, confidence);
      return;
    }
    const buffer = new RegExp(
      `(?:退款(?:\\s*[/+]\\s*物流)?缓冲|退款和物流缓冲|物流缓冲|refund(?:\\s*[/+]\\s*logistics)?\\s+buffer)\\s*[:：]?\\s*${amountPattern}\\s*USDT`,
      "iu",
    ).exec(text);
    if (buffer) {
      candidate("bufferMicros", amount(buffer[1]), text, confidence);
      return;
    }
    if (reserveLine) {
      const days =
        /(\d+)\s*(?:天后|days?\s*(?:later|from now))|(?:用款日|用款时间|几天后用款|reserve in|due in|need in)\s*[:：]?\s*(\d+)\s*(?:天|days?)/iu.exec(
          text,
        );
      if (days)
        candidate(
          "reserveInDays",
          Number(days[1] || days[2]),
          text,
          confidence,
        );
      const money = new RegExp(
        `(?:\\bUSDT\\s*[:：]?\\s*${amountPattern}|${amountPattern}\\s*USDT\\b)`,
        "iu",
      ).exec(text);
      if (money && !/USDD|USDC|USD(?!T)/i.test(text))
        candidate(
          "reserveMicros",
          amount(money[1] || money[2]),
          text,
          confidence,
        );
      else if (/\d/.test(text) && !days)
        result.warnings.push("用款金额须明确标注 USDT；未知币种不转换。");
      if (/\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}/u.test(text))
        result.warnings.push(
          "截图含绝对日期；没有明确基准日期及时区，不换算成“几天后”。",
        );
      return;
    }
    for (const asset of ["USDT", "USDD"] as const) {
      // Keep holdings distinct from yields, quotes and pending transfers.
      if (
        /收益|年化|apy|apr|price|价格|转账|transfer|手续费|fee|充值地址|address/iu.test(
          text,
        )
      )
        continue;
      const pattern = new RegExp(
        `^(?:余额|持仓|balance|holdings)?\\s*[:：]?\\s*(?:${asset}\\s*(?:余额|持仓|balance)?\\s*[:：]?\\s*${amountPattern}|${amountPattern}\\s*${asset})\\s*$`,
        "iu",
      );
      const match = pattern.exec(text);
      if (match)
        candidate(
          asset === "USDT" ? "usdtMicros" : "usddMicros",
          amount(match[1] || match[2]),
          text,
          confidence,
        );
    }
  });
  for (const key of Object.keys(OCR_LABELS) as IntakeOcrKey[]) {
    const sameKey = result.candidates.filter((item) => item.key === key);
    if (sameKey.length > 1) {
      sameKey.forEach((item) => {
        item.conflict = true;
      });
      result.warnings.push(
        `${OCR_LABELS[key]}出现冲突数值，不选取任何一个；请核对截图后手动填写。`,
      );
    }
  }
  if (result.candidates.some((item) => item.confidence === "low"))
    result.warnings.push("低置信字段不可一键填入，请在摘要中手动确认。");
  if (!result.candidates.length)
    result.warnings.push(
      "未找到明确的持仓或期限字段，请换清晰截图或手动输入。",
    );
  result.warnings = [...new Set(result.warnings)];
  return result;
}
export function applyOcrCandidates(
  current: Partial<Profile>,
  result: IntakeOcrExtraction,
  ids: readonly string[],
): Partial<Profile> {
  const next = { ...current };
  const used = new Set<string>();
  for (const id of ids) {
    const item = result.candidates.find((candidate) => candidate.id === id);
    if (
      !item ||
      item.confidence === "low" ||
      item.conflict ||
      used.has(item.key)
    )
      throw new Error("截图候选未满足逐字段确认条件。");
    used.add(item.key);
    if (
      !Object.hasOwn(OCR_LABELS, item.key) ||
      !Number.isSafeInteger(item.value) ||
      item.value < (item.key.endsWith("Days") ? 1 : 0) ||
      item.value > (item.key.endsWith("Days") ? 90 : 100_000_000_000)
    )
      throw new Error("截图候选超出支持范围。");
    next[item.key] = item.value;
  }
  if (
    next.sellerSettlementMicros !== undefined &&
    next.bufferMicros !== undefined
  )
    next.reserveMicros = next.sellerSettlementMicros + next.bufferMicros;
  return next;
}

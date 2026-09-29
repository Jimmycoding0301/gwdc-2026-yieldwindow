import { useMemo, useState } from "react";
import { Check, Copy, FileText } from "lucide-react";
import type { Plan } from "../shared/types";
import { attemptSummaryCopy, managerSummary } from "../shared/workflows";

export default function ManagerSummary({ plans }: { plans: Plan[] }) {
  const text = useMemo(() => managerSummary(plans), [plans]);
  const [expanded, setExpanded] = useState(false);
  const [status, setStatus] = useState("");
  const [failed, setFailed] = useState(false);

  async function copy() {
    const result = await attemptSummaryCopy(
      text,
      typeof navigator !== "undefined" && navigator.clipboard
        ? (value) => navigator.clipboard.writeText(value)
        : undefined,
    );
    setFailed(!result.copied);
    setStatus(result.message);
    if (!result.copied) setExpanded(true);
  }

  return (
    <section className="manager-summary">
      <div>
        <span className="eyebrow">READY TO SHARE</span>
        <h3>给负责人看。</h3>
        <p>准备金、两套计划、数据时间、模拟边界。</p>
      </div>
      <div className="summary-actions">
        <button className="primary" onClick={copy}>
          {status && !failed ? <Check size={15} /> : <Copy size={15} />}
          复制摘要
        </button>
        <button className="text-button" onClick={() => setExpanded(!expanded)}>
          <FileText size={14} />
          {expanded ? "收起" : "预览"}
        </button>
      </div>
      {status ? (
        <p
          className={failed ? "inline-error wide" : "copy-status wide"}
          role={failed ? "alert" : "status"}
        >
          {status}
        </p>
      ) : null}
      {expanded ? (
        <textarea
          className="summary-preview"
          aria-label="给负责人的计划摘要"
          value={text}
          readOnly
          rows={13}
          onFocus={(event) => event.currentTarget.select()}
        />
      ) : null}
    </section>
  );
}

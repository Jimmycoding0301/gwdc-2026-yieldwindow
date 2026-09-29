import { useEffect, useRef, useState } from "react";
import {
  Check,
  ImagePlus,
  LoaderCircle,
  ScanLine,
  ShieldCheck,
  Upload,
  X,
} from "lucide-react";
import { applyOcrCandidates } from "../shared/intake-ocr";
import type { IntakeOcrExtraction } from "../shared/intake-ocr";
import type { Profile } from "../shared/types";
import { money } from "../shared/planner";
export default function IntakeScreenshot({
  draft,
  onApply,
  disabled,
}: {
  draft: Partial<Profile>;
  onApply: (draft: Partial<Profile>) => void;
  disabled: boolean;
}) {
  const [image, setImage] = useState<{ name: string; url: string } | null>(
    null,
  );
  const [result, setResult] = useState<IntakeOcrExtraction | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const readerRef = useRef<FileReader | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);
  const version = useRef(0);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  useEffect(() => {
    setSelected([]);
  }, [draft]);
  useEffect(
    () => () => {
      version.current++;
      request.current?.abort();
      readerRef.current?.abort();
    },
    [],
  );
  async function choose(files: File[]) {
    if (disabledRef.current || busy) return;
    version.current++;
    request.current?.abort();
    readerRef.current?.abort();
    setImage(null);
    setResult(null);
    setSelected([]);
    setStatus("");
    setError("");
    if (
      files.length !== 1 ||
      !["image/png", "image/jpeg"].includes(files[0]?.type)
    ) {
      setError("请选择一张 PNG 或 JPEG 截图。");
      return;
    }
    const file = files[0];
    if (!file.size || file.size > 1_048_576) {
      setError("截图须不超过 1 MiB，请裁剪后重试。");
      return;
    }
    const current = ++version.current;
    request.current?.abort();
    setResult(null);
    setSelected([]);
    setStatus("");
    try {
      const url = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        readerRef.current = reader;
        reader.onabort = reject;
        reader.onload = () =>
          typeof reader.result === "string" ? resolve(reader.result) : reject();
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const size = await new Promise<{ w: number; h: number }>(
        (resolve, reject) => {
          const preview = new Image();
          preview.onload = () =>
            resolve({ w: preview.naturalWidth, h: preview.naturalHeight });
          preview.onerror = reject;
          preview.src = url;
        },
      );
      if (size.w > 8192 || size.h > 8192 || size.w * size.h > 12_000_000)
        throw new Error("图片像素过大，请裁剪后重试。");
      if (current === version.current) {
        setImage({ name: file.name || "粘贴的截图", url });
        setStatus("预览已就绪，点击识别才会发送到本机 OCR。");
      }
    } catch {
      if (current === version.current)
        setError("图片无法读取或像素过大，请换成清晰的 PNG / JPEG 截图。");
    } finally {
      if (current === version.current) readerRef.current = null;
    }
  }
  const chooseRef = useRef(choose);
  chooseRef.current = choose;
  useEffect(() => {
    const paste = (event: ClipboardEvent) => {
      if (event.defaultPrevented || disabledRef.current) return;
      const files = Array.from(event.clipboardData?.items || [])
        .filter(
          (item) => item.kind === "file" && item.type.startsWith("image/"),
        )
        .flatMap((item) => {
          const file = item.getAsFile();
          return file ? [file] : [];
        });
      if (files.length) {
        event.preventDefault();
        void chooseRef.current(files);
      }
    };
    window.addEventListener("paste", paste);
    return () => window.removeEventListener("paste", paste);
  }, []);
  async function recognize() {
    if (!image || disabled || busy) return;
    const controller = new AbortController();
    request.current = controller;
    const current = ++version.current;
    setBusy(true);
    setError("");
    setStatus("正在本机识别，表单仍保持原样。");
    const timeout = setTimeout(() => controller.abort(), 40_000);
    try {
      const response = await fetch("/api/intake/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageDataUrl: image.url }),
        signal: controller.signal,
      });
      const value = await response.json();
      if (!response.ok)
        throw new Error(
          typeof value.error === "string"
            ? value.error
            : "本机 OCR 未返回可用结果。",
        );
      if (
        value.source !== "local-ocr" ||
        !Array.isArray(value.candidates) ||
        !Array.isArray(value.warnings)
      )
        throw new Error("本机 OCR 结果格式无效。");
      if (current === version.current) {
        setResult(value);
        setSelected([]);
        setStatus("候选已列出。逐字段勾选后才能填入；旧值也会显示给你核对。");
      }
    } catch (reason) {
      if (current === version.current) {
        setError(
          controller.signal.aborted
            ? "识别超时，请裁剪后重试。草稿未改变。"
            : reason instanceof Error
              ? reason.message
              : "本机识别失败，草稿未改变。",
        );
        setStatus("");
      }
    } finally {
      clearTimeout(timeout);
      if (current === version.current) {
        setBusy(false);
        request.current = null;
      }
    }
  }
  function clear() {
    version.current++;
    readerRef.current?.abort();
    readerRef.current = null;
    request.current?.abort();
    request.current = null;
    setBusy(false);
    setImage(null);
    setResult(null);
    setSelected([]);
    setError("");
    setStatus("截图已清除，需求草稿保持不变。");
    if (input.current) input.current.value = "";
  }
  return (
    <section className="screenshot-panel">
      <div className="section-heading">
        <div>
          <span className="eyebrow">A SMALL SHORTCUT</span>
          <h3>有截图，就少填几格。</h3>
        </div>
        <span className="iridescent-badge">
          <ScanLine size={13} />
          本机 OCR
        </span>
      </div>
      <p className="subtle">钱包或结算表截图均可。只生成待确认候选。</p>
      <div
        className={`screenshot-drop ${dragging ? "dragging" : ""}`}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files")) {
            event.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void choose(Array.from(event.dataTransfer.files));
        }}
      >
        <input
          ref={input}
          aria-label="选择钱包或表格截图"
          type="file"
          accept="image/png,image/jpeg"
          disabled={disabled || busy}
          onChange={(event) => {
            void choose(Array.from(event.target.files || []));
          }}
        />
        <ImagePlus size={25} />
        <div>
          <b>拖入截图，或直接 ⌘ / Ctrl + V</b>
          <span>PNG / JPEG · ≤ 1 MiB · 不上传模型或第三方</span>
        </div>
        <button
          className="secondary"
          disabled={disabled || busy}
          onClick={() => input.current?.click()}
        >
          <Upload size={14} />
          选择图片
        </button>
      </div>
      {image ? (
        <div className="screenshot-preview">
          <img src={image.url} alt="待识别的钱包或表格截图" />
          <div>
            <b>{image.name}</b>
            <small>本机识别，处理后删除。</small>
            <button
              className="primary"
              disabled={disabled || busy}
              onClick={recognize}
            >
              {busy ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <ScanLine size={15} />
              )}
              {busy ? "正在本机识别…" : "识别持仓与期限"}
            </button>
          </div>
          <button className="clear-image" aria-label="清除截图" onClick={clear}>
            <X size={15} />
          </button>
        </div>
      ) : null}
      {error ? (
        <p className="inline-error" role="alert">
          {error}
        </p>
      ) : null}
      {status ? (
        <p className="ocr-status" role="status">
          {status}
        </p>
      ) : null}
      {result ? (
        <div className="ocr-result">
          {result.candidates.map((candidate) => {
            const existing = draft[candidate.key];
            const blocked =
              candidate.conflict || candidate.confidence === "low";
            return (
              <label
                key={candidate.id}
                className={`ocr-candidate ${blocked ? "blocked" : ""}`}
              >
                <input
                  type="checkbox"
                  aria-label={`确认截图字段 ${candidate.label} ${candidate.displayValue}`}
                  checked={selected.includes(candidate.id)}
                  disabled={disabled || blocked}
                  onChange={(event) =>
                    setSelected((old) =>
                      event.target.checked
                        ? [...old, candidate.id]
                        : old.filter((id) => id !== candidate.id),
                    )
                  }
                />
                <span>
                  <b>
                    {candidate.label} <strong>{candidate.displayValue}</strong>
                  </b>
                  <small>
                    {candidate.conflict
                      ? "数值冲突 · 请在摘要手动填写"
                      : candidate.confidence === "low"
                        ? "低置信 · 请在摘要手动填写"
                        : candidate.confidence === "high"
                          ? "高置信 · 仍需你确认"
                          : "中置信 · 请对照截图复核"}
                  </small>
                  <q>{candidate.evidence}</q>
                  {existing !== undefined && existing !== candidate.value ? (
                    <em>
                      当前草稿：
                      {candidate.key.endsWith("Days")
                        ? `${existing} 天`
                        : money(existing)}
                      ；勾选将明确替换这一项。
                    </em>
                  ) : null}
                </span>
              </label>
            );
          })}
          {result.warnings.map((warning) => (
            <p className="ocr-warning" key={warning}>
              {warning}
            </p>
          ))}
          <button
            className="primary"
            disabled={disabled || !selected.length}
            onClick={() => {
              try {
                onApply(applyOcrCandidates(draft, result, selected));
                setSelected([]);
                setStatus(
                  "已填入你确认的字段；需求确认已重置，请核对完整摘要。",
                );
              } catch {
                setError("有字段不符合确认条件，请在摘要中手动填写。");
              }
            }}
          >
            <Check size={15} />
            填入已确认的 {selected.length} 项
          </button>
        </div>
      ) : null}
      <p className="privacy-note">
        <ShieldCheck size={13} />
        风险、借款与授权仍由你确认。
      </p>
    </section>
  );
}

import { useEffect, useRef, useState } from "react";
import type { AnswerFeedbackSnapshot } from "@tracegraph/contracts";
import type { WorkbenchClient } from "../client";
import { useI18n } from "../i18n";
import { commandId, safeError } from "./UnifiedSettings";

export function MessageActions({ text, runId, client, feedbackReadable = false, feedbackWritable = false, onSaveAsMemory }: {
  text: string; runId?: string; client?: WorkbenchClient; feedbackReadable?: boolean; feedbackWritable?: boolean; onSaveAsMemory?: (text: string) => void;
}) {
  const { t } = useI18n(); const [feedback, setFeedback] = useState<AnswerFeedbackSnapshot | null>(null); const [busy, setBusy] = useState(false); const [message, setMessage] = useState<string | null>(null); const [error, setError] = useState<string | null>(null);
  const pending = useRef<{ command_id: string; answer_event_id: string; value: "like" | "dislike" | "clear" } | null>(null);
  const generation = useRef(0);
  useEffect(() => { let current = true; generation.current += 1; setFeedback(null); setError(null); setMessage(null); setBusy(false); pending.current = null; if (runId && client?.getAnswerFeedback && feedbackReadable) void client.getAnswerFeedback(runId).then((next) => { if (current) setFeedback(next); }).catch((caught) => { if (current) setError(safeError(caught)); }); return () => { current = false; generation.current += 1; }; }, [runId, client, feedbackReadable]);
  const copy = async () => { setError(null); try { if (client?.copyText) await client.copyText(text); else if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text); else throw new Error("Copy is unavailable. Select the text and use your keyboard shortcut."); setMessage(t("Copied")); } catch (caught) { setError(safeError(caught)); } };
  const rate = async (value: "like" | "dislike") => {
    if (!runId || !client?.setAnswerFeedback || feedback?.run_id !== runId || !feedback?.answer_event_id || !feedbackWritable || busy) return;
    const token = generation.current;
    const next: "like" | "dislike" | "clear" = feedback.value === value ? "clear" : value;
    const input = pending.current?.value === next ? pending.current : { command_id: commandId(), answer_event_id: feedback.answer_event_id, value: next };
    pending.current = input; setBusy(true); setError(null); setMessage(null);
    try { const receipt = await client.setAnswerFeedback(runId, input); if (token !== generation.current) return; setFeedback(receipt); pending.current = null; setMessage(t("Feedback saved on this device.")); }
    catch (caught) { if (token === generation.current) setError(safeError(caught)); } finally { if (token === generation.current) setBusy(false); }
  };
  return <div className="message-actions"><button aria-label={t("Copy message")} title={t("Copy message")} className="message-action" onClick={() => void copy()} type="button"><svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V4H4v12h4" /></svg></button>{feedbackReadable && runId && <>{(["like", "dislike"] as const).map((value) => <button className={`message-action ${feedback?.value === value ? "active" : ""}`} aria-label={t(value === "like" ? "Helpful answer" : "Unhelpful answer")} aria-pressed={feedback?.value === value} title={t("Saved only on this device")} disabled={!feedbackWritable || !feedback?.answer_event_id || busy} onClick={() => void rate(value)} key={value} type="button"><svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" style={value === "dislike" ? { transform: "rotate(180deg)" } : undefined}><path d="M8 10h-4v10h4M8 20h10l2-10h-7V4l-3-1-2 7v10Z" /></svg></button>)}</>}{onSaveAsMemory && <button className="message-action message-save-memory" onClick={() => onSaveAsMemory(text)} type="button">{t("Save as memory candidate")}</button>}{message && <span role="status">{message}</span>}{error && <span role="alert">{error}</span>}</div>;
}

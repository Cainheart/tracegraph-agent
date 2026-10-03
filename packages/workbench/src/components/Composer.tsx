import { useRef, useState, type ReactNode } from "react";
import type { PendingAttachment, RunMode } from "../model";
import type { PendingUserInput } from "@tracegraph/contracts";
import { useI18n } from "../i18n";
import { AttachmentComposer, pendingAttachmentsFromFiles } from "./AttachmentComposer";
import { Icon } from "./Icon";
import { useComposerPopover } from "../popover";
import type { PendingProjectFileContext } from "../drafts";

/** One input surface. UI options describe the next admission, never mutate a running Run. */
export function Composer({ value, onChange, onSubmit, onStop, busy = false, submitDisabled = false, stopping = false, disabledReason = null, active = false, enterBehavior = "enter", label = "Message", placeholder = "Ask anything…", attachments, onAttachmentsChange, attachmentsAvailable = false, imageInputAvailable = false, onConfigureImageInput, fileContexts = [], onFileContextsChange, onAddFileContext, fileContextAvailable = false, onCreateMedia, modelControl, permissionControl, mode, onModeChange, optionsDisabled = false, pending = [], error, children }: {
  value: string; onChange: (value: string) => void; onSubmit: () => void;
  onStop?: () => void; busy?: boolean; submitDisabled?: boolean; stopping?: boolean; disabledReason?: string | null; active?: boolean;
  enterBehavior?: "enter" | "mod-enter"; label?: string; placeholder?: string;
  attachments: readonly PendingAttachment[]; onAttachmentsChange: (value: readonly PendingAttachment[]) => void;
  attachmentsAvailable?: boolean; onCreateMedia?: () => void; modelControl?: ReactNode; permissionControl?: ReactNode;
  imageInputAvailable?: boolean; onConfigureImageInput?: () => void;
  fileContexts?: readonly PendingProjectFileContext[]; onFileContextsChange?: (files: readonly PendingProjectFileContext[]) => void; onAddFileContext?: () => void; fileContextAvailable?: boolean;
  mode: RunMode; onModeChange: (mode: RunMode) => void; optionsDisabled?: boolean;
  pending?: readonly PendingUserInput[]; error?: string | null; children?: ReactNode;
}) {
  const { t } = useI18n();
  const [menu, setMenu] = useState(false);
  const popover = useComposerPopover(menu, setMenu);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const disabled = disabledReason !== null;
  const cancellationPending = pending.some((input) => input.kind === "cancel");
  const canSend = !submitDisabled && !disabled && !busy && !cancellationPending && pending.length < 99 && Boolean(value.trim()) && (active || imageInputAvailable || !attachments.some((item) => item.delivery === "inline"));
  const add = (files: readonly File[]) => {
    if (disabled || active || !attachmentsAvailable) return;
    const result = pendingAttachmentsFromFiles(files, attachments);
    setAttachmentError(result.error); onAttachmentsChange(result.attachments);
  };
  return <div className={`unified-composer ${disabled ? "is-disabled" : ""}`} data-composer-surface="unified" ref={root}
    onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
    onDrop={(event) => { if (!event.dataTransfer.files.length) return; event.preventDefault(); add(Array.from(event.dataTransfer.files)); }}>
    {children}
    {fileContexts.length > 0 && <div className="composer-file-contexts" aria-label={t("Project file context")}>{fileContexts.map((file) => <div className="composer-file-context" key={file.path}><Icon name="file" size={13} /><strong title={file.path}>{file.path}</strong><small title={file.expected_sha256}>{file.expected_sha256.slice(7, 19)}</small><button className="icon-button" aria-label={`${t("Remove file context")}: ${file.path}`} disabled={disabled || active || busy || !onFileContextsChange} onClick={() => onFileContextsChange?.(fileContexts.filter((item) => item.path !== file.path))} type="button"><Icon name="x" size={12} /></button></div>)}</div>}
    {attachments.length > 0 && <AttachmentComposer compact minimal attachments={attachments} disabled={disabled || active || busy} imageInputAvailable={imageInputAvailable} {...(onConfigureImageInput ? { onConfigureImageInput } : {})} onChange={onAttachmentsChange} />}
    <textarea aria-label={t(label)} disabled={disabled || busy || cancellationPending} maxLength={8_000} rows={2} value={value}
      placeholder={t(disabledReason ?? placeholder)} onChange={(event) => onChange(event.target.value)}
      onPaste={(event) => { const files = Array.from(event.clipboardData.files); if (files.length && !active && attachmentsAvailable && !disabled) { event.preventDefault(); add(files); } }}
      onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && (enterBehavior === "enter" ? !(event.metaKey || event.ctrlKey) : event.metaKey || event.ctrlKey)) { event.preventDefault(); if (canSend) onSubmit(); } }} />
    <div className="unified-composer-footer">
      <div className="composer-option-row">
        <div className="composer-add-menu" {...popover}>
          <button className="composer-tool-button" aria-label={t("Add to message")} aria-expanded={menu} disabled={disabled || active || busy} onClick={() => setMenu(!menu)} type="button"><span aria-hidden="true" className="composer-plus">+</span></button>
          {menu && <div role="menu" className="composer-popover"><button role="menuitem" disabled={!attachmentsAvailable} onClick={() => { root.current?.querySelector<HTMLInputElement>('input[type="file"]')?.click(); setMenu(false); }} type="button"><Icon name="file" />{t("Attach image or PDF")}</button>{onAddFileContext && <button role="menuitem" disabled={!fileContextAvailable} onClick={() => { setMenu(false); onAddFileContext(); }} type="button"><Icon name="file" />{t("Add project file context")}</button>}{onCreateMedia && <button role="menuitem" onClick={() => { setMenu(false); onCreateMedia(); }} type="button"><Icon name="spark" />{t("Create media")}</button>}</div>}
          {attachmentsAvailable && <div hidden><AttachmentComposer minimal attachments={attachments} disabled={disabled || active || busy} imageInputAvailable={imageInputAvailable} onChange={onAttachmentsChange} /></div>}
        </div>
        {permissionControl}
        <button className={`composer-option ${mode === "plan" ? "is-active" : ""}`} aria-label={t("Plan mode")} aria-pressed={mode === "plan"} disabled={disabled || optionsDisabled} title={t(active ? "Applies to the next task" : "Plan before making changes")} onClick={() => onModeChange(mode === "plan" ? "execute" : "plan")} type="button"><Icon name="route" size={13} />{t("Plan")}</button>
      </div>
      <div className="composer-submit-row">{modelControl}{active && onStop && <button aria-label={t("Stop")} title={t("Stop at the next safe boundary")} className="composer-stop" disabled={disabled || stopping || cancellationPending || pending.length >= 100} onClick={onStop} type="button"><Icon name="stop" size={14} /></button>}{(!active || Boolean(value.trim())) && <button aria-label={t(active ? "Queue input" : "Send message")} className="composer-send" disabled={!canSend} onClick={onSubmit} type="button"><Icon name="send" size={15} /></button>}</div>
    </div>
    {pending.length > 0 && <details className="composer-queued"><summary>{t("Queued")}: {pending.length}</summary>{pending.map((input) => <p key={input.input_id}>{input.kind === "cancel" ? t("Stop at the next safe boundary") : input.body}</p>)}<small>{t("Will be sent at the next step")}</small></details>}
    {(error || attachmentError) && <p className="composer-error" role="alert">{t(error ?? attachmentError ?? "")}</p>}
  </div>;
}

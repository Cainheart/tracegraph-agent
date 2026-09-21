import { MAX_ATTACHMENTS_PER_RUN, MAX_ATTACHMENT_BYTES } from "@tracegraph/contracts";
import { useRef, useState, type DragEvent } from "react";
import type { AttachmentDelivery, PendingAttachment } from "../model";
import { useI18n } from "../i18n";
import { Icon } from "./Icon";

const ACCEPTED_MEDIA = new Set(["image/png", "image/jpeg", "application/pdf"]);

export function AttachmentComposer({
  attachments,
  disabled = false,
  onChange,
  compact = false,
  minimal = false,
}: {
  attachments: readonly PendingAttachment[];
  disabled?: boolean;
  onChange: (attachments: readonly PendingAttachment[]) => void;
  compact?: boolean;
  minimal?: boolean;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const addFiles = (files: FileList | readonly File[]) => {
    const result = pendingAttachmentsFromFiles(files, attachments);
    setError(result.error);
    if (result.attachments !== attachments) onChange(result.attachments);
  };
  const drop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (!disabled) addFiles(event.dataTransfer.files);
  };
  const setDelivery = (id: string, delivery: AttachmentDelivery) => {
    onChange(attachments.map((item) => item.id === id ? { ...item, delivery } : item));
  };
  return (
    <section
      aria-label={t("Attachments for next run")}
      className={`attachment-composer ${compact ? "is-compact" : ""} ${minimal ? "is-minimal" : ""}`}
      onDragOver={(event) => event.preventDefault()}
      onDrop={drop}
    >
      <input
        accept=".png,.jpg,.jpeg,.pdf,image/png,image/jpeg,application/pdf"
        aria-label={t("Choose attachments")}
        disabled={disabled}
        hidden
        multiple
        onChange={(event) => {
          if (event.target.files) addFiles(event.target.files);
          event.target.value = "";
        }}
        ref={inputRef}
        type="file"
      />
      <button
        className="attachment-add-button"
        disabled={disabled || attachments.length >= MAX_ATTACHMENTS_PER_RUN}
        onClick={() => inputRef.current?.click()}
        type="button"
      >
        <Icon name="file" size={14} />
        {minimal ? <span className="sr-only">{t("Attach image or PDF")}</span> : t("Attach image or PDF")}
      </button>
      {!minimal && <small>{t("PNG, JPEG, or PDF · 30 MiB each · sent with the next new task")}</small>}
      {attachments.length > 0 && <div className="pending-attachment-list">
        {attachments.map((item) => {
          const image = item.declaredMediaType === "image/png" || item.declaredMediaType === "image/jpeg";
          return <div className="pending-attachment" key={item.id}>
            <span><Icon name="file" size={13} /><strong title={item.label}>{item.label}</strong><small>{formatBytes(item.file.size)}</small></span>
            {image && <label title={t("Inline is attempted only when the configured model explicitly supports image input.")}>
              <input
                checked={item.delivery === "inline"}
                disabled={disabled}
                onChange={(event) => setDelivery(item.id, event.target.checked ? "inline" : "offload")}
                type="checkbox"
              />
              {t("Send image to model")}
            </label>}
            <button aria-label={`${t("Remove attachment")}: ${item.label}`} disabled={disabled} onClick={() => onChange(attachments.filter(({ id }) => id !== item.id))} type="button"><Icon name="x" size={12} /></button>
          </div>;
        })}
      </div>}
      {error && <p className="attachment-error" role="alert">{t(error)}</p>}
    </section>
  );
}

export function pendingAttachmentsFromFiles(
  files: FileList | readonly File[],
  current: readonly PendingAttachment[],
): { attachments: readonly PendingAttachment[]; error: string | null } {
  const next = [...current];
  for (const file of Array.from(files)) {
    if (next.length >= MAX_ATTACHMENTS_PER_RUN) {
      return { attachments: next, error: "A Run can include at most 8 attachments." };
    }
    const mediaType = normalizedMediaType(file);
    if (!ACCEPTED_MEDIA.has(mediaType)) {
      return { attachments: next, error: "Only PNG, JPEG, and PDF attachments are supported." };
    }
    if (file.size === 0) {
      return { attachments: next, error: "Empty attachments are not supported." };
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      return { attachments: next, error: "Each attachment must be 30 MiB or smaller." };
    }
    next.push({
      id: attachmentDraftId(),
      label: file.name,
      file,
      declaredMediaType: mediaType,
      // Offload is always the default. Image delivery requires the explicit
      // checkbox above and remains subject to the Host-owned model capability.
      delivery: "offload",
    });
  }
  return { attachments: next, error: null };
}

function normalizedMediaType(file: File): string {
  const declared = file.type.trim().toLowerCase();
  if (declared) return declared === "image/jpg" ? "image/jpeg" : declared;
  const name = file.name.toLowerCase();
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".pdf")) return "application/pdf";
  return "application/octet-stream";
}

function attachmentDraftId(): string {
  return typeof globalThis.crypto?.randomUUID === "function"
    ? `attachment-draft:${globalThis.crypto.randomUUID()}`
    : `attachment-draft:${Date.now()}:${Math.random().toString(16).slice(2)}`;
}

function formatBytes(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.ceil(bytes / 1024))} KiB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

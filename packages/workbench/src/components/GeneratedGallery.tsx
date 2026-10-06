import { useEffect, useRef, useState } from "react";
import type { GeneratedArtifact } from "../model";
import type { GeneratedArtifactContent } from "../client";
import { useI18n } from "../i18n";

export function GeneratedGallery({ artifacts, onLoad, disabled = false, disabledReason, activity, autoPreview = false }: {
  artifacts: readonly GeneratedArtifact[];
  onLoad?: (runId: string, artifactId: string) => Promise<GeneratedArtifactContent>;
  disabled?: boolean;
  disabledReason?: string;
  activity?: { state: "running" | "failed"; message?: string };
  autoPreview?: boolean;
}) {
  const { t } = useI18n();
  if (!artifacts.length && !activity) return null;
  return <div className="generated-gallery">
    {!artifacts.length && activity && <section className={`generated-media-status is-${activity.state}`} role={activity.state === "failed" ? "alert" : "status"}>
      <span aria-hidden="true" className={activity.state === "running" ? "generated-media-spinner" : "generated-media-error-mark"} />
      <div><strong>{t(activity.state === "running" ? "Generating media…" : "Media generation did not produce a verified artifact.")}</strong><p>{t(activity.message ?? (activity.state === "running" ? "The preview will appear after the completed Artifact is verified." : "Inspect the Run receipt and settings, then retry only if no write is pending."))}</p></div>
    </section>}
    {artifacts.map((artifact) => <GeneratedCard artifact={artifact} disabled={disabled} autoPreview={autoPreview} {...(disabledReason ? { disabledReason } : {})} {...(onLoad ? { onLoad } : {})} key={`${artifact.runId}:${artifact.artifactId}`} />)}
  </div>;
}

function GeneratedCard({ artifact, onLoad, disabled, disabledReason, autoPreview }: {
  artifact: GeneratedArtifact;
  onLoad?: (runId: string, artifactId: string) => Promise<GeneratedArtifactContent>;
  disabled: boolean;
  disabledReason?: string;
  autoPreview: boolean;
}) {
  const { t } = useI18n();
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = useRef(0);
  const autoStarted = useRef<string | null>(null);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  useEffect(() => { if (disabled) { current.current += 1; setUrl(null); setBusy(false); } }, [disabled]);
  useEffect(() => () => { current.current += 1; }, []);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  useEffect(() => { current.current += 1; setUrl(null); setError(null); setBusy(false); autoStarted.current = null; }, [artifact.artifactId, artifact.runId, artifact.sha256]);

  const load = async () => {
    if (!onLoad || disabled || busy) return;
    const generation = ++current.current;
    setBusy(true); setError(null);
    try {
      const content = await onLoad(artifact.runId, artifact.artifactId);
      if (generation !== current.current || disabledRef.current) return;
      if (content.artifactId !== artifact.artifactId || content.mediaType !== artifact.mediaType || content.sha256 !== artifact.sha256 || content.bytes.byteLength !== artifact.bytes) throw new Error("Generated artifact verification failed.");
      if (!globalThis.crypto?.subtle) throw new Error("This installation cannot verify generated artifact bytes.");
      const bytes = new Uint8Array(content.bytes).buffer;
      const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
      if (generation !== current.current || disabledRef.current) return;
      const hash = `sha256:${Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("")}`;
      if (hash !== artifact.sha256) throw new Error("Generated artifact byte digest verification failed.");
      setUrl(URL.createObjectURL(new Blob([bytes], { type: content.mediaType })));
    } catch (caught) { if (generation === current.current) setError(caught instanceof Error ? caught.message : "The generated artifact could not be opened."); }
    finally { if (generation === current.current) setBusy(false); }
  };
  useEffect(() => {
    const key = `${artifact.runId}:${artifact.artifactId}:${artifact.sha256}`;
    if (autoPreview && onLoad && !disabled && !url && !busy && !error && autoStarted.current !== key) {
      autoStarted.current = key;
      void load();
    }
  }, [autoPreview, artifact.runId, artifact.artifactId, artifact.sha256, onLoad, disabled, url, busy, error]);

  const extension = artifact.mediaType === "image/svg+xml" ? "svg" : artifact.mediaType.split("/")[1];
  return <section className="generated-card" aria-label={t(artifact.label)}>
    <header><strong>{t(artifact.label)}</strong><small>{artifact.mediaType} · {Math.ceil(artifact.bytes / 1024)} KB</small></header>
    {busy && <div className="generated-media-verifying" role="status"><span className="generated-media-spinner" />{t("Verifying generated artifact…")}</div>}
    {url && !disabled && <img src={url} alt={t(artifact.label)} />}
    <div className="generated-card-actions">
      {!url && !busy && <button className="button subtle" disabled={disabled || !onLoad} onClick={() => void load()} type="button">{t("Preview generated artifact")}</button>}
      {url && !disabled && <a className="button subtle" href={url} download={`outlive-${artifact.artifactId}.${extension}`}>{t("Download")}</a>}
      <details><summary>{t("Artifact details")}</summary><code>{artifact.artifactId}</code><br /><code>SHA256 {artifact.sha256}</code></details>
    </div>
    {(disabled || !onLoad) && <p>{t(disabledReason ?? "This feature is unavailable on this installation.")}</p>}
    {error && <p role="alert">{t(error)}</p>}
  </section>;
}

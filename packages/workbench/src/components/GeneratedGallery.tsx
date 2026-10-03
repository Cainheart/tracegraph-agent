import { useEffect, useRef, useState } from "react";
import type { GeneratedArtifact } from "../model";
import type { GeneratedArtifactContent } from "../client";
import { useI18n } from "../i18n";

export function GeneratedGallery({ artifacts, onLoad, disabled = false }: { artifacts: readonly GeneratedArtifact[]; onLoad?: (runId: string, artifactId: string) => Promise<GeneratedArtifactContent>; disabled?: boolean }) {
  if (!artifacts.length) return null;
  return <div className="generated-gallery">{artifacts.map((artifact) => <GeneratedCard artifact={artifact} disabled={disabled} {...(onLoad ? { onLoad } : {})} key={`${artifact.runId}:${artifact.artifactId}`} />)}</div>;
}
function GeneratedCard({ artifact, onLoad, disabled }: { artifact: GeneratedArtifact; onLoad?: (runId: string, artifactId: string) => Promise<GeneratedArtifactContent>; disabled: boolean }) {
  const { t } = useI18n(); const [url, setUrl] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const current = useRef(0); const disabledRef = useRef(disabled); disabledRef.current = disabled;
  useEffect(() => { if (disabled) { current.current += 1; setUrl(null); setBusy(false); } }, [disabled]);
  useEffect(() => () => { current.current += 1; }, []);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  useEffect(() => { setUrl(null); setError(null); }, [artifact.artifactId, artifact.runId, artifact.sha256]);
  const load = async () => {
    if (!onLoad || disabled || busy) return; const generation = ++current.current; setBusy(true); setError(null);
    try {
      const content = await onLoad(artifact.runId, artifact.artifactId);
      if (generation !== current.current || disabledRef.current) return;
      if (content.artifactId !== artifact.artifactId || content.mediaType !== artifact.mediaType || content.sha256 !== artifact.sha256 || content.bytes.byteLength !== artifact.bytes) throw new Error("Generated artifact verification failed.");
      const bytes = new Uint8Array(content.bytes).buffer;
      setUrl(URL.createObjectURL(new Blob([bytes], { type: content.mediaType })));
    } catch (caught) { setError(caught instanceof Error ? caught.message : "The generated artifact could not be opened."); }
    finally { if (generation === current.current) setBusy(false); }
  };
  const extension = artifact.mediaType === "image/svg+xml" ? "svg" : artifact.mediaType.split("/")[1];
  return <section className="generated-card" aria-label={t(artifact.label)}><header><strong>{t(artifact.label)}</strong><small>{artifact.mediaType} · {Math.ceil(artifact.bytes / 1024)} KB</small></header>{url && !disabled && <img src={url} alt={t(artifact.label)} />}<div className="generated-card-actions">{!url && <button className="button subtle" disabled={disabled || !onLoad || busy} onClick={() => void load()} type="button">{t(busy ? "Loading preview…" : "Preview generated artifact")}</button>}{url && !disabled && <a className="button subtle" href={url} download={`outlive-${artifact.artifactId}.${extension}`}>{t("Download")}</a>}<details><summary>{t("Artifact details")}</summary><code>{artifact.artifactId}</code><br /><code>SHA256 {artifact.sha256}</code></details></div>{disabled && <p>{t("Return to now to preview generated artifacts.")}</p>}{error && <p role="alert">{t(error)}</p>}</section>;
}

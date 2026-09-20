import { useEffect, useMemo, useState } from "react";
import { graphForVersion, type ChangedFile, type CodeIntelSnapshot, type DiffLine, type EvidenceSlot, type EvidenceSnapshot, type GraphEdge, type GraphNode } from "../model";
import { useI18n } from "../i18n";
import { Icon } from "./Icon";
import { IconButton } from "./Primitives";

function FileStatus({ status }: { status: ChangedFile["status"] }) {
  return <span className={`file-status file-status-${status}`}>{status === "modified" ? "M" : status === "added" ? "A" : "D"}</span>;
}

function EvidencePlaceholder({ slot, label }: { slot: EvidenceSlot; label: string }) {
  const { t } = useI18n();
  return <div className={`evidence-placeholder evidence-${slot.status}`}><Icon name={slot.status === "loading" ? "refresh" : "alert"} size={17} /><strong>{t(label)} {t(slot.status.replace("_", " "))}</strong><span>{t(slot.message)}</span>{slot.artifactId && <code>{slot.artifactId}</code>}</div>;
}

function ChangedFiles({ files, selected, onSelect, slot }: { files: readonly ChangedFile[]; selected: string; onSelect: (path: string) => void; slot: EvidenceSlot }) {
  const { t } = useI18n();
  return (
    <section className="review-pane changed-files-pane">
      <header className="review-pane-header"><span>{t("Changed files")}</span><small>{files.length}</small></header>
      <div className="changed-file-list">
        {files.length === 0 && <EvidencePlaceholder label="Changed files" slot={slot} />}
        {files.map((file) => (
          <button className={file.path === selected ? "active" : ""} key={file.path} onClick={() => onSelect(file.path)} type="button">
            <FileStatus status={file.status} />
            <span><strong>{file.path.split("/").at(-1)}</strong><small>{file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "root"}</small></span>
            <code><i>+{file.additions}</i> <b>−{file.deletions}</b></code>
          </button>
        ))}
      </div>
      <div className="file-scope-note"><Icon name="shield" size={14} /><span>{t("Patch scope locked to preview hash")}</span></div>
    </section>
  );
}

function DiffViewer({ path, lines, onOpenDetails, slot, patchId }: { path: string; lines: readonly DiffLine[]; onOpenDetails: () => void; slot: EvidenceSlot; patchId: string | undefined }) {
  const { t } = useI18n();
  const additions = lines.filter((line) => line.type === "added").length;
  const deletions = lines.filter((line) => line.type === "removed").length;
  return (
    <section className="review-pane diff-pane">
      <header className="review-pane-header diff-header">
        <div><Icon name="file" size={14} /><code>{path}</code></div>
        <div>{lines.length > 0 && <><span className="diff-add">+{additions}</span><span className="diff-remove">−{deletions}</span></>}<IconButton icon="more" label={t("Diff options")} /></div>
      </header>
      <div className="diff-code" role="table" aria-label={`Diff for ${path}`}>
        {lines.length === 0 && <EvidencePlaceholder label="Diff" slot={slot} />}
        {lines.map((line, index) => (
          <button className={`diff-line diff-line-${line.type}`} key={`${line.number ?? "meta"}-${index}`} onClick={onOpenDetails} type="button">
            <span className="line-number">{line.number ?? ""}</span>
            <span className="line-marker">{line.type === "added" ? "+" : line.type === "removed" ? "−" : ""}</span>
            <code>{line.content.replace(/^[+-]/, "")}</code>
          </button>
        ))}
      </div>
      <footer className="diff-footer"><span><Icon name="diff" size={14} />{t(lines.length > 0 ? "Selected hunk" : "No hunk selected")}</span><code>{patchId ?? slot.artifactId ?? t("unavailable")}</code></footer>
    </section>
  );
}

function ArchitectureGraph({ nodes, edges, onOpenDetails, slot }: { nodes: readonly GraphNode[]; edges: readonly GraphEdge[]; onOpenDetails: () => void; slot: EvidenceSlot }) {
  const { language, t } = useI18n();
  const [version, setVersion] = useState<"before" | "after">("after");
  const graph = useMemo(() => graphForVersion(nodes, edges, version), [edges, nodes, version]);
  const nodeById = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes]);
  const versionSlot: EvidenceSlot = graph.nodes.length === 0 && graph.edges.length === 0 && (slot.status === "available" || slot.status === "demo")
    ? {
        status: "unavailable",
        ...(slot.artifactId === undefined ? {} : { artifactId: slot.artifactId }),
        message: language === "zh-CN" ? `该差异制品不包含${version === "before" ? "变更前" : "变更后"}架构图，系统不会推断完整快照。` : `${version === "before" ? "Before" : "After"} graph is unavailable from this delta Artifact. No full snapshot is being inferred.`,
      }
    : slot;

  return (
    <section className="review-pane graph-pane">
      <header className="review-pane-header graph-header">
        <span>{t("Architecture delta")}</span>
        <div className="segmented compact">
          <button className={version === "before" ? "active" : ""} onClick={() => setVersion("before")} type="button">{t("Before")}</button>
          <button className={version === "after" ? "active" : ""} onClick={() => setVersion("after")} type="button">{t("After + delta")}</button>
        </div>
      </header>
      <div className={`graph-canvas graph-version-${version}`}>
        <div className="graph-watermark">DELTA ENTITIES · RECORDED {version.toUpperCase()}</div>
        {graph.nodes.length === 0 && graph.edges.length === 0 && <EvidencePlaceholder label={`${version} architecture`} slot={versionSlot} />}
        <svg aria-hidden="true" className="graph-lines" viewBox="0 0 320 300" preserveAspectRatio="xMidYMid meet">
          <defs>
            <marker id="arrow-added" markerHeight="7" markerWidth="7" orient="auto" refX="6" refY="3.5"><path d="M0,0 L7,3.5 L0,7" /></marker>
            <marker id="arrow-default" markerHeight="7" markerWidth="7" orient="auto" refX="6" refY="3.5"><path d="M0,0 L7,3.5 L0,7" /></marker>
          </defs>
          {graph.edges.map((edge) => {
            const from = nodeById.get(edge.from);
            const to = nodeById.get(edge.to);
            if (!from || !to) return null;
            return (
              <g className={`graph-edge edge-${edge.state}`} key={edge.id}>
                <line x1={from.x + 31} y1={from.y + 24} x2={to.x + 31} y2={to.y} markerEnd={edge.state === "added" ? "url(#arrow-added)" : "url(#arrow-default)"} />
                <text x={(from.x + to.x) / 2 + 36} y={(from.y + to.y) / 2 + 7}>{t(edge.label)}</text>
              </g>
            );
          })}
        </svg>
        {graph.nodes.map((node) => (
            <button
              className={`graph-node node-${node.state}`}
              key={node.id}
              onClick={onOpenDetails}
              title={node.path}
              style={{ left: node.x, top: node.y }}
              type="button"
            >
              <span>{node.state === "added" ? "+" : node.state === "removed" ? "−" : node.state === "changed" ? "~" : node.state === "partial" ? "?" : ""}</span>
              <strong>{node.label}</strong>
            </button>
        ))}
        <div className="graph-legend">
          <span><i className="legend-added">+</i>{t("Added")}</span>
          <span><i className="legend-removed">−</i>{t("Removed")}</span>
          <span><i className="legend-changed">~</i>{t("Changed")}</span>
          <span><i className="legend-partial">?</i>{t("Partial")}</span>
        </div>
      </div>
      <footer className="graph-summary">
        <div><strong>{nodes.filter((node) => node.state === "added").length}</strong><span>{t("added")}</span></div><div><strong>{graph.edges.length}</strong><span>{t(version === "before" ? "Before" : "After + delta")} · {t("edges")}</span></div><div><strong>{nodes.filter((node) => node.state === "changed").length}</strong><span>{t("changed")}</span></div>
        <button onClick={onOpenDetails} type="button">{t("View impact")} <Icon name="chevron" size={13} /></button>
      </footer>
    </section>
  );
}

/**
 * The semantic view is intentionally derived only from the bounded code_intel
 * projection/event evidence. It does not attempt to infer dynamic calls,
 * unresolved symbols, or diagnostics that were not recorded for this point in
 * the timeline.
 */
function CodeIntelPanel({ codeIntel, onSelectFile }: { codeIntel: CodeIntelSnapshot | undefined; onSelectFile: (path: string) => void }) {
  const { t } = useI18n();
  const diagnostics = codeIntel?.diagnosticsSummary;
  const files = codeIntel?.changedFiles ?? [];
  const symbols = codeIntel?.changedSymbols ?? [];
  const stale = codeIntel?.staleBase;
  const hasData = codeIntel !== undefined;

  return (
    <section className={`code-intel-panel ${stale ? "is-stale" : ""}`} aria-label={t("Semantic impact")}>
      <details open={hasData}>
        <summary>
          <span className="code-intel-title"><Icon name="graph" size={15} /><strong>{t("Semantic impact")}</strong><small>{t("Static declaration analysis")}</small></span>
          <span className="code-intel-badges">
            <i className="code-intel-file-count">{files.length} {t("files")}</i>
            <i className="code-intel-symbol-count">{symbols.length} {t("symbols")}</i>
            {diagnostics && <i className={`code-intel-diagnostic-count ${diagnostics.error_count > 0 ? "has-errors" : ""}`}>{diagnostics.error_count} {t("errors")} · {diagnostics.warning_count} {t("warnings")}</i>}
            {stale && <i className="code-intel-stale-count">{t("Reapproval required")}</i>}
            <Icon name="chevron" size={13} />
          </span>
        </summary>
        {!hasData ? (
          <p className="code-intel-empty">{t("No semantic evidence recorded for this event.")}</p>
        ) : (
          <div className="code-intel-content">
            {stale && (
              <div className="code-intel-stale">
                <Icon name="alert" size={15} />
                <div><strong>{t("Git base changed — approval reissued")}</strong><span>{t("The previous patch approval was not executed. Review the replacement approval before writing.")}</span></div>
              </div>
            )}
            <div className="code-intel-column semantic-files">
              <header><span>{t("Affected files")}</span><small>{files.length}{codeIntel.changedFilesTruncated ? "+" : ""}</small></header>
              {files.length === 0 ? <p>{t("No affected source file was recorded.")}</p> : (
                <ul>
                  {files.slice(0, 12).map((path) => (
                    <li key={path}><button onClick={() => onSelectFile(path)} title={path} type="button"><code>{path}</code></button></li>
                  ))}
                </ul>
              )}
              {(files.length > 12 || codeIntel.changedFilesTruncated) && <p className="code-intel-truncated">{t("Additional affected files are omitted from this bounded view.")}</p>}
            </div>
            <div className="code-intel-column semantic-symbols">
              <header><span>{t("Changed symbols")}</span><small>{symbols.length}{codeIntel.changedSymbolsTruncated ? "+" : ""}</small></header>
              {symbols.length === 0 ? <p>{t("No static declaration change was recorded.")}</p> : (
                <ul>
                  {symbols.slice(0, 12).map((symbol) => (
                    <li key={symbol.symbol_id}>
                      <button onClick={() => onSelectFile(symbol.file_path)} type="button" title={`${symbol.file_path}:${symbol.line}`}>
                        <i className={`symbol-change symbol-change-${symbol.change}`}>{symbol.change === "added" ? "+" : symbol.change === "removed" ? "−" : "~"}</i>
                        <span><strong>{symbol.name}</strong><small>{symbol.kind} · {symbol.file_path}:{symbol.line}</small></span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {codeIntel.changedSymbolsTruncated && <p className="code-intel-truncated">{t("Additional changed symbols are omitted from this bounded record.")}</p>}
            </div>
            <div className="code-intel-column diagnostic-summary">
              <header><span>{t("Diagnostic summary")}</span><small>{diagnostics?.server_name ?? t("Not recorded")}</small></header>
              {!diagnostics ? <p>{t("No LSP diagnostic summary was recorded for this event.")}</p> : (
                <>
                  <div className="diagnostic-counts"><span className={diagnostics.error_count > 0 ? "has-errors" : ""}>{diagnostics.error_count} {t("errors")}</span><span>{diagnostics.warning_count} {t("warnings")}</span><span>{diagnostics.information_count} {t("information")}</span></div>
                  {diagnostics.sample.length > 0 && <ul className="diagnostic-sample">
                    {diagnostics.sample.slice(0, 3).map((diagnostic, index) => <li key={`${diagnostic.path}:${diagnostic.range.start.line}:${index}`} className={`diagnostic-${diagnostic.severity}`}><strong>{diagnostic.path}:{diagnostic.range.start.line + 1}</strong><span>{diagnostic.message}</span></li>)}
                  </ul>}
                  {diagnostics.truncated && <p className="code-intel-truncated">{t("Diagnostic samples are truncated by the recorded safety limit.")}</p>}
                </>
              )}
            </div>
          </div>
        )}
      </details>
    </section>
  );
}

export function ChangesView({
  files,
  diffs,
  nodes,
  edges,
  onJumpToPatch,
  onOpenDetails,
  verified,
  evidence,
  patchId,
  codeIntel,
}: {
  files: readonly ChangedFile[];
  diffs: Readonly<Record<string, readonly DiffLine[]>>;
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  onJumpToPatch: () => void;
  onOpenDetails: () => void;
  verified: boolean;
  evidence: EvidenceSnapshot;
  patchId: string | undefined;
  codeIntel?: CodeIntelSnapshot;
}) {
  const { language, t } = useI18n();
  const [selectedPath, setSelectedPath] = useState(files[0]?.path ?? "");
  const [mobilePanel, setMobilePanel] = useState<"diff" | "graph">("diff");
  const lines = diffs[selectedPath] ?? [];

  useEffect(() => {
    if (!files.some((file) => file.path === selectedPath)) setSelectedPath(files[0]?.path ?? "");
  }, [files, selectedPath]);

  return (
    <div className="changes-view">
      <div className="changes-toolbar">
        <div>
          <span className="eyebrow">{t("Review workspace")}</span>
          <h2>{t("Architecture-aware changes")}</h2>
        </div>
        <div className="changes-toolbar-actions">
          <button className="button subtle file-drawer-trigger" type="button"><Icon name="folder" size={14} /> {t("Files")} ({files.length})</button>
          <div className="segmented mobile-review-tabs">
            <button className={mobilePanel === "diff" ? "active" : ""} onClick={() => setMobilePanel("diff")} type="button">{t("Diff")}</button>
            <button className={mobilePanel === "graph" ? "active" : ""} onClick={() => setMobilePanel("graph")} type="button">{t("Architecture")}</button>
          </div>
          <button className="button subtle" disabled={!patchId} onClick={onJumpToPatch} type="button"><Icon name="arrow-left" size={14} /> {t(patchId ? "Source event" : "Source unavailable")}</button>
          <button className="button" onClick={onOpenDetails} type="button">{t("Open details")} <Icon name="external" size={14} /></button>
        </div>
      </div>
      <div className={`review-workspace mobile-panel-${mobilePanel}`}>
        <ChangedFiles files={files} onSelect={setSelectedPath} selected={selectedPath} slot={evidence.diff} />
        <DiffViewer lines={lines} onOpenDetails={onOpenDetails} patchId={patchId} path={selectedPath || t("No verified file")} slot={evidence.diff} />
        <ArchitectureGraph edges={edges} nodes={nodes} onOpenDetails={onOpenDetails} slot={evidence.graph} />
      </div>
      <CodeIntelPanel codeIntel={codeIntel} onSelectFile={setSelectedPath} />
      <div className={`verification-bar ${verified ? "is-verified" : "is-pending"}`}>
        <div className="verification-result">
          <span><Icon name={verified ? "check" : "clock"} size={15} /></span>
          <div>
            <strong>{verified ? t("Test evidence available") : evidence.test.status === "not_present" ? t("No test evidence recorded") : language === "zh-CN" ? `测试证据：${evidence.test.status}` : `Test evidence ${evidence.test.status}`}</strong>
            <small>{t(evidence.test.message)}</small>
          </div>
        </div>
        <div className="verification-links">{patchId && <button onClick={onJumpToPatch} type="button"><Icon name="route" size={13} /> {patchId}</button>}{evidence.graph.artifactId && <code>{evidence.graph.artifactId}</code>}{evidence.test.artifactId && <code>{evidence.test.artifactId}</code>}</div>
      </div>
    </div>
  );
}

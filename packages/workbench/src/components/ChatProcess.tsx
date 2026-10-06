import { useEffect, useState } from "react";
import { classifyPublicChatFailure, projectPublicChat, type PublicChatFact, type PublicChatOperation } from "@tracegraph/contracts";
import type { ModelSurfaceSnapshot, RunStatus, TraceEvent } from "../model";
import { useI18n } from "../i18n";
import { Icon } from "./Icon";
import { MarkdownContent } from "./MarkdownContent";
import type { WorkbenchClient } from "../client";

const names: Record<string, readonly [string, string]> = {
  read_file: ["读取文件", "Read file"], list_files: ["列出文件", "List files"], search: ["搜索文件", "Search files"],
  run_project_command: ["运行项目命令", "Run project command"], run_test: ["运行测试", "Run tests"],
  preview_patch: ["预览修改", "Preview changes"], commit_patch: ["修改文件", "Edit file"],
  generate_image: ["生成图片", "Generate image"], render_diagram: ["绘制图形", "Render diagram"], render_chart: ["绘制图表", "Render chart"],
  todo_read: ["查看计划", "Read plan"], todo_write: ["更新计划", "Update plan"],
};
function label(operation: PublicChatOperation, chinese: boolean) {
  return names[operation.tool_name]?.[chinese ? 0 : 1] ?? (chinese ? `使用 ${operation.tool_name}` : `Use ${operation.tool_name}`);
}

export function ChatProcess({ events, plans, active, elapsed, runId, client, onInspectEvent, onOpenProjectFile }: {
  events: readonly TraceEvent[]; plans: readonly ModelSurfaceSnapshot[]; active: boolean; elapsed?: string;
  runId?: string; client?: WorkbenchClient;
  onInspectEvent?: (event: TraceEvent) => void;
  onOpenProjectFile?: (path: string) => void;
}) {
  const { language } = useI18n(); const zh = language === "zh-CN";
  // null follows the lifecycle default. An explicit choice always wins, even
  // when new events arrive or the Run changes from running to completed.
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const [limit, setLimit] = useState(40);
  const facts: PublicChatFact[] = events.map(event => ({ event_id: event.id, sequence: event.sequence, type: event.sourceType ?? (event.kind === "tool" ? event.state === "running" ? "tool.started" : event.state === "failed" ? "tool.failed" : event.state === "succeeded" ? "tool.completed" : "tool.unknown" : ""),
    ...(event.operationId ? { operation_id: event.operationId, model_call_id: event.operationId } : {}),
    ...(event.publicPlan ? { public_plan: event.publicPlan } : {}), ...(event.toolName ? { tool_name: event.toolName } : {}), ...(event.target ? { target: event.target } : {}) }));
  for (const plan of plans.filter(plan => plan.type === "public_plan_snapshot" && plan.status !== "failed" && plan.status !== "cancelled")) {
    const index = facts.findIndex(fact => fact.type === "model.decision" && (fact.model_call_id === plan.modelCallId || fact.event_id === plan.modelCallId));
    if (index >= 0) { facts[index] = { ...facts[index]!, public_plan: plan.text }; continue; }
    // An explicitly public, provisional plan is positioned at its model call.
    const request = facts.find(fact => fact.type === "model.request_started" && fact.model_call_id === plan.modelCallId);
    facts.push({ event_id: plan.id, sequence: (request?.sequence ?? events.at(-1)?.sequence ?? 0) + .1,
      type: "model.decision", public_plan: plan.text });
  }
  const blocks = projectPublicChat(facts);
  const open = expanded ?? active;
  if (!blocks.length && !active) return null;
  const hidden = Math.max(0, blocks.length - limit);
  const latest = blocks.at(-1);
  return <section className="chat-process" aria-label={zh ? "任务过程" : "Task process"}>
    {!active && <button className="chat-process-toggle" aria-expanded={open} onClick={() => setExpanded(!open)} type="button">{zh ? `用时 ${elapsed ?? "未记录"}` : `Worked for ${elapsed ?? "not recorded"}`}<Icon name="chevron" size={13} /></button>}
    {active && !open && <button className="chat-process-toggle is-running" aria-expanded={false} onClick={() => setExpanded(true)} type="button"><Icon className="chat-operation-spinner" name="spinner" size={13} /><span className="chat-running-label">{latest && latest.kind !== "operations" ? latest.text.split('\n')[0] : zh ? "正在处理任务" : "Working"}</span><Icon name="chevron" size={13} /></button>}
      {open && <div className="chat-process-body">
      {hidden > 0 && <button className="chat-process-toggle" onClick={() => setLimit(count => count + 40)} type="button">{zh ? `查看更早的记录（${hidden}）` : `Show earlier records (${hidden})`}</button>}
      {blocks.slice(-limit).map(block => block.kind !== "operations" ? <div className={`chat-public-statement${block.kind === "answer" ? " chat-final-answer" : ""}`} key={block.id}><MarkdownContent content={block.text} /></div> : <OperationGroup key={block.id} operations={block.operations} events={events} {...(runId ? { runId } : {})} {...(client ? { client } : {})} {...(onInspectEvent ? { onInspectEvent } : {})} {...(onOpenProjectFile ? { onOpenProjectFile } : {})} />)}
      {active && !blocks.length && <p className="chat-operation-waiting" role="status">{zh ? "正在处理…" : "Working…"}</p>}
    </div>}
  </section>;
}

function OperationGroup({ operations, events, runId, client, onInspectEvent, onOpenProjectFile }: {
  operations: readonly PublicChatOperation[]; events: readonly TraceEvent[]; runId?: string; client?: WorkbenchClient; onInspectEvent?: (event: TraceEvent) => void; onOpenProjectFile?: (path: string) => void;
}) {
  const { language } = useI18n(); const zh = language === "zh-CN";
  const [expanded, setExpanded] = useState<boolean | null>(null); const [limit, setLimit] = useState(30);
  const running = operations.some(op => op.status === "running");
  const open = expanded ?? running;
  const failed = operations.some(op => op.status === "failed" || op.status === "unknown");
  const summary = [...new Set(operations.map(op => label(op, zh)))].join(zh ? "、" : ", ");
  return <details className={`chat-operation-group${running ? " is-running" : ""}`} open={open}>
    <summary onClick={() => setExpanded(value => !(value ?? running))}><Icon className={running ? "chat-operation-spinner" : undefined} name={failed ? "alert" : running ? "spinner" : "file"} size={14} /><span>{summary}</span>{running && <em className="chat-running-state">{zh ? "运行中" : "Running"}</em>}{operations.length > 1 && <small>{operations.length}</small>}<Icon name="chevron" size={12} /></summary>
    {open && <div className="chat-operation-list">{operations.slice(-limit).map(op => {
      const sources = events.filter(event => op.source_event_ids.includes(event.id));
      const startEvent = sources.find(event => event.sourceType === "tool.started");
      // Older projected sessions do not carry sourceType, but their tool
      // event remains a trustworthy receipt that can be inspected read-only.
      const terminalEvent = [...sources].reverse().find(event => ["tool.completed", "tool.failed", "tool.unknown", "tool.cancelled", "tool.interrupted"].includes(event.sourceType ?? ""))
        ?? [...sources].reverse().find(event => event.kind === "tool");
      return <OperationItem key={op.id} operation={op} {...(startEvent ? { startEvent } : {})} {...(terminalEvent ? { terminalEvent } : {})} zh={zh} {...(runId ? { runId } : {})} {...(client ? { client } : {})} {...(onInspectEvent ? { onInspectEvent } : {})} {...(onOpenProjectFile ? { onOpenProjectFile } : {})} />;
    })}{operations.length > limit && <button className="chat-process-toggle" onClick={() => setLimit(count => count + 30)} type="button">{zh ? `查看更早的操作（${operations.length - limit}）` : `Show earlier operations (${operations.length - limit})`}</button>}</div>}
  </details>;
}

function OperationItem({ operation, startEvent, terminalEvent, zh, runId, client, onInspectEvent, onOpenProjectFile }: {
  operation: PublicChatOperation; startEvent?: TraceEvent; terminalEvent?: TraceEvent; zh: boolean; runId?: string; client?: WorkbenchClient;
  onInspectEvent?: (event: TraceEvent) => void; onOpenProjectFile?: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const targetEvent = terminalEvent ?? startEvent;
  const running = operation.status === "running";
  const startTimestamp = startEvent?.timestamp ?? targetEvent?.timestamp;
  const duration = targetEvent?.duration ?? elapsedSince(startTimestamp, running ? runningElapsedEnd(startTimestamp, now) : targetEvent?.timestamp ?? localClock(now));
  const status = zh ? { running: "进行中", completed: "已完成", failed: "失败", unknown: "结果待核对", cancelled: "已停止" }[operation.status] : operation.status;
  const iconName = operation.status === "failed" || operation.status === "unknown" ? "alert" : running ? "spinner" : "file";
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  const target = operation.target;
  const openablePath = target && ["read_file", "commit_patch", "preview_patch"].includes(operation.tool_name) && !/^(?:artifact:|\/|\\|[A-Za-z]:[\\/])/u.test(target) ? target : undefined;
  return <article className={`chat-operation is-${operation.status}`}>
    <div className="chat-operation-row">
      <button aria-expanded={expanded} className="chat-operation-toggle" onClick={() => setExpanded(value => !value)} type="button">
        <Icon className={running ? "chat-operation-spinner" : undefined} name={iconName} size={13} />
        <span className="chat-operation-label">{label(operation, zh)}</span><Icon className={expanded ? "is-expanded" : undefined} name="chevron" size={12} />
      </button>
      {openablePath && <ProjectPathLabel path={openablePath} zh={zh} {...(onOpenProjectFile ? { onOpen: onOpenProjectFile } : {})} />}
      <small className={`chat-operation-status is-${operation.status}`}>{running && <i aria-hidden="true" className="chat-running-dot" />}{status}{duration ? ` · ${duration}` : ""}</small>
    </div>
    {expanded && <div className="chat-operation-detail">
      {targetEvent && (targetEvent.commandName || targetEvent.target || targetEvent.exitCode !== undefined || targetEvent.receiptCode) && <dl className="chat-command-receipt">
        {targetEvent.commandName && <div><dt>{zh ? "命令" : "Command"}</dt><dd><code>{targetEvent.commandName}</code></dd></div>}
        {targetEvent.target && <div><dt>{zh ? "目标" : "Target"}</dt><dd><code title={targetEvent.target}>{targetEvent.target}</code></dd></div>}
        {targetEvent.exitCode !== undefined && <div><dt>{zh ? "退出状态" : "Exit status"}</dt><dd><code>{targetEvent.exitCode === null ? (zh ? "未知" : "unknown") : targetEvent.exitCode}</code></dd></div>}
        {targetEvent.receiptCode && <div><dt>{zh ? "回执" : "Receipt"}</dt><dd><code>{targetEvent.receiptCode}</code></dd></div>}
      </dl>}
      {targetEvent?.outputArtifactIds?.map(artifactId => <CommandOutput key={artifactId} artifactId={artifactId} {...(runId ? { runId } : {})} event={targetEvent} {...(client ? { client } : {})} />)}
      {targetEvent && onInspectEvent && <button className="chat-process-toggle" onClick={() => onInspectEvent(targetEvent)} type="button">{zh ? "打开事件详情" : "Open event details"}</button>}
      {!targetEvent && <p>{zh ? "此历史操作的 Ledger 详情尚不可读取。" : "No Ledger details are available for this historical operation."}</p>}
    </div>}
  </article>;
}

function ProjectPathLabel({ path, zh, onOpen }: { path: string; zh: boolean; onOpen?: (path: string) => void }) {
  const title = zh ? `打开项目文件：${path}` : `Open project file: ${path}`;
  return onOpen
    ? <button aria-label={title} className="chat-project-path" onClick={() => onOpen(path)} title={path} type="button"><Icon name="file" size={12} /><code>{path}</code></button>
    : <code className="chat-project-path is-static" title={path}>{path}</code>;
}

function elapsedSince(start: string | undefined, end: string | number): string | undefined {
  if (!start) return undefined;
  const parse = (value: string | number): number | undefined => {
    if (typeof value === "number") return value;
    const absolute = Date.parse(value);
    if (Number.isFinite(absolute)) return absolute;
    const match = /^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/u.exec(value);
    if (!match) return undefined;
    return ((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000 + Number((match[4] ?? "0").padEnd(3, "0"));
  };
  const from = parse(start), to = parse(end);
  if (from === undefined || to === undefined) return undefined;
  let milliseconds = to - from;
  if (milliseconds < 0 && typeof end === "string" && /^\d{1,2}:\d{2}:\d{2}/u.test(end)) milliseconds += 24 * 60 * 60 * 1000;
  if (milliseconds < 0 || !Number.isFinite(milliseconds)) return undefined;
  const seconds = Math.floor(milliseconds / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function localClock(timestamp: number): string {
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
}

function runningElapsedEnd(start: string | undefined, now: number): string | number {
  return start && Number.isFinite(Date.parse(start)) ? now : localClock(now);
}

function CommandOutput({ artifactId, event, runId, client }: { artifactId: string; event: TraceEvent; runId?: string; client?: WorkbenchClient }) {
  const { language } = useI18n();
  const [result, setResult] = useState<{ content: string; sha256: string; byteLength: number; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let current = true;
    if (!runId || !client?.loadCommandOutput) {
      setError(language === "zh-CN" ? "此安装版本无法读取命令输出。" : "Command output is unavailable on this installation.");
      return () => { current = false; };
    }
    setLoading(true); setError(null); setResult(null);
    void client.loadCommandOutput(runId, event.id, artifactId).then((value) => {
      if (current) setResult(value);
    }).catch((caught: unknown) => {
      if (current) setError(caught instanceof Error ? caught.message : String(caught));
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [artifactId, client, event.id, language, runId]);
  return <section className="chat-command-output" aria-label={language === "zh-CN" ? "命令输出" : "Command output"}>
    <strong>{language === "zh-CN" ? "输出" : "Output"}</strong>
    {loading && <p role="status">{language === "zh-CN" ? "正在读取已记录的输出…" : "Loading recorded output…"}</p>}
    {error && <p role="alert">{error}</p>}
    {result && <><pre>{result.content || (language === "zh-CN" ? "（没有输出）" : "(no output)")}{result.truncated ? "\n…" : ""}</pre><small>{result.byteLength} bytes · SHA256 {result.sha256}</small></>}
  </section>;
}

export function UserMessageText({ text }: { text: string }) {
  const { language } = useI18n(); const [expanded, setExpanded] = useState(false);
  const long = text.length > 600 || text.split('\n').length > 10;
  return <><p className={long && !expanded ? "user-message-text is-collapsed" : "user-message-text"}>{text}</p>{long && <button className="user-message-expand" aria-expanded={expanded} onClick={() => setExpanded(!expanded)} type="button">{language === "zh-CN" ? expanded ? "收起" : "显示更多" : expanded ? "Show less" : "Show more"}<Icon name="chevron" size={12} /></button>}</>;
}

export function TurnFailure({ message, status, onInspect, onConfigureModel }: { message: string; status: RunStatus; onInspect?: () => void; onConfigureModel?: () => void }) {
  const { language, t } = useI18n(); const zh = language === "zh-CN";
  const category = classifyPublicChatFailure(message);
  const budgetStop = /(?:Goal budget stopped|Goal request does not fit the remaining token budget|Goal (?:token budget exhausted|time budget exhausted|usage requires review)|Run budget stopped|Run token budget cannot fit the next model request|Run time budget exhausted|Run usage requires review|Software delivery request does not fit the remaining token budget|Software delivery (?:token budget exhausted|time budget exhausted|usage requires review|budget stopped))/i.test(message);
  const explanations = {
    authentication: ["模型认证失败。请在模型设置中检查或替换密钥，再测试连接。", "Model authentication failed. Check or replace the key in model settings and test the connection."],
    model: ["该服务无法使用所选模型。请检查模型名称与可用权限。", "This service cannot use the selected model. Check its name and availability."],
    connect_timeout: ["连接模型服务超时，尚未收到响应。请检查服务地址、代理与网络后测试连接。", "Connecting to the model service timed out before a response. Check the service address, proxy and network, then test the connection."],
    response_timeout: ["模型响应超时。请检查服务状态；再次提交前先核对本轮已完成的操作。", "The model response timed out. Check the service status and inspect completed operations before submitting again."],
    address: ["无法解析或访问模型服务地址。请检查地址和网络设置。", "The model service address could not be resolved or reached. Check the address and network settings."],
    connection: ["连接中断。请检查网络或恢复连接；本轮不会自动重新执行。", "The connection was interrupted. Check the network or repair the connection. This turn will not rerun automatically."],
    unknown: ["本轮未能完成。请查看诊断并核对已执行的操作，再决定如何继续。", "This turn could not finish. Inspect diagnostics and completed operations before continuing."],
  };
  return <section className="chat-turn-failure" role="alert"><p><Icon name="alert" size={15} /><strong>{zh ? status === "cancelled" ? "已停止" : status === "interrupted" ? "任务已中断" : "本轮未完成" : status === "cancelled" ? "Stopped" : "This turn did not finish"}</strong></p><p>{status === "cancelled" ? budgetStop ? t(message) : zh ? "停止请求已记录；操作结果请以对应回执为准。" : "The stop request is recorded; operation outcomes follow their receipts." : explanations[category][zh ? 0 : 1]}</p>{onConfigureModel && ["authentication", "model", "connect_timeout", "response_timeout", "address", "connection"].includes(category) && <button className="chat-process-toggle" onClick={onConfigureModel} type="button">{zh ? "检查模型设置" : "Check model settings"}</button>}<details><summary>{zh ? "查看诊断" : "View diagnostics"}</summary><pre>{message}</pre>{onInspect && <button className="chat-process-toggle" onClick={onInspect} type="button">{zh ? "查看失败记录" : "Inspect failure record"}</button>}</details></section>;
}

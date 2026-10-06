import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { LocalHostConnectionSupervisor, supervisedLocalHost, type ConnectedLocalHost } from "@tracegraph/host";
import { IdentifierSchema, LivePublicActivitySchema, RunProjectionSchema, RunModeSchema, ReasoningEffortSchema, StartChatRequestSchema, StartRunRequestSchema, SubmitUserInputRequestSchema, SessionRunOptionsSnapshotSchema, SessionRunOptionsUpdateRequestSchema, type SessionRunOptionsOverride } from "@tracegraph/contracts";
import { redactSensitiveText } from "@tracegraph/core";
import { terminalLocale } from "@tracegraph/sdk/client";
import { maybeRunWorkbenchCommand, type WorkbenchCommandOptions } from "./workbench-command.js";

interface Selection { projectId?: string | undefined; sessionId?: string | undefined; runId?: string | undefined; mode: "plan" | "execute"; connectionId?: string | undefined; model?: string | undefined; effort?: string | undefined; }
export interface InteractiveChatOptions {
  lines?: AsyncIterable<string>;
  connect?: () => Promise<ConnectedLocalHost>;
  command?: typeof maybeRunWorkbenchCommand;
  write?: (text: string) => void;
  signal?: AbortSignal;
  language?: "en" | "zh-CN";
}

/** Literal argv, not a shell. Command substitution and separators are plain text. */
export function splitSlashArguments(value: string): string[] {
  const parts: string[] = []; let token = "", quoted: string | undefined, started = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (char === "\\" && quoted !== "'") {
      const next = value[++i]; if (next === undefined) throw new Error("Unfinished escape");
      token += next; started = true;
    } else if (quoted) { if (char === quoted) quoted = undefined; else token += char; }
    else if (char === "'" || char === '"') { quoted = char; started = true; }
    else if (/\s/u.test(char)) { if (started) { parts.push(token); token = ""; started = false; } }
    else { token += char; started = true; }
  }
  if (quoted) throw new Error("Unclosed quote");
  if (started) parts.push(token);
  return parts;
}

const active = (status: string) => ["created", "indexing", "running", "awaiting_approval", "awaiting_plan_approval"].includes(status);
const helpEn = `Outlive Agent interactive chat
Write a message, or use // to send text beginning with /.
/new                         Select a new conversation; background tasks continue
/project <id>|none           Select a registered project (use /projects list)
/session <id>                Open existing history without resuming execution
/mode plan|execute           Mode for the next task
/model <connection-id> <model>  Saved service/model for the next task
/effort default|low|medium|high|xhigh|max
/status                      Read the selected Run
/guide <message>             Add explicit guidance to its durable mailbox
/stop [run-id]               Explicitly cancel a Run
/approve-plan <event-id>     Approve an exact plan revision
/run approve|reject <id> --approval-id <id> --action-id <id>
/sessions resume <id>        Explicit recovery through the shared controller
/models list, /skills list, /config get, /doctor, and other named CLI operations
/help, /quit                 Exit disconnects; it does not stop background work
While the selected Run is active, messages join its durable input queue.
Use a separate noninteractive command for stdin credentials, uploads or terminal attach.
`;
const helpZh = `Outlive Agent 交互对话
直接输入消息；以 // 开头可发送以 / 起始的正文。
/new                         选择新对话，后台任务继续
/project <id>|none           选择已登记项目（/projects list 查看）
/session <id>                打开历史，不恢复执行
/mode plan|execute           选择后续任务的计划／执行模式
/model <connection-id> <model>  选择后续任务的已保存服务和模型
/effort default|low|medium|high|xhigh|max
/status                      读取当前 Run
/guide <消息>                向当前任务的持久消息队列提供明确指导
/stop [run-id]               显式取消任务
/approve-plan <event-id>     批准精确计划版本
/run approve|reject <id> --approval-id <id> --action-id <id>
/sessions resume <id>        通过共享控制器显式恢复
/models list、/skills list、/config get、/doctor 及其他命名 CLI 操作
/help、/quit                 退出只断开连接，不停止后台任务
当前 Run 执行期间，普通消息进入该任务的持久输入队列。
凭据 stdin、附件 stdin 和 terminal attach 请单独使用非交互命令。
`;

/** Presentation only: the shared command parser owns validation and business operations. */
export async function maybeRunInteractiveChat(argv: readonly string[], options: InteractiveChatOptions = {}): Promise<number | undefined> {
  if (argv[0] !== "chat" || (argv[1] !== undefined && argv[1] !== "interactive" && !argv[1]!.startsWith("--"))) return undefined;
  const write = options.write ?? ((text: string) => { process.stdout.write(text); });
  const language = options.language ?? terminalLocale(process.env);
  const t = (en: string, zh: string) => language === "zh-CN" ? zh : en;
  const args = argv.slice(argv[1] === "interactive" ? 2 : 1);
  let profileRoot: string | undefined, jsonl = false, entryMode: "plan" | "execute" | undefined;
  const selection: Selection = { mode: "execute" };
  try {
    for (let i = 0; i < args.length; i++) {
      const key = args[i]!;
      if (key === "--help") { write(language === "zh-CN" ? helpZh : helpEn); return 0; }
      if (key === "--jsonl" || key === "--json") { jsonl = true; continue; }
      if (!["--profile-root", "--project-id", "--session-id", "--mode"].includes(key)) throw new Error(`Unknown interactive option: ${key}`);
      const value = args[++i]; if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
      if (key === "--profile-root") profileRoot = value;
      else if (key === "--mode") selection.mode = entryMode = RunModeSchema.parse(value);
      else if (key === "--project-id") selection.projectId = IdentifierSchema.parse(value);
      else selection.sessionId = IdentifierSchema.parse(value);
    }
  } catch (error) { write(JSON.stringify({ error: { code: "invalid_arguments", message: redactSensitiveText(String(error)) } }) + "\n"); return 2; }
  const emit = (kind: string, value: unknown) => {
    if (jsonl) write(JSON.stringify({ kind, value }) + "\n");
    else if (kind === "activity") { const activity = LivePublicActivitySchema.parse(value); write(`[${activity.run_id} #${activity.sequence} ${activity.status}] ${activity.summary}\n`); }
    else write(typeof value === "string" ? value + "\n" : JSON.stringify({ [kind]: value }, null, 2) + "\n");
  };
  const abort = new AbortController(), watchers = new Map<string, Promise<void>>();
  const onAbort = () => abort.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) abort.abort();
  if (!options.signal) process.once("SIGINT", onAbort);
  let connection: ConnectedLocalHost | undefined, input: ReturnType<typeof createInterface> | undefined;
  const command = options.command ?? maybeRunWorkbenchCommand;
  try {
    if (abort.signal.aborted) return 130;
    connection = await (options.connect ?? (async () => {
      const supervisor = new LocalHostConnectionSupervisor(profileRoot === undefined ? {} : { profileRoot });
      try { await supervisor.initialize(); return await supervisedLocalHost(supervisor); }
      catch (error) { await supervisor.close(); throw error; }
    }))();
    const client = connection.client;
    // Commands borrow the live client; their finally blocks cannot close the shell's subscriptions.
    const borrowed = { ...connection, close: async () => undefined };
    const execute = async (words: string[], display = true) => {
      if (words.includes("--profile-root") || words.some(word => ["--key-stdin", "--stdin"].includes(word)) || words.some((word, index) => word === "--input-file" && words[index + 1] === "-") || (words[0] === "terminal" && words[1] === "attach")) throw new Error(t("Use a separate CLI command for profile switching or terminal stdin.", "切换 Profile 或消费终端 stdin 请使用单独的 CLI 命令。"));
      const chunks: string[] = [], errors: string[] = [];
      const commandOptions: WorkbenchCommandOptions = { connect: async () => borrowed, signal: abort.signal, write: text => chunks.push(text), writeError: text => errors.push(text) };
      const code = await command([...words, ...(profileRoot === undefined ? [] : ["--profile-root", profileRoot]), "--json"], commandOptions);
      if (code === undefined) throw new Error(t("Unknown slash command. Use /help.", "未知斜杠指令，请查看 /help。"));
      const text = chunks.join("").trim(), err = errors.join("").trim();
      if (err) emit("error", JSON.parse(err));
      // Streaming named commands may contain several canonical JSONL records.
      let result: unknown;
      if (text) { try { result = JSON.parse(text); } catch { result = text.split("\n").filter(Boolean).map(line => JSON.parse(line)); } if (display) emit("receipt", result); }
      return { code, result };
    };
    const readRun = async (runId: string) => { const run = RunProjectionSchema.parse(await client.getRun(runId)); if (run.run_id !== runId) throw new Error("Run response does not match the selected task"); return run; };
    const sendInput = async (runId: string, body: string) => {
      const input = SubmitUserInputRequestSchema.parse({ command_id: randomUUID(), input_id: randomUUID(), kind: "message", body });
      emit("receipt", await client.submitUserInput(runId, input));
    };
    const saveNextOptions = async (change: SessionRunOptionsOverride) => {
      if (!selection.sessionId) return;
      const snapshot = SessionRunOptionsSnapshotSchema.parse(await client.getSessionRunOptions(selection.sessionId));
      if (snapshot.session_id !== selection.sessionId) throw new Error("Options belong to another conversation");
      const request = SessionRunOptionsUpdateRequestSchema.parse({ command_id: randomUUID(), expected_revision: snapshot.revision, overrides: { ...(snapshot.overrides ?? snapshot.options), ...change } });
      emit("receipt", await client.updateSessionRunOptions(selection.sessionId, request));
    };
    const watch = (runId: string) => {
      if (watchers.has(runId)) return;
      if (watchers.size >= 32) { emit("notice", t("Background task started; use /run activity <id> to observe it. The interactive subscription limit is 32.", "后台任务已开始；使用 /run activity <id> 查看进度。当前交互订阅上限为 32。")); return; }
      const promise = (async () => {
        const displayed = new Set<string>();
        for await (const raw of client.streamLiveActivities(runId, { signal: abort.signal })) {
          if (abort.signal.aborted) break;
          const activity = LivePublicActivitySchema.parse(raw);
          if (activity.run_id !== runId) throw new Error("Activity belongs to another task");
          // The volatile sequence restarts with an owner; canonical event IDs do not.
          if (displayed.has(activity.source_event_id)) continue;
          displayed.add(activity.source_event_id);
          emit("activity", activity);
        }
        if (abort.signal.aborted) return;
        const run = await readRun(runId);
        emit("run_status", { run_id: run.run_id, status: run.status, last_sequence: run.last_sequence, ...(run.failure_code ? { failure_code: run.failure_code } : {}) });
        if (run.status === "completed" && run.outcome) emit("answer", { run_id: run.run_id, content: redactSensitiveText(run.outcome) });
      })().catch(error => { if (!abort.signal.aborted) emit("error", { code: "activity_disconnected", run_id: runId, message: redactSensitiveText(error instanceof Error ? error.message : "Activity unavailable") }); }).finally(() => watchers.delete(runId));
      watchers.set(runId, promise);
    };
    const selectSession = async (id: string, overrideMode?: "plan" | "execute") => {
      const session = await client.getSession(IdentifierSchema.parse(id));
      const projects = await client.listProjects();
      const settings = SessionRunOptionsSnapshotSchema.parse(await client.getSessionRunOptions(id));
      if (settings.session_id !== id) throw new Error("Options belong to another conversation");
      selection.sessionId = id;
      selection.projectId = projects.some(project => project.project_id === session.header.project_id) ? session.header.project_id : undefined;
      selection.runId = session.header.run_ids.at(-1);
      selection.mode = settings.options.mode;
      selection.connectionId = settings.options.connection_id;
      selection.model = settings.options.model;
      selection.effort = settings.options.reasoning_effort;
      if (overrideMode !== undefined) { await saveNextOptions({ mode: overrideMode }); selection.mode = overrideMode; }
      emit("selection", { session_id: id, project_id: selection.projectId });
      if (selection.runId) { const run = await readRun(selection.runId); if (active(run.status)) watch(run.run_id); else emit("run_status", { run_id: run.run_id, status: run.status }); }
    };
    if (selection.projectId && !(await client.listProjects()).some(project => project.project_id === selection.projectId)) throw new Error(t("Select a registered project.", "请选择已登记的项目。"));
    if (selection.sessionId) await selectSession(selection.sessionId, entryMode);
    emit("help", language === "zh-CN" ? helpZh : helpEn);
    if (!options.lines) { input = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY && process.stdout.isTTY && !jsonl }); if (process.stdin.isTTY && !jsonl) { input.setPrompt("outlive> "); input.prompt(); } }
    const closeInput = () => input?.close(); abort.signal.addEventListener("abort", closeInput, { once: true });
    for await (const value of options.lines ?? input!) {
      if (abort.signal.aborted) break;
      const line = value.trim(); if (!line) continue;
      try {
        if (line === "/quit" || line === "/exit") break;
        if (line === "/help") { emit("help", language === "zh-CN" ? helpZh : helpEn); continue; }
        if (line === "/new") { selection.sessionId = undefined; selection.runId = undefined; emit("selection", t("New conversation selected; background tasks continue.", "已选择新对话，后台任务继续。")); continue; }
        if (line.startsWith("/project ")) {
          const id = line.slice(9).trim();
          if (id !== "none" && !(await client.listProjects()).some(project => project.project_id === IdentifierSchema.parse(id))) throw new Error(t("Project is not registered.", "此项目未登记。"));
          selection.projectId = id === "none" ? undefined : id; selection.sessionId = undefined; selection.runId = undefined;
          emit("selection", { project_id: selection.projectId }); continue;
        }
        if (line.startsWith("/session ")) { await selectSession(line.slice(9).trim()); continue; }
        if (line.startsWith("/mode ")) { const mode = RunModeSchema.parse(line.slice(6).trim()); await saveNextOptions({ mode }); selection.mode = mode; emit("next_task", { mode }); continue; }
        if (line.startsWith("/effort ")) { const effort = ReasoningEffortSchema.parse(line.slice(8).trim()); await saveNextOptions({ reasoning_effort: effort }); selection.effort = effort; emit("next_task", { reasoning_effort: effort }); continue; }
        if (line.startsWith("/model ")) {
          const words = splitSlashArguments(line.slice(7)); if (words.length !== 2) throw new Error("/model <connection-id> <model>");
          const connections = await client.getModelConnections(), saved = connections.connections.find(item => item.connection_id === words[0]);
          if (!saved || !saved.models.includes(words[1]!)) throw new Error(t("Choose a saved connection and one of its configured models.", "请选择已保存连接及其已配置模型。"));
          await saveNextOptions({ connection_id: saved.connection_id, model: words[1]! });
          selection.connectionId = saved.connection_id; selection.model = words[1]!; emit("next_task", { connection_id: selection.connectionId, model: selection.model }); continue;
        }
        if (line === "/status") { if (!selection.runId) throw new Error(t("No Run selected.", "尚未选择任务。")); await execute(["run", "get", selection.runId]); continue; }
        if (line.startsWith("/stop") && /^\/stop(?:\s|$)/u.test(line)) { const id = line.slice(5).trim() || selection.runId; if (!id) throw new Error("/stop <run-id>"); await execute(["run", "stop", IdentifierSchema.parse(id)]); continue; }
        if (line.startsWith("/approve-plan ")) { if (!selection.runId) throw new Error("No Run selected"); await execute(["run", "approve-plan", selection.runId, "--plan-event-id", IdentifierSchema.parse(line.slice(14).trim())]); continue; }
        if (line.startsWith("/guide ")) { if (!selection.runId) throw new Error("No Run selected"); await sendInput(selection.runId, line.slice(7)); continue; }
        if (line.startsWith("/") && !line.startsWith("//")) {
          const words = splitSlashArguments(line.slice(1)), response = await execute(words);
          if (response.code === 0 || response.code === 3) {
            const run = RunProjectionSchema.safeParse(response.result);
            if (run.success) {
              // A named resume/start may select another conversation. Its saved
              // next-task options, not the shell's previous selection, own follow-ups.
              const settings = run.data.session_id === undefined ? undefined : SessionRunOptionsSnapshotSchema.parse(await client.getSessionRunOptions(run.data.session_id));
              if (settings && settings.session_id !== run.data.session_id) throw new Error("Options belong to another conversation");
              const projects = await client.listProjects();
              selection.projectId = projects.some(project => project.project_id === run.data.project_id) ? run.data.project_id : undefined;
              selection.runId = run.data.run_id; selection.sessionId = run.data.session_id;
              selection.mode = settings?.options.mode ?? run.data.mode; selection.connectionId = settings?.options.connection_id;
              selection.model = settings?.options.model; selection.effort = settings?.options.reasoning_effort;
              watch(run.data.run_id);
            }
          }
          continue;
        }
        const body = line.startsWith("//") ? line.slice(1) : value;
        if (selection.runId && active((await readRun(selection.runId)).status)) {
          await sendInput(selection.runId, body);
          continue;
        }
        // Messages never become argv. Even a body equal to --help/--api-key is literal task text.
        const request = StartChatRequestSchema.parse({ command_id: randomUUID(), task: body, mode: selection.mode,
          ...(selection.sessionId ? { session_id: selection.sessionId } : {}),
          ...(selection.effort ? { reasoning_effort: selection.effort } : {}),
          ...(selection.connectionId || selection.model ? { run_options: { mode: selection.mode, ...(selection.connectionId ? { connection_id: selection.connectionId } : {}), ...(selection.model ? { model: selection.model } : {}), ...(selection.effort ? { reasoning_effort: selection.effort } : {}) } } : {}) });
        const run = RunProjectionSchema.parse(selection.projectId ? await client.startRun(StartRunRequestSchema.parse({ ...request, project_id: selection.projectId })) : await client.startChat(request));
        selection.runId = run.run_id; selection.sessionId = run.session_id;
        emit("admission", { run_id: run.run_id, session_id: run.session_id, project_id: run.project_id, status: run.status, mode: run.mode });
        watch(run.run_id);
      } catch (error) { emit("error", { code: "interactive_operation_failed", message: redactSensitiveText(error instanceof Error ? error.message : "Interactive operation failed") }); }
      finally { if (!abort.signal.aborted && process.stdin.isTTY && !jsonl) input?.prompt(); }
    }
    abort.signal.removeEventListener("abort", closeInput);
    return abort.signal.aborted ? 130 : 0;
  } catch (error) { emit("error", { code: "interactive_connection_failed", message: redactSensitiveText(error instanceof Error ? error.message : "Connection unavailable") }); return 1; }
  finally {
    abort.abort(); input?.close();
    await Promise.allSettled([...watchers.values()]);
    await connection?.close();
    options.signal?.removeEventListener("abort", onAbort);
    if (!options.signal) process.removeListener("SIGINT", onAbort);
  }
}

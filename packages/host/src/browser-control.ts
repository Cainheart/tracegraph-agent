import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type ElementHandle, type Page } from "playwright-core";
import {
  BrowserCommandSchema, BrowserCommandReceiptSchema, BrowserGrantRequestSchema, BrowserGrantSchema, BrowserObservationSchema, BrowserStatusSchema,
  type BrowserCommand, type BrowserCommandResult, type BrowserGrant, type BrowserGrantRequest,
  type BrowserObservation, type BrowserStatus, type BrowserTab,
} from "@tracegraph/contracts";
import { atomicPrivateJson, privateDirectory } from "./local-profile.js";
import { WorkbenchJournal, workbenchError } from "./workbench-journal.js";
import type {VisualEvidenceRecorder} from "./visual-evidence-control.js";

export interface BrowserControlContext {
  profileRoot: string;
  executablePath: string;
  runtimeKind: "bundled" | "development";
  resolveProject(projectId: string): Promise<void>;
  /** Trusted native human interaction. Model/HTTP input cannot supply this callback. */
  authorizeGrant?(request: BrowserGrantRequest, signal: AbortSignal): Promise<boolean>;
  /** Trusted construction seam, never selected through client/model input. */
  launchBrowser?(): Promise<Browser>;
  visualEvidence?:VisualEvidenceRecorder;
  /** Outlive internal origins are never browser targets, even with a grant. */
  forbiddenOrigins?: readonly string[] | (() => readonly string[]);
}
type NodeRef = { handle: ElementHandle<Node>; fingerprint: string };
type TabState = { snapshot: BrowserTab; context: BrowserContext; page: Page; refs: Map<string, NodeRef>; queue: Promise<unknown> };
const hash = (bytes: string | Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;
const failure = (code: string, message: string, status = 409) => workbenchError(code, message, status);
/** Chromium's own startup complaint is the only diagnosis for a refused launch, so keep it bounded. */
const launchFailureDetail = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim().slice(0, 300) || "no detail";

/** Business controller shared by authenticated clients and registered Runtime tools. */
export class BrowserControl {
  readonly #context: BrowserControlContext;
  readonly #journal: WorkbenchJournal;
  readonly #tabs = new Map<string, TabState>();
  readonly #evidence = new Map<string, { path: string; project: string; sha256: string }>();
  #grants: BrowserGrant[] = [];
  #browser: Browser | undefined;
  #launch: Promise<Browser> | undefined;
  #grantQueue: Promise<unknown> = Promise.resolve();
  #available = false;
  #closed = false;
  readonly #lifetime = new AbortController();
  readonly #pending = new Set<Promise<unknown>>();
  #closePromise: Promise<void> | undefined;
  #cleanupFailed = false;
  private constructor(context: BrowserControlContext) {
    this.#context = context; this.#journal = new WorkbenchJournal(join(context.profileRoot, "workbench-events"));
  }
  static async create(context: BrowserControlContext): Promise<BrowserControl> {
    const control = new BrowserControl(context);
    await control.#journal.initialize();
    await privateDirectory(join(context.profileRoot, "browser-evidence"));
    try {
      const saved: unknown = JSON.parse(await readFile(control.#grantFile, "utf8"));
      if (!Array.isArray(saved) || saved.length > 128) throw failure("browser_grants_invalid", "Saved browser permissions need repair");
      control.#grants = saved.map(item => BrowserGrantSchema.parse(item));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try { const info = await lstat(context.executablePath); control.#available = info.isFile() && !info.isSymbolicLink(); } catch { /* Missing browser affects only this feature. */ }
    return control;
  }
  get #grantFile() { return join(this.#context.profileRoot, "browser-grants.json"); }
  #assertOpen() { if (this.#closed) throw failure("browser_closed", "Browser control is closed", 503); }
  #track<T>(operation: Promise<T>): Promise<T> {
    this.#pending.add(operation);
    void operation.finally(() => this.#pending.delete(operation)).catch(() => undefined);
    return operation;
  }
  #human(execute: (signal: AbortSignal) => Promise<boolean>): Promise<boolean> {
    this.#assertOpen();
    return new Promise((resolve, reject) => {
      const confirmation = new AbortController();
      let settled = false;
      const done = (error?: unknown, value?: boolean) => {
        if (settled) return;
        settled = true; clearTimeout(timer); this.#lifetime.signal.removeEventListener("abort", abort);
        error === undefined ? resolve(value!) : reject(error);
      };
      const abort = () => { confirmation.abort(); done(failure("browser_closed", "Browser control was closed before confirmation", 503)); };
      const timer = setTimeout(() => { confirmation.abort(); done(failure("browser_confirmation_timeout", "Human confirmation expired; issue a new explicit request")); }, 30_000);
      timer.unref(); this.#lifetime.signal.addEventListener("abort", abort, { once: true });
      if (this.#lifetime.signal.aborted) { abort(); return; }
      try { void execute(confirmation.signal).then(value => done(undefined, value), error => done(error)); }
      catch (error) { done(error); }
    });
  }
  async status(): Promise<BrowserStatus> {
    this.#assertOpen();
    return BrowserStatusSchema.parse({ available: this.#available, human_grant_available: !!this.#context.authorizeGrant, runtime: this.#available ? this.#context.runtimeKind : "unavailable",
      ...(!this.#available ? { reason: "The matching browser runtime is missing; repair the application installation" } : {}),
      grants: this.#grants, tabs: [...this.#tabs.values()].map(tab => tab.snapshot).filter(tab => !["closed", "interrupted"].includes(tab.state)).concat([...this.#tabs.values()].map(tab => tab.snapshot).filter(tab => ["closed", "interrupted"].includes(tab.state))).slice(0, 8) });
  }
  /** Internal owner barrier: interrupted tabs are not proof of process quiescence. */
  ownerUpgradeBusy():boolean {
    return this.#pending.size>0||this.#cleanupFailed||[...this.#tabs.values()].some(tab=>tab.snapshot.state!=="closed");
  }
  async reconcile(commandId:string) {
    this.#assertOpen();
    const receipt=await this.#journal.inspect(commandId);
    if(receipt.operation && !["browser.grant","browser.open","browser.navigate","browser.click","browser.fill","browser.key","browser.close","browser.takeover","browser.return-control","browser.revoke"].includes(receipt.operation)) throw failure("browser_receipt_scope","This receipt belongs to another operation",403);
    const {operation:_operation,...value}=receipt;
    if(receipt.operation==="browser.grant" && receipt.state==="completed") value.result={command_id:commandId,status:"succeeded",grant:BrowserGrantSchema.parse(receipt.result)};
    return BrowserCommandReceiptSchema.parse(value);
  }
  async requestGrant(value: BrowserGrantRequest): Promise<BrowserGrant> {
    this.#assertOpen();
    const input = BrowserGrantRequestSchema.parse(value);
    const operation = this.#grantQueue.then(() => {
      this.#assertOpen();
      return this.#journal.once(input.command_id, "browser.grant", input, async () => {
      this.#assertOpen();
      await this.#context.resolveProject(input.project_id);
      this.#assertOpen();
      for (const origin of input.origins) this.#assertPublicTarget(origin);
      if (!this.#context.authorizeGrant) throw failure("browser_grant_ui_unavailable", "Browser permission requires a trusted user confirmation", 503);
      if (!await this.#human(signal => this.#context.authorizeGrant!(input, signal))) throw failure("browser_grant_denied", "Browser permission was declined", 403);
      this.#assertOpen();
      if (this.#grants.length >= 128) throw failure("browser_grant_limit", "Remove an old browser permission before adding another");
      const { command_id: _commandId, ...authority } = input;
      const grant = BrowserGrantSchema.parse({ ...authority, grant_id: `browser-grant:${randomUUID()}`, revision: 0, state: "active", created_at: new Date().toISOString() });
      this.#grants.push(grant); await atomicPrivateJson(this.#grantFile, this.#grants); return grant;
    }); });
    this.#grantQueue = operation.catch(() => undefined); return this.#track(operation);
  }
  /** Actor scope is a trusted Runtime binding; clients use the human channel. */
  async command(value: BrowserCommand, actor?: { projectId: string; mode: "plan" | "execute"; signal?: AbortSignal }): Promise<BrowserCommandResult> {
    this.#assertOpen();
    const input = BrowserCommandSchema.parse(value);
    if (actor && ["revoke", "takeover", "return-control", "open"].includes(input.type)) throw failure("browser_user_operation", "This operation requires the user browser control", 403);
    if (actor?.mode === "plan") throw failure("browser_plan_readonly", "Plan mode can observe the browser; actions require execution mode", 403);
    const execute = () => {
      this.#assertOpen();
      return this.#journal.once(input.command_id, `browser.${input.type}`, input, async () => {
      this.#assertOpen();
      if (actor?.signal?.aborted) throw failure("browser_cancelled", "Browser action was cancelled before dispatch");
      const abort = () => { if ("tab_id" in input) void this.#tabs.get(input.tab_id)?.page.close().catch(() => undefined); };
      actor?.signal?.addEventListener("abort", abort, { once: true });
      try { return await this.#execute(input, actor?.projectId, actor?.signal); }
      finally { actor?.signal?.removeEventListener("abort", abort); }
    }); };
    // Admit the command before changing ownership. A takeover bypasses the tab
    // queue so it fences actions still checking their target, while retries and
    // conflicting identifiers cannot mutate state outside the canonical receipt.
    if (input.type === "takeover") return this.#track(execute());
    if ("tab_id" in input) {
      const tab = this.#tab(input.tab_id, actor?.projectId);
      const next = tab.queue.then(execute, execute); tab.queue = next.catch(() => undefined); return this.#track(next);
    }
    const next = this.#grantQueue.then(execute, execute); this.#grantQueue = next.catch(() => undefined); return this.#track(next);
  }
  async #execute(input: BrowserCommand, projectId?: string, signal?: AbortSignal): Promise<BrowserCommandResult> {
    this.#assertOpen();
    const base = { command_id: input.command_id, status: "succeeded" as const };
    if (input.type === "revoke") {
      const grant = this.#grant(input.grant_id);
      if (grant.revision !== input.expected_revision) throw failure("browser_revision_conflict", "Browser permission changed; refresh before continuing");
      grant.state = "revoked"; grant.revision++; await atomicPrivateJson(this.#grantFile, this.#grants);
      for (const tab of this.#tabs.values()) if (tab.snapshot.grant_id === grant.grant_id) await this.#closeTab(tab);
      return { ...base, grant };
    }
    if (input.type === "open") {
      if (!this.#available) throw failure("browser_runtime_unavailable", "Repair the application browser installation", 503);
      if (this.#tabs.size >= 128 || [...this.#tabs.values()].filter(tab => !["closed", "interrupted"].includes(tab.snapshot.state)).length >= 8) throw failure("browser_tab_limit", "Close a browser tab before opening another; the browser session retains at most 128 tab records");
      const grant = this.#grant(input.grant_id);
      if (grant.state !== "active") throw failure("browser_grant_inactive", "Choose an active browser permission", 403);
      await this.#context.resolveProject(grant.project_id); this.#assertOpen(); this.#assertOrigin(input.url, grant);
      if (grant.duration === "once") { grant.state = "consumed"; grant.revision++; await atomicPrivateJson(this.#grantFile, this.#grants); }
      const browser = await this.#ensureBrowser();
      this.#assertOpen();
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: false, serviceWorkers: "block" });
      if (this.#closed) { await context.close(); this.#assertOpen(); }
      await context.route("**/*", async route => {
        try { this.#assertOrigin(route.request().url(), grant); await route.continue(); } catch { await route.abort("blockedbyclient"); }
      });
      if (this.#closed) { await context.close(); this.#assertOpen(); }
      const page = await context.newPage();
      if (this.#closed) { await context.close(); this.#assertOpen(); }
      const tab: TabState = { snapshot: { tab_id: `browser-tab:${randomUUID()}`, project_id: grant.project_id, grant_id: grant.grant_id, url: "about:blank", title: "", state: "agent", revision: 0 }, context, page, refs: new Map(), queue: Promise.resolve() };
      this.#tabs.set(tab.snapshot.tab_id, tab);
      context.on("page", other => { if (other !== page) void other.close().catch(() => undefined); });
      page.on("framenavigated", frame => { if (frame === page.mainFrame()) { tab.snapshot = { ...tab.snapshot, url: this.#safeUrl(frame.url()), revision: tab.snapshot.revision + 1 }; void this.#clearRefs(tab); } });
      page.on("close", () => { tab.snapshot = { ...tab.snapshot, state: "closed", revision: tab.snapshot.revision + 1 }; });
      try { this.#assertOpen(); await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 15_000 }); await this.#refresh(tab); return { ...base, tab: tab.snapshot }; }
      catch { await this.#closeTab(tab); throw failure("browser_effect_unknown", "The page did not confirm navigation; inspect the target before trying again"); }
    }
    const tab = this.#tab(input.tab_id, projectId);
    if (input.type === "close") { await this.#closeTab(tab); return { ...base, tab: tab.snapshot }; }
    if (input.type === "takeover") {
      if (["closed", "interrupted"].includes(tab.snapshot.state)) throw failure("browser_tab_closed", "Open a browser tab before taking control");
      tab.snapshot = { ...tab.snapshot, state: "human", revision: tab.snapshot.revision + 1 };
      return { ...base, tab: tab.snapshot };
    }
    if ("expected_revision" in input && input.expected_revision !== tab.snapshot.revision) throw failure("browser_revision_conflict", "The browser changed; observe it again before acting");
    if (input.type === "return-control") { tab.snapshot = { ...tab.snapshot, state: "agent", revision: tab.snapshot.revision + 1 }; await this.#clearRefs(tab); return { ...base, tab: tab.snapshot }; }
    if (tab.snapshot.state !== "agent") throw failure("browser_human_control", "The user controls this browser; wait for them to return control", 403);
    const grant = this.#grant(tab.snapshot.grant_id);
    if (grant.state === "revoked") throw failure("browser_grant_revoked", "Browser permission was revoked", 403);
    this.#assertOrigin(tab.page.url(), grant);
    let target: NodeRef | undefined;
    if ("ref" in input) {
      target = tab.refs.get(input.ref); if (!target) throw failure("browser_target_stale", "Observe the browser again to select this element");
      try { if (await this.#fingerprint(target.handle) !== target.fingerprint) throw new Error("changed"); } catch { throw failure("browser_target_stale", "The selected element changed; observe it again"); }
    }
    if (signal?.aborted) throw failure("browser_cancelled", "Browser action was cancelled before dispatch");
    this.#assertOpen();
    // A takeover can arrive during asynchronous target checks; recheck at dispatch.
    if (tab.snapshot.state !== "agent") throw failure("browser_human_control", "The user took control before dispatch", 403);
    tab.snapshot = { ...tab.snapshot, revision: tab.snapshot.revision + 1 };
    try {
      if (input.type === "navigate") { this.#assertOrigin(input.url, grant); await tab.page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 15_000 }); }
      else if (input.type === "click") await target!.handle.click({ timeout: 5_000 });
      else if (input.type === "fill") {
        const privateField = await target!.handle.evaluate(element => element instanceof HTMLInputElement && ["password", "file"].includes(element.type));
        if (privateField) throw failure("browser_private_input", "Private credentials and file uploads require user takeover", 403);
        this.#assertOpen();
        if (signal?.aborted) throw failure("browser_cancelled", "Browser action was cancelled before dispatch");
        if (tab.snapshot.state !== "agent") throw failure("browser_human_control", "The user took control before dispatch", 403);
        await target!.handle.fill(input.text, { timeout: 5_000 });
      } else await tab.page.keyboard.press(input.key);
      await this.#refresh(tab); return { ...base, tab: tab.snapshot };
    } catch (error) { if ((error as { code?: string }).code?.startsWith("browser_")) throw error; throw failure("browser_effect_unknown", "The browser did not confirm this action; inspect the page before trying again"); }
    finally { await this.#clearRefs(tab); }
  }
  async observe(tabId: string, projectId?: string): Promise<BrowserObservation> {
    this.#assertOpen();
    const tab = this.#tab(tabId, projectId);
    const operation = async () => {
      this.#assertOpen();
      if (["closed", "interrupted"].includes(tab.snapshot.state)) throw failure("browser_tab_closed", "Open a browser tab before observing it");
      if (this.#grant(tab.snapshot.grant_id).state === "revoked") throw failure("browser_grant_revoked", "Browser permission was revoked", 403);
      await this.#refresh(tab); await this.#clearRefs(tab);
      tab.snapshot = { ...tab.snapshot, revision: tab.snapshot.revision + 1 };
      const elements: BrowserObservation["elements"] = [];
      const handles = await tab.page.locator("a[href],button,input:not([type=password]):not([type=file]),textarea,select,[role=button],[role=link]").elementHandles();
      for (const handle of handles.slice(0, 200)) {
        if (!await handle.isVisible()) { await handle.dispose(); continue; }
        const ref = `browser-node:${randomUUID()}`;
        const data = await handle.evaluate(element => { if (!(element instanceof Element)) throw new Error("Not an element"); return { role: element.getAttribute("role") || element.tagName.toLowerCase(), text: (element.getAttribute("aria-label") || element.textContent || element.getAttribute("placeholder") || "").trim().slice(0, 512), input_type: element instanceof HTMLInputElement ? element.type : undefined }; });
        tab.refs.set(ref, { handle, fingerprint: await this.#fingerprint(handle) }); elements.push({ ref, ...data });
      }
      for (const handle of handles.slice(200)) await handle.dispose();
      const bytes = await tab.page.screenshot({ type: "png", fullPage: false, timeout: 5_000 });
      this.#assertOpen();
      if (bytes.length > 8 * 1024 * 1024) throw failure("browser_evidence_too_large", "Browser evidence exceeds the limit");
      const evidenceId = `browser-evidence:${randomUUID()}`, path = join(this.#context.profileRoot, "browser-evidence", evidenceId.split(":")[1] + ".png");
      await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
      await this.#context.visualEvidence?.registerBrowser({evidence_id:evidenceId,project_id:tab.snapshot.project_id,sha256:hash(bytes),byte_length:bytes.length,captured_at:new Date().toISOString()});
      this.#evidence.set(evidenceId, { path, project: tab.snapshot.project_id, sha256: hash(bytes) });
      const observation = BrowserObservationSchema.parse({ tab: tab.snapshot, elements, evidence: { evidence_id: evidenceId, sha256: hash(bytes), mime_type: "image/png", byte_length: bytes.length } });
      await this.#journal.once(`browser-observe:${randomUUID()}`, "browser.observe", { tab_id: tabId, revision: tab.snapshot.revision }, async () => ({ tab: tab.snapshot, evidence: observation.evidence }));
      return observation;
    };
    const next = tab.queue.then(operation, operation); tab.queue = next.catch(() => undefined); return this.#track(next);
  }
  async evidence(evidenceId: string, projectId?: string): Promise<Uint8Array> {
    this.#assertOpen();
    const entry = this.#evidence.get(evidenceId); if (!entry || projectId && entry.project !== projectId) throw failure("browser_evidence_scope", "Browser evidence is outside this task scope", 403);
    const bytes = await readFile(entry.path); if (hash(bytes) !== entry.sha256) throw failure("browser_evidence_changed", "Browser evidence changed on disk"); return bytes;
  }
  async registerRunEvidenceCopy(evidenceId:string,artifact:import("@tracegraph/contracts").ArtifactRef){await this.#context.visualEvidence?.registerRunCopy(evidenceId,artifact);}
  #tab(id: string, projectId?: string): TabState { const tab = this.#tabs.get(id); if (!tab || projectId && tab.snapshot.project_id !== projectId) throw failure("browser_tab_scope", "Browser tab is outside this task scope", 403); return tab; }
  #grant(id: string): BrowserGrant { const grant = this.#grants.find(item => item.grant_id === id); if (!grant) throw failure("browser_grant_missing", "Choose a browser permission before continuing", 403); return grant; }
  #safeUrl(value: string) { try { const url = new URL(value); url.hash = ""; url.search = ""; return url.toString().slice(0, 4096); } catch { return "about:blank"; } }
  #assertPublicTarget(value: string) { const url = new URL(value), forbidden = typeof this.#context.forbiddenOrigins === "function" ? this.#context.forbiddenOrigins() : this.#context.forbiddenOrigins; if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hostname === "outlive.local" || forbidden?.includes(url.origin)) throw failure("browser_origin_denied", "This browser target is outside the allowed scope", 403); }
  #assertOrigin(value: string, grant: BrowserGrant) { this.#assertPublicTarget(value); if (grant.state === "revoked" || !grant.origins.includes(new URL(value).origin)) throw failure("browser_origin_denied", "This website has not been authorized", 403); }
  async #fingerprint(handle: NodeRef["handle"]) { return handle.evaluate(element => { if (!(element instanceof Element) || !element.isConnected) throw new Error("detached"); return JSON.stringify({ tag: element.tagName, text: element.textContent?.slice(0, 512), role: element.getAttribute("role"), href: element.getAttribute("href"), type: element.getAttribute("type"), name: element.getAttribute("name"), label: element.getAttribute("aria-label") }); }); }
  async #clearRefs(tab: TabState) { const refs = [...tab.refs.values()]; tab.refs.clear(); await Promise.allSettled(refs.map(ref => ref.handle.dispose())); }
  async #refresh(tab: TabState) { tab.snapshot = { ...tab.snapshot, url: this.#safeUrl(tab.page.url()), title: (await tab.page.title()).slice(0, 512) }; }
  async #ensureBrowser(): Promise<Browser> {
    this.#assertOpen();
    if (this.#browser?.isConnected()) return this.#browser;
    this.#launch ??= (this.#context.launchBrowser ? this.#context.launchBrowser() : chromium.launch({ executablePath: this.#context.executablePath, headless: true, chromiumSandbox: true, timeout: 15_000 })).then(async browser => {
      if (this.#closed) {
        try { await browser.close(); } catch { this.#cleanupFailed = true; }
        this.#assertOpen();
      }
      this.#browser = browser; browser.on("disconnected", () => { for (const tab of this.#tabs.values()) if (tab.snapshot.state !== "closed") tab.snapshot = { ...tab.snapshot, state: "interrupted", revision: tab.snapshot.revision + 1 }; }); return browser;
    }).catch(error => {
      if ((error as { code?: string }).code === "browser_closed") throw error;
      this.#available = false; throw failure("browser_runtime_unavailable", `The matching browser could not start; repair the application installation (${launchFailureDetail(error)})`, 503);
    }).finally(() => { this.#launch = undefined; });
    return this.#launch;
  }
  async #closeTab(tab: TabState) { tab.snapshot = { ...tab.snapshot, state: "closed", revision: tab.snapshot.revision + 1 }; await this.#clearRefs(tab); await tab.context.close(); }
  close(): Promise<void> {
    this.#closePromise ??= this.#shutdown();
    return this.#closePromise;
  }
  async #shutdown(): Promise<void> {
    this.#closed = true; this.#lifetime.abort();
    try { await this.#browser?.close(); } catch { this.#cleanupFailed = true; }
    // A launch which resolves after close cleans its own browser before settling.
    await this.#launch?.catch(() => undefined);
    while (this.#pending.size) await Promise.allSettled([...this.#pending]);
    for (const tab of this.#tabs.values()) await this.#clearRefs(tab);
    if (this.#cleanupFailed) throw failure("browser_cleanup_failed", "The browser did not confirm shutdown; inspect its process before restarting", 503);
  }
}

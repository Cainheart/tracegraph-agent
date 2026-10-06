import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import { BrowserControl } from "./browser-control.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("Outlive's real isolated browser", () => {
  it("uses trusted origin grants, real DOM effects, CAS references, takeover, revoke and canonical receipts", async () => {
    const profileRoot = await mkdtemp(join(tmpdir(), "outlive-browser-"));
    let writes = 0, posted = "", forbiddenRequests = 0, grants = 0;
    const outside = createServer((_request, response) => { forbiddenRequests++; response.end("outside"); });
    outside.listen(0, "127.0.0.1"); await once(outside, "listening");
    const outsideOrigin = `http://127.0.0.1:${(outside.address() as { port: number }).port}`;
    const service = createServer((request, response) => {
      if (request.url === "/write") {
        writes++;
        void (async () => { for await (const chunk of request) posted += String(chunk); response.end("ok"); })();
      } else if (request.url === "/redirect") { response.writeHead(302, { location: outsideOrigin }); response.end(); }
      else {
        response.setHeader("content-type", "text/html");
        response.end(`<title>Real browser fixture</title><input aria-label="Name" id="name"><input type="password" value="private-key"><button id="save">Save</button><div id="status"></div><img src="${outsideOrigin}/asset"><script>document.getElementById('save').onclick=async()=>{await fetch('/write',{method:'POST',body:document.getElementById('name').value});document.getElementById('status').textContent='Saved'};</script>`);
      }
    });
    service.listen(0, "127.0.0.1"); await once(service, "listening");
    const origin = `http://127.0.0.1:${(service.address() as { port: number }).port}`;
    const context = { profileRoot, executablePath: chromium.executablePath(), runtimeKind: "development" as const,
      resolveProject: async (id: string) => { if (id !== "test-project") throw new Error("scope"); },
      authorizeGrant: async () => { grants++; return true; }, forbiddenOrigins: ["http://127.0.0.1:4311"] };
    const control = await BrowserControl.create(context);
    try {
      const grant = await control.requestGrant({ command_id: "grant-1", project_id: "test-project", label: "Verify local software", origins: [origin], duration: "once" });
      expect(grants).toBe(1);
      const opened = await control.command({ type: "open", command_id: "open-1", grant_id: grant.grant_id, url: origin });
      const id = opened.tab!.tab_id;
      let observed = await control.observe(id, "test-project");
      expect(observed.tab.title).toBe("Real browser fixture"); expect(observed.elements.some(element => element.input_type === "password")).toBe(false);
      expect(JSON.stringify(observed)).not.toContain("private-key"); expect([...((await control.evidence(observed.evidence.evidence_id, "test-project")).slice(0, 8))]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      await expect(control.observe(id, "another-project")).rejects.toMatchObject({ code: "browser_tab_scope" });
      const name = observed.elements.find(element => element.text === "Name")!;
      await expect(control.command({ type: "fill", command_id: "plan-write", tab_id: id, expected_revision: observed.tab.revision, ref: name.ref, text: "denied" }, { projectId: "test-project", mode: "plan" })).rejects.toMatchObject({ code: "browser_plan_readonly" });
      await control.command({ type: "fill", command_id: "fill-1", tab_id: id, expected_revision: observed.tab.revision, ref: name.ref, text: "Actual UI result" });
      await expect(control.command({ type: "click", command_id: "stale-1", tab_id: id, expected_revision: observed.tab.revision, ref: name.ref })).rejects.toMatchObject({ code: "browser_revision_conflict" });
      observed = await control.observe(id); const save = observed.elements.find(element => element.text === "Save")!;
      const click = { type: "click" as const, command_id: "click-1", tab_id: id, expected_revision: observed.tab.revision, ref: save.ref };
      await control.command(click); await control.command(click);
      await new Promise(resolve => setTimeout(resolve, 150)); expect(writes).toBe(1); expect(posted).toBe("Actual UI result"); expect(forbiddenRequests).toBe(0);
      expect(await control.reconcile("click-1")).toMatchObject({state:"completed",result:{command_id:"click-1"}});
      expect(await control.reconcile("never-dispatched")).toEqual({command_id:"never-dispatched",state:"not_found"});
      expect(writes).toBe(1);
      const takeover = { type: "takeover" as const, command_id: "human-1", tab_id: id };
      const beforeTakeover = (await control.status()).tabs[0]!;
      const [human, retry] = await Promise.all([control.command(takeover), control.command(takeover)]);
      expect(human).toEqual(retry);
      expect((await control.status()).tabs[0]).toMatchObject({ state: "human", revision: beforeTakeover.revision + 1 });
      observed = await control.observe(id);
      await expect(control.command({ type: "key", command_id: "human-denied", tab_id: id, expected_revision: observed.tab.revision, key: "Enter" }, { projectId: "test-project", mode: "execute" })).rejects.toMatchObject({ code: "browser_human_control" });
      await expect(control.command({ type: "return-control", command_id: "agent-resume", tab_id: id, expected_revision: observed.tab.revision }, { projectId: "test-project", mode: "execute" })).rejects.toMatchObject({ code: "browser_user_operation" });
      await control.command({ type: "return-control", command_id: "human-return", tab_id: id, expected_revision: observed.tab.revision });
      const afterReturn = (await control.status()).tabs[0]!;
      expect(await control.command(takeover)).toEqual(human);
      expect((await control.status()).tabs[0]).toEqual(afterReturn);
      await expect(control.command({ ...takeover, command_id: "open-1" })).rejects.toMatchObject({ code: "command_id_conflict" });
      expect((await control.status()).tabs[0]).toEqual(afterReturn);
      observed = await control.observe(id);
      await expect(control.command({ type: "navigate", command_id: "outside-1", tab_id: id, expected_revision: observed.tab.revision, url: outsideOrigin })).rejects.toMatchObject({ code: "browser_origin_denied" });
      const current = (await control.status()).grants[0]!;
      await control.command({ type: "revoke", command_id: "revoke-1", grant_id: grant.grant_id, expected_revision: current.revision });
      expect((await control.status()).tabs[0]?.state).toBe("closed");
      await expect(control.command({ type: "open", command_id: "open-again", grant_id: grant.grant_id, url: origin })).rejects.toMatchObject({ code: "browser_grant_inactive" });
      await control.close();
      const reopened = await BrowserControl.create(context);
      try { expect((await reopened.status()).tabs).toHaveLength(0); expect((await reopened.status()).grants[0]?.state).toBe("revoked"); expect(writes).toBe(1); }
      finally { await reopened.close(); }
    } finally {
      await control.close(); service.closeAllConnections(); outside.closeAllConnections();
      await Promise.all([new Promise<void>(resolve => service.close(() => resolve())), new Promise<void>(resolve => outside.close(() => resolve()))]);
      await rm(profileRoot, { recursive: true, force: true });
    }
  }, 30_000);
  it("cannot synthesize user authorization without a trusted human callback", async () => {
    const profileRoot = await mkdtemp(join(tmpdir(), "outlive-browser-grant-"));
    const control = await BrowserControl.create({ profileRoot, executablePath: chromium.executablePath(), runtimeKind: "development", resolveProject: async () => undefined });
    try { await expect(control.requestGrant({ command_id: "model-self-grant", project_id: "project", label: "test", origins: ["https://example.test"], duration: "always" })).rejects.toMatchObject({ code: "browser_grant_ui_unavailable" }); expect((await control.status()).grants).toHaveLength(0); }
    finally { await control.close(); await rm(profileRoot, { recursive: true, force: true }); }
  });
  it("fences pending human confirmation and queued grants when closing", async () => {
    const profileRoot = await mkdtemp(join(tmpdir(), "outlive-browser-pending-grant-"));
    const confirmation = deferred<boolean>(), started = deferred<void>();
    let confirmationSignal: AbortSignal | undefined, confirmations = 0;
    const context = { profileRoot, executablePath: chromium.executablePath(), runtimeKind: "development" as const,
      resolveProject: async () => undefined,
      authorizeGrant: async (_input: unknown, signal?: AbortSignal) => { confirmations++; confirmationSignal = signal; started.resolve(); return confirmation.promise; } };
    const control = await BrowserControl.create(context);
    const input = { command_id: "pending-grant", project_id: "project", label: "test", origins: ["https://example.test"], duration: "always" as const };
    const pending = control.requestGrant(input).then(value => ({ value }), error => ({ error }));
    await started.promise;
    const queued = control.requestGrant({ ...input, command_id: "queued-grant" }).then(value => ({ value }), error => ({ error }));
    const queuedOpen = control.command({ type: "open", command_id: "queued-open", grant_id: "browser-grant:unadmitted", url: "https://example.test" }).then(value => ({ value }), error => ({ error }));
    try {
      await control.close();
      confirmation.resolve(true);
      expect(await pending).toMatchObject({ error: { code: "browser_closed" } });
      expect(await queued).toMatchObject({ error: { code: "browser_closed" } });
      expect(await queuedOpen).toMatchObject({ error: { code: "browser_closed" } });
      expect(confirmationSignal?.aborted).toBe(true);
      expect(confirmations).toBe(1);
      await expect(readFile(join(profileRoot, "browser-grants.json"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(control.requestGrant({ ...input, command_id: "after-close" })).rejects.toMatchObject({ code: "browser_closed" });
      const reopened = await BrowserControl.create(context);
      try {
        expect((await reopened.status()).grants).toHaveLength(0);
        expect(await reopened.reconcile("pending-grant")).toMatchObject({ state: "failed", code: "browser_closed" });
        expect(await reopened.reconcile("queued-grant")).toMatchObject({ state: "not_found" });
        expect(await reopened.reconcile("queued-open")).toMatchObject({ state: "not_found" });
        expect(await reopened.reconcile("after-close")).toMatchObject({ state: "not_found" });
      } finally { await reopened.close(); }
    } finally {
      confirmation.resolve(false);
      await Promise.allSettled([pending, queued, queuedOpen]);
      await control.close(); await rm(profileRoot, { recursive: true, force: true });
    }
  });
  it("settles a late launch by closing its browser without creating a context", async () => {
    const profileRoot = await mkdtemp(join(tmpdir(), "outlive-browser-late-launch-"));
    const launch = deferred<Browser>(), started = deferred<void>();
    const browser = { close: vi.fn(async () => undefined), newContext: vi.fn(), on: vi.fn(), isConnected: () => true } as unknown as Browser;
    const control = await BrowserControl.create({ profileRoot, executablePath: chromium.executablePath(), runtimeKind: "development",
      resolveProject: async () => undefined, authorizeGrant: async () => true,
      launchBrowser: () => { started.resolve(); return launch.promise; } });
    try {
      const grant = await control.requestGrant({ command_id: "late-launch-grant", project_id: "project", label: "test", origins: ["https://example.test"], duration: "always" });
      const opened = control.command({ type: "open", command_id: "late-launch-open", grant_id: grant.grant_id, url: "https://example.test" }).then(value => ({ value }), error => ({ error }));
      await started.promise;
      const close = control.close();
      expect(control.close()).toBe(close);
      await expect(control.command({ type: "open", command_id: "new-after-close", grant_id: grant.grant_id, url: "https://example.test" })).rejects.toMatchObject({ code: "browser_closed" });
      launch.resolve(browser);
      await close;
      expect(await opened).toMatchObject({ error: { code: "browser_closed" } });
      expect(browser.close).toHaveBeenCalledTimes(1);
      expect(browser.newContext).not.toHaveBeenCalled();
      expect(browser.on).not.toHaveBeenCalled();
      await expect(control.status()).rejects.toMatchObject({ code: "browser_closed" });
      await expect(control.observe("missing")).rejects.toMatchObject({ code: "browser_closed" });
      await expect(control.evidence("missing")).rejects.toMatchObject({ code: "browser_closed" });
      const reopened = await BrowserControl.create({ profileRoot, executablePath: chromium.executablePath(), runtimeKind: "development", resolveProject: async () => undefined });
      try {
        expect((await reopened.status()).tabs).toHaveLength(0);
        expect(await reopened.reconcile("late-launch-open")).toMatchObject({ state: "failed", code: "browser_closed" });
        expect(await reopened.reconcile("new-after-close")).toMatchObject({ state: "not_found" });
      } finally { await reopened.close(); }
    } finally {
      launch.resolve(browser);
      await control.close(); await rm(profileRoot, { recursive: true, force: true });
    }
  });
  it("reports failed cleanup instead of claiming a late browser was closed", async () => {
    const profileRoot = await mkdtemp(join(tmpdir(), "outlive-browser-failed-close-"));
    const launch = deferred<Browser>(), started = deferred<void>();
    const browser = { close: vi.fn(async () => { throw new Error("fixture shutdown failed"); }), newContext: vi.fn() } as unknown as Browser;
    const control = await BrowserControl.create({ profileRoot, executablePath: chromium.executablePath(), runtimeKind: "development",
      resolveProject: async () => undefined, authorizeGrant: async () => true,
      launchBrowser: () => { started.resolve(); return launch.promise; } });
    try {
      const grant = await control.requestGrant({ command_id: "cleanup-grant", project_id: "project", label: "test", origins: ["https://example.test"], duration: "always" });
      const opened = control.command({ type: "open", command_id: "cleanup-open", grant_id: grant.grant_id, url: "https://example.test" }).then(value => ({ value }), error => ({ error }));
      await started.promise;
      const closing = control.close().then(() => ({ succeeded: true }), error => ({ error }));
      launch.resolve(browser);
      expect(await closing).toMatchObject({ error: { code: "browser_cleanup_failed" } });
      expect(await opened).toMatchObject({ error: { code: "browser_closed" } });
      expect(browser.close).toHaveBeenCalledTimes(1);
      expect(browser.newContext).not.toHaveBeenCalled();
      await expect(control.close()).rejects.toMatchObject({ code: "browser_cleanup_failed" });
    } finally {
      launch.resolve(browser);
      await control.close().catch(() => undefined); await rm(profileRoot, { recursive: true, force: true });
    }
  });
  it("settles an interrupted real navigation as unknown without replaying its external request", async () => {
    const profileRoot = await mkdtemp(join(tmpdir(), "outlive-browser-interrupted-navigation-"));
    const received = deferred<void>();
    let requests = 0;
    const service = createServer((request, response) => {
      if (request.url === "/held") { requests++; received.resolve(); }
      else { response.setHeader("content-type", "text/html"); response.end("<title>Ready</title>"); }
    });
    service.listen(0, "127.0.0.1"); await once(service, "listening");
    const origin = `http://127.0.0.1:${(service.address() as { port: number }).port}`;
    const context = { profileRoot, executablePath: chromium.executablePath(), runtimeKind: "development" as const,
      resolveProject: async () => undefined, authorizeGrant: async () => true };
    const control = await BrowserControl.create(context);
    try {
      const grant = await control.requestGrant({ command_id: "navigation-grant", project_id: "project", label: "test", origins: [origin], duration: "always" });
      const opened = await control.command({ type: "open", command_id: "navigation-open", grant_id: grant.grant_id, url: origin });
      const navigation = { type: "navigate" as const, command_id: "navigation-held", tab_id: opened.tab!.tab_id, expected_revision: opened.tab!.revision, url: `${origin}/held` };
      const pending = control.command(navigation).then(value => ({ value }), error => ({ error }));
      await received.promise;
      await control.close();
      expect(await pending).toMatchObject({ error: { code: "browser_effect_unknown" } });
      expect(requests).toBe(1);
      const reopened = await BrowserControl.create(context);
      try {
        expect(await reopened.reconcile("navigation-held")).toMatchObject({ state: "unknown", code: "browser_effect_unknown" });
        await expect(reopened.command(navigation)).rejects.toMatchObject({ code: "browser_tab_scope" });
        expect(requests).toBe(1);
        expect((await reopened.status()).tabs).toHaveLength(0);
      } finally { await reopened.close(); }
    } finally {
      await control.close(); service.closeAllConnections();
      await new Promise<void>(resolve => service.close(() => resolve()));
      await rm(profileRoot, { recursive: true, force: true });
    }
  }, 30_000);
});

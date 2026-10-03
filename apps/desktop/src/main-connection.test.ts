import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_IPC } from "./ipc-channels.js";

const doubles = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  appEvents: new Map<string, (...args: unknown[]) => unknown>(),
  windowEvents: new Map<string, (...args: unknown[]) => unknown>(),
  webContentsEvents: new Map<string, (...args: unknown[]) => unknown>(),
  probe:vi.fn(), ensure: vi.fn(), detach: vi.fn(), stop: vi.fn(), quit: vi.fn(), loadFile: vi.fn(),
  capabilities: vi.fn(), bootstrap: vi.fn(), registerProject: vi.fn(), dialog: vi.fn(),
  packaged: false,
  connect: vi.fn(), migrationPreview: vi.fn(), migrationCommit: vi.fn(), migrationResult: vi.fn(),
}));
vi.mock("@tracegraph/desktop-host",async()=>{
  const {HostConnectionError}=await import("@tracegraph/contracts");
  class Supervisor {
    private owner:any;private snapshot:any={state:"starting",generation:0};
    constructor(private options:any){}
    private async bind(owner:any){if(this.owner?.status.boot_nonce!==owner.status.boot_nonce){await this.options.onDisconnect?.();await this.owner?.close();await this.options.onRebind?.(owner,this.snapshot.generation+1);this.snapshot={state:"connected",generation:this.snapshot.generation+1,profile_id:owner.status.profile_id,owner_nonce:owner.status.boot_nonce};this.owner=owner;}else this.snapshot={...this.snapshot,state:"connected"};}
    private failure(error:any){const code=error?.code??"host_startup_failed";this.snapshot={...this.snapshot,state:code==="host_stopped"?"stopped":"offline",code,message:"The local Host could not be started"};}
    async initialize(){try{await this.bind(await doubles.ensure({...this.target(),recoveryMode:true}));}catch(error){this.failure(error);}}
    private target(){return {profileRoot:this.options.profileRoot,...(this.options.runtimeDirectory?{runtimeDirectory:this.options.runtimeDirectory,webAssetRoot:this.options.webAssetRoot}:{}),...(this.owner?{httpPort:Number(new URL(this.owner.status.http_address).port)}:{})};}
    async repair(){if(this.owner?.client.replayActive)throw new HostConnectionError({...this.snapshot,code:"host_replay_stale"});try{await this.bind(await doubles.ensure({...this.target(),recoveryMode:false}));}catch(error){this.failure(error);throw new HostConnectionError(this.snapshot);}}
    async refresh(){if(this.owner)try{await this.owner.probe();this.snapshot={...this.snapshot,state:"connected"};}catch(error){this.failure(Object.assign(error as object,{code:(error as {code?:string}).code??"host_offline"}));}}
    getSnapshot(){return {...this.snapshot};}
    async connection(){await this.refresh();if(this.snapshot.state!=="connected")throw new HostConnectionError(this.snapshot);return this.owner;}
    async read(fn:any){await this.connection();return fn(this.owner);}
    async mutate(fn:any){await this.connection();return fn(this.owner);}
    async pause(){return()=>undefined;}
    async waitForReplacement(){await this.bind(await doubles.connect({profileRoot:this.options.profileRoot}));}
    async close(){await this.options.onDisconnect?.();await this.owner?.close();}
  }
  return {DESKTOP_HOST_PACKAGE_VERSION:"0.1.0-alpha.0",LocalHostConnectionSupervisor:Supervisor,connectLocalHost:doubles.connect};
});
vi.mock("electron", () => ({
  app: { get isPackaged(){return doubles.packaged;}, whenReady: () => Promise.resolve(), on: (name: string, handler: (...args: unknown[]) => unknown) => doubles.appEvents.set(name, handler), quit: doubles.quit },
  BrowserWindow: class {
    static getAllWindows() { return []; }
    webContents = { id: 42, setWindowOpenHandler: vi.fn(), on: (name: string, handler: (...args: unknown[]) => unknown) => doubles.webContentsEvents.set(name, handler) };
    once = vi.fn();
    on(name: string, handler: (...args: unknown[]) => unknown) { doubles.windowEvents.set(name, handler); }
    show = vi.fn(); isDestroyed = () => false; loadFile = doubles.loadFile;
  },
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => doubles.handlers.set(channel, handler) },
  dialog: { showOpenDialog: doubles.dialog }, shell: {},
  clipboard:{writeText:vi.fn(),readText:vi.fn()},
  session: { defaultSession: { setPermissionRequestHandler: vi.fn() } },
}));

const originalArguments = process.argv;
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  doubles.packaged=false;
  doubles.handlers.clear(); doubles.appEvents.clear(); doubles.windowEvents.clear(); doubles.webContentsEvents.clear();
  vi.stubEnv("OUTLIVE_PROFILE_ROOT", "/synthetic-profile-only");
  process.argv = [process.execPath, "synthetic-main"];
  doubles.detach.mockResolvedValue(undefined);doubles.probe.mockResolvedValue(undefined);
  doubles.dialog.mockResolvedValue({ canceled: true, filePaths: [] });
  doubles.bootstrap.mockResolvedValue({ token: "PRIVATE_MAIN_BEARER_DO_NOT_EXPOSE", expiresAt: "2026-10-03T00:00:00Z" });
  const connection={
    status: { protocol_version: "outlive.local-host.v1", boot_nonce: "00000000-0000-4000-8000-000000000002", profile_id:"00000000-0000-4000-8000-000000000001", profile_root: "/synthetic-profile-only", http_address: "http://127.0.0.1:12345" },
    client: { bootstrap: doubles.bootstrap, getCapabilities: doubles.capabilities, streamEvents: async function* () {} },
    native: { registerProject: doubles.registerProject,previewMigration:doubles.migrationPreview,commitMigration:doubles.migrationCommit,migrationResult:doubles.migrationResult }, probe:doubles.probe, close: doubles.detach, stop: doubles.stop,
  };
  doubles.ensure.mockResolvedValue(connection);doubles.connect.mockResolvedValue(connection);
});
afterEach(() => { process.argv = originalArguments; vi.unstubAllEnvs(); });
function rendererEvent(trusted = true) {
  const frame = { url: trusted ? new URL("./renderer/index.html", import.meta.url).href : "https://untrusted.invalid" };
  return { senderFrame: frame, sender: { mainFrame: frame, id: 42 } };
}

describe("Desktop unified Host connection lifetime", () => {
  it("treats a fresh user application launch as one explicit start after a persisted stop",async()=>{
    doubles.ensure.mockRejectedValueOnce(Object.assign(new Error("Synthetic persisted stop"),{code:"host_stopped"}));
    await import("./main.js");await vi.waitFor(()=>expect(doubles.loadFile).toHaveBeenCalledOnce());
    expect(doubles.ensure).toHaveBeenCalledTimes(2);
    expect(doubles.ensure.mock.calls.map(([input])=>input.recoveryMode)).toEqual([true,false]);
    expect(await doubles.handlers.get(DESKTOP_IPC.hostStatus)?.(rendererEvent())).toMatchObject({state:"ready"});
    doubles.appEvents.get("activate")?.();
    await vi.waitFor(()=>expect(doubles.loadFile).toHaveBeenCalledTimes(2));
    expect(doubles.ensure).toHaveBeenCalledTimes(2);expect(doubles.stop).not.toHaveBeenCalled();
  });
  it("keeps a stop issued while Main is running across activation and window recreation",async()=>{
    await import("./main.js");await vi.waitFor(()=>expect(doubles.loadFile).toHaveBeenCalledOnce());
    doubles.probe.mockRejectedValue(Object.assign(new Error("Synthetic later explicit stop"),{code:"host_stopped"}));
    expect(await doubles.handlers.get(DESKTOP_IPC.getConnectionStatus)?.(rendererEvent())).toMatchObject({state:"connected"});
    await vi.waitFor(async()=>expect(await doubles.handlers.get(DESKTOP_IPC.getConnectionStatus)?.(rendererEvent())).toMatchObject({state:"stopped",code:"host_stopped"}));
    doubles.windowEvents.get("closed")?.();doubles.appEvents.get("activate")?.();
    await vi.waitFor(()=>expect(doubles.loadFile).toHaveBeenCalledTimes(2));
    expect(await doubles.handlers.get(DESKTOP_IPC.hostStatus)?.(rendererEvent())).toMatchObject({state:"offline"});
    expect(doubles.ensure).toHaveBeenCalledOnce();expect(doubles.stop).not.toHaveBeenCalled();
  });
  it.each(["host_profile_invalid","host_upgrade_required","host_replay_stale"])("does not reinterpret initial %s as a stopped owner or implicitly repair it",async code=>{
    doubles.ensure.mockRejectedValueOnce(Object.assign(new Error("Synthetic non-stop authority failure"),{code}));
    await import("./main.js");await vi.waitFor(()=>expect(doubles.loadFile).toHaveBeenCalledOnce());
    expect(doubles.ensure).toHaveBeenCalledOnce();
    expect(doubles.ensure).toHaveBeenCalledWith(expect.objectContaining({recoveryMode:true}));
    expect(await doubles.handlers.get(DESKTOP_IPC.getConnectionStatus)?.(rendererEvent())).toMatchObject({state:"offline",code});
    expect(doubles.stop).not.toHaveBeenCalled();
  });
  it("preserves retained replay authority during activation and does not upgrade it through Start",async()=>{
    const connection=await doubles.ensure.getMockImplementation()?.();
    connection.client.replayActive=true;
    await import("./main.js");await vi.waitFor(()=>expect(doubles.loadFile).toHaveBeenCalledOnce());
    doubles.probe.mockRejectedValue(Object.assign(new Error("Synthetic owner changed during Replay"),{code:"host_replay_stale"}));
    doubles.appEvents.get("activate")?.();await vi.waitFor(()=>expect(doubles.loadFile).toHaveBeenCalledTimes(2));
    expect(await doubles.handlers.get(DESKTOP_IPC.startHost)?.(rendererEvent())).toMatchObject({__outlive_connection_error:{code:"host_replay_stale"}});
    expect(connection.client.replayActive).toBe(true);expect(doubles.ensure).toHaveBeenCalledOnce();
    expect(doubles.bootstrap).toHaveBeenCalledOnce();expect(doubles.stop).not.toHaveBeenCalled();
  });
  it("preserves only closed Host admission rejection metadata across Electron IPC",async()=>{
    await import("./main.js");await vi.waitFor(()=>expect(doubles.loadFile).toHaveBeenCalledOnce());
    const {TraceGraphHttpError}=await import("@tracegraph/sdk");
    doubles.capabilities.mockRejectedValueOnce(new TraceGraphHttpError(401,"Private URL/token must not cross IPC",{error:"capability_invalid",private_path:"/never-expose"}));
    const response=await doubles.handlers.get(DESKTOP_IPC.getCapabilities)?.(rendererEvent());
    expect(response).toEqual({__outlive_command_rejected:{code:"capability_invalid",status:401,admission:"rejected"}});expect(JSON.stringify(response)).not.toContain("never-expose");
  });
  it("probes the current owner on application activation without restarting or stopping it",async()=>{
    await import("./main.js");await vi.waitFor(()=>expect(doubles.loadFile).toHaveBeenCalledOnce());
    const before=doubles.probe.mock.calls.length;doubles.appEvents.get("activate")?.();
    await vi.waitFor(()=>expect(doubles.probe.mock.calls.length).toBeGreaterThan(before));
    expect(doubles.ensure).toHaveBeenCalledOnce();expect(doubles.stop).not.toHaveBeenCalled();
  });
  it("selects fixed bundled runtime and Web resources for the installed application",async()=>{
    doubles.packaged=true;const previous=process.resourcesPath;Object.defineProperty(process,"resourcesPath",{value:"/synthetic-installed/Contents/Resources",configurable:true});
    try{await import("./main.js");await vi.waitFor(()=>expect(doubles.loadFile).toHaveBeenCalledOnce());expect(doubles.ensure).toHaveBeenCalledWith(expect.objectContaining({profileRoot:"/synthetic-profile-only",runtimeDirectory:"/synthetic-installed/Contents/Resources/runtime",webAssetRoot:"/synthetic-installed/Contents/Resources/app/apps/web/dist"}));expect(doubles.stop).not.toHaveBeenCalled();}
    finally{if(previous===undefined)delete (process as {resourcesPath?:string}).resourcesPath;else Object.defineProperty(process,"resourcesPath",{value:previous,configurable:true});}
  });
  it("selects the explicit shared profile and keeps all authentication in Main", async () => {
    await import("./main.js");
    await vi.waitFor(() => expect(doubles.loadFile).toHaveBeenCalledOnce());
    expect(doubles.ensure).toHaveBeenCalledWith(expect.objectContaining({ profileRoot: "/synthetic-profile-only",recoveryMode:true }));
    const status = await doubles.handlers.get(DESKTOP_IPC.hostStatus)?.(rendererEvent());
    expect(status).toMatchObject({ state: "ready", identity: { package_name: "@tracegraph/host", protocol_version: "outlive.local-host.v1" } });
    expect(JSON.stringify(status)).not.toContain("PRIVATE_MAIN_BEARER");
    await expect(doubles.handlers.get(DESKTOP_IPC.hostStatus)?.(rendererEvent(false))).rejects.toThrow("packaged renderer");
  });
  it("probes actual Host readiness and starts only through the explicit native action", async () => {
    await import("./main.js");await vi.waitFor(() => expect(doubles.loadFile).toHaveBeenCalledOnce());
    doubles.probe.mockRejectedValueOnce(new Error("Synthetic stopped socket"));
    expect(await doubles.handlers.get(DESKTOP_IPC.hostStatus)?.(rendererEvent())).toMatchObject({ state: "offline" });
    expect(doubles.ensure).toHaveBeenCalledOnce();
    await doubles.handlers.get(DESKTOP_IPC.startHost)?.(rendererEvent());
    expect(doubles.ensure).toHaveBeenCalledTimes(2);
    expect(doubles.ensure).toHaveBeenLastCalledWith(expect.objectContaining({profileRoot:"/synthetic-profile-only",httpPort:12345,recoveryMode:false}));
    expect(doubles.stop).not.toHaveBeenCalled();
    expect(await doubles.handlers.get(DESKTOP_IPC.hostStatus)?.(rendererEvent())).toMatchObject({ state: "ready" });
  });
  it("queries only Main's profile-bound unknown migration and blocks duplicate imports until a terminal receipt",async()=>{
    await import("./main.js");await vi.waitFor(()=>expect(doubles.loadFile).toHaveBeenCalledOnce());
    doubles.dialog.mockResolvedValue({canceled:false,filePaths:["/synthetic-legacy-not-user-data"]});
    doubles.migrationPreview.mockResolvedValue({selected_source_id:"legacy-1",requires_source_selection:false,files:[],conflicts:[],active_writer_sources:[],warnings:[]});
    await doubles.handlers.get(DESKTOP_IPC.previewMigration)?.(rendererEvent());
    doubles.migrationCommit.mockRejectedValueOnce(Object.assign(new Error("Synthetic unknown result"),{code:"migration_outcome_unknown",operation_id:"migration:one"}));
    await expect(doubles.handlers.get(DESKTOP_IPC.commitMigration)?.(rendererEvent(),{source_id:"legacy-1"})).rejects.toThrow("unknown");
    await expect(doubles.handlers.get(DESKTOP_IPC.commitMigration)?.(rendererEvent(),{source_id:"legacy-1"})).rejects.toThrow("Inspect its persistent result");
    expect(doubles.migrationCommit).toHaveBeenCalledOnce();expect(doubles.connect).toHaveBeenCalledWith({profileRoot:"/synthetic-profile-only"});
    doubles.migrationResult.mockResolvedValueOnce({state:"queued"}).mockResolvedValueOnce({state:"failed",code:"migration_failed",message:"Private source /never-show"});
    expect(await doubles.handlers.get(DESKTOP_IPC.getMigrationResult)?.(rendererEvent())).toEqual({state:"queued",operation_id:"migration:one"});
    const terminal=await doubles.handlers.get(DESKTOP_IPC.getMigrationResult)?.(rendererEvent());
    expect(terminal).toMatchObject({state:"failed",operation_id:"migration:one"});expect(JSON.stringify(terminal)).not.toContain("/never-show");
    expect(await doubles.handlers.get(DESKTOP_IPC.getMigrationResult)?.(rendererEvent())).toBeUndefined();
    expect(doubles.migrationResult).toHaveBeenCalledWith("migration:one");
  });

  it("keeps the authenticated profile and gateway target for a retry after an owner startup failure", async () => {
    await import("./main.js");await vi.waitFor(() => expect(doubles.loadFile).toHaveBeenCalledOnce());
    doubles.ensure.mockRejectedValueOnce(new Error("Synthetic transient startup failure"));
    expect(await doubles.handlers.get(DESKTOP_IPC.startHost)?.(rendererEvent())).toMatchObject({__outlive_connection_error:{code:"host_startup_failed"}});
    expect(await doubles.handlers.get(DESKTOP_IPC.hostStatus)?.(rendererEvent())).toMatchObject({state:"ready"});
    await doubles.handlers.get(DESKTOP_IPC.startHost)?.(rendererEvent());
    expect(doubles.ensure).toHaveBeenLastCalledWith(expect.objectContaining({profileRoot:"/synthetic-profile-only",httpPort:12345,recoveryMode:false}));
    expect(doubles.stop).not.toHaveBeenCalled();
  });

  it("closes only renderer streams and detaches on app quit without stopping the background owner", async () => {
    await import("./main.js");
    await vi.waitFor(() => expect(doubles.loadFile).toHaveBeenCalledOnce());
    doubles.windowEvents.get("closed")?.();
    expect(doubles.detach).not.toHaveBeenCalled();
    expect(doubles.stop).not.toHaveBeenCalled();
    const preventDefault = vi.fn();
    doubles.appEvents.get("before-quit")?.({ preventDefault });
    await vi.waitFor(() => expect(doubles.detach).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(doubles.quit).toHaveBeenCalledOnce());
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(doubles.stop).not.toHaveBeenCalled();
  });

  it("releases stale feed handles on main-frame reload or renderer crash without stopping the Host", async () => {
    await import("./main.js");
    await vi.waitFor(() => expect(doubles.loadFile).toHaveBeenCalledOnce());
    const open = () => doubles.handlers.get(DESKTOP_IPC.openStream)?.(rendererEvent(), { kind: "ledger", run_id: "run:one", after: 0, reconnect: false });
    const ids = await Promise.all(Array.from({ length: 12 }, open));
    await expect(open()).rejects.toThrow("stream limit");
    doubles.webContentsEvents.get("did-start-navigation")?.({}, "file:///synthetic-frame", false, false);
    await expect(open()).rejects.toThrow("stream limit");
    doubles.webContentsEvents.get("did-start-navigation")?.({}, "file:///synthetic-main#same-document", true, true);
    await expect(open()).rejects.toThrow("stream limit");
    doubles.webContentsEvents.get("did-start-navigation")?.({}, "file:///synthetic-main", false, true);
    const replacement = await open();
    expect(replacement).toEqual(expect.any(String));
    await expect(doubles.handlers.get(DESKTOP_IPC.readStream)?.(rendererEvent(), await ids[0])).rejects.toThrow("Unknown Desktop stream");
    doubles.webContentsEvents.get("render-process-gone")?.({}, { reason: "crashed" });
    await expect(doubles.handlers.get(DESKTOP_IPC.readStream)?.(rendererEvent(), replacement)).rejects.toThrow("Unknown Desktop stream");
    expect(await open()).toEqual(expect.any(String));
    expect(doubles.detach).not.toHaveBeenCalled();
    expect(doubles.stop).not.toHaveBeenCalled();
  });

  it("rejects another origin and canceled native selection before a privileged operation", async () => {
    await import("./main.js");
    await vi.waitFor(() => expect(doubles.loadFile).toHaveBeenCalledOnce());
    await expect(doubles.handlers.get(DESKTOP_IPC.getCapabilities)?.(rendererEvent(false))).rejects.toThrow("packaged renderer");
    expect(doubles.capabilities).not.toHaveBeenCalled();
    await expect(doubles.handlers.get(DESKTOP_IPC.openLocalProject)?.(rendererEvent(), { access: "read_write" })).resolves.toBeUndefined();
    expect(doubles.registerProject).not.toHaveBeenCalled();
  });
});

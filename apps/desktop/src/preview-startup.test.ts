import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const doubles = vi.hoisted(() => ({
  mkdir: vi.fn(),
  getPath: vi.fn(() => "/synthetic-desktop-user-data"),
  launchHost: vi.fn(),
  loadFile: vi.fn(async () => undefined),
  quit: vi.fn(),
}));

vi.mock("node:fs/promises", async (original) => ({
  ...await original<typeof import("node:fs/promises")>(),
  mkdir: doubles.mkdir,
}));
vi.mock("@tracegraph/desktop-host", () => ({
  DESKTOP_HOST_PACKAGE_VERSION: "0.1.0-alpha.0",
  LocalHostConnectionSupervisor:class{
    constructor(private options:any){}
    async initialize(){const owner=await doubles.launchHost(this.options);await this.options.onRebind?.(owner,1);}
    getSnapshot(){return {state:"connected",generation:1};}
  },
}));
vi.mock("electron", () => ({
  app: { whenReady: () => Promise.resolve(), on: vi.fn(), getPath: doubles.getPath, quit: doubles.quit },
  BrowserWindow: class {
    static getAllWindows() { return []; }
    webContents = { setWindowOpenHandler: vi.fn(), on: vi.fn() };
    once = vi.fn();
    on = vi.fn();
    show = vi.fn();
    loadFile = doubles.loadFile;
  },
  dialog: {}, ipcMain: { handle: vi.fn() }, shell: {},
  session: { defaultSession: { setPermissionRequestHandler: vi.fn() } },
}));

const originalArguments = process.argv;
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  doubles.mkdir.mockResolvedValue(undefined);
  doubles.launchHost.mockResolvedValue({ status: { protocol_version: "outlive.local-host.v1",profile_root:"/synthetic-profile-only",http_address:"http://127.0.0.1:12345" }, client: { bootstrap: async () => ({ token: "synthetic-main-only", expiresAt: "2026-10-03T00:00:00Z" }) } });
});
afterEach(() => { process.argv = originalArguments; });

describe("Desktop preview startup authority", () => {
  it("loads the fixture renderer without a Host process or user-data access", async () => {
    process.argv = [process.execPath, "synthetic-main", "--preview"];
    await import("./main.js");
    await vi.waitFor(() => expect(doubles.loadFile).toHaveBeenCalledOnce());
    expect(doubles.loadFile).toHaveBeenCalledWith(expect.stringContaining("renderer/index.html"), { query: { preview: "1" } });
    expect(doubles.getPath).not.toHaveBeenCalled();
    expect(doubles.mkdir).not.toHaveBeenCalled();
    expect(doubles.launchHost).not.toHaveBeenCalled();
    expect(doubles.quit).not.toHaveBeenCalled();
  });

  it("connects to the shared Host for normal startup without a separate Desktop data owner", async () => {
    process.argv = [process.execPath, "synthetic-main"];
    await import("./main.js");
    await vi.waitFor(() => expect(doubles.loadFile).toHaveBeenCalledOnce());
    expect(doubles.getPath).not.toHaveBeenCalled();
    expect(doubles.launchHost).toHaveBeenCalledWith(expect.objectContaining(process.env.OUTLIVE_PROFILE_ROOT === undefined ? {} : { profileRoot: process.env.OUTLIVE_PROFILE_ROOT }));
    expect(doubles.launchHost.mock.calls[0]?.[0]).toHaveProperty("onRebind");
    expect(doubles.loadFile).toHaveBeenCalledWith(expect.stringContaining("renderer/index.html"), { query: {} });
  });
});

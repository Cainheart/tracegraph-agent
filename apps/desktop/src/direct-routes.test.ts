import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { TraceGraphClient } from "@tracegraph/sdk";
import { DIRECT_DESKTOP_ROUTES, DesktopAttachmentUploadSchema, invokeDirectDesktopRoute } from "./direct-routes.js";
import { DESKTOP_IPC } from "./ipc-channels.js";

describe("Fixed Desktop typed SDK routes", () => {
  it("has an explicit preload channel for every supported typed route", async () => {
    const preload = await readFile(new URL("./preload.cts", import.meta.url), "utf8");
    for (const operation of [...Object.keys(DIRECT_DESKTOP_ROUTES), "uploadAttachment", "openStream", "readStream", "closeStream"]) {
      expect(DESKTOP_IPC, operation).toHaveProperty(operation);
      expect(preload, operation).toContain(`  ${operation}: (...args: Parameters<DesktopBridgeApi["${operation}"]>)`);
    }
    expect(preload).not.toMatch(/contextBridge[^\n]*\binvoke\b/u);
    expect(preload).not.toMatch(/ipcRenderer\.(?:send|sendSync|once)\(/u);
    expect([...preload.matchAll(/ipcRenderer\.on\(([^,]+)/gu)].map(match => match[1])).toEqual(['"tracegraph:native-run-requested"']);
  });

  it("rejects privileged or malformed input before calling the shared client", async () => {
    const getCapabilities = vi.fn();
    const workbenchCommand = vi.fn();
    const client = { getCapabilities, workbenchCommand } as unknown as TraceGraphClient;
    await expect(invokeDirectDesktopRoute(client, "getCapabilities", [{ token: "renderer-injected" }])).rejects.toThrow();
    await expect(invokeDirectDesktopRoute(client, "workbenchCommand", [{ type: "terminal.input", command_id: "cmd:one", terminal_id: "terminal:one", text: "test", cwd: "/arbitrary" }])).rejects.toThrow();
    expect(getCapabilities).not.toHaveBeenCalled();
    expect(workbenchCommand).not.toHaveBeenCalled();
  });

  it("preserves effective unsupported states and validates the safe Host reply", async () => {
    const value = { profile_id: "profile:test", protocol_version: "outlive.local-host.v1", capabilities: [{ operation: "mcp.restart", state: "unconfigured", reason: "No server configured", scope: "profile", requires_restart: false }] };
    const client = { getCapabilities: vi.fn(async () => value) } as unknown as TraceGraphClient;
    await expect(invokeDirectDesktopRoute(client, "getCapabilities", [])).resolves.toEqual(value);
    const badClient = { getCapabilities: vi.fn(async () => ({ ...value, credential: "private-main-only" })) } as unknown as TraceGraphClient;
    await expect(invokeDirectDesktopRoute(badClient, "getCapabilities", [])).rejects.toThrow();
  });

  it("limits attachments to reusable bytes and never accepts a renderer filesystem path", () => {
    const metadata = { command_id: "command:attachment", target: "chat", declared_media_type: "image/png", delivery: "offload" };
    expect(DesktopAttachmentUploadSchema.parse({ metadata, bytes: new Uint8Array([1, 2]) }).bytes).toEqual(new Uint8Array([1, 2]));
    expect(() => DesktopAttachmentUploadSchema.parse({ metadata, bytes: new Uint8Array(), path: "/arbitrary" })).toThrow();
    expect(() => DesktopAttachmentUploadSchema.parse({ metadata: { ...metadata, path: "/arbitrary" }, bytes: new Uint8Array([1]) })).toThrow();
  });
  it("keeps image configuration closed and binary Artifact content bounded",async()=>{
    const configureImageProvider=vi.fn();const getArtifactContent=vi.fn(async()=>({artifactId:"artifact:one",mediaType:"image/png",sha256:"sha256:"+"0".repeat(64),bytes:new Uint8Array([1,2,3])}));
    const client={configureImageProvider,getArtifactContent} as unknown as TraceGraphClient;
    await expect(invokeDirectDesktopRoute(client,"configureImageProvider",[{protocol:"openai-images",base_url:"https://provider.invalid/v1",model:"fixture",credential_ref:"renderer-secret-ref"}])).rejects.toThrow();expect(configureImageProvider).not.toHaveBeenCalled();
    const value=await invokeDirectDesktopRoute(client,"getArtifactContent",["run:one","artifact:one"]);expect(value).toMatchObject({bytes:new Uint8Array([1,2,3])});
    getArtifactContent.mockResolvedValueOnce({artifactId:"artifact:one",mediaType:"image/png",sha256:"sha256:"+"0".repeat(64),bytes:new Uint8Array()});await expect(invokeDirectDesktopRoute(client,"getArtifactContent",["run:one","artifact:one"])).rejects.toThrow();
    await expect(invokeDirectDesktopRoute(client,"getArtifactContent",["run:one","artifact:one","/arbitrary/path"])).rejects.toThrow();expect(getArtifactContent).toHaveBeenCalledTimes(2);
  });
});

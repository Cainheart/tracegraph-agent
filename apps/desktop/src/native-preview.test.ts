import {beforeEach,describe,expect,it,vi} from "vitest";
import type {PreviewSnapshot} from "@tracegraph/contracts";
import type {TraceGraphClient} from "@tracegraph/sdk";
import {NativePreviewManager,resolvePreviewUrl} from "./native-preview.js";

const doubles=vi.hoisted(()=>({preferences:[] as unknown[],navigation:new Map<string,(event:{preventDefault:()=>void},url:string)=>void>(),load:vi.fn(),close:vi.fn(),windowClose:vi.fn(),request:undefined as undefined|((details:{url:string},callback:(result:{cancel:boolean})=>void)=>void),popup:vi.fn(),permission:vi.fn()}));
vi.mock("electron",()=>({
  WebContentsView:class {
    constructor(options:unknown){doubles.preferences.push(options);}
    setBounds=vi.fn();webContents={setWindowOpenHandler:doubles.popup,on:(name:string,callback:(event:{preventDefault:()=>void},url:string)=>void)=>doubles.navigation.set(name,callback),session:{setPermissionRequestHandler:doubles.permission,on:vi.fn(),webRequest:{onBeforeRequest:(callback:typeof doubles.request)=>{doubles.request=callback;}}},isDestroyed:()=>false,close:doubles.close,loadURL:doubles.load};
  },
  BrowserWindow:class {constructor(options:unknown){doubles.preferences.push(options);}contentView={addChildView:vi.fn()};getContentBounds=()=>({width:1100,height:760});on=vi.fn();once=vi.fn();show=vi.fn();isDestroyed=()=>false;close=doubles.windowClose;},
}));
const preview={preview_id:"preview:test",project_id:"project:test",url:"http://127.0.0.1:12345/",state:"ready",owned_process:true} as const;
beforeEach(()=>{vi.clearAllMocks();doubles.preferences.length=0;doubles.navigation.clear();doubles.request=undefined;doubles.load.mockResolvedValue(undefined);});
describe("Native project preview isolation",()=>{
  it("accepts only the ready Host-owned loopback projection",()=>{
    expect(resolvePreviewUrl(preview).origin).toBe("http://127.0.0.1:12345");
    for(const change of [{state:"starting"},{url:"https://example.com"},{url:"file:///private"},{url:"http://localhost:12345/"},{url:"http://127.0.0.1:80/"},{url:"http://user:password@127.0.0.1:12345/"}])expect(()=>resolvePreviewUrl({...preview,...change} as PreviewSnapshot)).toThrow();
  });
  it("does not accept a caller-supplied URL or an unknown preview resource",async()=>{
    const manager=new NativePreviewManager();const client={getWorkbenchResources:async()=>({previews:[preview]})} as unknown as TraceGraphClient;
    await expect(manager.open({} as never,client,{url:preview.url})).rejects.toThrow();
    await expect(manager.open({} as never,client,"preview:unknown")).rejects.toThrow("unavailable");
    expect(doubles.load).not.toHaveBeenCalled();
  });
  it("creates a separate sandbox with no app preload, denies remote navigation and keeps service lifetime separate",async()=>{
    const manager=new NativePreviewManager();const workbenchCommand=vi.fn();const client={getWorkbenchResources:async()=>({previews:[preview]}),workbenchCommand} as unknown as TraceGraphClient;
    await manager.open({} as never,client,preview.preview_id);
    expect(doubles.preferences[0]).toMatchObject({webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,partition:expect.stringMatching(/^outlive-preview-/u)}});
    expect(JSON.stringify(doubles.preferences[0])).not.toContain("preload");
    expect(doubles.load).toHaveBeenCalledWith(preview.url);
    const prevented=vi.fn();doubles.navigation.get("will-navigate")?.({preventDefault:prevented},"https://untrusted.invalid");expect(prevented).toHaveBeenCalledOnce();
    const blocked=vi.fn();doubles.request?.({url:"http://127.0.0.1:4311/api/bootstrap"},blocked);expect(blocked).toHaveBeenCalledWith({cancel:true});
    const local=vi.fn();doubles.request?.({url:"ws://127.0.0.1:12345/"},local);expect(local).toHaveBeenCalledWith({cancel:false});
    manager.close();expect(doubles.close).toHaveBeenCalled();expect(doubles.windowClose).toHaveBeenCalledOnce();expect(workbenchCommand).not.toHaveBeenCalled();
  });
});

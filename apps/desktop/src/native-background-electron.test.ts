import {beforeEach,describe,expect,it,vi} from "vitest";
import type {BackgroundMenuItem} from "./native-background.js";

const doubles=vi.hoisted(()=>({append:vi.fn(),trayMenu:vi.fn(),setApplicationMenu:vi.fn(),windowMenu:true,items:[] as any[]}));
vi.mock("electron",()=>({
 Menu:{getApplicationMenu:()=>doubles.windowMenu?{items:[{role:"windowMenu",label:"Window",submenu:{append:doubles.append}}]}:null,buildFromTemplate:(items:any[])=>items,setApplicationMenu:doubles.setApplicationMenu},
 MenuItem:class{constructor(options:any){Object.assign(this,options);doubles.items.push(this);}},
 Tray:class{on=vi.fn();setContextMenu=doubles.trayMenu;setToolTip=vi.fn();destroy=vi.fn();},
 nativeImage:{createFromPath:()=>({resize(){return this;},isEmpty:()=>false,setTemplateImage:vi.fn()})},
 Notification:class{static isSupported(){return false;}},powerSaveBlocker:{start:vi.fn(),stop:vi.fn(),isStarted:()=>false},
}));
beforeEach(()=>{vi.resetModules();vi.clearAllMocks();doubles.windowMenu=true;doubles.items=[];});
// Negative cases deliberately forge unsupported IDs to verify runtime fail-closed mapping.
function item(id:string,label:string,click:()=>void,checked=false,enabled=true):BackgroundMenuItem{return {id:id as NonNullable<BackgroundMenuItem["id"]>,label,type:"checkbox",checked,enabled,click};}
function native(id:string){return doubles.items.find(item=>item.id===id);}

describe("closed native Window presentation menu",()=>{
 it("maps by fixed IDs even when Tray order and labels change, never selecting a background stop action",async()=>{const {createNativeBackgroundEffects}=await import("./native-background-electron.js");const effects=createNativeBackgroundEffects("/synthetic-packaged/tray.png",vi.fn()),floating=vi.fn(),onTop=vi.fn(),stop=vi.fn();
  const items=[item("host.stop","浮动聊天窗口",stop),item("outlive-on-top","Pinned window",onTop,true),item("outlive-floating","Floating chat",floating)];effects.setMenu(items);
  native("outlive-floating").click();native("outlive-on-top").click();expect(floating).toHaveBeenCalledOnce();expect(onTop).toHaveBeenCalledOnce();expect(stop).not.toHaveBeenCalled();expect(native("outlive-floating").label).toBe("Floating chat");expect(native("outlive-on-top").checked).toBe(true);expect(doubles.trayMenu).toHaveBeenCalledWith(items);effects.destroyTray();
 });
 it("rebinds only the latest fixed callbacks while keeping checked/enabled state synchronized",async()=>{const {createNativeBackgroundEffects}=await import("./native-background-electron.js");const effects=createNativeBackgroundEffects("/synthetic-packaged/tray.png",vi.fn()),previous=vi.fn(),current=vi.fn();
  effects.setMenu([item("outlive-floating","Float",previous)]);effects.setMenu([item("outlive-floating","Float",current)]);native("outlive-floating").click();expect(previous).not.toHaveBeenCalled();expect(current).toHaveBeenCalledOnce();expect(doubles.setApplicationMenu).toHaveBeenCalledOnce();
  effects.setMenu([item("outlive-floating","Float",current,true,false)]);expect(native("outlive-floating")).toMatchObject({checked:true,enabled:false});expect(doubles.setApplicationMenu).toHaveBeenCalledTimes(2);effects.destroyTray();
 });
 it("does not map an unknown ID or an identical label into a fixed presentation action",async()=>{const {createNativeBackgroundEffects}=await import("./native-background-electron.js");const effects=createNativeBackgroundEffects("/synthetic-packaged/tray.png",vi.fn()),unknown=vi.fn();effects.setMenu([item("untrusted-presentation","浮动聊天窗口",unknown)]);
  for(const id of ["outlive-floating","outlive-on-top"]){expect(native(id)).toMatchObject({enabled:false,checked:false});native(id).click();}expect(unknown).not.toHaveBeenCalled();effects.destroyTray();
 });
 it("keeps Tray controls usable without creating another native menu when Window menu is absent",async()=>{doubles.windowMenu=false;const {createNativeBackgroundEffects}=await import("./native-background-electron.js");const effects=createNativeBackgroundEffects("/synthetic-packaged/tray.png",vi.fn()),floating=vi.fn();const items=[item("outlive-floating","Float",floating)];effects.setMenu(items);expect(doubles.items).toEqual([]);expect(doubles.setApplicationMenu).not.toHaveBeenCalled();expect(doubles.trayMenu).toHaveBeenCalledWith(items);effects.destroyTray();});
});

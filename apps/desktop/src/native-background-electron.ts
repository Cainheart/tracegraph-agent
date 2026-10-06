import {Menu,MenuItem,Notification,Tray,nativeImage,powerSaveBlocker} from "electron";
import type {NativeBackgroundEffects} from "./native-background.js";
/** Fixed packaged icon and a closed menu; no renderer-supplied OS effects. */
export function createNativeBackgroundEffects(iconPath:string,onShow:()=>void):NativeBackgroundEffects {
 const image=nativeImage.createFromPath(iconPath).resize({width:18,height:18});if(image.isEmpty())throw new Error("The native background icon is unavailable");if(process.platform==="darwin")image.setTemplateImage(true);const tray=new Tray(image);tray.on("click",onShow);const notifications=new Set<Notification>();
 // The same closed presentation actions are also reachable through the native
 // Window menu, including keyboard and accessibility navigation.
 const applicationMenu=Menu.getApplicationMenu();
 const windowMenu=applicationMenu?.items.find(item=>item.role?.toLowerCase()==="windowmenu"||["Window","窗口"].includes(item.label))?.submenu;
 const presentationItems=windowMenu?[new MenuItem({id:"outlive-floating",label:"浮动聊天窗口",type:"checkbox"}),new MenuItem({id:"outlive-on-top",label:"窗口置顶",type:"checkbox"})]:[];
 if(windowMenu){windowMenu.append(new MenuItem({type:"separator"}));for(const item of presentationItems)windowMenu.append(item);}
 let menuState="";
 return {setMenu:items=>{tray.setContextMenu(Menu.buildFromTemplate(items));const values=presentationItems.map(item=>items.find(value=>value.id===item.id));values.forEach((value,index)=>{const item=presentationItems[index]!;item.label=value?.label??item.label;item.checked=value?.checked??false;item.enabled=value?.enabled??Boolean(value);item.click=()=>value?.click?.();});const state=JSON.stringify(values.map(value=>[value?.label,value?.checked,value?.enabled]));if(applicationMenu&&state!==menuState){Menu.setApplicationMenu(applicationMenu);menuState=state;}},setTooltip:text=>tray.setToolTip(text),destroyTray:()=>{tray.destroy();for(const notification of notifications)notification.close();notifications.clear();},notify:input=>{try{if(!Notification.isSupported())return false;const notification=new Notification({title:input.title,body:input.body});notifications.add(notification);if(notifications.size>128){const oldest=notifications.values().next().value;if(oldest){oldest.close();notifications.delete(oldest);}}notification.once("click",input.click);notification.once("failed",input.failed);notification.once("close",()=>notifications.delete(notification));notification.show();return true;}catch{return false;}},startPowerBlocker:()=>powerSaveBlocker.start("prevent-app-suspension"),stopPowerBlocker:id=>{if(powerSaveBlocker.isStarted(id))powerSaveBlocker.stop(id);}};
}

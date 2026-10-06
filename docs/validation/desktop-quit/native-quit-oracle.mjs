import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
const root=resolve(new URL('../../../',import.meta.url).pathname);
const mode=process.argv[2]??'plain';
if(!['plain','plain-diagnostic','dirty','dirty-cancel','dirty-discard'].includes(mode))throw new Error('Only fixed oracle modes are accepted');
// This historical oracle attaches only to an existing, explicitly owned fixture.
// Fail before launching Main if that fixture is gone, rather than creating a new owner.
process.kill(23666,0);
if(!(await fetch('http://127.0.0.1:50831/health',{signal:AbortSignal.timeout(2000)})).ok)throw new Error('Owned fixture Host is not healthy');
const directory=await mkdtemp(join(tmpdir(),'outlive-quit-oracle-'));
const main=pathToFileURL(join(root,'apps/desktop/dist/main.js')).href;
const bootstrap=join(directory,'bootstrap.mjs');
await writeFile(bootstrap,`import {app,BrowserWindow,dialog} from 'electron';
process.on('uncaughtException',error=>{process.stdout.write('ORACLE_SETUP_ERROR '+error.name+': '+error.message+'\\n');app.exit(3);});
app.setPath('userData',${JSON.stringify(join(directory,'userData'))});
const facts={mode:${JSON.stringify(mode)},before_quit:0,will_quit:0,unload_veto:0,window_closed:0};
const output=()=>process.stdout.write('QUIT_ORACLE '+JSON.stringify(facts)+'\\n');
void (async()=>{
if(${JSON.stringify(mode)}==='plain-diagnostic'){
const {LocalHostConnectionSupervisor:S}=await import(${JSON.stringify(pathToFileURL(join(root,'packages/host/dist/index.js')).href)});
for(const name of ['initialize','refresh','close']){const original=S.prototype[name];S.prototype[name]=function(...args){process.stdout.write('PHASE '+name+' enter\\n');return original.apply(this,args).then(value=>{process.stdout.write('PHASE '+name+' exit\\n');return value;});};}
const {DesktopStreamManager:M}=await import(${JSON.stringify(pathToFileURL(join(root,'apps/desktop/dist/stream-bridge.js')).href)});const original=M.prototype.closeAll;M.prototype.closeAll=async function(){process.stdout.write('PHASE streams close enter\\n');await original.call(this);process.stdout.write('PHASE streams close exit\\n');};
}
await import(${JSON.stringify(main)});
app.on('before-quit',()=>facts.before_quit++);
app.on('will-quit',()=>facts.will_quit++);
await app.whenReady();
const deadline=Date.now()+15000;let window;
while(Date.now()<deadline){window=BrowserWindow.getAllWindows()[0];if(window&&!window.webContents.isLoading())break;await new Promise(resolve=>setTimeout(resolve,50));}
if(!window||window.webContents.isLoading())throw new Error('Actual Main renderer failed to load');
window.on('closed',()=>{facts.window_closed++;});
window.webContents.on('will-prevent-unload',()=>{facts.unload_veto++;output();});
if(!${JSON.stringify(mode)}.startsWith('plain'))await window.webContents.executeJavaScript("window.__quitOracleGuard=event=>{event.preventDefault();event.returnValue='';};window.addEventListener('beforeunload',window.__quitOracleGuard);");
if(['dirty-cancel','dirty-discard'].includes(${JSON.stringify(mode)}))dialog.showMessageBoxSync=(_window,options)=>{facts.native_confirmation=true;facts.confirmation_default=options.defaultId;return ${JSON.stringify(mode)}==='dirty-discard'?1:0;};
if(${JSON.stringify(mode)}==='dirty-cancel')setTimeout(async()=>{facts.cancel_retained_window=!window.isDestroyed();const snapshot=await window.webContents.executeJavaScript('window.tracegraphDesktop.getConnectionStatus()');facts.cancel_connection_state=snapshot.state;output();await window.webContents.executeJavaScript('window.removeEventListener(\"beforeunload\",window.__quitOracleGuard)');app.quit();},200);
setTimeout(()=>{facts.hung_after_quit=true;output();app.exit(2);},1500);
output();app.quit();
process.on('exit',()=>output());
})().catch(error=>{process.stdout.write('ORACLE_SETUP_ERROR '+error.name+': '+error.message+'\\n');app.exit(3);});
`);
const child=spawn(join(root,'apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),[bootstrap],{cwd:root,env:{...process.env,NODE_OPTIONS:'',OUTLIVE_PROFILE_ROOT:'/var/folders/7b/stkwnxgj6mq3wv9s461kw92r0000gn/T/outlive-product-ui-f84WQ4',OUTLIVE_CREDENTIAL_BACKEND:'private-file'},stdio:['ignore','pipe','pipe']});
let stdout='',stderr='';child.stdout.on('data',chunk=>{stdout+=chunk;process.stdout.write(chunk);});child.stderr.on('data',chunk=>{stderr+=chunk;});
const timer=setTimeout(()=>child.kill('SIGKILL'),20000);const code=await new Promise(resolve=>child.once('exit',(code,signal)=>resolve(code??signal)));clearTimeout(timer);
const records=stdout.split('\n').filter(line=>line.startsWith('QUIT_ORACLE ')).map(line=>JSON.parse(line.slice(12)));const last=records.at(-1);let backgroundOwnerAlive=false;try{process.kill(23666,0);backgroundOwnerAlive=true;}catch{}
const assertions=code===0&&last?.window_closed===1&&last?.will_quit>=1&&!last?.hung_after_quit&&backgroundOwnerAlive&&(mode!=='dirty-cancel'||(last.cancel_retained_window===true&&last.cancel_connection_state==='connected'));
process.stdout.write(JSON.stringify({native_main:true,mode,exit:code,assertions_passed:assertions,child_exited:true,background_owner_alive:backgroundOwnerAlive,stderr_present:stderr.length>0})+'\n');await rm(directory,{recursive:true,force:true});process.exitCode=assertions?0:typeof code==='number'&&code!==0?code:1;

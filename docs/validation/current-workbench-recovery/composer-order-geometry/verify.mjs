import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
import React from '../../../../packages/workbench/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../../../packages/workbench/node_modules/react-dom/server.node.js';
import { chromium } from '/Users/cain/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
registerHooks({resolve(specifier,context,nextResolve){try{return nextResolve(specifier,context);}catch(error){if(error.code==='ERR_MODULE_NOT_FOUND'&&specifier.startsWith('.'))return nextResolve(specifier+'.js',context);throw error;}}});
const { Composer }=await import('../../../../packages/workbench/dist/components/Composer.js');
const { ComposerModelMenu, ComposerPermissionMenu }=await import('../../../../packages/workbench/dist/conversation-options.js');
const output=dirname(fileURLToPath(import.meta.url)),repo=resolve(output,'../../../..');
const shared=await readFile(resolve(repo,'packages/workbench/src/styles.css'),'utf8'),css=await readFile(resolve(repo,'packages/workbench/src/workbench.css'),'utf8');
const noop=()=>{},options={mode:'execute',permission_preset:'workspace-write',reasoning_effort:'default',connection_id:'one',model:'gpt-4.1-mini'};
const connections={default_connection_id:'one',connections:[{connection_id:'one',label:'Alpha',provider:'openai',revision:1,model:'gpt-4.1-mini',models:['gpt-4.1-mini'],has_key:true,source:'profile',writable:true}]};
const markup=renderToStaticMarkup(React.createElement(Composer,{value:'Review this project',onChange:noop,onSubmit:noop,attachments:[],onAttachmentsChange:noop,mode:'execute',onModeChange:noop,modelControl:React.createElement(ComposerModelMenu,{connections,options,onChange:noop,onSettings:noop,disabled:false,active:false}),permissionControl:React.createElement(ComposerPermissionMenu,{options,permission:null,grant:null,onChange:noop,onGrant:noop,disabled:false,active:false})}));
const report={boundary:'Isolated CSS geometry fixture with built Composer SSR markup, relocated exactly as the two-line source order change and an explicit static model popup. It is not an application or installed-product journey.',checks:[],cleanup:false};
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage();await page.route('**/*',r=>r.abort());
 for(const [width,height] of [[1024,768],[1280,800],[1440,900]]){
  await page.setViewportSize({width,height});
  await page.setContent(`<style>${shared}\n${css}\n#fixture-canvas{position:absolute;left:220px;right:0;bottom:20px;padding:34px;}</style><div class="app outlive-workbench theme-light"><div id="fixture-canvas">${markup}</div></div>`);
  await page.evaluate(()=>{const left=document.querySelector('.composer-option-row'),right=document.querySelector('.composer-submit-row'),model=document.querySelector('.composer-model-menu'),permission=document.querySelector('.composer-permission-menu'),plan=document.querySelector('[aria-label="Plan mode"]');left.insertBefore(permission,plan);right.prepend(model);const popup=document.createElement('div');popup.className='composer-popover model-choice-popover';popup.innerHTML='<p>Model for this conversation</p><section><strong>Alpha · openai</strong><button type="button">gpt-4.1-mini</button></section><button type="button">Default reasoning effort</button><button type="button">Manage model connections</button>';model.append(popup);});
  const geometry=await page.evaluate(()=>{const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};return{plus:rect('[aria-label="Add to message"]'),permission:rect('[aria-label="Choose permissions"]'),plan:rect('[aria-label="Plan mode"]'),model:rect('[aria-label="Choose model"]'),send:rect('[aria-label="Send message"]'),popup:rect('.model-choice-popover'),left:rect('.composer-option-row'),right:rect('.composer-submit-row'),overflow:document.documentElement.scrollWidth>innerWidth};});
  assert.ok(geometry.plus.right<=geometry.permission.left&&geometry.permission.right<=geometry.plan.left,'left controls ordered');assert.ok(geometry.left.right<=geometry.model.left,'model is right of the left group');assert.ok(geometry.model.right<=geometry.send.left,'model before send');assert.ok(geometry.popup.left>=0&&geometry.popup.right<=width,'model popup within viewport');assert.equal(geometry.overflow,false);report.checks.push({width,height,...geometry});await page.screenshot({path:resolve(output,`model-menu-${width}x${height}.png`),animations:'disabled'});
 }
}finally{await browser.close();report.cleanup=true;await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2)+'\n');}
process.stdout.write(JSON.stringify({status:'passed',viewportChecks:report.checks.length,cleanup:report.cleanup})+'\n');

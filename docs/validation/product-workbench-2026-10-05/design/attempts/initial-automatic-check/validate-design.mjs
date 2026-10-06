import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir=dirname(fileURLToPath(import.meta.url));
const output=join(dir,'evidence');
const modulePath=process.env.OUTLIVE_PLAYWRIGHT_MODULE ?? '/Users/cain/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
await access(modulePath);await mkdir(output,{recursive:true});
const {chromium}=await import(pathToFileURL(modulePath).href);
const source=await readFile(join(dir,'index.html'),'utf8');
new Function(source.match(/<script>([\s\S]*?)<\/script>/)[1]);
assert(source.includes("connect-src 'none'"));
assert(!/\b(fetch|XMLHttpRequest|WebSocket)\s*\(/.test(source));
const report={kind:'design-prototype-only',prototypeNotProduct:true,started_at:new Date().toISOString(),networkRequests:[],checks:[],screenshots:[],errors:[],cleanupPassed:false};
let browser;
const pages=['chat-new','chat-project','chat-history','agents','goals','memory','skills','tools','browser','computer','usage','archive','help'];
const categories=['general','profile','shortcuts','notifications','appearance','personalization','models','permissions','browser','computer','memory','developer','git','skills','tools','tasks','usage','archive','about'];
const record=(name,detail)=>report.checks.push({name,...detail});
try{
  browser=await chromium.launch({executablePath:process.env.OUTLIVE_CHROME_BINARY??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  const page=await browser.newPage();
  page.on('pageerror',error=>report.errors.push(String(error)));
  page.on('request',request=>{if(!request.url().startsWith('file:')&&!request.url().startsWith('data:'))report.networkRequests.push(request.url());});
  const open=async(route,theme,width,scene='ready',category='general',panel='')=>{
    await page.setViewportSize({width:width+32,height:930});
    await page.goto(pathToFileURL(join(dir,'index.html')).href+'#'+new URLSearchParams({page:route,theme,width:String(width),state:scene,category,panel}),{waitUntil:'load'});
    await page.waitForSelector('.prototype-footer');
    assert.equal(await page.getByRole('navigation',{name:'主导航'}).count(),1);
    assert.equal(await page.getByText('设计原型 · 所有状态 / 数据 / 操作均模拟 · 无模型、Host或电脑调用').count(),1);
    const geometry=await page.evaluate(()=>{const stage=document.querySelector('#stage'),body=document.querySelector('.canvas-body');return {canvasWidth:stage.getBoundingClientRect().width,overflow:body.scrollWidth>body.clientWidth+1,viewport:innerWidth};});
    assert.equal(geometry.canvasWidth,width);
    assert.equal(geometry.overflow,false,route+' overflows '+width);
    return geometry;
  };
  const shot=async(name)=>{const path=join(output,name+'.png');await page.locator('#stage').screenshot({path});report.screenshots.push({name,path:resolve(path)});};
  for(const theme of ['light','dark'])for(const width of [1440,1280,1024]){
    for(const route of pages){
      const geometry=await open(route,theme,width,route==='chat-project'?'running':route==='chat-history'?'completed':'ready');
      if(route.startsWith('chat')){
        const rects=await page.evaluate(()=>{const r=x=>{const b=document.querySelector(x).getBoundingClientRect();return {left:b.left,right:b.right,width:b.width};};return{plus:r('[data-action="add"]'),permission:r('[data-action="permission"]'),plan:r('[data-action="plan"]'),model:r('[data-action="model"]'),left:r('.composer-left'),right:r('.composer-right')};});
        assert(rects.plus.right<=rects.permission.left+1);
        assert(rects.permission.right<=rects.plan.left+1);
        assert(rects.model.left>rects.left.right);
        assert(rects.model.right<=rects.right.right);
        record('uniform composer order',{route,theme,width,geometry,rects});
      }else record('page renders',{route,theme,width,geometry});
      if(['chat-new','chat-project','agents','goals','computer','usage'].includes(route))await shot(route+'-'+theme+'-'+width);
    }
    for(const category of categories){
      await open('settings',theme,width,'ready',category);
      assert.equal(await page.getByRole('navigation',{name:'设置分类'}).locator('button').count(),19);
      assert((await page.locator('.setting-row').count())>=2,'settings category has real review content: '+category);
      assert(await page.locator('.metadata').first().isVisible());
      record('settings classification renders',{category,theme,width});
      if(width===1440)await shot('settings-'+category+'-'+theme+'-'+width);
    }
    for(const panel of ['files','changes','terminal','preview','artifacts']){
      await open('chat-project',theme,width,'completed','general',panel);
      const p=await page.getByRole('complementary',{name:'统一工作区面板'}).boundingBox();
      assert(p&&p.width>100);
      assert.equal(Math.round(p.width),width<1200?width-2:390);
      record('panel has actual geometry',{panel,theme,width,rect:p});
      if(panel==='files'||panel==='changes')await shot('panel-'+panel+'-'+theme+'-'+width);
    }
  }
  await open('chat-project','light',1280,'running');
  await page.locator('#draft').fill('保留这个原型草稿');
  await page.getByRole('button',{name:'打开工作区面板',exact:true}).click();
  await page.getByRole('button',{name:'关闭面板',exact:true}).click();
  assert.equal(await page.locator('#draft').inputValue(),'保留这个原型草稿');
  await page.getByRole('button',{name:'选择模型与推理',exact:true}).count().catch(()=>{});
  await page.locator('[data-action="model"]').click();
  const popup=await page.getByRole('menu',{name:'模型与推理选择'}).boundingBox();
  assert(popup&&popup.x>=0&&popup.x+popup.width<=(await page.viewportSize()).width);
  await page.getByRole('menuitem',{name:'推理强度 · 高',exact:true}).click();
  assert((await page.locator('[data-action="model"]').innerText()).includes('高'));
  await page.locator('.activity-summary').click();
  await page.locator('[data-detail="test"]').click();
  assert(await page.locator('.activity-detail').isVisible());
  record('draft preserved and operation drills down',{modelPopup:popup});
  await open('settings','dark',1024,'pending','computer');
  await page.locator('[data-help="computer"]').first().click();
  assert(await page.getByRole('complementary',{name:'上下文帮助'}).isVisible());
  await shot('settings-computer-help-dark-1024');
  await page.getByRole('button',{name:'关闭帮助',exact:true}).click();
  await page.locator('[data-action="computer-grant"]').first().click();
  assert(await page.getByRole('dialog',{name:'应用授权'}).isVisible());
  await shot('computer-grant-dark-1024');
  record('setting help and app grant modal visible',{width:1024});
  for(const scene of ['queued','plan','approval','unknown','failed','offline','recovering','unconfigured','readonly','pending','conflict','handover','locked']){
    await open('chat-project','light',1280,scene);
    if(['plan','approval'].includes(scene))assert(await page.locator('.pending-card').isVisible());
    else assert(await page.locator('.notice').first().isVisible());
    if(['offline','recovering','readonly','locked'].includes(scene))assert(await page.locator('#draft').isDisabled());
    record('visible actionable state',{scene});
  }
  assert.equal(report.networkRequests.length,0);
  assert.equal(report.errors.length,0);
  report.status='passed';
}catch(error){report.status='failed';report.errors.push(error.stack??String(error));process.exitCode=1;}
finally{if(browser)await browser.close();report.cleanupPassed=true;report.finished_at=new Date().toISOString();await writeFile(join(output,'report.json'),JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify({status:report.status,checks:report.checks.length,screenshots:report.screenshots.length,networkRequests:report.networkRequests.length,cleanupPassed:report.cleanupPassed,errors:report.errors}));

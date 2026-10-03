import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';

/** Real packaged UI controls and native window dimensions, never a injected demo state. */
export function desktopMatrix({page:readPage,electron:readElectron,output,receipt,delay}) {
  const sizes=[[1440,900],[1280,800],[1024,768]];
  receipt.screenshots=[];
  let activeTheme;
  async function dimensions(width,height) {
    const window=await readElectron().browserWindow(readPage());
    await window.evaluate((value,{width,height})=>value.setContentSize(width,height),{width,height});
    await delay(120);
    const actual=await readPage().evaluate(()=>({width:innerWidth,height:innerHeight}));
    assert.deepEqual(actual,{width,height});
  }
  async function settings() {
    await readPage().locator('.sidebar-account-trigger').click();
    await readPage().getByRole('menuitem',{name:/^Settings/}).click();
    await readPage().getByRole('dialog',{name:'Settings',exact:true}).waitFor();
    await readPage().getByRole('button',{name:'Refresh',exact:true}).first().waitFor({state:'visible'});
    await readPage().getByText('Loading settings…',{exact:true}).waitFor({state:'hidden'});
  }
  async function closeSettings() {
    await readPage().getByRole('button',{name:'Back to workbench',exact:true}).click();
    await readPage().getByRole('dialog',{name:'Settings',exact:true}).waitFor({state:'hidden'});
  }
  async function theme(value) {
    if(activeTheme===value)return;
    await settings();
    await readPage().getByRole('button',{name:'Appearance',exact:true}).click();
    const current=await readPage().evaluate(()=>window.tracegraphDesktop.getWorkbenchSettings());
    await readPage().getByRole('combobox',{name:'Theme',exact:true}).selectOption(value);
    await readPage().getByText('Saved',{exact:true}).waitFor();
    const result=await readPage().evaluate(()=>window.tracegraphDesktop.getWorkbenchSettings());
    assert.ok(result.revision>current.revision);assert.equal(result.settings.appearance.theme,value);
    await closeSettings();activeTheme=value;
    assert.equal(await readPage().evaluate(()=>document.documentElement.style.colorScheme),value);
  }
  async function shot(state,width,height,value) {
    await dimensions(width,height);
    await readPage().evaluate(()=>document.fonts.ready);
    await delay(120);
    const bounds=await readPage().evaluate(()=>({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,theme:document.documentElement.style.colorScheme,dialog:document.querySelector('[role="dialog"]')?.getAttribute('aria-label'),horizontalOverflow:[...document.querySelectorAll('button,input,select,textarea')].filter(node=>{const box=node.getBoundingClientRect();return box.width&&box.height&&(box.right>innerWidth+2||box.left< -2)&&getComputedStyle(node).visibility!=='hidden';}).slice(0,8).map(node=>({text:node.textContent?.trim().slice(0,100),label:node.getAttribute('aria-label'),left:node.getBoundingClientRect().left,right:node.getBoundingClientRect().right}))}));
    assert.ok(bounds.scrollWidth<=width+1,`${state} horizontal page overflow ${bounds.scrollWidth}/${width}`);
    assert.equal(bounds.theme,value);
    if(state==='change-review') {
      const rect=await readPage().locator('.review-side-panel').evaluate(node=>{const box=node.getBoundingClientRect();return {left:box.left,top:box.top,width:box.width,height:box.height,right:box.right,bottom:box.bottom};});
      assert.ok(rect.width>=320&&rect.height>=300&&rect.right>0&&rect.left<width&&rect.top<height&&rect.bottom>0,`Review is not visible: ${JSON.stringify(rect)}`);
      await readPage().getByRole('button',{name:'Close review',exact:true}).waitFor({state:'visible'});
      bounds.reviewRect=rect;
    }
    const file=`screenshots/${state}-${value}-${width}x${height}.png`;
    await mkdir(join(output,'screenshots'),{recursive:true});
    await readPage().screenshot({path:join(output,file),animations:'disabled'});
    const bytes=await readFile(join(output,file));
    receipt.screenshots.push({file,state,theme:value,width,height,sha256:createHash('sha256').update(bytes).digest('hex'),bounds});
  }
  async function core(state,prepare=async()=>{}) {
    for(const value of ['light','dark']) {
      await theme(value);await prepare();
      for(const [width,height] of sizes)await shot(state,width,height,value);
    }
  }
  async function settingsMatrix() {
    const categories=['General','Appearance','Models','Permissions','Memory and privacy','Developer','Skills and extensions','MCP and LSP','Usage and diagnostics','About'];
    for(const value of ['light','dark']) {
      await theme(value);await settings();
      for(const [index,category] of categories.entries()) {
        await readPage().getByRole('button',{name:category,exact:true}).click();
        await readPage().getByText('Loading capability status…',{exact:true}).waitFor({state:'hidden'});
        await readPage().getByRole('heading',{name:category,exact:true,level:1}).waitFor();
        for(const [width,height] of sizes)await shot(`settings-${String(index+1).padStart(2,'0')}`,width,height,value);
      }
      await readPage().getByRole('searchbox',{name:'Search settings',exact:true}).fill('Theme');
      await readPage().getByRole('heading',{name:'Search results',exact:true,level:1}).waitFor();
      assert.equal(await readPage().getByRole('combobox',{name:'Theme',exact:true}).count(),1);
      await shot('settings-search',1024,768,value);
      await closeSettings();
    }
  }
  async function resourceMatrix(prepare=async()=>{}) {
    const tabs=['Background tasks','Git and worktrees','Terminal','Preview services','Schedules','Archive'];
    for(const value of ['light','dark']) {
      await theme(value);await prepare();
      await readPage().getByRole('button',{name:'Workspace tools',exact:true}).first().click();
      const panel=readPage().getByRole('complementary',{name:'Workspace tools',exact:true});
      await panel.waitFor();
      for(const [index,tab] of tabs.entries()) {
        await panel.getByRole('button',{name:tab,exact:true}).first().click();
        await panel.getByText('Loading workspace resources…',{exact:true}).waitFor({state:'hidden'});
        if(tab==='Git and worktrees') {
          await panel.getByRole('button',{name:'Refresh Git status',exact:true}).click();
          await panel.getByText('Branch:',{exact:false}).first().waitFor();
        }
        if(tab==='Terminal')await panel.locator('[aria-label="Host terminal output"]').waitFor();
        for(const [width,height] of sizes)await shot(`resources-${String(index+1).padStart(2,'0')}`,width,height,value);
      }
      await panel.getByRole('button',{name:'Close workspace tools',exact:true}).click();
    }
  }
  return {core,settingsMatrix,resourceMatrix,dimensions,theme,shot};
}

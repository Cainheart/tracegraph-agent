import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/Users/cain/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const output = dirname(fileURLToPath(import.meta.url));
const repo = resolve(output, '../../../..');
const shared = await readFile(resolve(repo, 'packages/workbench/src/styles.css'), 'utf8');
const fixed = await readFile(resolve(repo, 'packages/workbench/src/workbench.css'), 'utf8');
const before = fixed.replace('justify-items: stretch; column-gap: 6px; ', '').replace('display: flex !important; min-width: 0; width: 100%; gap: 2px;', 'display: flex !important; gap: 2px;').replace('flex-shrink: 0; justify-self: start; ', '');
const html = `<div class="app outlive-workbench theme-light"><div class="desktop-app"><aside class="sidebar"><div class="sidebar-scroll"><div class="section-label">Projects</div><button class="project-card project-card-button" type="button"><span class="project-icon"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 6h7l2 2h9v12H3z"/></svg></span><div class="project-card-copy compact-hide"><strong>tracegraph-fixture-dnmP0M-with-a-long-project-name</strong></div><svg class="project-chevron compact-hide" viewBox="0 0 24 24" width="14" height="14"><path d="m9 6 6 6-6 6" fill="none" stroke="currentColor"/></svg></button></div></aside></div></div>`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const report = { boundary: 'Isolated layout fixture using exact production CSS and current Sidebar markup; not a real application or installed-product journey.', before: [], after: [], cleanup: false };
try {
 const page = await browser.newPage(); await page.route('**/*', route => route.abort());
 for (const [state, css] of [['before', before], ['after', fixed]]) for (const [width,height] of [[1024,768],[1280,800],[1440,900]]) {
  await page.setViewportSize({width,height}); await page.setContent(`<style>${shared}\n${css}</style>${html}`);
  const geometry = await page.evaluate(() => { const rect = selector => { const r=document.querySelector(selector).getBoundingClientRect(); return {left:r.left,right:r.right,width:r.width,top:r.top,bottom:r.bottom}; }; const label=document.querySelector('.project-card-copy strong'); return {icon:rect('.project-icon svg'),label:rect('.project-card-copy strong'),row:rect('.project-card'),label_overflow:getComputedStyle(label).textOverflow,label_whitespace:getComputedStyle(label).whiteSpace,document_overflow:document.documentElement.scrollWidth>innerWidth}; });
  report[state].push({width,height,...geometry});
  if(state==='after'){assert.ok(geometry.icon.right<=geometry.label.left,`${width} icon must precede label`);assert.ok(geometry.label.right<=geometry.row.right,`${width} label must stay within row`);assert.equal(geometry.document_overflow,false);assert.equal(geometry.label_overflow,'ellipsis');}
  await page.screenshot({path:resolve(output,`${state}-${width}x${height}.png`), animations: "disabled"});
 }
 assert.ok(report.before[0].icon.right > report.before[0].label.left, '1024 original overlap reproduced with production CSS');
} finally { await browser.close(); report.cleanup=true; await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2)+'\n'); }
process.stdout.write(JSON.stringify({status:'passed',beforeOverlap1024:true,afterChecks:report.after.length,cleanup:report.cleanup})+'\n');

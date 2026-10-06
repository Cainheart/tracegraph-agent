import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';

// Static checks only. Browser opening was unavailable; do not serve or switch
// surfaces to bypass that restriction. These checks do not prove visual fit.
const dir=dirname(fileURLToPath(import.meta.url));
const html=await readFile(join(dir,'index.html'),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert(script);new Function(script);
assert(html.includes("connect-src 'none'"));
assert(html.includes("img-src data:"));
assert(!/\b(fetch|XMLHttpRequest|WebSocket)\s*\(/.test(script));
assert(!/<(?:script|link|img)[^>]+(?:src|href)=['"]https?:/i.test(html));
const expected=['general','profile','shortcuts','notifications','appearance','personalization','models','permissions','browser','computer','memory','developer','git','skills','tools','tasks','usage','archive','about'];
for(const id of expected)assert(script.includes("case'"+id+"':"),'Missing settings content: '+id);
for(const page of ['chat-new','chat-project','chat-history','agents','goals','memory','skills','tools','browser','computer','usage','archive','settings','help'])assert(html.includes('value="'+page+'"'),'Missing route: '+page);
for(const width of ['1440','1280','1024'])assert(html.includes('value="'+width+'"'));
assert(html.includes('@container canvas (max-width:1199px)'));
assert(html.includes('.side-panel{left:0;right:0;top:0;width:auto;'));
assert(html.includes('class="composer-left"'));
assert(html.includes('class="composer-right"'));
assert(html.includes('设计原型 · 所有状态 / 数据 / 操作均模拟 · 无模型、Host或电脑调用'));
const svg=await readFile(join(dir,'../../../brand/current.svg'),'utf8');
for(const path of svg.matchAll(/<path d="([^"]+)"/g))assert(html.includes(path[1]),'Current brand path mismatch');
const report={kind:'design-prototype-static-only',status:'passed',scriptParsed:true,settingsClassifications:expected.length,declaredRoutes:14,widthPresets:[1440,1280,1024],themes:['light','dark'],networkPolicy:'connect-src none',externalRequestsInSource:false,brand:'B Current exact paths',visualAcceptance:'pending manual review; no visual pass claimed',initialAutomaticAttempt:'attempts/initial-automatic-check/evidence/report.json (failed and browser cleaned up)',checked_at:new Date().toISOString()};
await writeFile(join(dir,'static-checks.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));

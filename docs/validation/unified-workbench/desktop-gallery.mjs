#!/usr/bin/env node
/** Local screenshot index; each image remains an unchanged, hash-checked evidence file. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const directory=resolve(process.argv[2]??'docs/validation/unified-workbench/desktop-evidence-final');
const report=JSON.parse(await readFile(join(directory,'report.json'),'utf8'));
const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const frames=[];
for(const shot of report.screenshots??[]) {
  const bytes=await readFile(join(directory,shot.file));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),shot.sha256);
  frames.push(`<figure><figcaption>${escape(shot.state)} · ${escape(shot.theme)} · ${shot.width}×${shot.height}</figcaption><a href="${escape(shot.file)}"><img src="${escape(shot.file)}" alt="${escape(shot.state)} ${escape(shot.theme)} ${shot.width}x${shot.height}" loading="eager"></a></figure>`);
}
const css='body{margin:16px;background:#f4f4f5;color:#18181b;font:14px system-ui}h1{font-size:20px}header{margin:0 0 16px}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}figure{margin:0;min-width:0;border:1px solid #ccc;background:white}figcaption{padding:6px;font-size:13px}img{display:block;width:100%;height:310px;object-fit:contain;background:#dedee0}a{display:block}@media(max-width:1000px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}';
await writeFile(join(directory,'gallery.html'),`<!doctype html><meta charset="utf-8"><title>Desktop evidence index</title><style>${css}</style><header><h1>Desktop evidence: ${escape(report.status)}</h1>${frames.length} unchanged screenshot files. Click a frame to inspect its full resolution. The report status and cleanup receipt determine acceptance.</header><main class="grid">${frames.join('')}</main>`);
for(let offset=0;offset<frames.length;offset+=12)await writeFile(join(directory,`gallery-${String(Math.floor(offset/12)+1).padStart(2,'0')}.html`),`<!doctype html><meta charset="utf-8"><title>Desktop evidence ${offset+1}–${Math.min(offset+12,frames.length)}</title><style>${css}</style><header>Desktop screenshot evidence ${offset+1}–${Math.min(offset+12,frames.length)} · report ${escape(report.status)}</header><main class="grid">${frames.slice(offset,offset+12).join('')}</main>`);
process.stdout.write(JSON.stringify({status:report.status,screenshots:frames.length,galleries:Math.ceil(frames.length/12)})+'\n');

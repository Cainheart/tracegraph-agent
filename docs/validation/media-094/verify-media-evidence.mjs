import {readFile,readdir,writeFile} from 'node:fs/promises';
import {resolve,join,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {inflateSync} from 'node:zlib';
const directory=resolve(process.argv[2]??fileURLToPath(new URL('evidence/source-final',import.meta.url)));
const checks=[];
function assert(name,passed){checks.push({name,passed:Boolean(passed)});if(!passed)throw new Error('Independent media evidence check failed: '+name);}
const digest=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const load=name=>readFile(join(directory,name),'utf8').then(JSON.parse);
function inspectPng(bytes){
 assert('PNG signature',bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')));
 let width,height,color,offset=8,ended=false;const compressed=[];
 for(;offset<bytes.length;){const size=bytes.readUInt32BE(offset),kind=bytes.toString('ascii',offset+4,offset+8),end=offset+12+size;assert('PNG chunk bound '+kind,end<=bytes.length);const body=bytes.subarray(offset+8,offset+8+size);let crc=0xffffffff;for(const byte of bytes.subarray(offset+4,offset+8+size)){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}assert('PNG CRC '+kind,((crc^0xffffffff)>>>0)===bytes.readUInt32BE(end-4));
  if(kind==='IHDR'){width=body.readUInt32BE(0);height=body.readUInt32BE(4);color=body[9];assert('fixture PNG header',size===13&&width===320&&height===180&&body[8]===8&&color===6&&body[12]===0);}if(kind==='IDAT')compressed.push(body);if(kind==='IEND'){ended=true;assert('PNG IEND has no trailing bytes',end===bytes.length);}offset=end;
 }
 const decoded=inflateSync(Buffer.concat(compressed),{maxOutputLength:320*180*5});assert('PNG actually inflates to full pixel rows',ended&&decoded.length===height*(1+width*4));for(let row=0;row<height;row++)assert('PNG row filter '+row,decoded[row*(1+width*4)]<=4);return{width,height};
}
let report,error;
try{
 report=await load('report.json');const receipts=await load('cli-receipts.json'),requests=await load('provider-requests.json'),artifacts=await load('artifacts.json');
 assert('source harness finished and all owned resources cleaned',report.status==='passed'&&report.cleanup===true&&report.assertions.length>60&&report.assertions.every(value=>value.passed));
 if(report.execution_inputs_sha256){assert('execution input manifest matches report SHA',digest(await readFile(join(directory,'execution-inputs.json')))===report.execution_inputs_sha256);const inputs=await load('execution-inputs.json');for(const module of inputs.modules){assert('module locator remains inside execution root '+module.path,!module.path.startsWith('/')&&!module.path.split(/[\\/]/u).includes('..'));const bytes=await readFile(join(inputs.repository_root,module.path));assert('execution module bytes unchanged '+module.path,bytes.length===module.bytes&&digest(bytes)===module.sha256);}}
 assert('explicit deterministic provider boundary',report.provider_boundary.includes('no live provider key')&&report.cli_environment_path==='/usr/bin:/bin');
 assert('all CLI receipts accounted',receipts.length===report.cli_count&&receipts.length===20);
 assert('three positive protocols and only four negatives plus cancellation dispatched',requests.length===8&&report.provider_request_count===requests.length&&requests.every(value=>value.authorized));
 for(const protocol of ['openai-images','openai-responses','openai-chat-images'])assert('single external dispatch '+protocol,requests.filter(value=>value.prompt_tag===protocol).length===1);
 for(const tag of ['prose','bad64','auth','unknown','hold'])assert('single external negative/cancel dispatch '+tag,requests.filter(value=>value.prompt_tag===tag).length===1);
 assert('six positive scoped media Artifacts accounted',artifacts.length===6&&report.artifact_count===artifacts.length);
 const runs=new Map();for(const name of await readdir(join(directory,'runs'))){if(name.endsWith('.json')){const run=JSON.parse(await readFile(join(directory,'runs',name),'utf8'));runs.set(run.run_id,run);assert('friendly task and explicit no extraction admission '+run.run_id,/^Create (?:image|diagram|chart): /u.test(run.task)&&run.timeline.find(event=>event.type==='run.created')?.data.background_model_derivation===false);}}
 for(const artifact of artifacts){assert('evidence path is a fixed basename',basename(artifact.file)===artifact.file);const bytes=await readFile(join(directory,artifact.file)),run=runs.get(artifact.run_id);assert('actual external file length and SHA '+artifact.file,bytes.length===artifact.byte_length&&digest(bytes)===artifact.content_hash);assert('same Run/project scope '+artifact.file,run?.status==='completed'&&run.project_id===artifact.project_id&&run.artifact_refs.some(ref=>ref.artifact_id===artifact.artifact_id&&ref.content_hash===artifact.content_hash&&ref.mime_type===artifact.mime_type));
  const event=run.timeline.find(event=>event.type==='tool.completed'&&event.data.receipt?.receipt_id===artifact.receipt_id),receipt=event?.data.receipt;assert('business success and canonical receipt '+artifact.file,receipt?.business_status==='success'&&receipt.code==='media_artifact_created'&&receipt.artifact_refs.some(ref=>ref.artifact_id===artifact.artifact_id&&ref.run_id===artifact.run_id&&ref.project_id===artifact.project_id&&ref.content_hash===artifact.content_hash));assert('Event proof refs match receipt '+artifact.file,event.artifact_refs.some(ref=>ref.artifact_id===artifact.artifact_id&&ref.content_hash===artifact.content_hash));
  if(artifact.mime_type==='image/png')inspectPng(bytes);else{const svg=bytes.toString('utf8');assert('self-contained real SVG '+artifact.file,artifact.mime_type==='image/svg+xml'&&svg.startsWith('<svg')&&svg.includes('xmlns="http://www.w3.org/2000/svg"')&&svg.endsWith('</svg>')&&!/<script|<foreignObject|href=|url\(|NaN|Infinity/u.test(svg));}
  assert('no image bytes in public Run '+artifact.file,!JSON.stringify(run).includes(Buffer.from(bytes).toString('base64'))&&!JSON.stringify(run).includes('Provider prose is not a success receipt'));
 }
 const expected={prose:[1,'failure','image_output_invalid'],bad64:[1,'failure','image_output_invalid'],auth:[1,'failure','image_authentication_failed'],unknown:[3,'unknown','image_http_503']};
 for(const [tag,[exit,status,code]] of Object.entries(expected)){const cli=receipts.find(value=>value.name==='negative '+tag),run=runs.get(cli?.result.run_id),receipt=run?.timeline.find(event=>['tool.failed','tool.unknown'].includes(event.type)&&event.data.receipt?.tool_name==='generate_image')?.data.receipt;assert('typed negative outcome/exit '+tag,cli?.exit===exit&&receipt?.business_status===status&&receipt.code===code&&!run.artifact_refs.some(ref=>ref.mime_type==='image/png'));}
 assert('cancelled Run has no false image receipt',[...runs.values()].some(run=>run.status==='cancelled'&&!run.artifact_refs.some(ref=>ref.mime_type==='image/png')));
 assert('local rendering with configured model had zero tail billing',report.assertions.some(value=>value.name==='local rendering never calls the configured chat/image provider or post-run extractor'&&value.passed));
 assert('scope, replay and tamper negative oracles recorded',['foreign Run binary content is denied','replay capability denies binary read and generation','tampered binary hash fails closed'].every(name=>report.assertions.some(value=>value.name===name&&value.passed)));
 assert('explicit export matches positive Artifact',digest(await readFile(join(directory,'exported-copy.png')))===artifacts[0].content_hash);
}catch(failure){error=failure instanceof Error?failure.message:String(failure);}
const result={schema:'outlive.media-independent-verification.v1',status:error?'failed':'passed',completed_at:new Date().toISOString(),evidence_directory:directory,checks,source_report_sha256:digest(await readFile(join(directory,'report.json'))),...(error?{error}:{})};
await writeFile(join(directory,'independent-verification.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({status:result.status,checks:checks.length,error}));if(error)process.exitCode=1;

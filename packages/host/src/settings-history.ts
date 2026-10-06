import {redactSensitiveText,redactStructuredArtifactValue} from "@tracegraph/core";
import {WorkbenchSettingsHistoryEntrySchema,WorkbenchSettingsHistorySchema,type WorkbenchSettingsHistoryEntry,type WorkbenchSettingsValues} from "@tracegraph/contracts";
import type {WorkbenchJournal} from "./workbench-journal.js";

/** History stores sanitized values; literal process env/args never enter receipts. */
export function settingsHistoryEntry(input:{revision:number;command_id:string;operation:WorkbenchSettingsHistoryEntry["operation"];settings:WorkbenchSettingsValues;restored_from_revision?:number}):WorkbenchSettingsHistoryEntry{
  const redacted_paths:string[]=[];
  const visit=(value:unknown,path:string):unknown=>{
    if(typeof value==="string"){
      if(/^\$\{secret:[A-Za-z0-9_.-]+\}$/u.test(value)){redacted_paths.push(path);return "[REDACTED]";}
      const privateToolValue=path.startsWith("tools.")&&(/\.env\./u.test(path)||/\.args\.\d+$/u.test(path));
      const redacted=privateToolValue&&value?"[redacted]":redactSensitiveText(value);
      if(redacted!==value)redacted_paths.push(path);
      return redacted;
    }
    if(Array.isArray(value))return value.map((item,index)=>visit(item,`${path}.${index}`));
    if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,visit(item,path?`${path}.${key}`:key)]));
    return value;
  };
  const prepared=visit(input.settings,""),sanitized=redactStructuredArtifactValue(prepared);
  const mark=(before:unknown,after:unknown,path:string)=>{
    if(JSON.stringify(before)===JSON.stringify(after))return;
    if(before&&after&&typeof before==="object"&&typeof after==="object")for(const [key,value]of Object.entries(before))mark(value,(after as Record<string,unknown>)[key],path?`${path}.${key}`:key);
    else redacted_paths.push(path);
  };mark(prepared,sanitized,"");
  return WorkbenchSettingsHistoryEntrySchema.parse({...input,settings:sanitized,redacted_paths:[...new Set(redacted_paths)],occurred_at:new Date().toISOString()});
}

/** Derive history only from successful canonical command receipts. */
export async function readSettingsHistory(journal:WorkbenchJournal,profileId:string,currentRevision:number){
  const revisions=new Map<number,WorkbenchSettingsHistoryEntry>();
  for(const id of await journal.ledger.listRunIds()){
    for(const event of await journal.ledger.list(id)){
      if(event.type!=="workbench.command_completed")continue;
      const result=event.data.result as {settings_history?:unknown}|undefined;
      const parsed=WorkbenchSettingsHistoryEntrySchema.safeParse(result?.settings_history);
      if(parsed.success&&(!revisions.has(parsed.data.revision)||parsed.data.operation!=="checkpoint"))revisions.set(parsed.data.revision,parsed.data);
    }
  }
  const entries=[...revisions.values()].sort((a,b)=>b.revision-a.revision);
  return WorkbenchSettingsHistorySchema.parse({profile_id:profileId,current_revision:currentRevision,entries:entries.slice(0,200),has_more:entries.length>200});
}

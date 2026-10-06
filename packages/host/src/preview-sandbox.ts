import {realpath} from "node:fs/promises";
import {join,relative,isAbsolute,resolve,sep} from "node:path";
import type {WorkspaceHandle} from "@tracegraph/contracts";
import {generateSeatbeltProfile,probeNativeSandbox,SEATBELT_EXECUTABLE,seatbeltArguments} from "@tracegraph/core";
import {privateDirectory} from "./local-profile.js";
import {workbenchError} from "./workbench-journal.js";
import type {WorkbenchControlContext} from "./workbench-control.js";

/** Trusted process composition only. Public commands never choose grants or cache paths. */
export async function createReadOnlyPreviewExecution(input:{workspace:WorkspaceHandle;profileRoot:string;previewId:string;command:string;args:string[];port:number;probe?:WorkbenchControlContext["sandboxProbe"]}){
 const report=await(input.probe??probeNativeSandbox)({mode:"read-only",workspaceRoot:input.workspace.real_root});
 if(report.enforcement!=="full"||report.platform!=="darwin")throw workbenchError("sandbox_unavailable",`Read-only preview sandbox unavailable: ${report.unmet_constraints.join(", ")||"native backend cannot enforce private-cache grants"}; inspect Host diagnostics`,503);
 if(!/^preview:[a-f0-9-]{36}$/u.test(input.previewId))throw workbenchError("preview_identity_invalid","Preview identity is invalid",500);
 const profileRoot=await realpath(input.profileRoot);
 if(profileRoot!==resolve(input.profileRoot))throw workbenchError("preview_cache_scope_denied","Private preview cache must use the verified profile",503);
 const parent=join(profileRoot,"preview-cache"),cache=join(parent,input.previewId.slice("preview:".length));
 const inside=relative(input.workspace.real_root,cache);
 if(inside===""||(inside!==".."&&!inside.startsWith(`..${sep}`)&&!isAbsolute(inside)))throw workbenchError("preview_cache_scope_denied","Preview cache cannot grant writes within the source workspace",503);
 for(const target of [parent,cache]){try{if(await privateDirectory(target)!==target)throw new Error("Cache identity changed");}catch{throw workbenchError("preview_cache_scope_denied","Private preview cache must be a verified directory outside the source workspace",503);}}
 // All paths travel as separate sandbox parameters; no path is interpolated into SBPL.
 const profile=generateSeatbeltProfile("read-only")+`\n(allow file-read* file-map-executable (literal (param "OUTLIVE_PREVIEW_EXEC")))\n(allow file-read* file-write* (literal (param "OUTLIVE_PREVIEW_CACHE")) (subpath (param "OUTLIVE_PREVIEW_CACHE")))\n(allow network-bind network-inbound (local ip "localhost:${input.port}"))\n(allow network-outbound (remote ip "localhost:*"))\n`;
 return {command:SEATBELT_EXECUTABLE,args:["-D",`OUTLIVE_PREVIEW_EXEC=${input.command}`,"-D",`OUTLIVE_PREVIEW_CACHE=${cache}`,...seatbeltArguments({profile,workspaceRoot:input.workspace.real_root,executable:input.command,args:input.args})],environment:{TMPDIR:cache,TMP:cache,TEMP:cache,XDG_CACHE_HOME:cache}};
}

import {spawn} from "node:child_process";
import {randomBytes,randomUUID,timingSafeEqual} from "node:crypto";
import {lstat,readFile,unlink} from "node:fs/promises";
import {createServer, type IncomingMessage, type ServerResponse} from "node:http";
import {delimiter,dirname,join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import type {Socket} from "node:net";
import {TraceGraphClient} from "@tracegraph/sdk";
import {ProjectSummarySchema,WorkbenchSettingsValuesSchema,WorkbenchSettingsSnapshotSchema,GoalSnapshotSchema,IdentifierSchema,WorkbenchCommandRequestSchema,type ProjectSummary} from "@tracegraph/contracts";
import {PrivateFileCredentialStore,createPlatformCredentialStore,type CredentialStore} from "@tracegraph/core";
import {z} from "zod";
import {atomicPrivateJson,defaultLocalProfileRoot,initializeLocalProfile,localSocketPath,LOCAL_HOST_PROTOCOL_VERSION,privateDirectory,readLocalProfile,type LocalProfileOptions} from "./local-profile.js";
import {acquireOwnerLease,acquireRuntimeRootLease,LocalHostOwnedError} from "./owner-lease.js";
import {previewLegacyMigration,commitLegacyMigration,type LegacyMigrationOptions} from "./profile-migration.js";
import {createLocalFetch} from "./local-fetch.js";
import {createWorkbenchControl} from "./workbench-control.js";
import {registerWorkbenchRoutes} from "./workbench-routes.js";
import {createHostComposition} from "./composition/host-composition.js";
import {curatedNodeEnvironment,resolveDesktopHostNodeExecutable} from "./composition/node-executable.js";
import {discoverCurrentBundledRuntime,resolveBundledRuntime} from "./composition/bundled-runtime.js";
import {registerPackagedWeb} from "./packaged-web.js";
import {clearLocalOwnerStopIntent,readLocalOwnerStopIntent,persistLocalOwnerStopIntent,LocalHostStoppedError} from "./local-owner-intent.js";
import {LocalOwnerAdmission,LocalOwnerUpgrade,LocalUpgradeReceiptSchema,assertSettledLocalFacts,type PrepareLocalUpgrade,type LocalUpgradeReceipt} from "./local-host-upgrade.js";
import {WorkbenchJournal,workbenchError} from "./workbench-journal.js";

const DiscoverySchema=z.object({protocol_version:z.literal(LOCAL_HOST_PROTOCOL_VERSION),profile_id:z.string().uuid(),profile_root:z.string(),data_root:z.string(),session_root:z.string(),pid:z.number().int().positive(),boot_nonce:z.string().uuid(),socket_path:z.string(),token:z.string().min(32),http_address:z.string(),product_build_id:z.string().regex(/^[a-f0-9]{64}$/u).optional(),upgrade_protocol:z.literal("outlive.local-upgrade.v1").optional()}).strict();
type Discovery=z.infer<typeof DiscoverySchema>;
export type LocalHostStatus=Omit<Discovery,"token"|"socket_path">;
export interface LocalHostOptions extends LocalProfileOptions {readonly httpPort?:number;readonly environment?:NodeJS.ProcessEnv;readonly logger?:boolean;readonly credentialBackend?:"platform"|"private-file";readonly credentialStore?:CredentialStore;readonly runtimeDirectory?:string;readonly webAssetRoot?:string;readonly productBuildId?:string;readonly recoveryMode?:boolean;readonly deliveryBudget?:import("@tracegraph/contracts").GoalBudgetLimits;}
export class LocalHostUpgradeRequiredError extends Error {
  readonly code="local_host_upgrade_required";
  constructor(message="A different Outlive build owns this profile. The installed application is waiting for a verified safe upgrade; existing work remains running."){super(message);this.name="LocalHostUpgradeRequiredError";}
}
/** Only explicit Host-owned policy settings survive the OS environment allowlist. */
function localOwnerEnvironment(environment:NodeJS.ProcessEnv):NodeJS.ProcessEnv {
  return {...curatedNodeEnvironment(environment),...Object.fromEntries(["TRACEGRAPH_PERMISSION_PRESET","TRACEGRAPH_ROLLBACK_ENABLED","TRACEGRAPH_ROLLBACK_ALLOW_FORCE"].flatMap(key=>environment[key]===undefined?[]:[[key,environment[key]]]))};
}
export interface ConnectedLocalHost {
  readonly client:TraceGraphClient;
  readonly status:LocalHostStatus;
  readonly native:{upgradeStatus?():Promise<{state:"open"|"checking"|"sealed";receipt?:LocalUpgradeReceipt}>;prepareUpgrade?(input:PrepareLocalUpgrade):Promise<LocalUpgradeReceipt>;upgradeReceipt?(commandId:string):Promise<Awaited<ReturnType<WorkbenchJournal["inspect"]>>>;previewMigration(input:LegacyMigrationOptions):Promise<Awaited<ReturnType<typeof previewLegacyMigration>>>;commitMigration(input:LegacyMigrationOptions):Promise<Awaited<ReturnType<typeof commitLegacyMigration>>>;migrationResult(operationId:string):Promise<{state:"queued"|"failed"|"succeeded";result?:Awaited<ReturnType<typeof commitLegacyMigration>>;code?:string;message?:string}>;registerProject(input:{selectedPath:string;access:"read_write"|"read_only"}):Promise<ProjectSummary>;resolveProjectRoot(projectId:string):Promise<{project_id:string;root:string}>;};
  /** Detach only. Does not cancel Runs or stop the owner. */
  close():Promise<void>;
  stop():Promise<void>;
  /** Probe the fixed private channel without refreshing replay/live authority. */
  probe():Promise<void>;
}
export async function readLocalHostStatus(options:LocalProfileOptions={}):Promise<LocalHostStatus|undefined> {
  try{const connection=await connectLocalHost(options);const status=connection.status;await connection.close();return status;}
  catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT" || (error as NodeJS.ErrnoException).code==="ECONNREFUSED")return undefined;throw error;}
}
/** Safe native failure identity; lets callers reconcile without resubmitting the migration. */
export class LocalMigrationOutcomeError extends Error {
  constructor(readonly code:"migration_failed"|"migration_outcome_unknown",readonly operation_id:string) {
    super(code==="migration_failed"?"Profile migration failed; inspect the persistent migration receipt before retrying":"Profile migration outcome is unknown; inspect the persistent migration receipt before retrying");
    this.name="LocalMigrationOutcomeError";
  }
}
async function readDiscovery(options:LocalProfileOptions):Promise<Discovery> {
  const profile=await readLocalProfile(options);const path=join(profile.profile_root,"discovery.json");
  const info=await lstat(path);
  if(!info.isFile() || info.isSymbolicLink() || (process.platform!=="win32" && (info.mode & 0o077)!==0))throw new Error("Local Host discovery must be a private regular file");
  const record=DiscoverySchema.parse(JSON.parse(await readFile(path,"utf8")));
  if(record.profile_id!==profile.profile_id || record.profile_root!==profile.profile_root || record.data_root!==profile.data_root || record.session_root!==profile.session_root || record.socket_path!==localSocketPath(profile.profile_root,record.boot_nonce))throw new Error("Local Host discovery identity is invalid");
  return record;
}
/** Main/CLI-only identity read; the private bearer and channel path never escape. */
export async function readLocalHostDiscoveryIdentity(options:LocalProfileOptions={}):Promise<LocalHostStatus> {
  const {token:_token,socket_path:_socket,...identity}=await readDiscovery(options);return identity;
}
export async function connectLocalHost(options:LocalProfileOptions={}):Promise<ConnectedLocalHost> {
  const record=await readDiscovery(options);
  const transport=createLocalFetch(record.socket_path,record.token);
  const boundedBootstrap:typeof fetch=async(input,init={})=>{
    const path=new URL(typeof input==="string"||input instanceof URL?input:input.url).pathname;
    try{return await transport.fetch(input,{...init,...(path==="/api/bootstrap"&&!init.signal?{signal:AbortSignal.timeout(3000)}:{})});}
    catch(error){if(["TimeoutError","AbortError"].includes((error as Error).name)&&path==="/api/bootstrap")throw Object.assign(new Error("The local Host handshake timed out"),{code:"ETIMEDOUT"});throw error;}
  };
  const client=new TraceGraphClient({baseUrl:"http://outlive.local",fetch:boundedBootstrap});
  try {
    await client.bootstrap();
    const response=await transport.fetch("http://outlive.local/api/local/status",{signal:AbortSignal.timeout(2000),headers:{authorization:`Bearer ${client.token}`,origin:"http://127.0.0.1:4310"}});
    if(!response.ok)throw new Error(`Local Host identity check failed (${response.status})`);
    const status=DiscoverySchema.omit({token:true,socket_path:true}).parse(await response.json());
    if(status.boot_nonce!==record.boot_nonce || status.profile_id!==record.profile_id || status.pid!==record.pid)throw new Error("Local Host owner identity changed");
    async function native<T>(path:string,body?:unknown):Promise<T> {
      if(body!==undefined&&client.replayActive)throw workbenchError("replay_read_only","Exit replay before issuing a native owner operation",403);
      await client.bootstrap();
      const result=await transport.fetch(`http://outlive.local${path}`,{method:body===undefined?"GET":"POST",headers:{authorization:`Bearer ${client.token}`,origin:"http://127.0.0.1:4310",...(body===undefined?{}:{"content-type":"application/json"})},...(body===undefined?{}:{body:JSON.stringify(body)}),...(path.startsWith("/api/local/upgrade/")?{signal:AbortSignal.timeout(path.endsWith("/prepare")?20_000:2_000)}:{})});
      const value=await result.json();
      if(!result.ok)throw Object.assign(new Error((value as {message?:string}).message ?? "Local Host request failed"),{statusCode:result.status,code:(value as {error?:string}).error});
      return value as T;
    }
    return {client,status,native:{
      upgradeStatus:()=>native("/api/local/upgrade/state"),
      prepareUpgrade:async input=>LocalUpgradeReceiptSchema.parse(await native("/api/local/upgrade/prepare",input)),
      upgradeReceipt:commandId=>native(`/api/local/upgrade/receipts/${encodeURIComponent(commandId)}`),
      previewMigration:input=>native("/api/local/migration/preview",{...input,profileRoot:record.profile_root}),
      migrationResult:operationId=>native(`/api/local/migration/results/${encodeURIComponent(operationId)}`),
      commitMigration:async input=>{
        const queued=await native<{operation_id:string}>("/api/local/migration/commit",{...input,profileRoot:record.profile_root});
        transport.close();
        const deadline=Date.now()+60_000;
        while(Date.now()<deadline){
          let connection:ConnectedLocalHost|undefined;
          try{connection=await connectLocalHost({profileRoot:record.profile_root});if(connection.status.boot_nonce!==record.boot_nonce){const receipt=await connection.native.migrationResult(queued.operation_id);if(receipt.state==="succeeded"&&receipt.result)return receipt.result;if(receipt.state==="failed")throw new LocalMigrationOutcomeError("migration_failed",queued.operation_id);}}
          catch(error){if((error as {code?:string}).code?.startsWith("migration_"))throw error;}
          finally{await connection?.close();}
          await new Promise(resolve=>setTimeout(resolve,100));
        }
        throw new LocalMigrationOutcomeError("migration_outcome_unknown",queued.operation_id);
      },
      registerProject:async input=>ProjectSummarySchema.parse(await native("/api/local/projects/register",input)),resolveProjectRoot:projectId=>native(`/api/local/projects/${encodeURIComponent(projectId)}/root`)
    },close:async()=>transport.close(),stop:async()=>{await native("/api/local/stop",{});transport.close();},probe:async()=>{try{const response=await transport.fetch("http://outlive.local/health",{signal:AbortSignal.timeout(2000)});if(!response.ok)throw Object.assign(new Error("The private local Host channel is unavailable"),{code:"ECONNRESET"});await response.body?.cancel();}catch(error){if(["TimeoutError","AbortError"].includes((error as Error).name))throw Object.assign(new Error("The local Host readiness probe timed out"),{code:"ETIMEDOUT"});throw error;}}};
  }catch(error){transport.close();if(["TimeoutError","AbortError"].includes((error as Error).name))throw Object.assign(new Error("The local Host identity handshake timed out"),{code:"ETIMEDOUT"});throw error;}
}
export async function ensureLocalHost(options:LocalHostOptions={}):Promise<ConnectedLocalHost> {
  const bundled=options.runtimeDirectory?await resolveBundledRuntime(options.runtimeDirectory):await discoverCurrentBundledRuntime();
  const productBuildId=options.productBuildId ?? bundled?.productBuildId;
  const target={...options,profileRoot:resolve(options.profileRoot ?? defaultLocalProfileRoot(options.environment))};
  if(options.recoveryMode){if(await readLocalOwnerStopIntent(target))throw new LocalHostStoppedError();}
  else {
    // Explicit start must not attach to the owner whose durable stop is still settling.
    if(await readLocalOwnerStopIntent(target)){
      const deadline=Date.now()+20_000;
      while(true){
        let stopping:ConnectedLocalHost|undefined;
        try{stopping=await connectLocalHost(target);await stopping.probe();}
        catch(error){if(["ENOENT","ECONNREFUSED","ECONNRESET"].includes((error as NodeJS.ErrnoException).code??""))break;throw error;}
        finally{await stopping?.close();}
        if(Date.now()>=deadline)throw new LocalHostStoppedError();
        await new Promise(resolve=>setTimeout(resolve,100));
      }
    }
    await clearLocalOwnerStopIntent(target.profileRoot);
  }
  const compatible=async(connection:ConnectedLocalHost):Promise<ConnectedLocalHost>=>{
    if(productBuildId===undefined||connection.status.product_build_id===productBuildId)return connection;
    if(!bundled||bundled.productBuildId!==productBuildId||!connection.status.product_build_id||connection.status.upgrade_protocol!=="outlive.local-upgrade.v1"||!connection.native.prepareUpgrade){
      await connection.close();throw new LocalHostUpgradeRequiredError("The current Host cannot verify a safe application upgrade. Keep existing work intact; after explicitly finishing or stopping it, quit the old application and use its Stop Host action before opening this installed build.");
    }
    const input:PrepareLocalUpgrade={command_id:`upgrade:${randomUUID()}`,profile_id:connection.status.profile_id,owner_nonce:connection.status.boot_nonce,source_build_id:connection.status.product_build_id,target_build_id:productBuildId};
    let receipt:LocalUpgradeReceipt;
    try{receipt=await connection.native.prepareUpgrade(input);}
    catch(error){
      // Another first-launch client can already own the same sealed transaction.
      // Observe only its canonical identity; do not issue a replacement command.
      if((error as {code?:string}).code==="host_upgrade_in_progress"){
        let status=await connection.native.upgradeStatus?.();const waitUntil=Date.now()+2_000;
        while(status?.state==="checking"&&Date.now()<waitUntil){if(await readLocalOwnerStopIntent(target))throw new LocalHostStoppedError();await new Promise(resolve=>setTimeout(resolve,25));status=await connection.native.upgradeStatus?.();}
        if(status?.receipt?.target_build_id===productBuildId)receipt=status.receipt;
        else{await connection.close();throw new LocalHostUpgradeRequiredError("Another application upgrade is being checked. The current Host remains authoritative; wait for its connection status.");}
      }else{
        if((error as {code?:string}).code?.startsWith("host_upgrade_")){await connection.close();throw new LocalHostUpgradeRequiredError((error as Error).message);}
        // An interrupted response is not permission to start another owner. Reconcile this exact command once, read-only.
        const saved=await new WorkbenchJournal(join(target.profileRoot,"owner-upgrade-events")).inspect(input.command_id);
        if(saved.state==="completed")receipt=LocalUpgradeReceiptSchema.parse(saved.result);
        else{await connection.close();throw new LocalHostUpgradeRequiredError("The upgrade request has no confirmed result. No replacement was started; inspect its original canonical receipt.");}
      }
    }
    receipt=LocalUpgradeReceiptSchema.parse(receipt);
    if(receipt.profile_id!==input.profile_id||receipt.owner_nonce!==input.owner_nonce||receipt.source_build_id!==input.source_build_id||receipt.target_build_id!==input.target_build_id||receipt.state!=="prepared"){
      await connection.close();throw new LocalHostUpgradeRequiredError("The upgrade receipt does not match the authenticated owner and installed build. Existing work is preserved.");
    }
    await connection.close();
    const journal=new WorkbenchJournal(join(target.profileRoot,"owner-upgrade-events"));
    const deadline=Date.now()+20_000;
    while(Date.now()<deadline){
      if(await readLocalOwnerStopIntent(target))throw new LocalHostStoppedError();
      // Read the durable retirement fact, rather than interpreting a dropped socket as safe.
      const retired=await journal.inspect(`${receipt.command_id}:retired`);
      if(retired.state==="completed"){
        const fact=LocalUpgradeReceiptSchema.parse(retired.result);
        if(fact.state!=="retired"||fact.command_id!==receipt.command_id||fact.profile_id!==receipt.profile_id||fact.owner_nonce!==receipt.owner_nonce||fact.source_build_id!==receipt.source_build_id||fact.target_build_id!==receipt.target_build_id)throw new LocalHostUpgradeRequiredError("The canonical retirement fact could not be verified.");
        let ownerPresent=true;try{await lstat(join(target.profileRoot,"owner.json"));}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")ownerPresent=false;else throw error;}
        if(!ownerPresent){
          const port=Number(new URL(connection.status.http_address).port);
          // Recovery mode never clears a racing explicit-stop marker.
          return ensureLocalHost({...options,profileRoot:target.profileRoot,httpPort:port,recoveryMode:true});
        }
        // A racing client may have already started the exact requested owner.
        let replacement:ConnectedLocalHost|undefined;
        try{replacement=await connectLocalHost(target);if(replacement.status.product_build_id===productBuildId&&replacement.status.boot_nonce!==receipt.owner_nonce)return replacement;}catch(error){if(!["ENOENT","ECONNREFUSED","ECONNRESET","ETIMEDOUT"].includes((error as NodeJS.ErrnoException).code??""))throw error;}finally{if(replacement?.status.product_build_id!==productBuildId)await replacement?.close();}
      }
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    throw new LocalHostUpgradeRequiredError("The old Host has no verified retirement receipt and released owner lease. Its work was preserved; inspect the original upgrade command before retrying.");
  };
  let existing:ConnectedLocalHost|undefined;
  try{existing=await connectLocalHost(target);}catch(error){if(!["ENOENT","ECONNREFUSED","ECONNRESET","ETIMEDOUT"].includes((error as NodeJS.ErrnoException).code ?? ""))throw error;}
  // A failed upgrade handshake must never fall through to the absent-owner launcher.
  if(existing)return compatible(existing);
  const profileRoot=await privateDirectory(target.profileRoot);
  const node=bundled?.executable ?? await resolveDesktopHostNodeExecutable();
  const webAssetRoot=options.webAssetRoot ?? (bundled?join(dirname(bundled.runtimeDirectory),"app","apps","web","dist"):undefined);
  const argumentsForWorker=[fileURLToPath(new URL("./local-host-worker.js",import.meta.url)),"--profile-root",profileRoot,...(options.recoveryMode?["--recover"]:[]),...(options.dataRoot?["--data-root",resolve(options.dataRoot)]:[]),...(options.sessionRoot?["--session-root",resolve(options.sessionRoot)]:[]),...(options.httpPort!==undefined?["--http-port",String(options.httpPort)]:[]),...(webAssetRoot?["--web-asset-root",resolve(webAssetRoot)]:[]),...(productBuildId?["--product-build-id",productBuildId]:[]),...(options.credentialBackend?["--credential-backend",options.credentialBackend]:[])];
  const ownerEnvironment=localOwnerEnvironment(options.environment ?? process.env);
  if(bundled)ownerEnvironment.PATH=[dirname(bundled.executable),ownerEnvironment.PATH].filter(Boolean).join(delimiter);
  const child=spawn(node,argumentsForWorker,{detached:true,stdio:"ignore",env:ownerEnvironment,windowsHide:true});
  child.unref();
  let spawnError:unknown;child.once("error",error=>{spawnError=error;});
  const deadline=Date.now()+20_000;
  while(Date.now()<deadline){
    if(options.recoveryMode && await readLocalOwnerStopIntent({profileRoot}))throw new LocalHostStoppedError();
    if(spawnError)throw spawnError;
    let candidate:ConnectedLocalHost|undefined;
    try{candidate=await connectLocalHost({...options,profileRoot});}catch(error){if(!["ENOENT","ECONNREFUSED","ECONNRESET","ETIMEDOUT"].includes((error as NodeJS.ErrnoException).code ?? ""))throw error;}
    if(candidate)return compatible(candidate);
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error("Local Host setup unavailable: owner did not become ready; check supported Node and the loopback gateway port");
}
/** Real owner composition. Acquires all root leases before creating Runtime. */
export async function startLocalHost(options:LocalHostOptions={}) {
  const profileRoot=await privateDirectory(resolve(options.profileRoot ?? defaultLocalProfileRoot(options.environment)));
  const profileLease=await acquireOwnerLease(profileRoot);
  const rootLeases:Awaited<ReturnType<typeof acquireOwnerLease>>[]=[];
  let composition:Awaited<ReturnType<typeof createHostComposition>>|undefined;
  const sockets=new Set<Socket>();const authenticated=new WeakSet<Socket>();
  const server=createServer();
  let discovery:Discovery|undefined;
  let control:Awaited<ReturnType<typeof createWorkbenchControl>>|undefined;
  let closing:Promise<void>|undefined;
  let restarting=false,activeMutations=0;
  let grantTimer:ReturnType<typeof setInterval>|undefined;
  let grantChecking=false;
  const admission=new LocalOwnerAdmission();
  const upgradePreparations=new WeakSet<object>();
  let upgrade:LocalOwnerUpgrade|undefined;
  const restartBusy=()=>Object.assign(new Error("Finish active Runs and commands, and close owned terminals/previews before restarting the Host"),{statusCode:409,code:"restart_busy"});
  const restartInProgress=()=>Object.assign(new Error("The Host is restarting; reconnect before starting another operation"),{statusCode:409,code:"host_restarting"});
  const close=():Promise<void>=>closing ??= (async()=>{
    clearInterval(grantTimer);
    for(const socket of sockets)socket.destroy();
    if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));
    composition?.workspaceCoordinator.close();
    await control?.close();
    await composition?.close();
    if(discovery){try{const current=DiscoverySchema.parse(JSON.parse(await readFile(join(profileRoot,"discovery.json"),"utf8")));if(current.boot_nonce===discovery.boot_nonce)await unlink(join(profileRoot,"discovery.json"));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}}
    if(process.platform!=="win32" && discovery)await unlink(discovery.socket_path).catch(()=>undefined);
    await upgrade?.recordRetired();
    for(const lease of rootLeases.reverse())await lease.release();await profileLease.release();
  })();
  try {
    if(options.recoveryMode && await readLocalOwnerStopIntent({profileRoot}))throw new LocalHostStoppedError();
    if(!options.recoveryMode)await clearLocalOwnerStopIntent(profileRoot);
    const profile=await initializeLocalProfile({...options,profileRoot});
    upgrade=new LocalOwnerUpgrade(profileRoot,profile.profile_id,profileLease.nonce,options.productBuildId,admission);await upgrade.initialize();
    for(const root of [...new Set([profile.data_root,profile.session_root])].sort())rootLeases.push(await acquireRuntimeRootLease(root));
    let settings=WorkbenchSettingsValuesSchema.parse({});
    try{const snapshot=WorkbenchSettingsSnapshotSchema.parse(JSON.parse(await readFile(join(profileRoot,"workbench-settings.json"),"utf8")));if(snapshot.profile_id!==profile.profile_id)throw new Error("Settings profile identity mismatch");settings=snapshot.settings;}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    const token=randomBytes(32).toString("base64url");
    composition=await createHostComposition({settings,...(options.deliveryBudget?{deliveryBudget:options.deliveryBudget}:{}),profileRoot,profileId:profile.profile_id,dataDir:profile.data_root,sessionDir:profile.session_root,repositoryRoot:profileRoot,permissionConfigPath:join(profileRoot,"config","harness-config.json"),credentialFile:join(profileRoot,"credentials.json"),credentialStore:options.credentialStore ?? (options.credentialBackend === "private-file" ? new PrivateFileCredentialStore(join(profileRoot,"credentials.json")) : createPlatformCredentialStore({fallbackFile:join(profileRoot,"credentials.json"),environment:curatedNodeEnvironment(options.environment ?? process.env)})),environment:localOwnerEnvironment(options.environment ?? process.env),useEnvironmentModel:false,nativePicker:false,admission:"workspace",isPrivateLocalRequest:request=>authenticated.has(request.raw.socket),assertOwnerAdmission:()=>{if(restarting)throw restartInProgress();admission.assertOpen();},mutationLifecycle:{enter(request){
      const privateStop=request?.routeOptions.url==="/api/local/stop"&&authenticated.has(request.raw.socket);
      const stopCommand=request?.routeOptions.url==="/api/workbench/commands"&&WorkbenchCommandRequestSchema.safeParse(request.body).data?.type==="host.stop";
      if(!privateStop&&!stopCommand){if(restarting)throw restartInProgress();admission.assertOpen();}
      // A private prepare is a synchronously serialized lifecycle check, not
      // admitted business work. Two clients may reach preHandler before the
      // first begins its seal; counting both would manufacture permanent busy.
      if(request?.routeOptions.url==="/api/local/upgrade/prepare"&&authenticated.has(request.raw.socket)){upgradePreparations.add(request);return;}
      admission.enter(privateStop||stopCommand);activeMutations++;
    },leave(request){if(request&&upgradePreparations.delete(request))return;admission.leave();activeMutations=Math.max(0,activeMutations-1);}},logger:options.logger ?? false});
    const {host}=composition;
    const requestRestart=async()=>{
      admission.assertOpen();if(restarting)throw restartInProgress();restarting=true;
      try{
        if(activeMutations>1||composition!.workspaceCoordinator.list().length>0||(await host.runSessions.getActiveRunProjections()).length>0)throw restartBusy();
        const resources=await control!.resources();
        if(resources.terminals.some(x=>x.state==="running")||resources.previews.some(x=>x.owned_process&&["starting","ready"].includes(x.state)))throw restartBusy();
        const port=discovery?Number(new URL(discovery.http_address).port):options.httpPort??0;
        setTimeout(()=>{void close().then(()=>startLocalHost({...options,profileRoot,httpPort:port})).catch(()=>{process.stderr.write("Outlive Host restart failed; the profile was preserved. Start the application again.\n");});},100);
      }catch(error){restarting=false;throw error;}
    };
    const requestStop=async()=>{await persistLocalOwnerStopIntent(profileRoot,profile.profile_id,profileLease.nonce);setTimeout(()=>void close(),100);};
    control=await createWorkbenchControl({...composition,projectCreationAvailable:true,profileRoot,profileId:profile.profile_id,dataRoot:profile.data_root,startRun:input=>{admission.assertOpen();if(restarting)throw restartInProgress();return host.runSessions.startRun(input);},readSession:id=>host.runSessions.getSession(id),registerWorktree:root=>composition!.registerProject(root,"read_write"),onSettingsChanged:async settings=>{composition!.updateRunSettings(settings);},requestStop,requestRestart});
    registerWorkbenchRoutes(host.app,control);
    // A changed local grant applies only to a replacement owner after all work is idle.
    // The canonical restart command remains responsible for its receipt and final busy check.
    grantTimer=setInterval(()=>{if(grantChecking||closing||restarting||admission.state!=="open")return;grantChecking=true;void (async()=>{
      const grant=await composition!.conversationControl.getPermissionGrant();if(!grant.pending_restart||activeMutations||(await readLocalOwnerStopIntent({profileRoot}))||composition!.workspaceCoordinator.list().length||(await host.runSessions.getActiveRunProjections()).length)return;
      const resources=await control!.resources();if(resources.terminals.some(x=>x.state==="running")||resources.previews.some(x=>x.owned_process&&["starting","ready"].includes(x.state)))return;
      await control!.command({type:"host.restart",command_id:`grant-restart:${profileLease.nonce}:${Date.now()}`});
    })().catch(()=>{/* pending grant remains durable; the next idle check reconciles it */}).finally(()=>{grantChecking=false;});},1000);grantTimer.unref?.();
    const requireNative=(request:{raw:IncomingMessage})=>{if(!authenticated.has(request.raw.socket))throw Object.assign(new Error("This operation requires the authenticated private local channel"),{statusCode:403});};
    host.app.get("/api/local/status",async request=>{requireNative(request);if(!discovery)throw new Error("Owner is starting");const {token:_token,socket_path:_socket,...status}=discovery;return status;});
    host.app.get("/api/local/upgrade/state",async request=>{requireNative(request);return upgrade!.status();});
    host.app.get<{Params:{commandId:string}}>("/api/local/upgrade/receipts/:commandId",async request=>{requireNative(request);return upgrade!.receipt(IdentifierSchema.parse(request.params.commandId));});
    host.app.post("/api/local/upgrade/prepare",async(request,reply)=>{
      requireNative(request);
      const receipt=await upgrade!.prepare(request.body,async()=>{
        if(restarting||closing||await readLocalOwnerStopIntent({profileRoot}))throw workbenchError("host_upgrade_busy","An explicit stop or another owner lifecycle operation is still settling.");
        if(composition!.workspaceCoordinator.list().length||(await host.runSessions.getActiveRunProjections()).length)throw workbenchError("host_upgrade_busy","Existing Runs or workspace resources remain active; they will not be cancelled for an upgrade.");
        const resources=await control!.resources();
        if(resources.terminals.some(x=>x.state==="running")||resources.previews.some(x=>x.owned_process&&["starting","ready"].includes(x.state)))throw workbenchError("host_upgrade_busy","Close owned terminals and previews before the installed application can upgrade its Host.");
        let count=0;
        // Read canonical Goal snapshots directly: list() can reconcile state and is not an idle oracle.
        for await(const ids of composition!.goals.ledger.iterateRunIdBatches(32))for(const id of ids){
          if(++count>1000)throw workbenchError("host_upgrade_inspection_limit","Goal history exceeds the bounded upgrade inspection limit.",413);
          const events=await composition!.goals.ledger.listBounded(id,{maxBytes:4*1024*1024,maxEvents:10_000});
          const fact=[...events].reverse().find(event=>event.data.snapshot!==undefined);if(!fact)throw workbenchError("host_upgrade_facts_unavailable","A Goal has no verified canonical snapshot.",503);
          const goal=GoalSnapshotSchema.parse({...fact.data.snapshot as object,receipt_event_id:fact.event_id});
          if(!["paused","completed","cancelled"].includes(goal.status)||goal.active_run_id||goal.budget.held_tokens||goal.budget.held_request_count||goal.budget.unknown_request_count||["recovery_required","persistence_failed","usage_unknown"].includes(goal.budget.stop_reason??""))throw workbenchError("host_upgrade_goal_pending","A Goal, pending approval, or unsettled budget must be explicitly resolved before upgrading.");
        }
        await assertSettledLocalFacts(profileRoot,profile.data_root);
      },()=>{const barriers=[composition!.pauseForOwnerUpgrade(),control!.pauseForOwnerUpgrade()];return {busy:grantChecking||barriers.some(x=>x.busy),resume:()=>{for(const barrier of barriers)barrier.resume();}};});
      reply.send(receipt);
      setTimeout(()=>void close().catch(()=>{process.stderr.write("Outlive safe upgrade could not retire all resources; the existing owner lease was retained. Inspect the upgrade receipt.\n");}),100);
    });
    host.app.post("/api/local/stop",async(request,reply)=>{requireNative(request);await persistLocalOwnerStopIntent(profileRoot,profile.profile_id,profileLease.nonce);reply.send({stopping:true});setImmediate(()=>void close());});
    host.app.post("/api/local/projects/register",async request=>{requireNative(request);const input=z.object({selectedPath:z.string().min(1),access:z.enum(["read_write","read_only"])}).strict().parse(request.body);const project=await composition!.registerProject(input.selectedPath,input.access);return ProjectSummarySchema.parse({project_id:project.workspace.project_id,label:project.label,workspace_kind:project.workspace.workspace_kind,capabilities:project.workspace.capabilities,...(project.location?{location:project.location}:{})});});
    host.app.get<{Params:{projectId:string}}>("/api/local/projects/:projectId/root",async request=>{requireNative(request);const workspace=await composition!.resolveWorkspace(request.params.projectId);return {project_id:workspace.project_id,root:workspace.real_root};});
    const migrationInput=z.object({profileRoot:z.string().optional(),sources:z.array(z.object({id:z.string(),dataRoot:z.string(),sessionRoot:z.string().optional(),modelConfigPath:z.string().optional(),permissionConfigPath:z.string().optional(),credentialFile:z.string().optional()}).strict()).min(1).max(8),selectedSourceId:z.string().optional()}).strict();
    let migrationPending=false;
    host.app.post("/api/local/migration/preview",async request=>{requireNative(request);const input=migrationInput.parse(request.body);if(input.profileRoot && resolve(input.profileRoot)!==profileRoot)throw Object.assign(new Error("Migration target must be this Host profile"),{statusCode:403});return previewLegacyMigration({...input,profileRoot});});
    host.app.get<{Params:{operationId:string}}>("/api/local/migration/results/:operationId",async request=>{requireNative(request);const id=z.string().uuid().parse(request.params.operationId);return JSON.parse(await readFile(join(profileRoot,"migration-operations",`${id}.json`),"utf8")) as unknown;});
    host.app.post("/api/local/migration/commit",async(request,reply)=>{
      requireNative(request);const input=migrationInput.parse(request.body);if(input.profileRoot && resolve(input.profileRoot)!==profileRoot)throw Object.assign(new Error("Migration target must be this Host profile"),{statusCode:403});
      if(migrationPending || composition!.workspaceCoordinator.list().length>0 || (await host.runSessions.getActiveRunProjections()).length>0)throw Object.assign(new Error("Stop active Runs, queued tasks, terminals and owned previews before migrating this profile"),{statusCode:409,code:"migration_busy"});
      const resources=await control!.resources();if(resources.terminals.some(x=>x.state==="running") || resources.previews.some(x=>x.owned_process && ["starting","ready"].includes(x.state)))throw Object.assign(new Error("Stop owned background resources before migrating this profile"),{statusCode:409,code:"migration_busy"});
      const preview=await previewLegacyMigration({...input,profileRoot});if(preview.active_writer_sources.length)throw Object.assign(new Error("Stop legacy writers before migration"),{statusCode:409,code:"migration_busy"});if(preview.requires_source_selection || !preview.selected_source_id)throw Object.assign(new Error("Select one migration source before committing"),{statusCode:400,code:"migration_source_required"});
      const operationId=(await import("node:crypto")).randomUUID();const receiptRoot=await privateDirectory(join(profileRoot,"migration-operations"));const receiptPath=join(receiptRoot,`${operationId}.json`);await atomicPrivateJson(receiptPath,{state:"queued",operation_id:operationId,started_at:new Date().toISOString()});migrationPending=true;
      reply.status(202).send({operation_id:operationId,state:"queued"});
      const restartPort=discovery?Number(new URL(discovery.http_address).port):options.httpPort ?? 0;
      setTimeout(()=>{void (async()=>{
        await close();
        try{const result=await commitLegacyMigration({...input,profileRoot});await atomicPrivateJson(receiptPath,{state:"succeeded",operation_id:operationId,result,completed_at:new Date().toISOString()});}
        catch(error){await atomicPrivateJson(receiptPath,{state:"failed",operation_id:operationId,code:"migration_failed",message:error instanceof Error?error.message:"Migration failed",completed_at:new Date().toISOString()});}
        await startLocalHost({...options,profileRoot,httpPort:restartPort});
      })().catch(async()=>{await atomicPrivateJson(receiptPath,{state:"failed",operation_id:operationId,code:"migration_restart_failed",message:"Profile was preserved but the local Host could not restart",completed_at:new Date().toISOString()});});},25);
    });
    if(options.webAssetRoot)await registerPackagedWeb(host.app,options.webAssetRoot);
    const httpAddress=await host.listen({port:options.httpPort ?? 0});
    const socketPath=localSocketPath(profileRoot,profileLease.nonce);
    if(process.platform!=="win32")await privateDirectory(dirname(socketPath));
    server.on("connection",socket=>{sockets.add(socket);socket.once("close",()=>sockets.delete(socket));});
    server.on("request",(request:IncomingMessage,response:ServerResponse)=>{
      const received=request.headers["x-outlive-local-token"];
      if(typeof received!=="string" || Buffer.byteLength(received)!==Buffer.byteLength(token) || !timingSafeEqual(Buffer.from(received),Buffer.from(token))){response.writeHead(401,{"content-type":"application/json"});response.end(JSON.stringify({error:"local_auth_required"}));return;}
      authenticated.add(request.socket);host.app.routing(request,response);
    });
    await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(socketPath,()=>{server.removeListener("error",reject);resolve();});});
    if(process.platform!=="win32")await (await import("node:fs/promises")).chmod(socketPath,0o600);
    discovery={upgrade_protocol:"outlive.local-upgrade.v1",protocol_version:LOCAL_HOST_PROTOCOL_VERSION,profile_id:profile.profile_id,profile_root:profileRoot,data_root:profile.data_root,session_root:profile.session_root,pid:process.pid,boot_nonce:profileLease.nonce,socket_path:socketPath,token,http_address:httpAddress,...(options.productBuildId?{product_build_id:options.productBuildId}:{})};
    await atomicPrivateJson(join(profileRoot,"discovery.json"),discovery);
    const {token:_token,socket_path:_socket,...status}=discovery;
    return {status,composition,close};
  }catch(error){await close();throw error;}
}
export async function stopLocalHost(options:LocalProfileOptions={}):Promise<void>{const connection=await connectLocalHost(options);await connection.stop();}
export {LocalHostOwnedError};

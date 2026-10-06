import { resolve } from "node:path";
import { HostConnectionError, HostConnectionSnapshotSchema, type HostConnectionSnapshot } from "@tracegraph/contracts";
import { connectLocalHost, ensureLocalHost, readLocalHostDiscoveryIdentity, LocalHostUpgradeRequiredError, type ConnectedLocalHost, type LocalHostOptions, type LocalHostStatus } from "./local-host.js";
import { defaultLocalProfileRoot } from "./local-profile.js";
import { readLocalOwnerStopIntent, LocalHostStoppedError } from "./local-owner-intent.js";
import {resolveBundledRuntime,discoverCurrentBundledRuntime} from "./composition/bundled-runtime.js";
import {TraceGraphHttpError,TraceGraphMutationPreflightError} from "@tracegraph/sdk";

export interface LocalConnectionSupervisorOptions extends LocalHostOptions {
  pollIntervalMs?: number;
  recoveryAttempts?: number;
  /** Composition-only seams for deterministic transport/authority tests. */
  connect?: (options: LocalHostOptions) => Promise<ConnectedLocalHost>;
  ensure?: (options: LocalHostOptions) => Promise<ConnectedLocalHost>;
  identity?: (options: LocalHostOptions) => Promise<LocalHostStatus>;
  stopped?: (options: LocalHostOptions) => Promise<boolean>;
  onRebind?: (connection: ConnectedLocalHost, generation: number) => Promise<void> | void;
  onDisconnect?: () => Promise<void> | void;
}

function transportError(error: unknown): boolean {
  const value=error as {code?:string;name?:string;status?:number;body?:{error?:string}};
  return ["ENOENT","ECONNREFUSED","ECONNRESET","EPIPE","ETIMEDOUT"].includes(value?.code??"")
    || value?.status===401 || value?.body?.error==="local_auth_required";
}

/** Native-only owner authority. It never repeats a domain operation or resumes a Run. */
export class LocalHostConnectionSupervisor {
  readonly #options: LocalConnectionSupervisorOptions;
  #connection: ConnectedLocalHost | undefined;
  #snapshot: HostConnectionSnapshot={state:"starting",generation:0};
  #flight: Promise<void> | undefined;
  #repairFlight:Promise<void>|undefined;
  #timer?: ReturnType<typeof setTimeout>;
  #closed=false;
  #attempts=0;
  #nextRecovery=0;
  #profileId?: string;
  #buildId:string|undefined;
  #buildLoaded=false;
  #paused=0;
  #lastPort:number|undefined;
  #stableSince=0;
  #nextUpgrade=0;
  #upgradeAvailable=false;
  constructor(options: LocalConnectionSupervisorOptions={}) {
    this.#options={...options,profileRoot:resolve(options.profileRoot??defaultLocalProfileRoot(options.environment))};
    this.#lastPort=options.httpPort;
  }
  getSnapshot(): HostConnectionSnapshot { return {...this.#snapshot}; }
  /** Use only for an explicit replay exit; it never grants fresh live authority. */
  get retainedConnection(): ConnectedLocalHost | undefined { return this.#connection; }
  async initialize(): Promise<void> { await this.refresh(); this.#schedule(); }
  repair():Promise<void>{
    if(!this.#repairFlight)this.#repairFlight=this.#repair().finally(()=>{this.#repairFlight=undefined;});
    return this.#repairFlight;
  }
  async #repair(): Promise<void> {
    if(this.#closed)throw new HostConnectionError({state:"offline",generation:this.#snapshot.generation,code:"host_offline",message:"This client was closed"});
    if(this.#connection?.client.replayActive)throw new HostConnectionError({...this.#snapshot,code:"host_replay_stale",message:"Exit replay before repairing the live Host connection"});
    await this.#flight;
    this.#attempts=0;this.#nextRecovery=0;
    try { await this.#bind(await (this.#options.ensure??ensureLocalHost)({...this.#options,...(this.#lastPort===undefined?{}:{httpPort:this.#lastPort}),recoveryMode:false})); }
    catch(error){this.#failure(error);throw new HostConnectionError(this.#snapshot);}
    this.#schedule();
  }
  refresh(): Promise<void> {
    if(this.#closed||this.#paused)return Promise.resolve();
    if(this.#repairFlight)return this.#repairFlight;
    if(!this.#flight)this.#flight=this.#refresh().finally(()=>{this.#flight=undefined;});
    return this.#flight;
  }
  /** Profile migration owns its close/copy/restart transaction; monitors must not race it. */
  async pause():Promise<()=>void> {this.#paused++;await this.#flight;await this.#repairFlight;let released=false;return()=>{if(!released){released=true;this.#paused--;this.#schedule();}};}
  async connection(): Promise<ConnectedLocalHost> {
    await this.refresh();
    if(this.#snapshot.state!=="connected"||!this.#connection)throw new HostConnectionError(this.#snapshot);
    return this.#connection;
  }
  async read<T>(operation:(connection:ConnectedLocalHost)=>Promise<T>|T):Promise<T> {
    const connection=await this.connection(),generation=this.#snapshot.generation;
    try {
      const value=await operation(connection);
      if(generation!==this.#snapshot.generation)throw new HostConnectionError({...this.#snapshot,code:"host_read_stale",message:"The Host owner changed while this read was pending. Read the current owner again."},"host_read_stale");
      return value;
    }catch(error){if(transportError(error)){if((error as {status?:number}).status===401&&!connection.client.replayActive)await connection.client.bootstrap().catch(()=>undefined);await this.refresh();throw new HostConnectionError({...this.#snapshot,code:"host_read_stale",message:"The Host connection changed while reading. Refresh the current view."},"host_read_stale");}throw error;}
  }
  async mutate<T>(operation:(connection:ConnectedLocalHost)=>Promise<T>|T):Promise<T> {
    const connection=await this.connection();
    try{return await operation(connection);}
    catch(error){if(error instanceof TraceGraphMutationPreflightError||(error instanceof TraceGraphHttpError&&error.admission==="rejected")){void this.refresh();throw error;}if(transportError(error)){void this.refresh();throw new HostConnectionError({...this.#snapshot,code:"host_write_outcome_unknown",message:"The connection changed before the command result arrived. Inspect its original command receipt before retrying."},"host_write_outcome_unknown");}throw error;}
  }
  /** Observe a known restart receipt without resubmitting the restart command. */
  async waitForReplacement(nonce:string,timeoutMs=20_000):Promise<void> {
    const deadline=Date.now()+timeoutMs;
    while(Date.now()<deadline&&!this.#closed){await this.refresh();if(this.#snapshot.state==="connected"&&this.#snapshot.owner_nonce!==nonce)return;await new Promise(resolve=>setTimeout(resolve,100));}
    throw new HostConnectionError({...this.#snapshot,code:"host_reconnecting",message:"The Host replacement is not confirmed. Inspect the connection before retrying the command."});
  }
  async close():Promise<void> {
    this.#closed=true;clearTimeout(this.#timer);await this.#flight;await this.#repairFlight;
    await this.#options.onDisconnect?.();await this.#connection?.close();this.#connection=undefined;
  }
  async #refresh():Promise<void> {
    try {
      if(!this.#buildLoaded){const bundled=this.#options.runtimeDirectory?await resolveBundledRuntime(this.#options.runtimeDirectory):await discoverCurrentBundledRuntime();this.#buildId=this.#options.productBuildId??bundled?.productBuildId;this.#upgradeAvailable=bundled!==undefined&&bundled.productBuildId===this.#buildId;this.#buildLoaded=true;}
      if(await (this.#options.stopped??readLocalOwnerStopIntent)(this.#options)) {
        if(this.#snapshot.state!=="stopped"){await this.#options.onDisconnect?.();await this.#connection?.close();this.#connection=undefined;}
        this.#set("stopped","host_stopped","The local Host was explicitly stopped. Start it explicitly to continue.");return;
      }
      let identity:LocalHostStatus|undefined;
      try{identity=await (this.#options.identity??readLocalHostDiscoveryIdentity)(this.#options);}
      catch(error){if(!transportError(error))throw error;}
      if(identity&&this.#profileId&&identity.profile_id!==this.#profileId)throw new Error("Profile identity changed");
      const current=this.#connection;
      // A client already bound to its build never attempts to replace a foreign newer owner.
      // Fresh installed clients can request only the verified private upgrade transaction.
      if(identity&&this.#buildId!==undefined&&identity.product_build_id!==this.#buildId&&current?.client.replayActive){this.#set("offline","host_replay_stale","The Host owner changed during replay. Exit replay before reconnecting; replay cannot prepare an upgrade.");return;}
      if(identity&&this.#buildId!==undefined&&identity.product_build_id!==this.#buildId&&current)throw new LocalHostUpgradeRequiredError("This client belongs to a retired application build. Open the updated application; it will not downgrade the running Host.");
      if(identity&&current?.status.boot_nonce===identity.boot_nonce){
        try{await current.probe();if(Date.now()-this.#stableSince>=60_000){this.#attempts=0;this.#nextRecovery=0;}this.#set("connected");return;}catch(error){if(!transportError(error))throw error;}
      }
      if(current?.client.replayActive){this.#set("offline","host_replay_stale","The Host owner changed during replay. Exit replay to reconnect; replay does not gain live write authority.");return;}
      const firstBinding=this.#snapshot.generation===0;
      let chargedRecovery=false;
      this.#set("reconnecting","host_reconnecting","Reconnecting to the current local Host owner");
      let next:ConnectedLocalHost;
      try { next=await (this.#options.connect??connectLocalHost)(this.#options); }
      catch(error){
        if(!transportError(error))throw error;
        if(Date.now()<this.#nextRecovery)return;
        if(this.#attempts>=(this.#options.recoveryAttempts??3)){this.#set("offline","host_recovery_exhausted","Automatic Host recovery did not succeed. Repair the connection to try again.");return;}
        this.#attempts++;this.#nextRecovery=Date.now()+Math.min(5_000,1_000*2**(this.#attempts-1));
        chargedRecovery=true;
        this.#set("recovering","host_recovering","Recovering the local Host. Saved Runs remain paused until explicitly resumed.");
        next=await (this.#options.ensure??ensureLocalHost)({...this.#options,...(this.#lastPort===undefined?{}:{httpPort:this.#lastPort}),recoveryMode:true});
      }
      const expected=this.#buildId??current?.status.product_build_id;
      if(expected!==undefined&&next.status.product_build_id!==expected){
        await next.close();
        if(current||!this.#upgradeAvailable)throw new LocalHostUpgradeRequiredError("This client belongs to a different application build. Open the updated application; existing work is preserved.");
        if(Date.now()<this.#nextUpgrade)throw new LocalHostUpgradeRequiredError();
        this.#nextUpgrade=Date.now()+5_000;
        // Upgrade checks have their own bounded polling cadence and do not consume crash recovery attempts.
        next=await (this.#options.ensure??ensureLocalHost)({...this.#options,...(this.#lastPort===undefined?{}:{httpPort:this.#lastPort}),recoveryMode:true});
        if(next.status.product_build_id!==expected){await next.close();throw new LocalHostUpgradeRequiredError();}
      }
      await this.#bind(next);
      // Refund only this successful ensure after all identity/build and rebind checks.
      // A verified unchanged process or its nonce rotation is not another crash.
      // Earlier failed startups and different-process recoveries remain charged.
      const ready=this.#connection;
      if(chargedRecovery&&this.#snapshot.state==="connected"
        &&ready?.status.profile_id===next.status.profile_id&&ready.status.boot_nonce===next.status.boot_nonce&&ready.status.pid===next.status.pid
        &&(firstBinding||current?.status.pid===next.status.pid)){
        this.#attempts=Math.max(0,this.#attempts-1);
      }
    }catch(error){this.#failure(error);}
  }
  async #bind(next:ConnectedLocalHost):Promise<void> {
    if(this.#closed){await next.close();return;}
    if(this.#profileId&&next.status.profile_id!==this.#profileId){await next.close();throw new Error("Profile identity changed");}
    const previous=this.#connection;
    if(previous?.status.boot_nonce===next.status.boot_nonce){await next.close();this.#set("connected");return;}
    const gateway=new URL(next.status.http_address);
    if(gateway.protocol!=="http:"||gateway.hostname!=="127.0.0.1"||gateway.username||gateway.password||gateway.pathname!=="/"||gateway.search||gateway.hash||!gateway.port){await next.close();throw new Error("Invalid local Host gateway identity");}
    await this.#options.onDisconnect?.();
    const generation=this.#snapshot.generation+1;
    try {await this.#options.onRebind?.(next,generation);}
    catch(error){await next.close();throw error;}
    this.#connection=next;this.#profileId=next.status.profile_id;this.#nextRecovery=0;this.#stableSince=Date.now();
    this.#lastPort=Number(gateway.port);
    this.#snapshot=HostConnectionSnapshotSchema.parse({state:"connected",generation,profile_id:next.status.profile_id,owner_nonce:next.status.boot_nonce});
    await previous?.close();
  }
  #failure(error:unknown):void {
    if(error instanceof LocalHostStoppedError){this.#set("stopped","host_stopped",error.message);return;}
    if(error instanceof LocalHostUpgradeRequiredError){this.#set("upgrade-required","host_upgrade_required",error.message);return;}
    if(transportError(error)){this.#set("offline","host_offline","The local Host could not be reached. Connection recovery will retry within its bounded budget.");return;}
    this.#set("offline","host_profile_invalid","The local Host profile or installation could not be validated. Open installation diagnostics before retrying.");
  }
  #set(state:HostConnectionSnapshot["state"],code?:HostConnectionSnapshot["code"],message?:string):void {
    this.#snapshot=HostConnectionSnapshotSchema.parse({state,generation:this.#snapshot.generation,...(this.#profileId?{profile_id:this.#profileId}:{}),...(this.#snapshot.owner_nonce?{owner_nonce:this.#snapshot.owner_nonce}:{}),...(code?{code}:{}),...(message?{message}:{} )});
  }
  #schedule():void {
    clearTimeout(this.#timer);if(this.#closed)return;
    this.#timer=setTimeout(()=>{void this.refresh().finally(()=>this.#schedule());},this.#options.pollIntervalMs??1_000);this.#timer.unref?.();
  }
}

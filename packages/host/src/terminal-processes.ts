import {execFile} from "node:child_process";

export interface TerminalProcessIdentity {pid:number;parent:number;group:number;uid:number;tty:string;state:string;started:string;}

/** Fixed native inspection only. No user arguments, shell, environment secrets or unbounded output. */
export async function readTerminalProcesses():Promise<TerminalProcessIdentity[]> {
  const output=await new Promise<string>((resolve,reject)=>execFile("/bin/ps",["-axo","pid=,ppid=,pgid=,uid=,tty=,stat=,lstart="],{encoding:"utf8",timeout:1000,maxBuffer:2*1024*1024,shell:false,env:{PATH:"/usr/bin:/bin",LC_ALL:"C"}},(error,stdout)=>error?reject(new Error("Terminal process identities could not be inspected")):resolve(stdout)));
  return output.split("\n").flatMap(line=>{const match=/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+?)\s*$/u.exec(line);if(!match)return [];return [{pid:Number(match[1]),parent:Number(match[2]),group:Number(match[3]),uid:Number(match[4]),tty:match[5]!,state:match[6]!,started:match[7]!}];});
}
const same=(a:TerminalProcessIdentity,b:TerminalProcessIdentity)=>a.pid===b.pid&&a.uid===b.uid&&a.started===b.started;
export async function identifyTerminalProcess(pid:number):Promise<TerminalProcessIdentity> {
  const deadline=Date.now()+2000;
  while(Date.now()<deadline){const row=(await readTerminalProcesses()).find(row=>row.pid===pid);if(row&&row.uid===process.getuid?.()&&row.tty!=="?"&&row.tty!=="??"&&row.group>1)return row;await new Promise(resolve=>setTimeout(resolve,10));}
  throw new Error("The owned terminal identity is unavailable");
}

/** Tracks this PTY's observed jobs, including shell-created process groups after reparenting. */
export class OwnedTerminalProcesses {
  readonly #known=new Map<number,TerminalProcessIdentity>();
  readonly #root:TerminalProcessIdentity;
  readonly #protectedGroups:ReadonlySet<number>;
  constructor(root:TerminalProcessIdentity,protectedGroups:readonly number[]){
    if(!Number.isSafeInteger(root.pid)||root.pid<=1||root.group<=1||root.uid!==process.getuid?.()||!root.tty||["?","??"].includes(root.tty))throw new Error("Invalid owned terminal identity");
    this.#root=root;this.#known.set(root.pid,root);this.#protectedGroups=new Set(protectedGroups);
  }
  async initialize():Promise<void>{const rows=await readTerminalProcesses();if(!rows.some(row=>same(row,this.#root)&&row.tty===this.#root.tty))throw new Error("Owned terminal identity changed before supervision");this.#observe(rows);}
  async refresh():Promise<void>{this.#observe(await readTerminalProcesses());}
  #observe(rows:TerminalProcessIdentity[]):void{
    const liveKnown=rows.filter(row=>{const known=this.#known.get(row.pid);return known&&same(row,known);});
    const parents=new Set(liveKnown.map(row=>row.pid));
    // A still-owned member proves the original PTY is occupied; do not claim a reused TTY alone.
    const ttyOwned=liveKnown.some(row=>row.tty===this.#root.tty&&!row.state.startsWith("Z"));
    for(let changed=true;changed;){changed=false;for(const row of rows){if(row.uid!==this.#root.uid||row.pid<=1||this.#protectedGroups.has(row.group))continue;if(parents.has(row.parent)||(ttyOwned&&row.tty===this.#root.tty)){if(!parents.has(row.pid)){parents.add(row.pid);changed=true;}this.#known.set(row.pid,row);}}}
  }
  #owned(rows:TerminalProcessIdentity[]):TerminalProcessIdentity[]{return rows.filter(row=>{const known=this.#known.get(row.pid);return known&&same(row,known)&&!row.state.startsWith("Z");});}
  #signal(rows:TerminalProcessIdentity[],signal:NodeJS.Signals):void{
    const groups=new Set(this.#owned(rows).map(row=>row.group));
    for(const group of groups){if(group<=1||this.#protectedGroups.has(group))throw new Error("Terminal process group authority is invalid");
      if(rows.some(row=>row.group===group&&row.uid!==this.#root.uid))throw new Error("Terminal process group contains another user");
      try{process.kill(-group,signal);}catch(error){if((error as NodeJS.ErrnoException).code!=="ESRCH")throw error;}
    }
  }
  async stop():Promise<void>{
    let rows=await readTerminalProcesses();this.#observe(rows);this.#signal(rows,"SIGTERM");
    await new Promise(resolve=>setTimeout(resolve,200));
    const deadline=Date.now()+3000;
    while(true){rows=await readTerminalProcesses();this.#observe(rows);const owned=this.#owned(rows);if(owned.length===0)return;if(Date.now()>deadline)throw new Error("Owned terminal jobs did not become quiescent");this.#signal(rows,"SIGKILL");await new Promise(resolve=>setTimeout(resolve,25));}
  }
}

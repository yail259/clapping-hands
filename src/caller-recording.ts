import {randomUUID} from 'node:crypto';
import {captureDemonstration} from './demonstration.js';
import {parseBrowserTaskOutcome,type BrowserTaskOutcome} from './browser-task.js';
import {assertResponseValue,type JsonValue} from './response-contract.js';
import {taskDefinitionSchema,type TaskDefinition} from './task-store.js';
import {TaskSession} from './task-session.js';

export type RecordedDemonstration=Awaited<ReturnType<typeof captureDemonstration>>;

/** Owns one explicitly shared local browser demonstration, not an agent loop.
 * CDP access is a trusted caller capability, not a security sandbox. The caller
 * must not close/reconfigure the browser or use it for unrelated tasks.
 * No connection is returned until both recorders surround the provider wait. */
export class CallerRecording{
  readonly id=randomUUID();
  private state:'recording'|'finishing'|'finished'|'cancelled'='recording';
  private timer:ReturnType<typeof setTimeout>|undefined;
  private settle!:(value:{outcome:BrowserTaskOutcome})=>void;
  private observation!:Promise<RecordedDemonstration>;
  private closing:Promise<void>|undefined;
  private readonly abort=()=>{void this.cancel().catch(()=>{});};
  private constructor(readonly session:TaskSession,readonly definition:TaskDefinition,
    readonly input:JsonValue,private readonly signal:AbortSignal){}

  static async start(definitionInput:TaskDefinition,input:JsonValue,directory:string,profile:string,
    signal:AbortSignal,options:{timeoutMs?:number;headless?:boolean;sessionFactory?:(definition:TaskDefinition,profile:string,headless:boolean)=>TaskSession}={}){
    const definition=taskDefinitionSchema.parse(definitionInput);
    assertResponseValue(definition.inputSchema,input);
    const timeoutMs=options.timeoutMs??300_000;
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>300_000)throw new Error('Invalid recording deadline.');
    if(signal.aborted)throw new Error('Recording cancelled.');
    const session=options.sessionFactory?.(definition,profile,options.headless??false)
      ??new TaskSession(new URL(definition.startUrl).origin,profile,options.headless??false,definition.allowedNetworkOrigins);
    await session.start();
    const recording=new CallerRecording(session,definition,structuredClone(input),signal);
    try{
      if(signal.aborted)throw new Error('Recording cancelled.');
      let ready!:()=>void;
      const attached=new Promise<void>(resolve=>{ready=resolve;});
      const outcome=new Promise<{outcome:BrowserTaskOutcome}>(resolve=>{recording.settle=resolve;});
      recording.observation=captureDemonstration(session,definition,recording.input,directory,
        {kind:'caller',execute:async()=>{ready();return outcome;}},signal);
      // Observe rejection immediately; the owner still receives it through finish/cancel.
      void recording.observation.catch(()=>{});
      await Promise.race([attached,recording.observation.then(()=>{throw new Error('Recording ended before attachment.');})]);
      signal.addEventListener('abort',recording.abort,{once:true});
      session.context.on('close',recording.abort);
      recording.timer=setTimeout(recording.abort,timeoutMs);recording.timer.unref();
      if(signal.aborted){await recording.cancel();throw new Error('Recording cancelled.');}
      return recording;
    }catch(error){await recording.close();throw error;}
  }
  connection(){
    if(this.state!=='recording')throw new Error('Recording is not active.');
    return {recordingId:this.id,cdpUrl:this.session.cdpUrl,startUrl:this.definition.startUrl};
  }
  async finish(value:unknown):Promise<RecordedDemonstration>{
    if(this.state!=='recording'||this.signal.aborted)throw new Error('Recording is not active.');
    const outcome=parseBrowserTaskOutcome(value,this.definition.outputSchema);
    this.state='finishing';this.settle({outcome});
    try{
      const result=await this.observation;
      if(this.signal.aborted||this.state!=='finishing')throw new Error('Recording cancelled.');
      this.state='finished';return result;
    }finally{await this.close();}
  }
  async cancel(){
    if(this.state==='finished'||this.state==='cancelled')return this.close();
    this.state='cancelled';this.settle?.({outcome:{status:'failed'}});
    await this.close();
    await this.observation?.catch(()=>{});
  }
  private close(){
    if(!this.closing){
      if(this.timer)clearTimeout(this.timer);
      this.signal.removeEventListener('abort',this.abort);
      this.session.context?.off('close',this.abort);
      this.closing=this.session.close();
    }
    return this.closing;
  }
}

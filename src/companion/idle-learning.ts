export const LEARNING_IDLE_MS=10*60_000;
export interface LearningJob {done:Promise<void>;cancel():void}
interface Clock {
  now():number;
  set(callback:()=>void,delay:number):{unref?():void};
  clear(timer:object):void;
}
const clock:Clock={now:()=>performance.now(),set:(fn,delay)=>setTimeout(fn,delay),
  clear:timer=>clearTimeout(timer as ReturnType<typeof setTimeout>)};

/** One runtime-wide idle window: foreground work always takes priority. */
export class IdleLearning {
  private readonly start:()=>LearningJob;
  private readonly pending:()=>boolean;
  private readonly busy:()=>boolean;
  private readonly clock:Clock;
  private timer:ReturnType<Clock['set']>|null=null;
  private job:LearningJob|null=null;
  private active=0;
  private lastActivity:number;
  private closed=false;
  private error:string|null=null;
  constructor(start:()=>LearningJob,pending:()=>boolean,busy:()=>boolean=()=>false,testClock:Clock=clock){
    this.start=start;this.pending=pending;this.busy=busy;this.clock=testClock;
    this.lastActivity=this.clock.now();this.arm();
  }
  activity(){
    if(this.closed)return;
    this.lastActivity=this.clock.now();this.error=null;
    const job=this.job;this.job=null;job?.cancel();this.arm();
  }
  begin(){
    this.active++;this.activity();let finished=false;
    return ()=>{if(finished)return;finished=true;this.active--;this.activity();};
  }
  status(){
    return {state:this.closed?'closed':this.job?'training':this.error?'failed':this.active||this.busy()?'active':'waiting',
      idleMs:this.active||this.busy()?0:Math.max(0,this.clock.now()-this.lastActivity),
      requiredIdleMs:LEARNING_IDLE_MS,error:this.error};
  }
  close(){
    this.closed=true;if(this.timer)this.clock.clear(this.timer);this.timer=null;
    const job=this.job;this.job=null;job?.cancel();
  }
  private arm(){
    if(this.timer)this.clock.clear(this.timer);this.timer=null;
    if(this.closed||this.active)return;
    this.timer=this.clock.set(()=>{this.timer=null;this.tick();},Math.max(1,LEARNING_IDLE_MS-(this.clock.now()-this.lastActivity)));
    this.timer.unref?.();
  }
  private tick(){
    if(this.closed||this.active||this.job)return;
    if(this.busy()){this.lastActivity=this.clock.now();this.arm();return;}
    if(this.clock.now()-this.lastActivity<LEARNING_IDLE_MS){this.arm();return;}
    try{
      if(!this.pending())return;
      const job=this.start();this.job=job;
      job.done.then(()=>this.finish(job,null),()=>this.finish(job,'personal_learning_failed'));
    }catch{this.error='personal_learning_failed';this.lastActivity=this.clock.now();this.arm();}
  }
  private finish(job:LearningJob,error:string|null){
    if(this.closed||this.job!==job)return;
    this.job=null;this.error=error;
    // New work or a failed batch waits for another complete idle interval.
    if(error||this.pending()){this.lastActivity=this.clock.now();this.arm();}
  }
}

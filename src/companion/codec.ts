import type {CompanionDecisionOutput,CompanionDecisionTask,CompanionOpportunity} from './types.ts';
import type {FrontendStrategy} from '../user-model/types.ts';

export function companionDecisionPrompt(opportunity:CompanionOpportunity,strategy:FrontendStrategy,
  context:{nowMs:number;unansweredCount:number;busyUntilMs:number|null;lastUserActivityAtMs:number|null}):CompanionDecisionTask {
  if(strategy.sourceVersions.profileRevision!==opportunity.profileRevision)throw new Error('context_changed_retry');
  return {schema:'xldb-companion-decision-task-v1',opportunityId:opportunity.opportunityId,allowedDecisions:['approve','defer','dismiss'],
    messages:[
      {role:'system',content:'Decide whether this one-way companion contact is useful now. Do not invent user activity, reply, feelings, or schedules. Silence is not evidence. Return only one of these exact JSON shapes: {"schema":"xldb-companion-decision-v1","decision":"approve","reason":"short reason"}; {"schema":"xldb-companion-decision-v1","decision":"defer","delayMinutes":1,"reason":"short reason"}; {"schema":"xldb-companion-decision-v1","decision":"dismiss","reason":"short reason"}. For defer choose delayMinutes as an integer from 1 to 1440. Never calculate timestamps; the host computes the next check from the time it receives your decision. Choose dismiss when no useful later contact fits the remaining window. No message body or new facts may be added.'},
      {role:'user',content:JSON.stringify({opportunity:{id:opportunity.opportunityId,kind:opportunity.kind,purpose:opportunity.purpose,
        topic:opportunity.topic,windowEndMs:opportunity.windowEndMs,expiresAtMs:opportunity.expiresAtMs},strategy,context})},
    ]};
}

export function decodeCompanionDecision(output:string,task:CompanionDecisionTask,nowMs=Date.now()):CompanionDecisionOutput {
  let value:unknown;try{value=JSON.parse(output);}catch{throw new Error('invalid_companion_decision_json');}
  if(!value||typeof value!=='object')throw new Error('invalid_companion_decision');
  const row=value as Record<string,unknown>,decision=row.decision;
  if(row.schema!=='xldb-companion-decision-v1'||!task.allowedDecisions.includes(decision as never))throw new Error('invalid_companion_decision');
  const reason=text(row.reason,300);
  let next:number|null=null;
  if(decision==='defer'){
    if(row.delayMinutes!==undefined){
      if(!Number.isSafeInteger(row.delayMinutes)||(row.delayMinutes as number)<1||(row.delayMinutes as number)>1440||row.nextCheckAtMs!==undefined)
        throw new Error('invalid_companion_defer');
      next=time(time(nowMs)+(row.delayMinutes as number)*60_000);
    }else next=time(row.nextCheckAtMs);
  }else if((row.nextCheckAtMs!==null&&row.nextCheckAtMs!==undefined)||row.delayMinutes!==undefined)throw new Error('invalid_companion_decision');
  return {schema:'xldb-companion-decision-v1',decision:decision as CompanionDecisionOutput['decision'],reason,nextCheckAtMs:next};
}
function text(value:unknown,max:number):string {if(typeof value!=='string'||!value.trim()||value.length>max)throw new Error('invalid_companion_decision');return value.trim();}
function time(value:unknown):number {if(!Number.isSafeInteger(value)||(value as number)<0)throw new Error('invalid_companion_decision');return value as number;}

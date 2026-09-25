import type {DatabaseSync} from 'node:sqlite';
import {AgentJevClient} from './agentjev.ts';
import {PersonalLearning,type LearningEvaluator,type LearningJob} from './personal-learning.ts';
import {PersonalWeightsStore} from './personal-weights.ts';

type RelationshipPayload={request:unknown;sourceId:string;sourceRevision:number;
  labelKey:string;kind:'explicit'|'behavior'};

/** Called only by the idle worker. A test can inject fixed features without loading AgentJev. */
export async function processLearningQueue(db:DatabaseSync,options:{
  cancelled?:()=>boolean;evaluator?:LearningEvaluator;onClient?:(client:AgentJevClient)=>void;
}={}):Promise<number> {
  const weights=new PersonalWeightsStore(db),learning=new PersonalLearning(db,weights);
  let client:AgentJevClient|undefined;
  const evaluator=()=>{
    if(options.evaluator)return options.evaluator;
    if(!client){client=new AgentJevClient({threads:1});options.onClient?.(client);}
    return client;
  };
  const assertActive=()=>{if(options.cancelled?.())throw new Error('learning_cancelled');};
  let completed=0;
  try{
    for(let job:LearningJob|undefined;(job=learning.nextJob());){
      assertActive();
      if(!learning.jobCurrent(job)){
        learning.finishJob(job);continue;
      }
      if(job.taskType==='contact'){
        const payload=JSON.parse(job.payload) as {modelIdentity:string};
        db.exec('BEGIN IMMEDIATE');
        try{
          assertActive();
          if(learning.jobCurrent(job))weights.train(job.scopeKey,'contact',payload.modelIdentity,assertActive);
          learning.finishJob(job);assertActive();db.exec('COMMIT');completed++;
        }catch(error){db.exec('ROLLBACK');throw error;}
        continue;
      }
      if(job.jobKey.startsWith('relationship-train:')){
        const {modelIdentity}=JSON.parse(job.payload) as {modelIdentity:string};
        db.exec('BEGIN IMMEDIATE');
        try{
          assertActive();
          if(learning.jobCurrent(job))weights.train(job.scopeKey,'relationship',modelIdentity,assertActive);
          learning.finishJob(job);assertActive();db.exec('COMMIT');completed++;
        }catch(error){db.exec('ROLLBACK');throw error;}
        continue;
      }
      const payload=JSON.parse(job.payload) as RelationshipPayload;
      if(!job.jobKey.startsWith('relationship-binary-v4:')){
        learning.finishJob(job);continue;
      }
      if(!learning.jobCurrent(job,payload.sourceId,payload.sourceRevision)){
        learning.finishJob(job);continue;
      }
      const worker=evaluator();
      let result:Awaited<ReturnType<LearningEvaluator['evaluateWithTrace']>>;
      try{result=await worker.evaluateWithTrace(payload.request,{scopeKey:job.scopeKey,taskType:'relationship'});}
      catch(error){assertActive();throw error;}
      assertActive();
      db.exec('BEGIN IMMEDIATE');
      try{
        assertActive();
        if(learning.jobCurrent(job,payload.sourceId,payload.sourceRevision)){
          for(const trace of result.learningTraces)weights.recordFeedback({trace,labelKey:payload.labelKey,
            sourceId:payload.sourceId,sourceRevision:payload.sourceRevision,kind:payload.kind},true);
          weights.train(job.scopeKey,'relationship',worker.identity(),assertActive);
        }
        learning.finishJob(job);assertActive();db.exec('COMMIT');completed++;
      }catch(error){db.exec('ROLLBACK');throw error;}
    }
    return completed;
  }finally{client?.close();}
}

import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {processLearningQueue} from './learning-executor.ts';
import type {AgentJevClient} from './agentjev.ts';

export function startLearningWorker(databasePath:string):{done:Promise<void>;cancel:()=>void} {
  if(!isMainThread)throw new Error('learning_worker_nested');
  const flag=new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const cancelled=new Int32Array(flag);
  const worker=new Worker(new URL(import.meta.url),{workerData:{kind:'xldb-learning',databasePath,flag}});
  let settled=false;
  const done=new Promise<void>((resolve,reject)=>{
    worker.once('error',error=>{settled=true;reject(error);});
    worker.once('exit',code=>{
      if(settled)return;
      settled=true;
      if(code===0||Atomics.load(cancelled,0)===1)resolve();
      else reject(new Error(`learning_worker_exit:${code}`));
    });
  });
  return {done,cancel:()=>{
    if(settled)return;
    Atomics.store(cancelled,0,1);
    worker.postMessage('cancel');
  }};
}

if(!isMainThread&&workerData?.kind==='xldb-learning'){
  const data=workerData as {databasePath:string;flag:SharedArrayBuffer};
  const cancelled=new Int32Array(data.flag);
  const db=new DatabaseSync(data.databasePath);
  let client:AgentJevClient|undefined;
  // Model inference has its own AgentJevClient and Python child in this thread.
  parentPort?.on('message',message=>{
    if(message==='cancel'){Atomics.store(cancelled,0,1);client?.close();}
  });
  try{
    await processLearningQueue(db,{cancelled:()=>Atomics.load(cancelled,0)===1,onClient:value=>{client=value;}});
  }catch(error){
    if(!(error instanceof Error&&error.message==='learning_cancelled'))throw error;
  }finally{
    db.close();parentPort?.close();
  }
}

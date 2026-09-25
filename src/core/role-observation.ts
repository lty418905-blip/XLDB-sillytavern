import type {ModelConfig} from './types.ts';
import type {SceneObservationPart} from './models.ts';
import {withModelAddress} from './runtime-log.ts';

/** One actor/source only. Durable part caching and retries remain owned by SceneCore.stage. */
export function roleObservationBatch(run:(parts:SceneObservationPart[],config:ModelConfig)=>Promise<Record<string,unknown>>) {
  type Pending={part:SceneObservationPart;config:ModelConfig;single:()=>Promise<unknown>;decode:(value:unknown)=>unknown;resolve:(value:unknown)=>void;reject:(error:unknown)=>void};
  let pending:Pending[]=[];
  const flush=async()=>{
    const batch=pending;pending=[];
    const groups:Pending[][]=[];
    for(const item of batch){
      const group=groups.find(items=>sameConfig(items[0].config,item.config));
      if(group)group.push(item);else groups.push([item]);
    }
    await Promise.all(groups.map(async group=>{
      if(group.length===1){const item=group[0];try{item.resolve(await withModelAddress({stage:item.part},item.single));}catch(error){item.reject(error);}return;}
      let result:Record<string,unknown>;
      try{result=await run(group.map(item=>item.part),group[0].config);}
      catch(error){for(const item of group)item.reject(error);return;}
      for(const item of group){
        try{
          if(!Object.hasOwn(result,item.part))throw new Error('model_invalid_response');
          item.resolve(item.decode(result[item.part]));
        }catch(error){item.reject(error instanceof Error&&['invalid_object','invalid_text'].includes(error.message)
          ?new Error('model_invalid_response'):error);}
      }
    }));
  };
  return <T>(part:SceneObservationPart,config:ModelConfig,single:()=>Promise<T>,decode:(value:unknown)=>T):Promise<T>=>
    new Promise<T>((resolve,reject)=>{
      pending.push({part,config,single,decode,resolve:resolve as (value:unknown)=>void,reject});
      if(pending.length===1)queueMicrotask(()=>{void flush();});
    });
}

function sameConfig(a:ModelConfig,b:ModelConfig){
  return a.baseUrl===b.baseUrl&&a.key===b.key&&a.model===b.model&&a.thinking===b.thinking;
}

import type {CommitmentRecord} from './types.ts';

/** Reader-scoped wording for a replacement; authority keeps each source-literal content unchanged. */
export function commitmentDisplayText(record:CommitmentRecord,records:readonly CommitmentRecord[],
  viewer:{readerId?:string;admin?:boolean},timeZone?:string):string{
  if(!viewer.admin&&(!viewer.readerId||!record.readers.includes(viewer.readerId)))return '';
  const deadline=record.term.kind==='deadline'?record.term.deadlineQuote:'';
  const clock=record.term.kind==='deadline'&&timeZone
    ?new Intl.DateTimeFormat('en-GB',{timeZone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(record.term.dueAtMs)
    :'';
  const currentTerm=deadline?`；当前期限：${deadline}${clock?`（${clock}）`:''}`:'';
  if(!record.replaces||!record.scope)return record.content+currentTerm;
  const history:CommitmentRecord[]=[];
  const seen=new Set([record.id]);
  let id:string|undefined=record.replaces;
  while(id&&!seen.has(id)){
    seen.add(id);
    const old=records.find(item=>item.id===id&&item.scope&&sameScope(item.scope,record.scope)&&
      item.status==='superseded'&&(viewer.admin||viewer.readerId&&item.readers.includes(viewer.readerId)));
    if(!old)break;
    history.push(old);id=old.replaces;
  }
  if(!history.length)return record.content+currentTerm;
  return `本次修订：${record.content}${currentTerm}；关联历史（已被替代、旧期限无效）：${history.reverse().map(item=>item.content).join(' → ')}`;
}

function sameScope(left:CommitmentRecord['scope'],right:CommitmentRecord['scope']):boolean{
  return left.worldId===right.worldId&&left.sessionId===right.sessionId&&
    left.branchId===right.branchId&&left.characterId===right.characterId;
}

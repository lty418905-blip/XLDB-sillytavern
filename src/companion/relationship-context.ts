import type {ProfileEntry} from '../user-model/types.ts';
import type {CommitmentRecord} from '../commitments/types.ts';
import type {EmotionState} from '../emotion/openher.ts';
import type {ContactAffect} from '../emotion/contact-affect.ts';
import {createHash} from 'node:crypto';

export interface RelationshipAuxiliaryContext {
  clock:{nowMs:number;utcIso:string;timeZone:string;localDateTime:string};
  waiting:{phase:'waiting'|'returning';absence:string;elapsedBand:'under12h'|'12-24h'|'over24h';sourceRefs:string[];
    sourceCount?:number;sourceDigest?:string}|null;
  profileFacts:{ref:string;claim:string;uncertain:boolean}[];
  commitments:{ref:string;content:string;term:CommitmentRecord['term'];contactRestriction?:CommitmentRecord['contactRestriction']}[];
  emotion:ReturnType<typeof compactOpenHerForContact>|null;
  /** Exact active/restricted window identities supplied by the authoritative commitment projection. */
  contactWindowState:string[];
  excluded:{profileRefs:string[];commitmentRefs:string[];profileCount?:number;commitmentCount?:number;digest?:string};
}

/** Character display precision only; the supplied OpenHer state and its learned weights are untouched. */
export function compactOpenHerForContact(state:EmotionState){
  const round=(value:number)=>Math.round(value*100)/100;
  return {drives:{connection:round(state.drives.connection),safety:round(state.drives.safety),expression:round(state.drives.expression)},
    frustration:{connection:round(state.frustration.connection),safety:round(state.frustration.safety)},
    signals:{warmth:round(state.behavioralSignals.warmth),vulnerability:round(state.behavioralSignals.vulnerability),
      initiative:round(state.behavioralSignals.initiative),directness:round(state.behavioralSignals.directness)},
    stableRelations:{trust:round(state.stableRelations.trust),depth:round(state.stableRelations.depth),
      valence:round(state.stableRelations.valence)}};
}

/** Selects complete authorized facts; exclusions are explicit for diagnostics. Characters are a display bound, not a token estimate. */
export function selectWholeContactFacts(entries:readonly ProfileEntry[],records:readonly CommitmentRecord[],maxCharacters:number){
  if(!Number.isSafeInteger(maxCharacters)||maxCharacters<1)throw new Error('invalid_relationship_context_budget');
  const profiles=entries.map((entry,index)=>({entry,index,ref:`${entry.id}@${entry.revision}`}))
    .sort((a,b)=>Number(b.entry.corrected)-Number(a.entry.corrected)||
      Number(b.entry.basis==='explicit')-Number(a.entry.basis==='explicit')||a.index-b.index);
  const commitments=records.map((record,index)=>({record,index,ref:`${record.id}@${record.revision}`}))
    .sort((a,b)=>Number(Boolean(b.record.contactRestriction))-Number(Boolean(a.record.contactRestriction))||
      Number(b.record.term.kind==='deadline')-Number(a.record.term.kind==='deadline')||a.index-b.index);
  const selectedProfiles:ProfileEntry[]=[],selectedCommitments:CommitmentRecord[]=[];
  const excluded={profileRefs:[] as string[],commitmentRefs:[] as string[]};
  let used=0;
  // Contact boundaries take priority over descriptive profile facts.
  for(const item of commitments){
    const compact={ref:item.ref,content:item.record.content,term:item.record.term,contactRestriction:item.record.contactRestriction};
    const cost=JSON.stringify(compact).length;
    if(used+cost<=maxCharacters){selectedCommitments.push(item.record);used+=cost;}
    else excluded.commitmentRefs.push(item.ref);
  }
  for(const item of profiles){
    const compact={ref:item.ref,claim:item.entry.claim,uncertain:item.entry.basis==='inferred'||item.entry.attribution==='uncertain'};
    const cost=JSON.stringify(compact).length;
    if(used+cost<=maxCharacters){selectedProfiles.push(item.entry);used+=cost;}
    else excluded.profileRefs.push(item.ref);
  }
  return {profileEntries:selectedProfiles,commitments:selectedCommitments,excluded};
}

export function relationshipAuxiliaryContext(input:{nowMs:number;timeZone:string;affect?:ContactAffect|null;
  profileEntries?:readonly ProfileEntry[];commitments?:readonly CommitmentRecord[];emotion?:EmotionState|null;
  contactWindowState?:readonly string[];
  factBudgetCharacters?:number}):RelationshipAuxiliaryContext {
  const {nowMs,timeZone}=input;
  if(!Number.isSafeInteger(nowMs)||nowMs<0||typeof timeZone!=='string'||!timeZone)throw new Error('invalid_relationship_clock');
  let localDateTime:string;
  try{
    const parts=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',
      second:'2-digit',hourCycle:'h23'}).formatToParts(nowMs);
    const part=(name:string)=>parts.find(item=>item.type===name)?.value??'';
    localDateTime=`${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`;
  }catch{throw new Error('invalid_relationship_clock');}
  const selected=selectWholeContactFacts(input.profileEntries??[],input.commitments??[],input.factBudgetCharacters??1200);
  const contactWindowState=[...new Set(input.contactWindowState??[])].sort();
  if(contactWindowState.some(value=>typeof value!=='string'||value.length>300))throw new Error('invalid_relationship_window_state');
  const affect=input.affect;
  const waitingRefs=affect?[...new Set([...affect.sourceRefs.outgoingIds,
    ...affect.sourceRefs.explanationSources.map(ref=>`${ref.sourceId}@${ref.revision}`)])]:[];
  const waiting=affect?.episode&&affect.phase!=='none'?{phase:affect.phase,absence:affect.absence??'uncertain',
    elapsedBand:affect.episode.elapsedMs<12*3_600_000?'under12h' as const:
      affect.episode.elapsedMs<24*3_600_000?'12-24h' as const:'over24h' as const,
    sourceRefs:waitingRefs.length<=6?waitingRefs:[...waitingRefs.slice(0,2),...waitingRefs.slice(-4)],
    sourceCount:waitingRefs.length,sourceDigest:createHash('sha256').update(JSON.stringify(waitingRefs)).digest('hex')}:null;
  return {clock:{nowMs,utcIso:new Date(nowMs).toISOString(),timeZone,localDateTime},waiting,
    profileFacts:selected.profileEntries.map(entry=>({ref:`${entry.id}@${entry.revision}`,claim:entry.claim,
      uncertain:entry.basis==='inferred'||entry.attribution==='uncertain'})),
    commitments:selected.commitments.map(record=>({ref:`${record.id}@${record.revision}`,content:record.content,term:record.term,
      ...(record.contactRestriction?{contactRestriction:record.contactRestriction}:{})})),
    emotion:input.emotion?compactOpenHerForContact(input.emotion):null,contactWindowState,
    excluded:{profileRefs:selected.excluded.profileRefs.slice(0,2),commitmentRefs:selected.excluded.commitmentRefs.slice(0,2),
      profileCount:selected.excluded.profileRefs.length,commitmentCount:selected.excluded.commitmentRefs.length,
      digest:createHash('sha256').update(JSON.stringify(selected.excluded)).digest('hex')}};
}

/** Stable within the same minute, while preserving exact wall time in the model input. */
export function relationshipContextFingerprint(value:RelationshipAuxiliaryContext|null|undefined):unknown {
  if(!value)return null;
  return {...value,clock:{timeZone:value.clock.timeZone,utcMinute:Math.floor(value.clock.nowMs/60_000)}};
}

import {currentMemory,sameScope} from './current-record.ts';
import type {CueRecall,Retention} from './retention.ts';
import {retainedAccess,visibleLayer,isLegacyTemplate,protectedEmotionalReaction,rememberedFragmentsOf,traceEligible} from './retention.ts';
import {eventKey,restoredAccess} from './trace.ts';
import type {TraceHit,TraceTier} from './trace.ts';
export {visibleLayer} from './retention.ts';

export interface Scope {
  worldId: string;
  sessionId: string;
  branchId: string;
  characterId: string;
}

export type Access = 'clear' | 'gist' | 'feeling' | 'anchor' | 'hidden';

export type MemoryKind = 'fact' | 'episode';

export interface EpisodeMemory {
  scene: string;
  participants: string[];
  sensoryCues: string[];
  appraisal: string;
  feelingBasis: 'explicit' | 'inferred';
  feelingQuote: string;
  /** Optional only on typed records created before multi-observation episodes. */
  evidenceQuotes?: string[];
}

export interface Memory {
  id: string;
  scope: Scope;
  source: { messageId: string; revision: number; occurredAtMs: number | null; knownAtMs: number;
    author?: {role:'user'|'assistant';actorId:string};
    reference?: {fileHash:string;table:string;row:string};
    knowledge?: {kind:string;actorId?:string;observationId:string;start:number;end:number} };
  status: 'accepted' | 'candidate' | 'deleted' | 'superseded';
  access: Access;
  /** User-set granularity takes precedence over automatic retention. */
  accessOverride?:boolean;
  retention?:Retention;
  retentionAtMs?:number;
  rehearsalSources?:number;
  reactivated?:boolean;
  reactivation?:{kind:'semantic'};
  detail: string;
  gist: string;
  feeling: string;
  anchor: string;
  protectedFacts: readonly string[];
  /** Missing only on records persisted before dual-memory extraction. */
  kind?: MemoryKind;
  episode?: EpisodeMemory;
}

/** Validated current records from one consistent authority read, never model/index data. */
export interface MemorySnapshot {
  /** Current story clock when applicable; otherwise the caller's real time. */
  memoryTimeMs?:number;
  scope: Scope;
  version: number;
  messages: ReadonlyMap<string, { revision: number; status: 'accepted' | 'deleted' }>;
  memories: ReadonlyMap<string, Memory>;
  /** Trusted one-hop host reply bindings; never copied into MemoryView output. */
  replyParents?: ReadonlyMap<string, {
    assistantRevision: number;
    parentMessageId: string;
    parentRevision: number;
  }>;
}

export interface MemoryView {
  /** A remembered reaction, never an assertion about current mood or objective history. */
  emotionalReaction?:NonNullable<ReturnType<typeof protectedEmotionalReaction>>;
  reactivated?:boolean;
  reactivation?:{kind:'semantic'};
  id: string;
  source: Memory['source'];
  access: Access;
  kind: MemoryKind | 'legacy';
  protectedFacts: string[];
  /** Preserves whether a visible episode feeling was stated or inferred. */
  feelingBasis?: EpisodeMemory['feelingBasis'];
  episode?: EpisodeMemory;
  detail?: string;
  gist?: string;
  feeling?: string;
  anchor?: string;
  /** Short verbatim scene and sensory fragments of a faded, emotionally protected episode. Absent at clear. */
  rememberedFragments?: string[];
  /** What has faded, as a code; contextFrom renders it in the story language. Absent at clear. */
  forgottenMarker?: ForgottenMarker;
}

export type ForgottenMarker = 'details_faded' | 'gist_faded' | 'scene_faded' | 'rest_inaccessible';

/**
 * Search supplies IDs only. Text and access decisions come from current authority.
 * Gist/feeling/anchor must already be approved for their respective access levels.
 * This projects stored decisions; it neither decides when to forget nor rewrites text.
 */
export function projectMemories(
  snapshot: MemorySnapshot,
  request: { scope: Scope; asOfMs: number; ids: readonly string[] },
): { scope: Scope; version: number; memories: MemoryView[] } {
  if (!sameScope(snapshot.scope, request.scope)) throw new Error('scope_mismatch');
  if (!Number.isSafeInteger(request.asOfMs) || request.asOfMs < 0) throw new Error('invalid_time');

  const memories: MemoryView[] = [];
  for (const id of new Set(request.ids)) {
    let memory = currentMemory(snapshot, id, request.asOfMs);
    if (!memory) continue;
    memory={...memory,access:retainedAccess(memory,snapshot.memoryTimeMs??request.asOfMs).access};

    // Construct an allow-listed result: spreading the record would copy hidden text.
    const view: MemoryView = {
      id,
      source: {
        messageId: memory.source.messageId,
        revision: memory.source.revision,
        occurredAtMs: memory.source.occurredAtMs,
        knownAtMs: memory.source.knownAtMs,
        ...(memory.source.author ? {author:{role:memory.source.author.role,actorId:memory.source.author.actorId}} : {}),
        ...(memory.source.reference ? {reference:{fileHash:memory.source.reference.fileHash,table:memory.source.reference.table,row:memory.source.reference.row}} : {}),
        ...(memory.source.knowledge ? {knowledge:{
          kind:memory.source.knowledge.kind,...(memory.source.knowledge.actorId?{actorId:memory.source.knowledge.actorId}:{}),
          observationId:memory.source.knowledge.observationId,start:memory.source.knowledge.start,end:memory.source.knowledge.end,
        }} : {}),
      },
      access: memory.access,
      ...(memory.reactivated?{reactivated:true}:{}),
      ...(memory.reactivation?{reactivation:memory.reactivation}:{}),
      kind: memory.kind ?? 'legacy',
      protectedFacts: [...memory.protectedFacts],
    };
    if (memory.access !== 'hidden' && memory.kind === 'episode' && memory.episode) {
      view.feelingBasis = memory.episode.feelingBasis;
    }
    switch (memory.access) {
      case 'clear':
        view.detail = memory.detail;
        // Layers are raw at clear; only a stored legacy template is withheld.
        for (const layer of ['gist','feeling','anchor'] as const) if (!isLegacyTemplate(memory[layer])) view[layer] = memory[layer];
        if (memory.kind === 'episode' && memory.episode) {
          view.episode = {
            scene: memory.episode.scene,
            participants: [...memory.episode.participants],
            sensoryCues: [...memory.episode.sensoryCues],
            appraisal: memory.episode.appraisal,
            feelingBasis: memory.episode.feelingBasis,
            feelingQuote: memory.episode.feelingQuote,
            evidenceQuotes: [...(memory.episode.evidenceQuotes ?? [memory.detail])],
          };
        }
        break;
      case 'gist':
        coarseLayers(view,memory,['gist','feeling','anchor']);
        view.forgottenMarker = 'details_faded';
        break;
      case 'feeling':
        coarseLayers(view,memory,['feeling','anchor']);
        view.forgottenMarker = 'gist_faded';
        break;
      case 'anchor':
        coarseLayers(view,memory,['anchor']);
        view.forgottenMarker = 'scene_faded';
        break;
      case 'hidden':
        if (view.protectedFacts.length === 0) continue;
        view.forgottenMarker = 'rest_inaccessible';
        break;
      default:
        throw new Error('invalid_access');
    }
    const reaction=protectedEmotionalReaction(memory);
    // The reaction stays structured next to the model's own feeling; a fallback phrase exists only in the context copy.
    if(reaction)view.emotionalReaction=reaction;
    const fragments=rememberedFragmentsOf(memory);
    if(fragments.length)view.rememberedFragments=fragments;
    memories.push(view);
  }
  return {
    scope: {
      worldId: snapshot.scope.worldId,
      sessionId: snapshot.scope.sessionId,
      branchId: snapshot.scope.branchId,
      characterId: snapshot.scope.characterId,
    },
    version: snapshot.version,
    memories,
  };
}

export {currentMemory} from './current-record.ts';
const CLARITY:readonly Access[]=['hidden','anchor','feeling','gist','clear'];
/**
 * The decided hits that name a restorable record, by event and in the order given: the first id that named the event,
 * and strong when any hit of the event is. Malformed hits, hits naming no target and throwing id/strong getters are
 * skipped. Access to the array itself (including an element getter) may throw.
 */
function hitEvents(raw:MemorySnapshot,nowMs:number,hits:readonly unknown[]):Map<string,TraceHit> {
  const events=new Map<string,TraceHit>();
  if(!Array.isArray(hits)||!hits.length)return events;
  const clock=raw.memoryTimeMs??nowMs;
  for(const hit of hits){
    let id:unknown,strong:unknown;
    try{if(!hit||typeof hit!=='object')continue;id=(hit as {id?:unknown}).id;strong=(hit as {strong?:unknown}).strong;}catch{continue;}
    const memory=typeof id==='string'?currentMemory(raw,id,nowMs):undefined;
    if(!memory||!traceEligible(memory,clock))continue;
    const key=eventKey(memory),known=events.get(key);
    events.set(key,{id:known?.id??memory.id,strong:known?.strong===true||strong===true});
  }
  return events;
}
/** Applies decided recall hits on top of the cue-restored snapshot. Stages and text come from the authority record. */
export function recallSnapshot(raw:MemorySnapshot,cued:MemorySnapshot,nowMs:number,hits:readonly unknown[]):MemorySnapshot {
  const decided=hitEvents(raw,nowMs,hits);
  if(!decided.size)return cued;
  const clock=raw.memoryTimeMs??nowMs;
  const memories=new Map(cued.memories);
  for(const [id,memory] of raw.memories){
    const current=cued.memories.get(id);
    if(!current||memory.status!=='accepted'||!traceEligible(memory,clock))continue;
    const strong=decided.get(eventKey(memory))?.strong;
    if(strong===undefined)continue;
    const restored=restoredAccess(retainedAccess(memory,clock).access as TraceTier,strong);
    const byCue=current.reactivated===true;
    const access=byCue&&CLARITY.indexOf(current.access)>CLARITY.indexOf(restored)?current.access:restored;
    memories.set(id,{...current,access,reactivated:true,...(byCue?{}:{reactivation:{kind:'semantic' as const}})});
  }
  return {...cued,memories};
}
/**
 * The recalls one context applies: at most `limit` events, twins being one event. The cue recalls come first, in this
 * order: a strong recall (two cues of one record); then an event one of whose records the search returned, in the
 * order of `ranked`; then the rest by source time, the newest first. The decided hits follow in the order given. An
 * event beyond the limit is left out of both lists, so it is not restored at all; a hit on an event a cue recalled
 * stays with that event.
 */
export function limitRecalls(raw:MemorySnapshot,nowMs:number,cues:readonly CueRecall[],hits:readonly unknown[],ranked:readonly unknown[],
  limit:number):{cues:CueRecall[];hits:TraceHit[]} {
  const decided=hitEvents(raw,nowMs,hits);
  const cued=new Map(cues.map(recall=>[recall.event,recall]));
  if(cued.size+[...decided.keys()].filter(event=>!cued.has(event)).length<=limit)return {cues:[...cues],hits:[...decided.values()]};
  const place=new Map<string,number>();
  ranked.forEach((id,index)=>{
    const memory=typeof id==='string'?raw.memories.get(id):undefined;
    if(!memory)return;
    const event=eventKey(memory);
    if(cued.has(event)&&!place.has(event))place.set(event,index);
  });
  const sourceOf=(recall:CueRecall)=>raw.memories.get(recall.ids[0]!)?.source;
  const order=[...cued.values()].sort((a,b)=>{
    if(a.strong!==b.strong)return a.strong?-1:1;
    const left=place.get(a.event),right=place.get(b.event);
    if(left!==right)return left===undefined?1:right===undefined?-1:left-right;
    const x=sourceOf(a),y=sourceOf(b);
    return (y?.knownAtMs??0)-(x?.knownAtMs??0)||(y?.occurredAtMs??0)-(x?.occurredAtMs??0)||(a.event<b.event?-1:a.event>b.event?1:0);
  }).map(recall=>recall.event);
  for(const event of decided.keys())if(!cued.has(event))order.push(event);
  const kept=new Set(order.slice(0,limit));
  return {cues:cues.filter(recall=>kept.has(recall.event)),hits:[...decided].filter(([event])=>kept.has(event)).map(([,hit])=>hit)};
}

/** Visible or masked layers only; a blocked layer is absent, never '' or a substitute sentence. */
function coarseLayers(view: MemoryView, memory: Memory, layers: readonly ('gist'|'feeling'|'anchor')[]): void {
  for (const layer of layers) {
    const result = visibleLayer(memory,layer);
    if (result.state !== 'blocked') view[layer] = result.text;
  }
}

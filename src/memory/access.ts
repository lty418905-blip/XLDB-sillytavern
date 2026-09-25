import type {Retention,SemanticCue} from './retention.ts';
import {retainedAccess,withoutDirectCopy,protectedEmotionalReaction,protectedFeeling} from './retention.ts';
export {directlyCopiesPreciseText,withoutDirectCopy} from './retention.ts';

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
  reactivated?:boolean;
  reactivation?:{kind:'semantic';cue:string;basis:string};
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
  reactivation?:{kind:'semantic';cue:string;basis:string};
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
  forgotten?: string;
}

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
    let memory = snapshot.memories.get(id);
    if (!memory || memory.id !== id || memory.status !== 'accepted') continue;
    if (!sameScope(memory.scope, request.scope)) continue;
    const message = snapshot.messages.get(memory.source.messageId);
    if (!message || message.status !== 'accepted' || message.revision !== memory.source.revision) continue;
    if (memory.source.knownAtMs > request.asOfMs || (memory.source.occurredAtMs !== null && memory.source.occurredAtMs > request.asOfMs)) continue;
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
        view.gist = memory.gist;
        view.feeling = memory.feeling;
        view.anchor = memory.anchor;
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
        view.gist = coarseLayer(memory,'gist');
        view.feeling = coarseLayer(memory,'feeling');
        view.anchor = coarseLayer(memory,'anchor');
        view.forgotten = '具体细节已遗忘，只记得大意、感觉和事件锚点。';
        break;
      case 'feeling':
        view.feeling = coarseLayer(memory,'feeling');
        view.anchor = coarseLayer(memory,'anchor');
        view.forgotten = '细节与大意已遗忘，只保留感觉和事件锚点。';
        break;
      case 'anchor':
        view.anchor = coarseLayer(memory,'anchor');
        view.forgotten = '细节与情景已遗忘，只保留事件锚点。';
        break;
      case 'hidden':
        if (view.protectedFacts.length === 0) continue;
        view.forgotten = '此记忆的其它内容当前不可访问。';
        break;
      default:
        throw new Error('invalid_access');
    }
    const reaction=protectedEmotionalReaction(memory);
    if(reaction){view.emotionalReaction=reaction;view.feeling=protectedFeeling(memory);}
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

/** Restore at most one layer from a source-backed, currently visible cue. */
export function reactivateSnapshot(snapshot:MemorySnapshot,nowMs:number,cues:readonly SemanticCue[]):MemorySnapshot {
  const views=new Map(projectMemories(snapshot,{scope:snapshot.scope,asOfMs:nowMs,ids:cues.map(cue=>cue.id)}).memories.map(view=>[view.id,view]));
  const memories=new Map(snapshot.memories);
  for(const cue of cues){
    const memory=memories.get(cue.id),view=views.get(cue.id);
    if(!memory||!view||!cue.basis.trim()||memory.accessOverride||memory.retention?.kind!=='peripheral'||memory.source.reference||
      !Number.isFinite(cue.distance)||!Number.isFinite(cue.margin)||cue.distance>0.14||cue.margin<0.05)continue;
    if(![view.gist,view.feeling,view.anchor].filter(Boolean).join('\n').includes(cue.basis))continue;
    if(view.access!=='gist'&&view.access!=='feeling')continue;
    const access:Access=view.access==='feeling'?'gist':cue.distance<=0.04&&cue.margin>=0.12?'clear':'gist';
    memories.set(cue.id,{...memory,access,reactivated:true,reactivation:{kind:'semantic',cue:cue.cue.slice(0,160),basis:cue.basis.slice(0,240)}});
  }
  return {...snapshot,memories};
}

function coarseLayer(memory: Memory, layer: 'gist'|'feeling'|'anchor'): string {
  return withoutDirectCopy(memory.detail,memory[layer],layer,memory.protectedFacts);
}

function sameScope(a: Scope, b: Scope): boolean {
  return a.worldId === b.worldId && a.sessionId === b.sessionId
    && a.branchId === b.branchId && a.characterId === b.characterId;
}

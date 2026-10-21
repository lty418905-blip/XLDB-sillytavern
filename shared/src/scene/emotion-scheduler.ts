import {createEmotionLineResolver} from './emotion-own-line.ts';
import type {EmotionLineResolver} from './emotion-own-line.ts';
import {foldForMatch} from '../common/script-fold.ts';
import type {SceneState} from './types.ts';

/** Foreground NPC updates per user turn; the product budget is four, with all remaining updates deferred. */
export const EMOTION_NPC_BUDGET = 4;

/** Identity of the frozen structural ranking rules, used only to invalidate derived ranking stage results. */
export const EMOTION_RANK_RULE_VERSION = 'structural-priority-v1';

/** Authorized NPC evidence and structural signals. Counts are events; emotion frustration is bounded to 0..5. */
export interface EmotionRankCandidate {
  id: string;
  name: string;
  evidenceQuotes: string[];
  omittedEvidenceCount: number;
  currentEmotion: string;
  currentTarget: boolean;
  present: boolean;
  deferredEvents: number;
}

/** Ranked identifiers and provenance; legacy methods remain readable by injected hosts and stored history. */
export interface EmotionRanking {
  orderedIds: string[];
  method: 'agentjev' | 'agentjev_guarded' | 'deterministic';
  reason?: string;
  modelIdentity?: string;
}

/**
 * Rank authorized evidence synchronously, without I/O or scheduling. Each candidate is scanned once before sorting:
 * O(T + C log C), where T is evidence and emotion-summary length and C is the candidate count.
 * Invalid backlog counts contribute zero; unreadable emotion contributes no unmet drive.
 */
export function deterministicEmotionRanking(
  candidates: readonly EmotionRankCandidate[],
  reason: string,
): EmotionRanking {
  const ranked = candidates.map(candidate => ({candidate, key: rankingKey(candidate)}));

  ranked.sort((left, right) => {
    for (let index = 0; index < left.key.length; index++) {
      const difference = right.key[index] - left.key[index];
      if (difference !== 0) return difference;
    }

    return left.candidate.id.localeCompare(right.candidate.id);
  });

  return {
    orderedIds: ranked.map(item => item.candidate.id),
    method: 'deterministic',
    reason,
  };
}

/** The production ranker returns a synchronous rules-only result; candidate access errors propagate to its caller. */
export function rankEmotionCandidates(candidates: readonly EmotionRankCandidate[]): EmotionRanking {
  return deterministicEmotionRanking(candidates, 'structural_priority');
}

function rankingKey(item: EmotionRankCandidate): number[] {
  const evidence = foldForMatch(item.evidenceQuotes.join('\n'));
  const mentioned = item.name.trim() !== '' && evidence.includes(foldForMatch(item.name));
  const deferred = Number.isFinite(item.deferredEvents) ? Math.max(0, item.deferredEvents) : 0;
  // Product-selected provisional buckets let lexical evidence break ties within an operational priority.
  // Exact backlog magnitudes would otherwise keep lexical evidence from ever deciding those ties.
  const backlogBucket = deferred >= 3 ? 2 : deferred >= 1 ? 1 : 0;
  const driveBucket = unmetDrive(item.currentEmotion) >= 3 ? 1 : 0;

  return [
    Number(item.present),
    Number(item.currentTarget),
    Number(mentioned),
    backlogBucket,
    driveBucket,
    currentImpactBand(item),
    lexicalScore(evidence),
  ];
}

/** Match the existing quote families; curved openers accept any curved closer. */
function closesQuote(opening: string, closing: string): boolean {
  if (opening === '"') return closing === '"';
  if (opening === '《') return closing === '》';

  return '”’」』'.includes(closing);
}

/** Strip quotations in O(n) time and O(n) space; speech verbs in the preceding 16 UTF-16 units retain speech. */
function impactEvidence(source: string): string {
  const straightEnds = new Int32Array(source.length);
  const bookEnds = new Int32Array(source.length);
  const curvedEnds = new Int32Array(source.length);
  let straightEnd = source.length;
  let bookEnd = source.length;
  let curvedEnd = source.length;

  // Two bounded passes visit at most 2n units; unmatched openers never rescan a suffix.
  for (let end = source.length - 1; end >= 0; end--) {
    straightEnds[end] = straightEnd;
    bookEnds[end] = bookEnd;
    curvedEnds[end] = curvedEnd;
    const closing = source[end];
    if (closesQuote('"', closing)) straightEnd = end;
    if (closesQuote('《', closing)) bookEnd = end;
    if (closesQuote('“', closing)) curvedEnd = end;
  }

  const parts: string[] = [];
  let start = 0;

  for (let offset = 0; offset < source.length; offset++) {
    const opening = source[offset];
    if (!'“‘「『"《'.includes(opening)) continue;

    let end = curvedEnds[offset];
    if (opening === '"') end = straightEnds[offset];
    if (opening === '《') end = bookEnds[offset];
    if (end === source.length) continue;

    parts.push(source.slice(start, offset));
    const lead = source.slice(Math.max(0, offset - 16), offset);
    if (opening !== '《' && /(?:说|喊|表示|回答|承认|坦白|叫道|喊道)\s*[:：]?$/u.test(lead))
      parts.push(source.slice(offset + 1, end));

    offset = end;
    start = end + 1;
  }

  parts.push(source.slice(start));
  return parts.join('');
}

function currentImpactBand(item:EmotionRankCandidate):number {
  // This is a conservative salience gate, not an emotion diagnosis. The source
  // quotations are already scoped to this NPC by the scene service.
  let band = 0;
  const name = foldForMatch(item.name);

  for (const original of item.evidenceQuotes) {
    // Fixed scans of a matching copy: O(n); the ranker never rewrites stored evidence.
    const source = foldForMatch(original);
    const outsideQuotes = impactEvidence(source);
    for (const raw of outsideQuotes.split(/[，,。；;！？!?\n]/u)) {
      let clause = raw.trim();
      if (!clause || /^(?:回忆|想起|记得)|(?:十年前|多年前|当年|以前|过去|曾经)/u.test(clause) &&
        !/(?:此刻|现在|如今|再次|重新|刚刚|刚|这时)/u.test(clause)) continue;
      if (/(?:档案|书中|报道)/u.test(clause) && !/(?:自己|本人|此刻|现在)/u.test(clause)) continue;

      const other = /(?:别人|另一个人|旁人|其[他它]人|他人|隔壁有人)/u.exec(clause);
      if (other) {
        const after = clause.slice(other.index + other[0].length);
        const own = [after.indexOf('自己'), after.indexOf('本人'), after.indexOf(name)]
          .filter(index => index >= 0)
          .sort((left, right) => left - right)[0];
        if (own === undefined) continue;
        clause = after.slice(own);
      }

      const positive = clause
        .replace(/(?:没有|并未|未曾|不再|不|没|无)(?:再)?(?:感到|觉得|会)?(?:受伤|害怕|恐惧|愤怒|悲伤|痛哭|哭泣|惊恐|绝望|发抖|颤抖|流泪|掉泪|掉眼泪|僵住|僵在原地)/gu, '')
        .replace(/(?:双手|手|身体|身子|浑身|全身)(?:已经)?(?:没有|不再|不|没)(?:再)?抖/gu, '');
      if (/(?:失声痛哭|痛哭|惊恐|恐惧|害怕|绝望|愤怒|背叛|去世|死亡|死了|失踪|遇险|重逢|失而复得|心碎|panic|terrified|betray|crying|grief|reunited)/iu.test(positive))
        band = Math.max(band, 3);
      else if (/(?:发抖|颤抖|(?:双手|手|身体|身子|浑身|全身)(?:还|一直|不停|止不住)?抖|僵(?:住|在原地)|眼泪(?:止不住地)?(?:掉|流|落)|(?:泪水|泪珠)(?:掉|流|落)|手心(?:全|都)?是汗|嘴唇发白|脸色发白|喘不过气|发不出声音|说不出话|站不住|脚下一软|眼眶发红|哭了|哭泣|摔下|冲上去拥抱|握紧拳头|反[复覆]确认|紧紧抓住)/u.test(positive))
        band = Math.max(band, 2);
      else if (/(?:道歉|失落|担心|不安|惊讶|笑了|点了点头|怀疑|期待已久|质问)/u.test(positive))
        band = Math.max(band, 1);
    }
  }

  return band;
}


function lexicalScore(evidence: string): number {
  // Preserve the previous lexical weights and length tie-break; structural signals now have their own levels.
  // Both scans are O(n). The provisional cap is twelve matches and five hundred UTF-16 units.
  const signal = (evidence.match(/!|！|哭|怒|怕|爱|恨|担心|害怕|惊|救|死|伤|失去|拥抱|争吵|道歉|高兴|悲伤/gu) ?? []).length;
  return Math.min(signal, 12) * 10 + Math.min(evidence.length, 500) / 500;
}

/** Largest finite frustration, clamped to 0..5; malformed summaries contribute zero. Work is O(n). */
function unmetDrive(serialized: string): number {
  try {
    const frustration = (JSON.parse(serialized) as {frustration?: Record<string, unknown>})?.frustration;
    if (!frustration || typeof frustration !== 'object') return 0;

    let maximum = 0;
    for (const value of Object.values(frustration)) {
      if (typeof value === 'number' && Number.isFinite(value))
        maximum = Math.max(maximum, value);
    }

    return Math.min(5, maximum);
  } catch {
    return 0;
  }
}

/** Read-only terminal-skip test; work is O(P + R + K) in this source's pending, ready and skipped entries. */
function hasCompletedEmotionSkip(analysis: SceneState['sources'][number]['analysis'], characterId: string): boolean {
  return Boolean(
    analysis?.emotionPendingIds?.includes(characterId)
    && !analysis.emotionCandidateReadyIds?.includes(characterId)
    && analysis.skippedStages?.some(skipped => skipped.stage === 'emotion' && skipped.characterId === characterId),
  );
}

/**
 * Read-only queue counts and identifiers, without another actor's evidence. A false stage predicate excludes a marker;
 * null or omission retains historical counting. Predicate/getter errors propagate. Work is linear per fixed roster.
 */
export function emotionScheduleStatus(state:SceneState,
  shouldAppraise?: ((source: SceneState['sources'][number], characterId: string,
    resolveOwnLine?: EmotionLineResolver) => boolean) | null) {
  const resolveOwnLine = createEmotionLineResolver(state.sources, state.roster);
  const windows=new Map<string,{eligible:Set<string>;selected:Set<string>;forced:Set<string>;method:string;reason?:string;modelIdentity?:string}>();
  const pending=new Map<string,number>();
  const legacyPending=new Map<string,number>();
  for(const source of state.sources){
    if(source.status!=='accepted'||source.processing!=='ready'||!source.analysis)continue;
    for(const id of source.analysis.emotionPendingIds??[]){
      if (shouldAppraise?.(source, id, resolveOwnLine) === false) continue;
      if (hasCompletedEmotionSkip(source.analysis, id)) continue;
      pending.set(id,(pending.get(id)??0)+1);
      if(!source.analysis.emotionCandidateReadyIds?.includes(id)&&
        !source.analysis.skippedStages?.some(item=>item.stage==='emotion'&&item.characterId===id))
        legacyPending.set(id,(legacyPending.get(id)??0)+1);
    }
    const schedule=source.analysis.emotionSchedule;
    if(!schedule)continue;
    const window=windows.get(schedule.windowId)??{eligible:new Set<string>(),selected:new Set<string>(),forced:new Set<string>(),method:schedule.method};
    for(const id of schedule.eligibleIds)window.eligible.add(id);
    for(const id of schedule.selectedIds)window.selected.add(id);
    for(const id of schedule.forcedIds)window.forced.add(id);
    window.method=schedule.method;window.reason=schedule.reason;window.modelIdentity=schedule.modelIdentity;
    windows.set(schedule.windowId,window);
  }
  const ordered=[...windows.entries()];
  return {budget:EMOTION_NPC_BUDGET,forceAfterMissedRounds:0,pendingTotal:[...pending.values()].reduce((a,b)=>a+b,0),
    latestRanking:ordered.length?{windowId:ordered.at(-1)![0],method:ordered.at(-1)![1].method,
      reason:ordered.at(-1)![1].reason??null,modelIdentity:ordered.at(-1)![1].modelIdentity??null}:null,
    npcs:state.roster.characters.map(character=>{
      let missedRounds=0,lastSelected:string|null=null,forced=false;
      for(const [windowId,window] of ordered)if(window.selected.has(character.id)){
        lastSelected=windowId;forced=window.forced.has(character.id);
      }
      for(const [,window] of [...ordered].reverse()){
        if(!window.eligible.has(character.id)||window.selected.has(character.id))break;
        missedRounds++;
      }
      return {id:character.id,pendingCount:pending.get(character.id)??0,
        legacyPendingCount:legacyPending.get(character.id)??0,missedRounds,lastSelected,forced};
    })};
}

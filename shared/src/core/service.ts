import { Authority } from './store.ts';
import { ModelTasks } from './models.ts';
import { Retrieval } from '../memory/retrieval.ts';
import {recallJudgeInput, RECALL_JUDGE_TEXT_LIMITS} from '../memory/recall-judge-input.ts';
import {recallTurnKey, reserveRecallTurn} from '../memory/recall-judge.ts';
import type {RecallJudgeStep, RecallJudgeOutcome} from '../memory/recall-judge.ts';
import type {RecallDetailCall, RecallDetailDistances} from '../memory/recall-judge-details.ts';
import {contextMemories,checkCurrentSource,type CurrentSource} from '../memory/context.ts';
import {cueRecalls,restoredSnapshot,retainedAccess,visibleLayer,rememberedFragmentsOf} from '../memory/retention.ts';
import {limitRecalls,recallSnapshot,projectMemories} from '../memory/access.ts';
import {memoryClockTimeMs} from '../memory/vector-forgetting.ts';
import {CORE_CONTEXT_LIMIT, nextContextRemoval, type ContextBudgetPlan, type ContextOmissions}
  from './context-budget.ts';
import {recallOrder,RECALL_EVENT_LIMIT,eventKey,foldCue,foldedCues,type TraceHit} from '../memory/trace.ts';
import {renderContextMemory,absenceSentence,recallShown} from '../memory/render.ts';
import {storyLanguageOf,compact,type StoryLanguage} from '../memory/text-units.ts';
import { emotionSummary } from '../emotion/openher.ts';
import {buildEmotionExpression,renderEmotionExpression,type EmotionExpressionInput} from '../emotion/expression.ts';
import type { Scope, Memory, MemorySnapshot, MemoryView } from '../memory/access.ts';
import type { EmotionState } from '../emotion/openher.ts';
import type { Preference } from './store.ts';
import { SceneCore } from '../scene/service.ts';
import type {SceneAuthority} from '../scene/store.ts';
import type {SceneCompanionPort} from '../scene/extension.ts';
import type { AcceptedMessage, Configurations } from './types.ts';
import { scopeKey } from './types.ts';
import {createHash} from 'node:crypto';
import {withModelAddress} from './runtime-log.ts';
import {buildRecallDetailPool, selectRecallDetails, revalidateRecallDetails} from '../memory/recall-details.ts';

const workCounts = {detailPools: 0, snapshotProjections: 0, assemblies: 0};

/** Cumulative deterministic work counts since module load; callers use before/after differences per context. */
export function contextWorkCounts(): Readonly<typeof workCounts> {
  return {...workCounts};
}
/** SHA-256 binds a uint32 seed to the authority event, record and reply revision (or raw query without a reply). */
function recallDetailSeed(memory: Memory, query: string, currentSource?: CurrentSource): number {
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
  const turn = currentSource ? [currentSource.id, currentSource.revision] : digest(query);
  const input = JSON.stringify(['recall-details-v1', digest(eventKey(memory)), memory.id, turn]);
  return createHash('sha256').update(input, 'utf8').digest().readUInt32BE(0);
}

/** Supply the detail selector only the current approved layers and fragments; its own validation handles empty or oversized pools. */
function recallDetailInput(memory: Memory) {
  workCounts.detailPools++;
  const gist = visibleLayer(memory, 'gist');
  const feeling = visibleLayer(memory, 'feeling');
  const anchor = visibleLayer(memory, 'anchor');
  const fragments = rememberedFragmentsOf(memory);
  return {
    gist,
    feeling,
    pool: buildRecallDetailPool({memory, gist, feeling, anchor, fragments}).candidates,
    fragmentCompactLength: fragments.reduce((total, fragment) => total + compact(fragment).length, 0),
    detailCompactLength: compact(memory.detail).length,
  };
}

/** Remove only this slice's view fields before rewrite/cache/emotion input. Existing property order is preserved. */
function withoutRecallDetails(view: MemoryView): MemoryView {
  const {recalledDetails: _details, strayDetail: _stray, recallSameTier: _sameTier, ...plain} = view;
  return plain;
}

/** Restore current-call details by record id after rewrite, including cache hits; a previous call is never a source. */
function reattachRecallDetails(views: readonly MemoryView[], originals: readonly MemoryView[]): MemoryView[] {
  const byId = new Map(originals.map(view => [view.id, view]));
  return views.map(
    view => {
      const original = byId.get(view.id);
      const restored = {
        ...view,
        ...(original?.recalledDetails ? {recalledDetails: original.recalledDetails} : {}),
        ...(original?.strayDetail !== undefined ? {strayDetail: original.strayDetail} : {}),
      };
      if (original?.recallSameTier) {
        Object.defineProperty(restored, 'recallSameTier', {value: original.recallSameTier});
      }
      return restored;
    }
  );
}

export interface CoreOptions<M extends object,C extends SceneCompanionPort> {
  /** The scene's companion port (the Agent's CompanionFlow); without it the scene uses the inert default port. */
  sceneCompanion?:(scene:SceneAuthority&M,core:Core<M,C>,models:ModelTasks)=>C;
  /** Optional recall decision step; without injection all existing context behavior is preserved. */
  recallJudge?: RecallJudgeStep;
}

export class Core<M extends object = {},C extends SceneCompanionPort = SceneCompanionPort> {
  private jobs = new Map<string, Promise<{status:string;version:number;error?:string}>>();
  authority: Authority<M>;
  private retrieval: Retrieval;
  private models: ModelTasks;
  private rewriteCache = new Map<string,string[]>();
  readonly scene: SceneCore<C>;
  private readonly recallJudge?: RecallJudgeStep;
  private readonly recallJudgeTurns = new Map<string, number>();
  private readonly recallDetailTurns = new Map<string, number>();
  constructor(authority: Authority<M>, retrieval: Retrieval, models = new ModelTasks(), options: CoreOptions<M,C> = {}) {
    this.authority = authority;
    this.retrieval = retrieval;
    this.models = models;
    this.recallJudge = options.recallJudge;
    this.scene = new SceneCore<C>(authority.scene,this as Core,models,undefined,
      {companion:options.sceneCompanion?.(authority.scene,this,models)});
  }

  async process(scope: Scope, message: AcceptedMessage, configs: Configurations) {
    const jobId = JSON.stringify([scopeKey(scope), message.id, message.revision, message.text, message.role]);
    const inFlight = this.jobs.get(jobId);
    if (inFlight) return inFlight;
    const status = this.authority.begin(scope, message);
    if (status !== 'pending') return {status,version:this.authority.snapshot(scope).version};
    const job = (async () => {
      try {
        const analysis = await this.models.analyze(message, configs, undefined, undefined,
          this.authority.emotion(scope, message.acceptedAtMs));
        const status = this.authority.commit(scope, message, analysis);
        return { status, version: this.authority.snapshot(scope).version };
      } catch (error) {
        this.authority.fail(scope, message);
        return { status:'failed', version:this.authority.snapshot(scope).version, error:safeError(error) };
      } finally { this.jobs.delete(jobId); }
    })();
    this.jobs.set(jobId, job);
    return job;
  }

  async context(scope: Scope, query: string, configs: Configurations, now = Date.now(), currentReplySourceId?:string) {
    const snapshot = this.authority.snapshot(scope);
    const replySourceId=currentReplySourceId===undefined?undefined:this.authority.currentReplySourceId(scope,query,currentReplySourceId);
    const result = await this.contextFrom(snapshot,query,configs,this.authority.emotion(scope,now),this.authority.preferences(scope,replySourceId),()=>this.assertVersion(scope,snapshot.version),now);
    this.authority.markIndexed(scope,snapshot.version);
    return result;
  }
  async clearProjection(scope:Scope) { await this.retrieval.clear?.(scope); }
  async reconcile(scope:Scope,messages:Parameters<Authority['reconcile']>[1]) {
    const result=this.authority.reconcile(scope,messages);
    if(this.authority.needsIndex(scope))await this.clearProjection(scope);
    return result;
  }
  /**
   * Assemble one authorized actor context, using millisecond clocks and UTF-16 length budgets.
   * Omissions are silent diagnostics. Preparation, stale versions and unavoidable fixed-block overflow throw;
   * only final visible reactivations are recorded when the caller requests reply-origin learning.
   */
  async contextFrom(
    snapshot: MemorySnapshot,
    query: string,
    configs: Configurations,
    emotion: EmotionState,
    allPreferences: Preference[],
    assertCurrent: () => void,
    now = Date.now(),
    expression?: Partial<Pick<
      EmotionExpressionInput,
      'actorId' | 'addresseeId' | 'timeZone' | 'clockKind' | 'clockTimeMs' |
        'hideStoryTime' | 'relationBasis' | 'waiting' | 'address'
    >>,
    options: {
      reactivationOrigin?: 'reply';
      language?: StoryLanguage;
      currentSource?: CurrentSource;
      /** Recalls decided outside the search (a judging step): the records to restore, each event strong or not. */
      recallHits?: readonly TraceHit[];
    } = {}
  ) {
    // The user source a reply path is answering (scene/service.ts passes it); its own memories are not "last contact".
    checkCurrentSource(options.currentSource);
    if (options.language !== undefined && options.language !== 'zh' && options.language !== 'en') {
      throw new Error('invalid_story_language');
    }
    // One story language per context, never switched by a single player line.
    const language = options.language ?? storyLanguageOf(snapshot);
    const render = (memories: readonly MemoryView[]) => memories.map(memory => renderContextMemory(memory, language));
    await this.scene.clearPendingIndexes();
    assertCurrent();
    const cues = cueRecalls(snapshot, now, query);
    const scope = snapshot.scope;
    const judge = this.recallJudge;
    const judgeModel = judge?.available() ?? null;
    const judgeAvailable = judgeModel !== null && options.currentSource !== undefined;
    const searchOptions = {
      currentSource: options.currentSource,
      ...(judge ? {
        recallTrace: {
          enabled: judgeAvailable,
          // An unavailable step keeps the constructor's count so existing trace-off cache entries remain reusable.
          ...(judgeAvailable ? {limit: RECALL_JUDGE_TEXT_LIMITS.search} : {}),
        },
      } : {}),
    };
    const result = await this.retrieval.search(snapshot, query, configs, now, searchOptions);
    try {
      assertCurrent();
    }
    catch (error) {
      await this.clearProjection(scope);
      throw error;
    }
    // One context recalls at most RECALL_EVENT_LIMIT events: the cue recalls first, then the hits decided outside the
    // search. An event beyond the limit stays at its stage: no mark, no seed and no place in front.
    let judgment: RecallJudgeOutcome = {outcome: 'not_needed', hits: []};
    const turnKey = options.currentSource ? recallTurnKey(scope, options.currentSource) : '';
    if (judge && judgeAvailable && options.currentSource && options.recallHits == null &&
      cues.length < RECALL_EVENT_LIMIT && result.traceCandidates?.length) {
      const input = recallJudgeInput(
        snapshot, query, now, options.currentSource, result.traceCandidates, result.ids,
        new Set(cues.map(cue => cue.event))
      );
      if (input.candidates.length) {
        const decision = judge.decide(input, scope, judgeModel!, () => reserveRecallTurn(this.recallJudgeTurns, turnKey));
        if (decision instanceof Promise) {
          judgment = await decision;
          try {
            assertCurrent();
          } catch (error) {
            await this.clearProjection(scope);
            throw error;
          }
        } else {
          judgment = decision;
        }
      }
    }
    const recalls = limitRecalls(snapshot, now, cues, options.recallHits ?? judgment.hits, result.ids, RECALL_EVENT_LIMIT);
    judgment.recordUsed?.(recalls.hits);
    const originalSnapshot = snapshot;
    const memoryClock = snapshot.memoryTimeMs ?? now;
    snapshot = recallSnapshot(snapshot, restoredSnapshot(snapshot, now, recalls.cues), now, recalls.hits);
    // Distances follow event order, while twins follow authority snapshot order, independent of display ranking.
    const orderedEvents = [
      ...new Set(
        [
          ...recalls.cues.map(recall => recall.event),
          ...recalls.hits.flatMap(
            hit => {
              const memory = snapshot.memories.get(hit.id);
              return memory ? [eventKey(memory)] : [];
            }
          ),
        ]
      )
    ];
    const eventPositions = new Map(orderedEvents.map((event, index) => [event, index]));
    const recalledGists = [...snapshot.memories.values()]
      .filter(memory => memory.reactivated === true && memory.access === 'gist')
      .sort((left, right) => eventPositions.get(eventKey(left))! - eventPositions.get(eventKey(right))!);
    const pools = recalledGists.map(memory => ({memory, ...recallDetailInput(memory)}));
    const requests = pools.filter(row => row.pool.length >= 2).map(
      row => ({
        id: row.memory.id,
        gist: row.gist.text,
        ...(row.memory.retention?.emotionalProtection && row.feeling.state !== 'blocked' && row.feeling.text.trim()
          ? {feeling: row.feeling.text} : {}),
        candidates: row.pool.map(candidate => candidate.text),
      })
    );
    let distances: (readonly number[] | undefined)[] = [];
    if (requests.length) {
      let response: unknown;
      let waited = false;
      try {
        response = judgeAvailable ? this.recallDetailDistances(requests, {
          embedding: configs.embedding,
          currentSource: options.currentSource,
          ...(result.degraded == null ? {} : {degraded: result.degraded}),
          judgment: judgment.outcome,
          turnKey,
        }) : this.recallDetailDistances(requests);
        if (response instanceof Promise) {
          waited = true;
          response = await response;
        }
      } catch {
        response = undefined;
      }
      // This assertion must be outside the distance-validation catch: a stale context cannot use any fallback.
      if (waited) {
        try {
          assertCurrent();
        } catch (error) {
          await this.clearProjection(scope);
          throw error;
        }
      }
      try {
        if (!Array.isArray(response) || response.length !== requests.length)
          throw new Error('invalid_detail_distances');
        distances = requests.map(
          (request, index) => {
            const values = response[index];
            if (values == null)
              return undefined;
            if (!Array.isArray(values) || values.length !== request.candidates.length) {
              throw new Error('invalid_detail_distances');
            }
            // Copy through indexed reads so holes and throwing getters also select the all-fallback path.
            return request.candidates.map(
              (_candidate, position) => {
                const value = values[position];
                if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 2) {
                  throw new Error('invalid_detail_distances');
                }
                return value;
              }
            );
          }
        );
      }
      catch {
        distances = [];
      }
    }
    const distancesById = new Map(requests.map((request, index) => [request.id, distances[index]]));
    const matchedCueFolds = new Map<string, string[]>();
    if (pools.some(row => recalls.cues.some(recall => recall.event === eventKey(row.memory)))) {
      const foldedQuery = foldCue(query);
      for (const recall of recalls.cues) {
        matchedCueFolds.set(
          recall.event,
          [
            ...new Set(
              recall.ids.flatMap(
                id => {
                  const memory = originalSnapshot.memories.get(id);
                  return memory
                    ? foldedCues(memory.retention?.cues ?? []).filter(cue => foldedQuery.includes(cue))
                    : [];
                }
              )
            )
          ]
        );
      }
    }
    const withDetails = new Map(snapshot.memories);
    for (const row of pools) {
      const original = originalSnapshot.memories.get(row.memory.id)!;
      const previous = retainedAccess(original, memoryClock).recallDetails;
      const cuesForEvent = matchedCueFolds.get(eventKey(row.memory));
      const selected = selectRecallDetails(
        {
          pool: row.pool,
          distances: distancesById.get(row.memory.id),
          seed: recallDetailSeed(row.memory, query, options.currentSource),
          ...(cuesForEvent ? {cueRecall: true, matchedCueFolds: cuesForEvent} : {}),
          ...(previous ? {previous} : {}),
          fragmentCompactLength: row.fragmentCompactLength,
          detailCompactLength: row.detailCompactLength,
        }
      );
      withDetails.set(
        row.memory.id,
        {
          ...row.memory,
          selectedRecallDetails: selected.items.map(
            item => ({
              start: item.start,
              end: item.end,
              ...(item.stray ? {stray: true as const} : {}),
              new: item.new,
            })
          ),
        }
      );
    }
    // Results live only for this call: selection may measure a rejected row again in another block.
    const preparedViews = new Map<string, MemoryView>();
    const prepareView = (view: MemoryView): MemoryView => {
      const id = view.id;
      const known = preparedViews.get(id);
      if (known) {
        return known;
      }
      const memory = snapshot.memories.get(id)!;
      if (memory.reactivated || memory.access !== 'gist') {
        return view;
      }
      const original = originalSnapshot.memories.get(id)!;
      const positions = retainedAccess(original, memoryClock).recallDetails;
      if (!positions) {
        return view;
      }
      const input = recallDetailInput(memory);
      const items = revalidateRecallDetails({
        positions,
        pool: input.pool,
        fragmentCompactLength: input.fragmentCompactLength,
        detailCompactLength: input.detailCompactLength,
      });
      withDetails.set(id, {
        ...memory,
        selectedRecallDetails: items.map(item => ({
          start: item.start,
          end: item.end,
          ...(item.stray ? {stray: true as const} : {}),
          new: false,
        })),
      });
      // Reuse the one authority-to-view implementation, including its visibility rules and property order.
      const prepared = projectMemories(snapshot, {scope, asOfMs: now, ids: [id]}).memories[0]!;
      preparedViews.set(id, prepared);
      return prepared;
    };
    snapshot = {...snapshot, memories: withDetails};
    // A row the search admitted only because a cue reminded of it takes no place when its event is beyond the limit.
    const beyond = new Set(cues.filter(recall => !recalls.cues.includes(recall)).flatMap(recall => recall.ids));
    const ranked = beyond.size ? result.ids.filter(
      (id, index) => !(beyond.has(id) && result.admission?.[index]?.id === id &&
        result.admission[index]!.by === 'reminded')
    ) : result.ids;
    // Protection controls retention, not unconditional injection. Relevant facts
    // compete alongside episodes; every returned ID is checked against authority.
    const recalled = recallOrder([...snapshot.memories.values()].filter(memory => memory.reactivated === true));
    const selection = {parents: new Map<string, readonly string[]>(), omittedIds: [] as string[]};
    const rankedIds = recalled.length ? [...recalled, ...ranked] : ranked;
    workCounts.snapshotProjections++;
    const projected = contextMemories(
      snapshot,
      rankedIds,
      now,
      {currentSource: options.currentSource, selection, prepareView}
    );
    // Preserve the inherited shared-cache capacity; only the first and final contexts may evict entries.
    const cacheClauses = (key: string, clauses: string[]) => {
      this.rewriteCache.delete(key);
      this.rewriteCache.set(key, [...clauses]);
      if (this.rewriteCache.size > 64) {
        this.rewriteCache.delete(this.rewriteCache.keys().next().value!);
      }
    };
    let detailViews = projected.memories;
    let rewriteViews = detailViews.map(withoutRecallDetails);
    let blurred = rewriteViews.filter(memory => memory.access !== 'clear');
    let rewriteKey = createHash('sha256').update(JSON.stringify([scopeKey(scope), blurred, configs.rewrite]))
      .digest('hex');
    let clauses = this.rewriteCache.get(rewriteKey);
    let cacheMiss = clauses === undefined;
    if (clauses === undefined) {
      clauses = await this.models.rewrite(rewriteViews, configs.rewrite);
      // A failed or stale model result must never become a reusable answer.
      assertCurrent();
      cacheClauses(rewriteKey, clauses);
    }
    assertCurrent();
    // O(s) text assembly per try; keep the cache-hit path synchronous after its existing current-version check.
    const assemble = () => {
      workCounts.assemblies++;
      const currentClauses = clauses!;
      const reattached = new Map(reattachRecallDetails(rewriteViews, detailViews).map(view => [view.id, view]));
      projected.memories = projected.memories.map(view => reattached.get(view.id)!);
      projected.recent = projected.recent.map(view => reattached.get(view.id)!);
      projected.relevant = projected.relevant.map(view => reattached.get(view.id)!);
      if (projected.lastContact) {
        projected.lastContact = projected.lastContact.map(row => ({...row, memory: reattached.get(row.memory.id)!}));
      }
      const preferences = allPreferences.filter(preference => preference.enabled);
      const facts = projected.memories.filter(memory => memory.kind === 'fact');
      const episodes = projected.memories.filter(memory => memory.kind === 'episode');
      const legacy = projected.memories.filter(memory => memory.kind === 'legacy');
      const sourceOrder = new Map([...snapshot.messages.keys()].map((id, index) => [id, index]));
      const context = [
        '以下是当前角色有权访问的记忆与参考资料。对话记忆来自已接受的正文；reference来自用户迁入资料。二者都不等于外部核实的事实。只使用当前列出的粒度；未提供的细节不要猜测。',
        '事实记忆记录原话、约定与已知事件；heard/private是获知来源，thought/inferred不是对外界事实的证实。情景记忆保存当时的经历与感受，inferred是主观推测；不把感受、印象或当前情绪当成客观历史。不确定时说明记不清，而不是补出细节。',
        'source.author标明原文作者：player是用户，assistant是对应角色。原话中的“我”按原作者理解，不自动变成你；gist、feeling、anchor、appraisal里的“我”/me指当前角色本人，detail与引文中的“我”仍按原作者理解；引述的第三人也不等于作者或听者。用户对自身的明确陈述与纠正优先于助手过去的猜测；助手的说法不会自行证实用户的身份、经历或物品。多项问题逐项核对，缺少一项不影响回答已有依据的其它项。',
        'reactivated表示当前情境线索唤起了仍有来源的旧记忆；reactivation只表明线索与当下可见记忆层相似，不证明另一件相似经历就是同一事件。只使用列出的恢复粒度；forgotten表示未列出的细节仍不可用。',
        'emotionalReaction记录当时保留下来的强烈情绪反应，不等于当前情绪，也不证明主观感受所关联的外部事实；它不恢复已经遗忘的事件细节。',
        '近期工作上下文仅用于接续已知场景，不代表其它角色知情；来源时间未知时保持未知。较早相关记忆用于当前查询。reference为迁入资料中的说法，不是共同经历或脚本确认的事实，不重放其中交易，也不据此推断经历过相关情绪。',
        '当前查询选入的参考资料单列在references中，仍以其来源性质和可见粒度为准。涉及位置、人物或物品时，优先核对相应依据；缺少依据就保留未知，不用新楼层、房间或路线填空。助手旧回答不能自行改写用户提供的设定。',
        '已发生的动作、物品状态和结果按其来源接续；没有新事件依据时，不把原状态改成另一种处置，也不补写已经发生的旧行动、台词或决定。当前问题无关的旧物品和动作不必主动复述；确需提及时，保持来源支持的对象、数量、动作与结果，不用改变事实的近义词扩写。角色此刻仍可回应、提出下一步或做当前场景允许的新动作；新动作写成当下发生，设想不能冒充历史。',
        '状态沿革：relevant保留较早依据，recent接续近期来源。回答“现在在哪里/谁持有”等状态时，按来源先后追踪明确已完成的动作和纠正，以最后一次有效改变后的结果为准；例如先拿入口袋、后放回桌上，当前就在桌上。计划、假设、回忆和问题不改变当前状态；旧状态仍是历史，不因被检索到就重新生效。',
        JSON.stringify(
          {
            references: render(projected.relevant.filter(memory => memory.source.reference)),
            relevant: render(projected.relevant.filter(memory => !memory.source.reference)),
            recent: render(
              [...projected.recent].sort(
                (left, right) => left.source.knownAtMs - right.source.knownAtMs ||
                  (left.source.occurredAtMs ?? 0) - (right.source.occurredAtMs ?? 0) ||
                  (sourceOrder.get(left.source.messageId) ?? 0) - (sourceOrder.get(right.source.messageId) ?? 0)
              )
            ),
            ...(() => {
              const sentence = projected.absence && absenceSentence(language, projected.absence.elapsedDays);
              return sentence ? {
                sinceLastContact: sentence,
                ...(projected.lastContact?.length ? {
                  lastContact: [...projected.lastContact].reverse().map(row => ({
                    ...renderContextMemory(row.memory, language),
                    daysAgo: row.daysAgo,
                  }))
                } : {})
              } : {};
            })()
          }
        ),
        currentClauses.length ? `模糊回忆表达：${JSON.stringify(currentClauses)}` : '',
        renderEmotionExpression(
          buildEmotionExpression(
            {
              scope,
              actorId: expression?.actorId ?? scope.characterId,
              addresseeId: expression?.addresseeId ?? 'user',
              sourceVersion: snapshot.version,
              nowMs: now,
              timeZone: expression?.timeZone ?? null,
              clockKind: expression?.clockKind,
              clockTimeMs: expression?.clockTimeMs,
              hideStoryTime: expression?.hideStoryTime,
              relationBasis: expression?.relationBasis,
              emotion,
              memories: rewriteViews,
              waiting: expression?.waiting,
              address: expression?.address
            }
          )
        ),
        '情绪数值仅指导语气、接近/回避和表达，不赋予新知识，不改变事实，不突破用户拒绝或隐私边界。',
        preferences.length ? `用户回答要求（当前指令优先；turn仅本轮有效；旧记录legacy未判定时效，以原quote为准，一次任务要求不得推广成持续偏好）：${JSON.stringify(
          preferences.map(
            ({category, text, quote, duration, sourceId}) => ({
              category,
              text,
              quote,
              duration: duration ?? 'legacy',
              sourceId,
            })
          )
        )}` : '',
      ].filter(Boolean).join('\n');

      return {context, facts, episodes, legacy, preferences, rewriteKey, clauses: currentClauses, cacheMiss};
    };
    let assembled = assemble();
    const contextOmissions: ContextOmissions = {
      characterId: scope.characterId,
      selection: {
        reason: 'memory_selection_budget',
        count: selection.omittedIds.length,
        ids: selection.omittedIds,
      },
      trim: {
        reason: 'core_context_budget',
        count: 0,
        ids: [],
        rows: [],
        initialCharacters: assembled.context.length,
        finalCharacters: assembled.context.length,
        assemblies: 1,
      },
    };
    const removedIds = new Set<string>();
    if (assembled.context.length > CORE_CONTEXT_LIMIT) {
      const initialRelevant = [...projected.relevant];
      const positions = new Map(initialRelevant.map((memory, index) => [memory.id, index]));
      const ranks = new Map<string, number>();
      rankedIds.forEach((id, index) => {
        if (!ranks.has(id)) {
          ranks.set(id, index);
        }
      });
      const admissions = new Map<string, string>();
      for (const admission of result.admission ?? []) {
        if (!admissions.has(admission.id)) {
          admissions.set(admission.id, admission.by);
        }
      }
      // Scan authority records once, so a recalled fixed-block twin also protects its relevant event.
      const events = new Map<string, string>();
      const reactivatedEvents = new Set<string>();
      for (const memory of snapshot.memories.values()) {
        const event = eventKey(memory);
        events.set(memory.id, event);
        if (memory.reactivated === true) {
          reactivatedEvents.add(event);
        }
      }
      const strongEvents = new Set(recalls.cues.filter(recall => recall.strong).map(recall => recall.event));
      for (const hit of recalls.hits) {
        const event = events.get(hit.id);
        if (hit.strong && event !== undefined) {
          strongEvents.add(event);
        }
      }
      const plan: ContextBudgetPlan = {
        parents: selection.parents,
        ranks,
        admissions,
        events,
        reactivatedEvents,
        strongEvents,
      };
      let step = 0;
      // Termination follows strictly fewer relevant rows, even when replacement emotion causes grow the text.
      while (assembled.context.length > CORE_CONTEXT_LIMIT) {
        const unitIds = nextContextRemoval(projected.relevant, plan);
        if (!unitIds.length) {
          break;
        }
        step++;
        const unit = new Set(unitIds);
        for (const memory of projected.relevant) {
          if (!unit.has(memory.id)) {
            continue;
          }
          const rank = ranks.get(memory.id);
          const admission = admissions.get(memory.id);
          const record = snapshot.memories.get(memory.id)!;
          contextOmissions.trim.rows.push({
            id: memory.id,
            position: positions.get(memory.id)!,
            ...(rank !== undefined ? {rank} : {}),
            ...(admission !== undefined ? {admission} : {}),
            access: memory.access,
            kind: memory.kind,
            // One story day is 86,400,000 ms, the existing memory-clock unit; future records have age zero.
            ageDays: Math.max(0, memoryClock - memoryClockTimeMs(record)) / 86_400_000,
            reactivated: memory.reactivated === true,
            reference: Boolean(memory.source.reference),
            protectedFacts: memory.protectedFacts.length,
            step,
            unitIds: [...unitIds],
          });
          removedIds.add(memory.id);
          contextOmissions.trim.ids.push(memory.id);
        }
        projected.relevant = projected.relevant.filter(memory => !unit.has(memory.id));
        projected.memories = projected.memories.filter(memory => !unit.has(memory.id));
        projected.grounding.selectedEvidence = projected.grounding.selectedEvidence
          .filter(evidence => !unit.has(evidence.memoryId));
        projected.budget.totalCharacters = projected.memories
          .reduce((total, memory) => total + JSON.stringify(memory).length, 0);
        detailViews = projected.memories;
        rewriteViews = detailViews.map(withoutRecallDetails);
        blurred = rewriteViews.filter(memory => memory.access !== 'clear');
        rewriteKey = createHash('sha256').update(JSON.stringify([scopeKey(scope), blurred, configs.rewrite]))
          .digest('hex');
        clauses = this.rewriteCache.get(rewriteKey);
        cacheMiss = clauses === undefined;
        if (clauses === undefined) {
          clauses = await this.models.rewrite(rewriteViews, configs.rewrite);
          assertCurrent();
        }
        assertCurrent();
        assembled = assemble();
        contextOmissions.trim.assemblies++;
      }
      if (assembled.context.length <= CORE_CONTEXT_LIMIT && assembled.cacheMiss) {
        cacheClauses(assembled.rewriteKey, assembled.clauses);
      }
    }
    contextOmissions.trim.count = removedIds.size;
    contextOmissions.trim.finalCharacters = assembled.context.length;
    if (assembled.context.length > CORE_CONTEXT_LIMIT) {
      throw Object.assign(new Error('context_budget_exceeded'), {contextOmissions});
    }
    const {context, facts, episodes, legacy, preferences} = assembled;
    // Only a reply context records what it brought back, and only once the whole context is known current. Without the
    // option (her own proactive contact, tavern, recall) nothing is written; outreach never feeds its own pressure.
    if (options.reactivationOrigin === 'reply') {
      const reactivated = projected.memories.flatMap(
        memory => recallShown(memory) && (memory.access === 'clear' || memory.access === 'gist')
          ? [
            {
              memoryId: memory.id,
              messageId: memory.source.messageId,
              messageRevision: memory.source.revision,
              access: memory.access,
              kind: memory.reactivation?.kind === 'semantic' ? 'semantic' as const : 'cue' as const
            }
          ] : []
      );
      if (reactivated.length)
        this.authority.recordMemoryReactivations(scope, reactivated, 'reply', Math.trunc(now));
    }
    const output = {
      ...projected,
      facts,
      episodes,
      legacy,
      context,
      emotion: emotionSummary(emotion),
      preferences: preferences.map(({id, category, text}) => ({id, category, text})),
      retrieval: result.mode,
      contextOmissions,
    };
    const cueEvents = new Set(recalls.cues.map(recall => recall.event));
    const weakEvents = new Set(
      recalls.hits.filter(hit => hit.strong !== true).flatMap(
        hit => {
          const memory = snapshot.memories.get(hit.id);
          return memory && !cueEvents.has(eventKey(memory)) ? [eventKey(memory)] : [];
        }
      )
    );
    const weakIds = new Set(
      [...snapshot.memories.values()]
        .filter(memory => memory.reactivated === true && weakEvents.has(eventKey(memory))).map(memory => memory.id)
    );
    if (removedIds.size) {
      const finalMemories = new Map(snapshot.memories);
      for (const id of removedIds) {
        weakIds.delete(id);
        const memory = finalMemories.get(id)!;
        const {selectedRecallDetails: _removedDetails, ...withoutDetails} = memory;
        finalMemories.set(id, withoutDetails);
      }
      snapshot = {...snapshot, memories: finalMemories};
    }
    // A non-enumerable server-only channel preserves the host packet and view JSON shapes.
    // Scene acceptance copies only the shown recalled rows into its private ticket or draft.
    return Object.defineProperty(output, 'rehearsal', {value: {snapshot, weakIds}}) as typeof output & {
      readonly rehearsal: {
        snapshot: MemorySnapshot;
        weakIds: ReadonlySet<string>;
      };
    };
  }
  /** Ordered detail distances; absent call data stays synchronous, while an actual request returns a safe Promise. */
  private recallDetailDistances(
    requests: readonly {
      id: string;
      gist: string;
      feeling?: string;
      candidates: readonly string[];
    }[],
    call?: RecallDetailCall
  ): RecallDetailDistances | Promise<RecallDetailDistances> {
    if (!call || !call.currentSource || !this.recallJudge || call.judgment === 'failed' ||
      call.degraded?.stage === 'embedding') return requests.map(() => undefined);
    return this.retrieval.recallDetailDistances(
      requests, call.embedding, () => reserveRecallTurn(this.recallDetailTurns, call.turnKey)
    );
  }

  async generate(scope: Scope, input: string, persona: string, configs: Configurations, currentReplySourceId?:string) {
    const replySourceId=this.authority.currentReplySourceId(scope,input,currentReplySourceId);
    const context = await this.context(scope, input, configs,Date.now(),replySourceId);
    return this.respond(context,input,persona,configs,()=>this.assertVersion(scope,context.version));
  }
  /**
   * Generates role prose from a versioned context and returns the answer, context version and calculations report.
   * With publicOutput, the front model sends structured utterances; answer is their joined visible text.
   * If a required calculation lacks information or reliable results, appends guidance against computing new numbers,
   * skips calculation-reference validation and returns the front prose with the calculations report.
   * With usable results, throws invalid_calculation_reference for non-operand numbers, missing result placeholders
   * or unknown placeholders. The same error is thrown when no calculation is needed but the answer still contains
   * a result marker. The version guard runs after the calculation call and after the front call; on paths without
   * the insufficient branch, reference checks precede the final version guard. Model failures and stale-context
   * errors propagate unchanged.
   */
  async respond(
    context: {context: string; version: number; memories: MemoryView[]},
    input: string,
    persona: string,
    configs: Configurations,
    assertCurrent: () => void,
    publicOutput = false
  ) {
    const calculations = await withModelAddress(
      {stage: 'calculation'},
      () => this.models.calculations(input, context.memories, configs.calculation)
    );
    assertCurrent();

    if (calculations.needed && (
      calculations.missing.length || !calculations.results.length || calculations.results.some(result => !result.ok)
    )) {
      // An incomplete report supplies no usable placeholders, so the result-reference checks do not apply.
      const calculationGuidance = '\n本轮需要的数字计算没有可靠的脚本结果。不要自行计算，也不要写出需要计算才能得到的数字；原文已经给出的数字可以照原样复述。需要时可以按角色自己的方式表示没算清楚，或者追问。';
      const answer = await this.models.generate(
        persona,
        context.context + calculationGuidance,
        input,
        configs.front,
        publicOutput
      );
      assertCurrent();
      return {answer, version: context.version, calculations};
    }
    const calculationContext = calculations.results.length ? '\n以下数值由确定性脚本计算。表达计算结果只能逐字使用对应占位符，不自行计算或写出结果数字。占位符已包含数值和单位，后面不要再添加单位；例如只说“结果是 [[XLDB_CALC_1]]。”：\n' + JSON.stringify(calculations.results.map((result,index)=>({placeholder:`[[XLDB_CALC_${index+1}]]`,result}))) : '';
    let answer = await this.models.generate(persona, context.context + calculationContext, input, configs.front,publicOutput);
    if (calculations.results.length) {
      const operands = new Set(calculations.results.flatMap(result => result.ok ? result.operands.map(operand => operand.value.replace(/^\+/,'')) : []));
      const prose = answer.replace(/\[\[XLDB_CALC_\d+\]\]/g,'');
      const numbers = prose.match(/[+-]?\d+(?:\.\d+)?/g) ?? [];
      if (numbers.some(value => !operands.has(value.replace(/^\+/,'')))) throw new Error('invalid_calculation_reference');
    }
    for (const [index,result] of calculations.results.entries()) {
      const marker = `[[XLDB_CALC_${index+1}]]`;
      if (!result.ok || !answer.includes(marker)) throw new Error('invalid_calculation_reference');
      const unitLabels:Record<string,string> = {milliseconds:'毫秒',seconds:'秒',minutes:'分钟',hours:'小时',days:'天',count:'项'};
      const unit = result.unit ? unitLabels[result.unit] ?? result.unit : '';
      answer = answer.replaceAll(marker,`${result.exact ? '' : '约'}${result.value}${unit ? ` ${unit}` : ''}`);
    }
    if (answer.includes('[[XLDB_CALC_')) throw new Error('invalid_calculation_reference');
    assertCurrent();
    return {answer, version:context.version,calculations};
  }

  private assertVersion(scope: Scope, version: number) {
    if (this.authority.snapshot(scope).version !== version) throw new Error('context_changed_retry');
  }
}

/** Returns an allowed public error code; unknown errors and non-errors become operation_failed without details. */
export function safeError(error: unknown): string {
  if (error instanceof Error && ['store_format_unsupported', 'scene_emotion_settings_locked'].includes(error.message)) {
    return error.message;
  }
  const message = error instanceof Error ? error.message : '';
  if (/^(calendar_story_clock_unknown|calendar_todo_deleted|calendar_todo_not_found|calendar_todo_not_future)$/.test(message)) {
    return message;
  }
  return /^(model_(not_configured|connection_failed|stream_failed|output_incomplete|invalid_response|invalid_json|output_truncated|output_too_large|http_\d{3})|host_(timeout|closed|worker_failed|invalid_result)|unsafe_rewrite|context_changed_retry|context_budget_exceeded|invalid_[a-z_]+|[a-z_]+_missing_source|record_not_found|duplicate_message_id|retrieval_[a-z_]+|director_model_not_configured|companion_[a-z_]+|proactive_companion_disabled|profile_[a-z_]+|relationship_evidence_(invalid_response|input_incomplete)|npc_resource_[a-z_]+|agentjev_[a-z_]+)$/.test(message)
    ? message : 'operation_failed';
}

/**
 * Codes thrown only while decoding a host or local-model output that failed local validation. Explicit on purpose:
 * configuration, input and internal errors that share a prefix (for example invalid_relationship_clock,
 * invalid_relationship_input, invalid_relationship_diagnostics, invalid_relationship_fold, invalid_profile_controls)
 * are not host output and must keep propagating. model_output_incomplete (a stream that ended without finish_reason)
 * is transport infrastructure and propagates too. relationship_evidence_input_incomplete is the deterministic
 * over-budget history case; it degrades the enrichment and is reported with its own code.
 */
const HOST_OUTPUT_INVALID=new Set([
  'model_invalid_json','model_invalid_response','model_output_truncated','model_output_too_large',
  'invalid_profile_strategy','invalid_profile_strategy_reference','invalid_profile_output','invalid_profile_json',
  'invalid_profile_theme','profile_evidence_not_in_source',
  'invalid_relationship_evidence','invalid_relationship_evidence_role','invalid_relationship_evidence_ref',
  'invalid_relationship_evidence_receipt','invalid_relationship_support','invalid_relationship_retraction',
  'invalid_relationship_assessment','invalid_relationship_selection',
  'relationship_evidence_invalid_response','relationship_evidence_input_incomplete',
]);

/**
 * Returns the fixed code when a host/model produced an output that failed local validation, otherwise null.
 * Only codes that safeError already exposes qualify. Infrastructure (host_*, model transport/configuration),
 * version conflicts (context_changed_retry), runtime/provider codes (agent*), configuration and internal errors keep
 * propagating; callers may degrade an optional enrichment only for this class.
 */
export function hostOutputInvalid(error:unknown):string|null {
  if(!(error instanceof Error))return null;
  const code=safeError(error);
  return code===error.message&&HOST_OUTPUT_INVALID.has(code)?code:null;
}

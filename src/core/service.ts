import { Authority } from './store.ts';
import { ModelTasks } from './models.ts';
import { Retrieval } from '../memory/retrieval.ts';
import {contextMemories} from '../memory/context.ts';
import {retentionSnapshot} from '../memory/retention.ts';
import {reactivateSnapshot} from '../memory/access.ts';
import { emotionSummary } from '../emotion/openher.ts';
import {buildEmotionExpression,renderEmotionExpression,type EmotionExpressionInput} from '../emotion/expression.ts';
import type { Scope, MemorySnapshot, MemoryView } from '../memory/access.ts';
import type { EmotionState } from '../emotion/openher.ts';
import type { Preference } from './store.ts';
import { SceneCore } from '../scene/service.ts';
import type { AcceptedMessage, Configurations } from './types.ts';
import { scopeKey } from './types.ts';
import {createHash} from 'node:crypto';
import {withModelAddress} from './runtime-log.ts';

export class Core {
  private jobs = new Map<string, Promise<{status:string;version:number;error?:string}>>();
  authority: Authority;
  private retrieval: Retrieval;
  private models: ModelTasks;
  private rewriteCache = new Map<string,string[]>();
  readonly scene: SceneCore;
  constructor(authority: Authority, retrieval: Retrieval, models = new ModelTasks()) {
    this.authority = authority; this.retrieval = retrieval; this.models = models;
    this.scene = new SceneCore(authority.scene,this,models);
  }

  async process(scope: Scope, message: AcceptedMessage, configs: Configurations) {
    const jobId = JSON.stringify([scopeKey(scope), message.id, message.revision, message.text, message.role]);
    const inFlight = this.jobs.get(jobId);
    if (inFlight) return inFlight;
    const status = this.authority.begin(scope, message);
    if (status !== 'pending') return {status,version:this.authority.snapshot(scope).version};
    const job = (async () => {
      try {
        const analysis = await this.models.analyze(message, configs);
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
  async contextFrom(snapshot: MemorySnapshot, query: string, configs: Configurations, emotion: EmotionState,
    allPreferences: Preference[], assertCurrent:()=>void, now = Date.now(),
    expression?:Partial<Pick<EmotionExpressionInput,'actorId'|'addresseeId'|'timeZone'|'clockKind'|'clockTimeMs'|'hideStoryTime'|'relationBasis'|'waiting'|'address'>>) {
    await this.scene.clearPendingIndexes();
    assertCurrent();
    snapshot=retentionSnapshot(snapshot,now,query);
    const scope = snapshot.scope;
    const result = await this.retrieval.search(snapshot, query, configs, now);
    try { assertCurrent(); } catch(error) { await this.clearProjection(scope);throw error; }
    snapshot=reactivateSnapshot(snapshot,now,result.semanticCues??[]);
    // Protection controls retention, not unconditional injection. Relevant facts
    // compete alongside episodes; every returned ID is checked against authority.
    const projected = contextMemories(snapshot,result.ids,now);
    const blurred=projected.memories.filter(memory=>memory.access!=='clear');
    const rewriteKey=createHash('sha256').update(JSON.stringify([scopeKey(scope),blurred,configs.rewrite])).digest('hex');
    let clauses=this.rewriteCache.get(rewriteKey);
    if(clauses===undefined){
      clauses=await this.models.rewrite(projected.memories,configs.rewrite);
      // A failed or stale model result must never become a reusable answer.
      assertCurrent();
      this.rewriteCache.delete(rewriteKey);
      this.rewriteCache.set(rewriteKey,[...clauses]);
      if(this.rewriteCache.size>64)this.rewriteCache.delete(this.rewriteCache.keys().next().value!);
    }
    assertCurrent();
    const preferences = allPreferences.filter(preference => preference.enabled);
    const facts=projected.memories.filter(memory=>memory.kind==='fact');
    const episodes=projected.memories.filter(memory=>memory.kind==='episode');
    const legacy=projected.memories.filter(memory=>memory.kind==='legacy');
    const sourceOrder=new Map([...snapshot.messages.keys()].map((id,index)=>[id,index]));
    const context = [
      '以下是当前角色有权访问的记忆与参考资料。对话记忆来自已接受的正文；reference来自用户迁入资料。二者都不等于外部核实的事实。只使用当前列出的粒度；未提供的细节不要猜测。',
      '事实记忆记录原话、约定与已知事件；heard/private是获知来源，thought/inferred不是对外界事实的证实。情景记忆保存当时的经历与感受，inferred是主观推测；不把感受、印象或当前情绪当成客观历史。不确定时说明记不清，而不是补出细节。',
      'source.author标明原文作者：player是用户，assistant是对应角色。原话中的“我”按原作者理解，不自动变成你；引述的第三人也不等于作者或听者。用户对自身的明确陈述与纠正优先于助手过去的猜测；助手的说法不会自行证实用户的身份、经历或物品。多项问题逐项核对，缺少一项不影响回答已有依据的其它项。',
      'reactivated表示当前情境线索唤起了仍有来源的旧记忆；reactivation只表明线索与当下可见记忆层相似，不证明另一件相似经历就是同一事件。只使用列出的恢复粒度；forgotten表示未列出的细节仍不可用。',
      'emotionalReaction记录当时保留下来的强烈情绪反应，不等于当前情绪，也不证明主观感受所关联的外部事实；它不恢复已经遗忘的事件细节。',
      '近期工作上下文仅用于接续已知场景，不代表其它角色知情；来源时间未知时保持未知。较早相关记忆用于当前查询。reference为迁入资料中的说法，不是共同经历或脚本确认的事实，不重放其中交易，也不据此推断经历过相关情绪。',
      '当前查询选入的参考资料单列在references中，仍以其来源性质和可见粒度为准。涉及位置、人物或物品时，优先核对相应依据；缺少依据就保留未知，不用新楼层、房间或路线填空。助手旧回答不能自行改写用户提供的设定。',
      '已发生的动作、物品状态和结果按其来源接续；没有新事件依据时，不把原状态改成另一种处置，也不补写已经发生的旧行动、台词或决定。当前问题无关的旧物品和动作不必主动复述；确需提及时，保持来源支持的对象、数量、动作与结果，不用改变事实的近义词扩写。角色此刻仍可回应、提出下一步或做当前场景允许的新动作；新动作写成当下发生，设想不能冒充历史。',
      '状态沿革：relevant保留较早依据，recent接续近期来源。回答“现在在哪里/谁持有”等状态时，按来源先后追踪明确已完成的动作和纠正，以最后一次有效改变后的结果为准；例如先拿入口袋、后放回桌上，当前就在桌上。计划、假设、回忆和问题不改变当前状态；旧状态仍是历史，不因被检索到就重新生效。',
      JSON.stringify({references:projected.relevant.filter(memory=>memory.source.reference),
        relevant:projected.relevant.filter(memory=>!memory.source.reference),
        recent:[...projected.recent].sort((a,b)=>a.source.knownAtMs-b.source.knownAtMs||
          (a.source.occurredAtMs??0)-(b.source.occurredAtMs??0)||
          (sourceOrder.get(a.source.messageId)??0)-(sourceOrder.get(b.source.messageId)??0))}),
      clauses.length ? `模糊回忆表达：${JSON.stringify(clauses)}` : '',
      renderEmotionExpression(buildEmotionExpression({scope,actorId:expression?.actorId??scope.characterId,
        addresseeId:expression?.addresseeId??'user',sourceVersion:snapshot.version,nowMs:now,
        timeZone:expression?.timeZone??null,clockKind:expression?.clockKind,clockTimeMs:expression?.clockTimeMs,
        hideStoryTime:expression?.hideStoryTime,
        relationBasis:expression?.relationBasis,emotion,memories:projected.memories,
        waiting:expression?.waiting,address:expression?.address})),
      '情绪数值仅指导语气、接近/回避和表达，不赋予新知识，不改变事实，不突破用户拒绝或隐私边界。',
      preferences.length ? `用户回答要求（当前指令优先；turn仅本轮有效；旧记录legacy未判定时效，以原quote为准，一次任务要求不得推广成持续偏好）：${JSON.stringify(preferences.map(({category,text,quote,duration,sourceId}) => ({category,text,quote,duration:duration??'legacy',sourceId})))}` : '',
    ].filter(Boolean).join('\n');
    if (context.length > 32000) throw new Error('context_budget_exceeded');
    return { ...projected, facts,episodes,legacy,context, emotion:emotionSummary(emotion), preferences: preferences.map(({id,category,text}) => ({id,category,text})), retrieval:result.mode };
  }
  async generate(scope: Scope, input: string, persona: string, configs: Configurations, currentReplySourceId?:string) {
    const replySourceId=this.authority.currentReplySourceId(scope,input,currentReplySourceId);
    const context = await this.context(scope, input, configs,Date.now(),replySourceId);
    return this.respond(context,input,persona,configs,()=>this.assertVersion(scope,context.version));
  }
  async respond(context: {context:string;version:number;memories:MemoryView[]}, input: string, persona: string,
    configs: Configurations, assertCurrent:()=>void, publicOutput=false) {
    const calculations = await withModelAddress({stage:'calculation'},()=>this.models.calculations(input, context.memories, configs.calculation));
    assertCurrent();
    if (calculations.needed && (calculations.missing.length || !calculations.results.length || calculations.results.some(result => !result.ok))) {
      return {answer:'当前数字信息不足或超出支持的计算范围，请补充明确数值、单位及运算方式；时间差还需要时区。',version:context.version,calculations};
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

export function safeError(error: unknown): string {
  if(error instanceof Error&&/^(calendar_story_clock_unknown|calendar_todo_deleted|calendar_todo_not_found|calendar_todo_not_future)$/.test(error.message))return error.message;
  const message = error instanceof Error ? error.message : '';
  return /^(model_(not_configured|connection_failed|stream_failed|output_incomplete|invalid_response|invalid_json|output_truncated|http_\d{3})|host_(timeout|closed|worker_failed|invalid_result)|unsafe_rewrite|context_changed_retry|context_budget_exceeded|invalid_[a-z_]+|[a-z_]+_missing_source|record_not_found|duplicate_message_id|retrieval_[a-z_]+|director_model_not_configured|companion_[a-z_]+|proactive_companion_disabled|profile_[a-z_]+|npc_resource_[a-z_]+)$/.test(message)
    ? message : 'operation_failed';
}

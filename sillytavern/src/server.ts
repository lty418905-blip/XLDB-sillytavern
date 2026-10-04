import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Authority } from '../../shared/src/core/store.ts';
import { Core, safeError } from '../../shared/src/core/service.ts';
import { Retrieval } from '../../shared/src/memory/retrieval.ts';
import { configProfileOf, configsOf, integer, messageOf, object, profileFromLegacy, resolveConfigProfile, scopeOf, text } from '../../shared/src/core/types.ts';
import type { ConfigProfile, Configurations, ModelConfig } from '../../shared/src/core/types.ts';
import type { Access } from '../../shared/src/memory/access.ts';
import {sceneWorkbench,correctSceneSource} from '../../shared/src/scene/workbench.ts';
import {sceneDashboard} from './dashboard.ts';
import {listModels, ModelCatalogError} from './model-catalog.ts';
import {RuntimeLog} from '../../shared/src/core/runtime-log.ts';
import {closeEmotionRanker,emotionRankerStatus} from '../../shared/src/scene/emotion-scheduler.ts';
import {startPairCapture} from '../../shared/src/core/pair-capture-switch.ts';

export function loadConfigProfile(filename: string): ConfigProfile {
  if (!fs.existsSync(filename)) return {version:2,revision:0,defaultText:{baseUrl:'',key:'',model:''},overrides:{},
    embedding:{baseUrl:'',key:'',model:''},reranker:{baseUrl:'',key:'',model:''}};
  const stored = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (stored?.version !== undefined && stored.version !== 2) throw new Error('invalid_config_version');
  return stored?.version === 2 ? configProfileOf(stored) : profileFromLegacy(stored);
}
export function loadConfig(filename: string): Configurations {
  return resolveConfigProfile(loadConfigProfile(filename));
}
// Windows reports EPERM/EBUSY/EACCES while another process (an antivirus scan, an editor, a backup) briefly holds
// the target; the previous file stays intact and the rename is retried for a bounded time.
const transientRename = new Set(['EPERM','EBUSY','EACCES']);
export function saveConfig(filename: string, config: ConfigProfile | Configurations) {
  fs.mkdirSync(path.dirname(filename), {recursive:true});
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const value = 'version' in config ? configProfileOf(config) : configsOf(config);
  try {
    const handle = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(handle, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(handle); }
    finally { fs.closeSync(handle); }
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(temporary, filename); return; }
      catch (error) {
        if (attempt >= 6 || !transientRename.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * 2 ** attempt);
      }
    }
  } catch (error) {
    fs.rmSync(temporary, {force:true});
    throw error;
  }
}

type RetrievalStage = 'embedding'|'reranker';
/**
 * The key rule of companion-agent/adapters/retrieval-config.mjs (CX-004), with the same error code: after trimming, a
 * key must not contain whitespace or `://` and must not start with http(s):, which catches a pasted URL or two keys.
 */
export function retrievalKeyRejected(key: unknown): boolean {
  if (typeof key !== 'string') return false;
  const trimmed = key.trim();
  return /\s/.test(trimmed) || trimmed.includes('://') || /^https?:/i.test(trimmed);
}
function rejectedRetrievalKey(value: {embedding?:ModelConfig;reranker?:ModelConfig}): RetrievalStage|undefined {
  return (['embedding','reranker'] as const).find(stage => retrievalKeyRejected(value[stage]?.key));
}

export type RetrievalCheck = {status:'ok'}|{status:'not_configured'}|
  {status:'failed';failure:string;attention:'configuration'|'transient';httpStatus?:number};
const CONFIGURATION_CHECK_FAILURES = new Set(['credentials_rejected','model_not_found','endpoint_redirected','invalid_key','invalid_config','invalid_response']);
function checkFailure(failure: string, httpStatus?: number): RetrievalCheck {
  return {status:'failed',failure,attention:CONFIGURATION_CHECK_FAILURES.has(failure)?'configuration':'transient',...(httpStatus===undefined?{}:{httpStatus})};
}
// Same status classes as the retrieval provider errors (shared/src/memory/retrieval.ts httpFailure, M0r).
function checkHttpFailure(status: number, body: string): string {
  if (status === 401 || status === 403) return 'credentials_rejected';
  if (status === 404) return 'model_not_found';
  if (status === 429) return 'rate_limited';
  if (status === 408 || status === 504) return 'timeout';
  if ((status === 400 || status === 422) && (/model[^.\n]{0,40}?(?:not[\s_-]*(?:found|exist)|does[\s_-]*not[\s_-]*exist|unknown|unsupported|invalid)/i.test(body) ||
    /(?:unknown|invalid|unsupported|no[\s_-]+such)[\s_-]+model/i.test(body) || /模型.{0,12}(?:不存在|无效|不支持|未找到)/.test(body))) return 'model_not_found';
  return 'provider_error';
}

/**
 * One minimal embedding or rerank request against the configured endpoint. The result carries only a failure class and
 * an HTTP status; the key, the address and the provider's reply never leave this function.
 */
export async function checkRetrievalProvider(stage: RetrievalStage, config: ModelConfig|undefined, timeoutMs = 8000): Promise<RetrievalCheck> {
  const baseUrl = typeof config?.baseUrl === 'string' ? config.baseUrl.trim() : '';
  const key = typeof config?.key === 'string' ? config.key.trim() : '';
  const model = typeof config?.model === 'string' ? config.model.trim() : '';
  if (!baseUrl && !key && !model) return {status:'not_configured'};
  if (retrievalKeyRejected(key)) return checkFailure('invalid_key');
  let url: URL;
  try { url = new URL(baseUrl); } catch { return checkFailure('invalid_config'); }
  if (!model || !['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return checkFailure('invalid_config');
  const expected = stage === 'embedding' ? '/embeddings' : '/rerank';
  const pathname = url.pathname.replace(/\/+$/, '');
  url.pathname = pathname.endsWith(expected) ? pathname : `${pathname}${expected}`;
  const payload = stage === 'embedding' ? {model,input:['ping'],encoding_format:'float'}
    : {model,query:'ping',documents:['ping'],top_n:1,return_documents:false};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(url, {method:'POST',redirect:'error',signal:controller.signal,body:JSON.stringify(payload),
        headers:key ? {Authorization:`Bearer ${key}`,'Content-Type':'application/json'} : {'Content-Type':'application/json'}});
    } catch (error) {
      const cause = error instanceof Error ? (error as Error&{cause?:unknown}).cause : undefined;
      return checkFailure(controller.signal.aborted ? 'timeout'
        : [error,cause].some(item => item instanceof Error && /redirect/i.test(item.message)) ? 'endpoint_redirected' : 'transport');
    }
    if (!response.ok) {
      const body = response.status === 400 || response.status === 422 ? await response.text().then(value => value.slice(0,4096), () => '') : '';
      return checkFailure(controller.signal.aborted ? 'timeout' : checkHttpFailure(response.status, body), response.status);
    }
    let body: unknown;
    try { body = await response.json(); } catch { return checkFailure(controller.signal.aborted ? 'timeout' : 'invalid_response'); }
    const list = body && typeof body === 'object' ? (body as Record<string,unknown>)[stage === 'embedding' ? 'data' : 'results'] : undefined;
    const first = Array.isArray(list) && list[0] && typeof list[0] === 'object' ? list[0] as Record<string,unknown> : undefined;
    const valid = stage === 'embedding'
      ? Array.isArray(first?.embedding) && first.embedding.length > 0 && first.embedding.every(value => typeof value === 'number' && Number.isFinite(value))
      : typeof first?.relevance_score === 'number' && Number.isFinite(first.relevance_score);
    return valid ? {status:'ok'} : checkFailure('invalid_response');
  } finally {
    clearTimeout(timer);
  }
}

type StageHealth = {status:'not_configured'|'unchecked'|'ok'|'failed';source?:'self_check'|'turn';failure?:string;
  attention?:'configuration'|'transient';httpStatus?:number;fallbackReason?:string};
const CODE = /^[a-z][a-z_]{0,47}$/;
const configuredStage = (config: ModelConfig|undefined) => Boolean(config?.baseUrl?.trim() || config?.key?.trim() || config?.model?.trim());

/**
 * Process-wide retrieval health for the Tavern status line: the latest self-check result or observed provider outcome
 * per stage. Only a provider call that completed clears a failure. A retrieval mode string never does: Retrieval.search
 * answers `hybrid` without any call for a scope with no memory, an empty query or a missing identifier. A success never
 * clears a failure recorded by the same request (a mixed turn stays degraded); a success in any later request does.
 */
class RetrievalHealth {
  private stages: Record<RetrievalStage,StageHealth> = {embedding:{status:'not_configured'},reranker:{status:'not_configured'}};
  private failedIn: Record<RetrievalStage,string|undefined> = {embedding:undefined,reranker:undefined};
  private generation = 0;
  reset(config: {embedding?:ModelConfig;reranker?:ModelConfig}) {
    this.generation++;
    for (const stage of ['embedding','reranker'] as const) this.stages[stage] = {status:configuredStage(config[stage]) ? 'unchecked' : 'not_configured'};
    return this.generation;
  }
  checked(generation: number, stage: RetrievalStage, result: RetrievalCheck) {
    if (generation !== this.generation) return;
    if (result.status === 'failed') this.fail(stage, {source:'self_check',failure:result.failure,attention:result.attention,httpStatus:result.httpStatus});
    else this.stages[stage] = result.status === 'ok' ? {status:'ok',source:'self_check'} : {status:'not_configured'};
  }
  degraded(event: {requestId?:string;parts?:readonly string[];failureClass?:string;attention?:string;httpStatus?:number;fallbackReason?:string}) {
    const stage = event.parts?.[0];
    if (stage !== 'embedding' && stage !== 'reranker') return;
    this.fail(stage, {source:'turn',failure:event.failureClass && CODE.test(event.failureClass) ? event.failureClass : 'provider_error',
      attention:event.attention === 'configuration' ? 'configuration' : 'transient',httpStatus:event.httpStatus,
      fallbackReason:event.fallbackReason && CODE.test(event.fallbackReason) ? event.fallbackReason : undefined}, event.requestId);
  }
  /** A dispatched embedding or rerank call completed (a runtime-log model event), so the configured endpoint answered. */
  succeeded(stage: RetrievalStage, requestId: string|undefined) {
    const current = this.stages[stage];
    if (current.status === 'not_configured') return;
    if (current.status === 'failed' && this.failedIn[stage] !== undefined && this.failedIn[stage] === requestId) return;
    this.stages[stage] = {status:'ok',source:'turn'};
  }
  snapshot() {
    const stages = {embedding:{...this.stages.embedding},reranker:{...this.stages.reranker}};
    return {...stages,degraded:Object.values(stages).some(stage => stage.status === 'failed')};
  }
  private fail(stage: RetrievalStage, fields: Omit<StageHealth,'status'>, requestId?: string) {
    this.failedIn[stage] = requestId;
    const httpStatus = Number.isInteger(fields.httpStatus) && fields.httpStatus! >= 100 && fields.httpStatus! <= 599 ? fields.httpStatus : undefined;
    this.stages[stage] = {status:'failed',source:fields.source,failure:fields.failure,attention:fields.attention,
      ...(httpStatus === undefined ? {} : {httpStatus}),...(fields.fallbackReason ? {fallbackReason:fields.fallbackReason} : {})};
  }
}

/**
 * The runtime log, observed so the status line learns retrieval outcomes as they happen: a degraded retrieval event
 * records a failure, and a completed, dispatched provider call (stage set by withModelAddress in retrieval.ts request())
 * is the only success signal.
 */
class ObservedRuntimeLog extends RuntimeLog {
  private readonly health: RetrievalHealth;
  constructor(health: RetrievalHealth) { super(); this.health = health; }
  override append(event: Parameters<RuntimeLog['append']>[0]) {
    super.append(event);
    if (event.kind === 'stage' && event.stage === 'retrieval' && event.status === 'degraded') this.health.degraded(event);
    else if (event.kind === 'model' && event.status === 'completed' && event.apiAttempt === true
      && (event.stage === 'embedding' || event.stage === 'reranker')) this.health.succeeded(event.stage, event.requestId);
  }
}

type InstallPairing = {codeSha256:string;origin:string;expiresAtMs:number};

function consumeInstallPairing(filename: string, origin: string, code: unknown): boolean {
  if (typeof code !== 'string' || !/^[0-9a-fA-F]{64}$/.test(code)) return false;
  let pairing: InstallPairing;
  try {
    const value = JSON.parse(fs.readFileSync(filename, 'utf8')) as Partial<InstallPairing>;
    if (typeof value.codeSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.codeSha256)
      || typeof value.origin !== 'string' || typeof value.expiresAtMs !== 'number' || !Number.isFinite(value.expiresAtMs)) return false;
    pairing = value as InstallPairing;
  } catch { return false; }
  const supplied = Buffer.from(createHash('sha256').update(code, 'utf8').digest('hex'), 'hex');
  const expected = Buffer.from(pairing.codeSha256, 'hex');
  if (pairing.origin !== origin || pairing.expiresAtMs <= Date.now() || !timingSafeEqual(supplied, expected)) return false;
  fs.unlinkSync(filename);
  return true;
}

export function createServer(core: Core, options: {token:string;configPath:string;origins:string[];onShutdown?:()=>void;
  /** Self-check the saved embedding and reranker once at startup (the product entry point sets it). */
  checkRetrievalOnStart?:boolean;retrievalCheckTimeoutMs?:number}) {
  const retrievalHealth=new RetrievalHealth();
  const runtimeLog=new ObservedRuntimeLog(retrievalHealth);
  let profile = loadConfigProfile(options.configPath);
  let profileV2 = fs.existsSync(options.configPath) && JSON.parse(fs.readFileSync(options.configPath,'utf8')).version === 2;
  let config = resolveConfigProfile(profile);
  const token = Buffer.from(options.token);
  const checkRetrieval = async (value: {embedding:ModelConfig;reranker:ModelConfig}) => {
    const generation=retrievalHealth.reset(value);
    const [embedding,reranker]=await Promise.all((['embedding','reranker'] as const).map(async stage=>{
      const result=await checkRetrievalProvider(stage,value[stage],options.retrievalCheckTimeoutMs);
      retrievalHealth.checked(generation,stage,result);
      return result;
    }));
    return {embedding,reranker};
  };
  const retrievalChanged = (next: {embedding:ModelConfig;reranker:ModelConfig}) =>
    JSON.stringify([next.embedding,next.reranker])!==JSON.stringify([profile.embedding,profile.reranker]);
  if (options.checkRetrievalOnStart) void checkRetrieval(profile);
  else retrievalHealth.reset(profile);
  return http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status: number, body: unknown) => {
      // A turn reports its retrieval modes; the status line gets the health observed so far with the same response.
      if (status === 200 && body && typeof body === 'object' && Array.isArray((body as {retrievalModes?:unknown}).retrievalModes))
        body = {...body, retrievalStatus:retrievalHealth.snapshot()};
      response.writeHead(status); response.end(JSON.stringify(body));
    };
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(request.headers.host ?? '')) return send(403, {error:'invalid_host'});
    const origin = request.headers.origin;
    if (origin && !options.origins.includes(origin)) return send(403, {error:'origin_not_allowed'});
    if (origin) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
      response.setHeader('Access-Control-Allow-Private-Network', 'true');
    }
    if (request.method === 'OPTIONS') return send(204, null);
    if (request.method === 'GET' && request.url === '/health') return send(200, {status:'ready',protocol:'xldb-scene-v2',sqlite:core.authority.sqliteVersion()});
    if (request.method === 'POST' && request.url === '/v1/install/pair') {
      try {
        if (!origin) return send(403, {error:'pairing_failed'});
        const input = await bodyOf(request);
        const pairingPath = path.join(path.dirname(options.configPath), 'install-pairing.json');
        if (!consumeInstallPairing(pairingPath, origin, input.code)) return send(403, {error:'pairing_failed'});
        return send(200, {protocol:'xldb-scene-v2',token:options.token});
      } catch { return send(403, {error:'pairing_failed'}); }
    }
    const supplied = Buffer.from((request.headers.authorization ?? '').replace(/^Bearer /, ''));
    if (supplied.length !== token.length || !timingSafeEqual(supplied, token)) return send(401, {error:'unauthorized'});
    if(request.method==='POST'&&request.url==='/v1/install/shutdown'&&options.onShutdown){
      if(origin)return send(403,{error:'local_process_only'});
      send(200,{status:'stopping'});options.onShutdown();return;
    }
    try {
      if (request.url === '/v1/config' && request.method === 'GET') return send(200, config);
      if (request.url === '/v1/config-profile' && request.method === 'GET') return send(200, profile);
      // Read-only NPC emotion ranker state for the Tavern badge; reading it never starts AgentJev.
      if (request.url === '/v1/emotion-ranker' && request.method === 'GET') return send(200, emotionRankerStatus());
      // Read-only retrieval health for the Tavern status line; never contains a key or an address.
      if (request.url === '/v1/retrieval-status' && request.method === 'GET') return send(200, retrievalHealth.snapshot());
      if (!['POST','PUT'].includes(request.method ?? '')) return send(405, {error:'method_not_allowed'});
      let input: Record<string,unknown>;
      try { input = await bodyOf(request); }
      catch (error) {
        if (request.url === '/v1/model-catalog') return send(400,{error:'model_catalog_invalid_input'});
        throw error;
      }
      if (request.url === '/v1/model-catalog') {
        if (request.method !== 'POST') return send(405,{error:'method_not_allowed'});
        try { return send(200,await listModels(input.baseUrl,input.key)); }
        catch (error) {
          const code=error instanceof ModelCatalogError?error.code:'model_catalog_unavailable';
          return send(code==='model_catalog_invalid_input'?400:502,{error:code});
        }
      }
      if(request.url==='/v1/diagnostics')return send(200,{protocol:'xldb-scene-v2',authenticated:true,
        node:process.version,sqlite:core.authority.sqliteVersion(),emotionRanker:emotionRankerStatus(),retrieval:retrievalHealth.snapshot(),stages:Object.fromEntries(Object.entries(config).map(([name,value])=>[name,{configured:Boolean(value.model)}]))});
      if (request.url === '/v1/config') {
        if (profileV2) return send(409,{error:'config_profile_required'});
        const next = configsOf(input);
        const rejected = rejectedRetrievalKey(next);
        if (rejected) return send(400, {error:'invalid_retrieval_config_key',stage:rejected});
        const nextProfile = profileFromLegacy(next);
        const recheck = retrievalChanged(nextProfile);
        saveConfig(options.configPath, next);
        profile = nextProfile;
        config = next;
        core.scene.invalidateModelConfiguration();
        return send(200, {status:'saved',...(recheck ? {retrievalCheck:await checkRetrieval(nextProfile)} : {})});
      }
      if (request.url === '/v1/config-profile') {
        const next = configProfileOf(input);
        const rejected = rejectedRetrievalKey(next);
        if (rejected) return send(400, {error:'invalid_retrieval_config_key',stage:rejected});
        const same=JSON.stringify([next.defaultText,next.overrides,next.embedding,next.reranker])===
          JSON.stringify([profile.defaultText,profile.overrides,profile.embedding,profile.reranker]);
        if(profileV2 && same && (next.revision===profile.revision || next.revision===profile.revision-1))
          return send(200,{status:'saved',revision:profile.revision});
        if(next.revision!==profile.revision)return send(409,{error:'config_revision_conflict'});
        const saved={...next,revision:profile.revision+1};
        const recheck = retrievalChanged(saved);
        saveConfig(options.configPath, saved);
        profile = saved;
        profileV2 = true;
        config = resolveConfigProfile(saved);
        core.scene.invalidateModelConfiguration();
        return send(200, {status:'saved',revision:saved.revision,...(recheck ? {retrievalCheck:await checkRetrieval(saved)} : {})});
      }
      const scope = scopeOf(input.scope);
      if(request.url==='/v1/scene/runtime-log')return send(200,runtimeLog.snapshot(scope));
      runtimeLog.enter(scope,(request.url??'').split('?')[0].replace(/[^a-z0-9/\-]/gi,'').slice(0,80));
      const interactions=core.authority.scene.interactions;
      if(request.url==='/v1/scene/interaction')return send(200,interactions.open(scope,'sillytavern'));
      // The Tavern has only roleplay; the route stays so an older plugin gets a clear refusal instead of not_found.
      if(request.url==='/v1/scene/interaction-switch'){
        if(input.mode!=='roleplay')throw new Error('invalid_interaction_mode');
        return send(200,interactions.switch(scope,'sillytavern','roleplay',integer(input.expectedRevision)));
      }
      if(request.url==='/v1/scene/interaction-settings')return send(200,interactions.settings(scope,'sillytavern',object(input.settings),integer(input.expectedRevision)));
      if(request.url==='/v1/scene/interaction-clock'){
        interactions.assertActive(scope,input.interactionRevision as number|undefined);
        return send(200,interactions.clock(scope));
      }
      interactions.assertActive(scope,input.interactionRevision as number|undefined);
      if(['/v1/scene/configure','/v1/scene/world-configure','/v1/scene/access','/v1/scene/preference','/v1/scene/identity-extract','/v1/scene/native-context','/v1/scene/restore','/v1/scene/undo'].includes(request.url??'')) {
        if(core.scene.syncState(scope).version!==integer(input.expectedVersion))throw new Error('context_changed_retry');
      }
      switch (request.url) {
        case '/v1/scene/resources': return send(200,core.scene.resources(scope));
        case '/v1/scene/resources-configure': return send(200,core.scene.configureResources(scope,{
          maxActive:integer(input.maxActive),priorityIds:input.priorityIds as string[],expectedRevision:integer(input.expectedRevision)}));
        case '/v1/scene/initialization-provenance': return send(200,core.authority.scene.initialization.provenance(scope));
        case '/v1/scene/initialization-refresh-preview': return send(200,core.authority.scene.initialization.previewRefresh(scope,input.sources));
        case '/v1/scene/initialization-refresh': return send(200,core.authority.scene.initialization.refresh(scope,input.sources,
          {expectedVersion:integer(input.expectedVersion),previewId:text(input.previewId,200),operationId:text(input.operationId,200)}));
        case '/v1/scene/initialization-preview': return send(200,await core.scene.previewInitialization(scope,input.sources as import('../../shared/src/scene/initialization.ts').InitializationSource[],config));
        case '/v1/scene/initialization-apply': return send(200,core.authority.scene.initialization.apply(scope,
          input.candidate as import('../../shared/src/scene/initialization.ts').InitializationCandidate,input.sources as import('../../shared/src/scene/initialization.ts').InitializationSource[],
          {expectedVersion:integer(input.expectedVersion),previewId:text(input.previewId,200),operationId:text(input.operationId,200)}));
        case '/v1/scene/commitments': return send(200,core.authority.scene.commitments.list(scope,object(input.query??{})));
        case '/v1/scene/template-export': return send(200,core.authority.scene.transfer.exportTemplate(scope,text(input.name,200)));
        case '/v1/scene/transfer-preview': return send(200,core.authority.scene.transfer.preview(scope,input.document));
        case '/v1/scene/transfer-apply': return send(200,core.authority.scene.transfer.apply(scope,input.document,
          {expectedVersion:integer(input.expectedVersion),previewId:text(input.previewId,200),operationId:text(input.operationId,200)}));
        case '/v1/scene/reference-delete': return send(200,core.authority.scene.transfer.deleteReference(scope,text(input.id,200),
          {expectedVersion:integer(input.expectedVersion),operationId:text(input.operationId,200)}));
        case '/v1/scene/dashboard': {
          const dashboard=sceneDashboard(core.authority.scene,scope,Date.now(),{
          characterId:input.characterId===undefined?undefined:text(input.characterId,200),
          year:input.year===undefined?undefined:integer(input.year,1),month:input.month===undefined?undefined:integer(input.month,1)});
          const scheduling=dashboard.selectedCharacterId==='player'?null:core.scene.emotionScheduling(scope);
          const directorTodos=dashboard.selectedCharacterId==='player'?[]:core.scene.directorCalendarTodos(scope).filter(item=>item.characterId===dashboard.selectedCharacterId);
          const skipped=core.scene.progress(scope).sources.flatMap(source=>source.stages.filter(stage=>String(stage.status)==='skipped').map(stage=>({sourceId:source.sourceId,...stage})));
          return send(200,{...dashboard,directorTodos,skippedStages:skipped,emotionRanker:emotionRankerStatus(),emotionScheduling:scheduling?{budget:scheduling.budget,pendingTotal:scheduling.pendingTotal,backgroundError:scheduling.backgroundError,
            latestRanking:scheduling.latestRanking,npc:scheduling.npcs.find(item=>item.id===dashboard.selectedCharacterId)}:null});
        }
        case '/v1/scene/calendar-preview': return send(200,await core.scene.previewCalendar(scope,config));
        case '/v1/scene/todo-save': return send(200,core.authority.scene.calendar.putTodo(scope,
          {id:input.id===undefined?undefined:text(input.id,200),title:text(input.title,500),date:text(input.date,10),time:text(input.time,5)},
          input.revision===undefined?undefined:integer(input.revision)));
        case '/v1/scene/todo-complete': return send(200,core.authority.scene.calendar.completeTodo(scope,text(input.id,200),integer(input.revision)));
        case '/v1/scene/todo-delete': return send(200,core.authority.scene.calendar.deleteTodo(scope,text(input.id,200),integer(input.revision)));
        case '/v1/scene/todo-ack': return send(200,core.authority.scene.calendar.ackReminder(scope,text(input.id,200),integer(input.revision)));
        case '/v1/scene/calendar-apply': return send(200,core.authority.scene.calendar.apply(scope,input.candidate,
          {expectedVersion:integer(input.expectedVersion),previewId:text(input.previewId,200)}));
        case '/v1/scene/geography/status': return send(200,{configuration:core.authority.scene.geography.configuration(scope),
          projection:core.authority.scene.geography.project(scope,input.readerId===undefined?'player':text(input.readerId,200))});
        case '/v1/scene/geography/configure': return send(200,core.authority.scene.geography.configure(scope,input.config,
          {expectedRevision:integer(input.expectedRevision),operationId:text(input.operationId,200)}));
        case '/v1/scene/geography/import-preview': return send(200,core.authority.scene.geography.previewImport(scope,input.document));
        case '/v1/scene/geography/import': return send(200,core.authority.scene.geography.import(scope,input.document,
          {expectedVersion:integer(input.expectedVersion),operationId:text(input.operationId,200),documentHash:text(input.documentHash,64),allowInitialPositionConflicts:input.allowInitialPositionConflicts===true}));
        case '/v1/scene/geography/export': return send(200,core.authority.scene.geography.export(scope,input.readerId===undefined?'player':text(input.readerId,200)));
        case '/v1/scene/geography/correct': return send(200,core.authority.scene.geography.correct(scope,input.correction,
          {expectedVersion:integer(input.expectedVersion),operationId:text(input.operationId,200)}));
        case '/v1/scene/geography/layout': return send(200,core.authority.scene.geography.saveLayout(scope,input.readerId===undefined?'player':text(input.readerId,200),input.layout,
          {expectedRevision:integer(input.expectedRevision),operationId:text(input.operationId,200)}));
        case '/v1/scene/geography/background-preview': return send(200,await core.scene.previewGeographyBackground(scope,input,config));
        case '/v1/scene/physiology/status': return send(200,core.authority.scene.physiology.status(scope,{readerId:input.readerId===undefined?'player':text(input.readerId,200)}));
        case '/v1/scene/physiology/configure': return send(200,core.authority.scene.physiology.configure(scope,input.config,integer(input.expectedRevision)));
        case '/v1/scene/physiology/correct': return send(200,core.authority.scene.physiology.correct(scope,input.correction,integer(input.expectedRevision)));
        case '/v1/scene/physiology/clear': return send(200,core.authority.scene.physiology.clearCorrection(scope,text(input.characterId,200),text(input.id,200),integer(input.expectedRevision)));
        case '/v1/scene/workbench': return send(200,sceneWorkbench(core.authority.scene,scope,{view:text(input.view,20) as 'admin'|'character',
          characterId:input.characterId===undefined?undefined:text(input.characterId,200),query:input.query===undefined?undefined:text(input.query,500,true),type:input.type===undefined?undefined:text(input.type,30,true)}));
        case '/v1/scene/source-correct': return send(200,await correctSceneSource(core,scope,text(input.sourceId,200),integer(input.revision,1),
          input.text===null?null:text(input.text,20000),{expectedVersion:integer(input.expectedVersion),operationId:text(input.operationId,200)},config));
        case '/v1/scene/progress': return send(200,core.scene.progress(scope));
        case '/v1/scene/retry': return send(200,await core.scene.retryPending(scope,config,input.sourceId===undefined?undefined:text(input.sourceId,200),input.revision===undefined?undefined:integer(input.revision,1)));
        case '/v1/scene/restore-preview': {
          if(!['restore','undo'].includes(text(input.operation,20)))throw new Error('invalid_restore_operation');
          return send(200,core.authority.scene.lifecycle.preview(scope,input.operation==='restore'?text(input.checkpointId,200):undefined));
        }
        case '/v1/scene/configure': return send(200,core.scene.configure(scope,input.roster));
        case '/v1/scene/world-configure': return send(200,core.scene.configureWorld(scope,input.settings));
        case '/v1/scene/checkpoint': return send(200,core.scene.checkpoint(scope,text(input.reason??'手动保存点',200)));
        case '/v1/scene/checkpoints': return send(200,core.scene.checkpoints(scope));
        case '/v1/scene/restore': return send(200,await core.scene.restore(scope,text(input.checkpointId,200),integer(input.expectedVersion)));
        case '/v1/scene/undo': return send(200,await core.scene.undo(scope,integer(input.expectedVersion),input.checkpointId===undefined?undefined:text(input.checkpointId,200)));
        case '/v1/scene/fork': {
          const result=interactions.fork(scope,'sillytavern',()=>core.scene.fork(scope,text(input.branchId,200),input.checkpointId===undefined?undefined:text(input.checkpointId,200)));
          core.authority.scene.refreshDerived(result.scope);
          return send(200,result);
        }
        case '/v1/scene/identity-plan': return send(200,await core.scene.identityPlan(input.materials,config));
        case '/v1/scene/identity-extract': return send(200,await core.scene.identityExtract(scope,input.materials,config));
        case '/v1/scene/inspect': return send(200,core.scene.inspect(scope,input.characterId===undefined?undefined:text(input.characterId,200)));
        case '/v1/scene/sync-state': return send(200,core.scene.syncState(scope));
        case '/v1/scene/reconcile': return send(200,await core.scene.reconcile(scope,input.messages,config,{expectedVersion:integer(input.expectedVersion),operationId:text(input.operationId,200)}));
        case '/v1/scene/reconfirm': return send(200,await core.scene.reconfirm(scope,text(input.sourceId,200),config,{expectedVersion:integer(input.expectedVersion),operationId:text(input.operationId,200)}));
        case '/v1/scene/native-accept': return send(200,await core.scene.acceptNative(scope,text(input.contextTicket,200),input.message,config));
        case '/v1/scene/prepare': {
          const submission=object(input.userSubmission);
          return send(200,await core.scene.prepare(scope,input.envelope,input.input,config,{expectedVersion:integer(submission.expectedVersion),operationId:text(submission.operationId,200),
            userMessageId:text(submission.userMessageId,200),acceptedAtMs:integer(submission.acceptedAtMs)}));
        }
        case '/v1/scene/regenerate': return send(200,await core.scene.regenerate(scope,config));
        case '/v1/scene/native-context': return send(200,await core.scene.nativeContext(scope,input.envelope,input.sourceId,config,input.regenerateId===undefined?undefined:text(input.regenerateId,200)));
        case '/v1/scene/accept': return send(200,await core.scene.accept(scope,text(input.draftId,200),input.messages,config));
        case '/v1/scene/reject': return send(200,core.scene.reject(scope,text(input.draftId,200)));
        case '/v1/scene/access':
          core.scene.setAccess(scope,text(input.characterId,200),text(input.memoryId,500),text(input.access,20));
          return send(200,{status:'updated',...core.scene.syncState(scope)});
        case '/v1/scene/preference':
          if(typeof input.enabled!=='boolean')throw new Error('invalid_preference');
          core.scene.setPreference(scope,text(input.characterId,200),text(input.id,500),input.enabled,input.text===undefined?undefined:text(input.text,500));
          return send(200,{status:'updated',...core.scene.syncState(scope)});
        case '/v1/process': {
          const message = messageOf(input.message);
          if (message.acceptedAtMs > Date.now() + 5000) throw new Error('invalid_future_time');
          return send(200, await core.process(scope, message, config));
        }
        case '/v1/reconcile': {
          if (!Array.isArray(input.messages) || input.messages.length > 10000) throw new Error('invalid_messages');
          const messages = input.messages.map(value => {
            const message = object(value);
            if (message.role !== 'user' && message.role !== 'assistant') throw new Error('invalid_role');
            return { id:text(message.id,200), role:message.role as 'user'|'assistant', text:text(message.text,20000) };
          });
          return send(200, await core.reconcile(scope, messages));
        }
        case '/v1/context': return send(200, await core.context(scope, text(input.query,20000), config));
        case '/v1/generate': return send(200, await core.generate(scope, text(input.input,20000), text(input.persona,12000,true), config));
        case '/v1/inspect': return send(200, core.authority.inspect(scope));
        case '/v1/access':
          core.authority.setAccess(scope, text(input.memoryId,500), text(input.access,20) as Access);
          return send(200, {status:'updated'});
        case '/v1/preference':
          if (typeof input.enabled !== 'boolean') throw new Error('invalid_preference');
          core.authority.setPreference(scope, text(input.id,500), input.enabled, input.text === undefined ? undefined : text(input.text,500));
          return send(200, {status:'updated'});
        default: return send(404, {error:'not_found'});
      }
    } catch (error) {
      const code = safeError(error);
      send(code === 'context_changed_retry' ? 409 : 400, {error:code});
    }
  });
}

/**
 * Stops a Tavern core. The NPC emotion ranker's AgentJev worker is a module singleton; it is closed first so no python
 * child outlives the core.
 */
export function stopCore(server: http.Server, authority: {close():void}) {
  closeEmotionRanker();
  server.close(() => { authority.close(); });
}

async function bodyOf(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error('invalid_body_size');
    chunks.push(chunk);
  }
  try { return object(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
  catch { throw new Error('invalid_json'); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  // Same default as tools/start.ps1: the private directory sits next to this installation root.
  const installRoot = path.resolve(root);
  const privateDirectory = process.env.XLDB_PRIVATE_DIR ?? path.join(path.dirname(installRoot), `${path.basename(installRoot)}-private`);
  fs.mkdirSync(privateDirectory, {recursive:true});
  const tokenPath = path.join(privateDirectory, 'local-token.txt');
  if (!fs.existsSync(tokenPath)) fs.writeFileSync(tokenPath, randomBytes(32).toString('hex'), {mode:0o600});
  const token = fs.readFileSync(tokenPath, 'utf8').trim();
  if (token.length < 32) throw new Error('Local token must contain at least 32 characters');
  const dataDirectory=process.env.XLDB_DATA_DIR??path.join(root,'.local/data');
  const authority = new Authority(path.join(dataDirectory,'authority/xldb.sqlite'));
  const retrieval = new Retrieval(path.join(dataDirectory,'indexes'));
  // Pair capture is a test and evaluation aid, off by default: the switch is read once here, never per model call.
  const pairCapture = startPairCapture(process.env.XLDB_PAIR_CAPTURE, installRoot);
  if (pairCapture.notice !== null) console.error(pairCapture.notice);
  const core = new Core(authority, retrieval);
  await core.scene.clearPendingIndexes();
  const origins = (process.env.XLDB_ALLOWED_ORIGINS ?? 'http://localhost:11451,http://127.0.0.1:11451,http://localhost:8000,http://127.0.0.1:8000').split(',');
  const stop = () => stopCore(server, authority);
  const server = createServer(core, {token,configPath:path.join(privateDirectory,'config.json'),origins,onShutdown:stop,checkRetrievalOnStart:true});
  const port = Number(process.env.XLDB_PORT ?? 4318);
  server.listen(port, '127.0.0.1', () => console.log(`XLDB ready at http://127.0.0.1:${port}; token file: ${tokenPath}`));
  server.on('error', () => { authority.close(); console.error('XLDB could not bind its local port'); process.exitCode=1; });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

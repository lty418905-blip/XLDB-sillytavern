import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Authority } from './core/store.ts';
import { Core, safeError } from './core/service.ts';
import { Retrieval } from './memory/retrieval.ts';
import { configProfileOf, configsOf, integer, messageOf, object, profileFromLegacy, resolveConfigProfile, scopeOf, text } from './core/types.ts';
import type { ConfigProfile, Configurations } from './core/types.ts';
import type { Access } from './memory/access.ts';
import {sceneWorkbench,correctSceneSource} from './scene/workbench.ts';
import {sceneDashboard} from './scene/dashboard.ts';
import {listModels, ModelCatalogError} from './core/model-catalog.ts';
import {RuntimeLog} from './core/runtime-log.ts';

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
export function saveConfig(filename: string, config: ConfigProfile | Configurations) {
  fs.mkdirSync(path.dirname(filename), {recursive:true});
  const temporary = `${filename}.tmp`;
  const value = 'version' in config ? configProfileOf(config) : configsOf(config);
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', {mode:0o600});
  fs.renameSync(temporary, filename);
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

export function createServer(core: Core, options: {token:string;configPath:string;origins:string[];onShutdown?:()=>void}) {
  const runtimeLog=new RuntimeLog();
  let profile = loadConfigProfile(options.configPath);
  let profileV2 = fs.existsSync(options.configPath) && JSON.parse(fs.readFileSync(options.configPath,'utf8')).version === 2;
  let config = resolveConfigProfile(profile);
  const token = Buffer.from(options.token);
  return http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status: number, body: unknown) => { response.writeHead(status); response.end(JSON.stringify(body)); };
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
        node:process.version,sqlite:core.authority.sqliteVersion(),stages:Object.fromEntries(Object.entries(config).map(([name,value])=>[name,{configured:Boolean(value.model)}]))});
      if (request.url === '/v1/config') {
        if (profileV2) return send(409,{error:'config_profile_required'});
        const next = configsOf(input);
        const nextProfile = profileFromLegacy(next);
        saveConfig(options.configPath, next);
        profile = nextProfile;
        config = next;
        core.scene.invalidateModelConfiguration();
        return send(200, {status:'saved'});
      }
      if (request.url === '/v1/config-profile') {
        const next = configProfileOf(input);
        const same=JSON.stringify([next.defaultText,next.overrides,next.embedding,next.reranker])===
          JSON.stringify([profile.defaultText,profile.overrides,profile.embedding,profile.reranker]);
        if(profileV2 && same && (next.revision===profile.revision || next.revision===profile.revision-1))
          return send(200,{status:'saved',revision:profile.revision});
        if(next.revision!==profile.revision)return send(409,{error:'config_revision_conflict'});
        const saved={...next,revision:profile.revision+1};
        saveConfig(options.configPath, saved);
        profile = saved;
        profileV2 = true;
        config = resolveConfigProfile(saved);
        core.scene.invalidateModelConfiguration();
        return send(200, {status:'saved',revision:saved.revision});
      }
      const scope = scopeOf(input.scope);
      const subject=core.authority.scene.subject?.(scope);
      const bindingId=subject?createHash('sha256').update(JSON.stringify([subject.host,subject.subjectId])).digest('hex'):undefined;
      if(request.url==='/v1/scene/runtime-log')return send(200,runtimeLog.snapshot(scope,bindingId));
      runtimeLog.enter(scope,(request.url??'').split('?')[0].replace(/[^a-z0-9/\-]/gi,'').slice(0,80),bindingId);
      const interactions=core.authority.scene.interactions;
      if(request.url==='/v1/scene/interaction')return send(200,interactions.open(scope,'sillytavern'));
      if(request.url==='/v1/scene/interaction-switch')return send(200,interactions.switch(scope,'sillytavern',input.mode as 'roleplay'|'companion',integer(input.expectedRevision)));
      if(request.url==='/v1/scene/interaction-settings')return send(200,interactions.settings(scope,'sillytavern',object(input.settings),integer(input.expectedRevision)));
      if(request.url==='/v1/scene/interaction-clock'){
        interactions.assertActive(scope,input.interactionRevision as number|undefined);
        return send(200,interactions.clock(scope));
      }
      interactions.assertActive(scope,input.interactionRevision as number|undefined);
      const requireSubject=()=>{const subject=core.authority.scene.subject(scope);if(!subject)throw new Error('companion_subject_not_bound');return subject.subjectId;};
      if(['/v1/scene/configure','/v1/scene/world-configure','/v1/scene/access','/v1/scene/preference','/v1/scene/identity-extract','/v1/scene/native-context','/v1/scene/restore','/v1/scene/undo'].includes(request.url??'')) {
        if(core.scene.syncState(scope).version!==integer(input.expectedVersion))throw new Error('context_changed_retry');
      }
      switch (request.url) {
        case '/v1/scene/subject-bind': return send(200,core.authority.scene.bindSubject(scope,text(input.subjectId,200)));
        case '/v1/scene/profile': {
          const subject=core.authority.scene.subject(scope);
          return send(200,{subject,controls:subject?core.authority.scene.userModel.controls(subject.subjectId):null,
            entries:subject?core.authority.scene.userModel.listEntries(subject.subjectId,{purpose:'user'}):[]});
        }
        case '/v1/scene/profile-controls': {
          const subject=requireSubject(),controls=core.authority.scene.userModel.setControls(subject,object(input.patch),integer(input.expectedRevision),Date.now(),false);
          core.authority.scene.companion.refreshControls(subject);core.scene.invalidateModelConfiguration();return send(200,controls);
        }
        case '/v1/scene/profile-correct': {
          const subject=requireSubject(),correction=object(input.correction);
          const result=core.authority.scene.userModel.correctEntry(subject,text(input.id,200),{...correction,claim:text(correction.claim,1000)},Date.now(),false);
          core.authority.scene.companion.refreshControls(subject);core.scene.invalidateModelConfiguration();return send(200,result);
        }
        case '/v1/scene/profile-delete': {
          const subject=requireSubject();core.authority.scene.userModel.deleteEntry(subject,text(input.id,200),Date.now(),false);
          core.authority.scene.companion.refreshControls(subject);core.scene.invalidateModelConfiguration();return send(200,{status:'deleted'});
        }
        case '/v1/scene/companion-status': return send(200,core.scene.companion.status(scope,text(input.characterId,200)));
        case '/v1/scene/contact-settings': return send(200,core.authority.scene.companion.setContactSettings(requireSubject(),object(input.settings),integer(input.expectedRevision)));
        case '/v1/scene/companion-busy': return send(200,core.authority.scene.companion.setBusyUntil(requireSubject(),input.busyUntilMs===null?null:integer(input.busyUntilMs),integer(input.expectedRevision)));
        case '/v1/scene/companion-poll': {
          if(input.trigger!=='event'&&input.trigger!=='scheduled')throw new Error('invalid_companion_trigger');
          return send(200,await core.scene.companionPoll(scope,text(input.characterId,200),input.trigger,config));
        }
        case '/v1/scene/companion-claim': return send(200,core.scene.companion.claim(scope,text(input.characterId,200),text(input.deliveryId,200),'sillytavern'));
        case '/v1/scene/companion-receipt': {
          const value=object(input.outcome);
          if(!['sent','failed','unknown'].includes(String(value.status)))throw new Error('invalid_companion_receipt');
          const outcome=value.status==='sent'?{status:'sent' as const,hostMessageId:text(value.hostMessageId,200)}:{status:value.status as 'failed'|'unknown',code:text(value.code,200)};
          return send(200,await core.scene.companionReceipt(scope,text(input.characterId,200),text(input.deliveryId,200),text(input.claimToken,200),outcome,config));
        }
        case '/v1/scene/companion-reconcile': {
          const value=object(input.outcome);
          if(value.status!=='sent'&&value.status!=='failed')throw new Error('invalid_companion_receipt');
          const outcome=value.status==='sent'?{status:'sent' as const,hostMessageId:text(value.hostMessageId,200)}:{status:'failed' as const,code:text(value.code,200)};
          return send(200,await core.scene.reconcileCompanion(scope,text(input.characterId,200),text(input.deliveryId,200),outcome,config));
        }
        case '/v1/scene/resources': return send(200,core.scene.resources(scope));
        case '/v1/scene/resources-configure': return send(200,core.scene.configureResources(scope,{
          maxActive:integer(input.maxActive),priorityIds:input.priorityIds as string[],expectedRevision:integer(input.expectedRevision)}));
        case '/v1/scene/initialization-provenance': return send(200,core.authority.scene.initialization.provenance(scope));
        case '/v1/scene/initialization-refresh-preview': return send(200,core.authority.scene.initialization.previewRefresh(scope,input.sources));
        case '/v1/scene/initialization-refresh': return send(200,core.authority.scene.initialization.refresh(scope,input.sources,
          {expectedVersion:integer(input.expectedVersion),previewId:text(input.previewId,200),operationId:text(input.operationId,200)}));
        case '/v1/scene/initialization-preview': return send(200,await core.scene.previewInitialization(scope,input.sources as import('./scene/initialization.ts').InitializationSource[],config));
        case '/v1/scene/initialization-apply': return send(200,core.authority.scene.initialization.apply(scope,
          input.candidate as import('./scene/initialization.ts').InitializationCandidate,input.sources as import('./scene/initialization.ts').InitializationSource[],
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
          return send(200,{...dashboard,directorTodos,skippedStages:skipped,emotionScheduling:scheduling?{budget:scheduling.budget,pendingTotal:scheduling.pendingTotal,backgroundError:scheduling.backgroundError,
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
  const root = fileURLToPath(new URL('../', import.meta.url));
  const privateDirectory = process.env.XLDB_PRIVATE_DIR ?? 'D:/XLDB-private';
  fs.mkdirSync(privateDirectory, {recursive:true});
  const tokenPath = path.join(privateDirectory, 'local-token.txt');
  if (!fs.existsSync(tokenPath)) fs.writeFileSync(tokenPath, randomBytes(32).toString('hex'), {mode:0o600});
  const token = fs.readFileSync(tokenPath, 'utf8').trim();
  if (token.length < 32) throw new Error('Local token must contain at least 32 characters');
  const dataDirectory=process.env.XLDB_DATA_DIR??path.join(root,'.local/data');
  const authority = new Authority(path.join(dataDirectory,'authority/xldb.sqlite'));
  const retrieval = new Retrieval(path.join(dataDirectory,'indexes'));
  const core = new Core(authority, retrieval);
  await core.scene.clearPendingIndexes();
  const origins = (process.env.XLDB_ALLOWED_ORIGINS ?? 'http://localhost:11451,http://127.0.0.1:11451,http://localhost:8000,http://127.0.0.1:8000').split(',');
  const stop = () => server.close(() => { authority.close(); });
  const server = createServer(core, {token,configPath:path.join(privateDirectory,'config.json'),origins,onShutdown:stop});
  const port = Number(process.env.XLDB_PORT ?? 4318);
  server.listen(port, '127.0.0.1', () => console.log(`XLDB ready at http://127.0.0.1:${port}; token file: ${tokenPath}`));
  server.on('error', () => { authority.close(); console.error('XLDB could not bind its local port'); process.exitCode=1; });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

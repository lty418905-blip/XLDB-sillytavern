import type { DatabaseSync } from 'node:sqlite';
import {PersonalWeightsStore} from '../companion/personal-weights.ts';
import {PersonalLearning} from '../companion/personal-learning.ts';
import {createHash} from 'node:crypto';
import { createEmotion, advanceEmotion, emotionAt, emotionSummary, emotionSettingsOf, validateEmotionState } from '../emotion/openher.ts';
import type { EmotionState } from '../emotion/openher.ts';
import { foldRelationships, relationshipAnchor as foldedRelationshipAnchor, validateRelationships } from '../emotion/relationships.ts';
import type { FoldedRelationship } from '../emotion/relationships.ts';
import { scopeKey } from '../core/types.ts';
import type { Preference } from '../core/store.ts';
import type { Memory, MemorySnapshot, Access } from '../memory/access.ts';
import { projectMemories } from '../memory/access.ts';
import {retentionSnapshot} from '../memory/retention.ts';
import { emotionIdentitySeed, npcScope } from './types.ts';
import type { SceneScope, SceneRoster, SceneMessage, SceneSource, SceneState, SceneAnalysis, SceneWriteGuard } from './types.ts';
import {foldWorldState,projectWorldState} from './world-state.ts';
import type {WorldSettings,WorldSourceEffects} from './world-state.ts';
import {SceneLifecycle} from './lifecycle.ts';
import {Processing} from './processing.ts';
import {SceneTransfer} from './transfer.ts';
import {SceneInteractions} from './interaction.ts';
import {SceneDirector} from './director.ts';
import {Commitments,validateCommitmentOperations} from '../commitments/index.ts';
import {contactRestrictionWindow} from '../commitments/index.ts';
import {absenceExplanationTimeline} from '../emotion/absence-explanation.ts';
import {projectContactAffect,projectContactEmotion} from '../emotion/contact-affect.ts';
import type {ContactOutgoing} from '../emotion/contact-affect.ts';
import {relationshipAuxiliaryContext} from '../companion/relationship-context.ts';
import type {CommitmentCandidate,CommitmentMode,ValidatedCommitmentOperation} from '../commitments/types.ts';
import {NpcResourceController} from './resources.ts';
import {SceneInitialization} from './initialization.ts';
import {UserModelStore,decodeProfileCandidates} from '../user-model/index.ts';
import type {ProfileCandidate} from '../user-model/types.ts';
import {CompanionStore} from '../companion/index.ts';
import {PhysiologyStore} from '../common/physiology.ts';
import {GeographyStore} from '../common/geography.ts';
import {CompanionPresets} from '../companion/presets.ts';
import {RelationshipAssessmentStore} from '../companion/relationship-assessment.ts';
import {SceneCalendarStore} from './calendar-store.ts';
import {initialStorySettings} from './story-initial-clock.ts';
import type {RelationshipAssessmentInput,RelationshipCorrection} from '../companion/relationship-assessment.ts';

export interface SceneSubjectBinding {host:'agent'|'sillytavern';baseScope:SceneScope;subjectId:string;bindingId:string;createdAtMs:number}

/** World sources and all NPC projections share the existing SQLite transaction. */
export class SceneAuthority {
  private db: DatabaseSync;
  private emotionReplayCache=new Map<string,EmotionState>();
  private savepointSequence=0;
  readonly lifecycle:SceneLifecycle;
  readonly processing:Processing;
  readonly transfer:SceneTransfer;
  readonly interactions:SceneInteractions;
  readonly director:SceneDirector;
  readonly commitments:Commitments;
  readonly npcResources:NpcResourceController;
  readonly initialization:SceneInitialization;
  readonly userModel:UserModelStore;
  readonly companion:CompanionStore;
  readonly relationshipAssessments:RelationshipAssessmentStore;
  readonly calendar:SceneCalendarStore;
  readonly personalWeights:PersonalWeightsStore;
  readonly personalLearning:PersonalLearning;
  personalModelIdentity='';
  readonly physiology:PhysiologyStore;
  readonly geography:GeographyStore;
  readonly presets:CompanionPresets;
  constructor(db: DatabaseSync, migrateEmotionStates = true) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS scene_worlds (
      key TEXT PRIMARY KEY, scope TEXT NOT NULL, roster TEXT NOT NULL, version INTEGER NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS scene_sources (
      scope TEXT NOT NULL REFERENCES scene_worlds(key), id TEXT NOT NULL, revision INTEGER NOT NULL,
      message TEXT NOT NULL, observed INTEGER NOT NULL, status TEXT NOT NULL, processing TEXT NOT NULL,
      analysis TEXT, PRIMARY KEY(scope,id));
      CREATE TABLE IF NOT EXISTS scene_controls (
      scope TEXT NOT NULL REFERENCES scene_worlds(key), character TEXT NOT NULL, id TEXT NOT NULL,
      revision INTEGER NOT NULL, access TEXT NOT NULL, PRIMARY KEY(scope,character,id,revision));
      CREATE TABLE IF NOT EXISTS scene_preference_controls (
      scope TEXT NOT NULL REFERENCES scene_worlds(key), character TEXT NOT NULL, id TEXT NOT NULL,
      body TEXT NOT NULL, PRIMARY KEY(scope,character,id));
      CREATE TABLE IF NOT EXISTS scene_world_settings (
      scope TEXT PRIMARY KEY REFERENCES scene_worlds(key), settings TEXT NOT NULL, clock_floor INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS scene_write_operations (
      scope TEXT NOT NULL, id TEXT NOT NULL, request_hash TEXT NOT NULL, sources_hash TEXT NOT NULL,
      PRIMARY KEY(scope,id));
      CREATE TABLE IF NOT EXISTS scene_index_cleanup (
      scope TEXT NOT NULL, character TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY(scope,character));`);
    this.processing=new Processing(db);
    this.transfer=new SceneTransfer(db,this);
    this.interactions=new SceneInteractions(db,(scope,now)=>this.world(scope,undefined,now));
    this.npcResources=new NpcResourceController(db);
    this.initialization=new SceneInitialization(db,this);
    this.director=new SceneDirector(db);
    this.commitments=new Commitments(db);
    this.calendar=new SceneCalendarStore(db,this);
    this.userModel=new UserModelStore(db);
    this.companion=new CompanionStore(db);
    this.relationshipAssessments=new RelationshipAssessmentStore(db);
    this.personalWeights=new PersonalWeightsStore(db);
    this.personalLearning=new PersonalLearning(db,this.personalWeights);
    this.geography=new GeographyStore(db,{
      state:scope=>this.state(scope),modeOf:scope=>this.interactions.modeOf(scope),fullRoleplay:scope=>this.interactions.isTavernRoleplay(scope),transaction:action=>this.transaction(action),
      checkpoint:(scope,reason)=>{this.lifecycle.checkpoint(scope,reason,{automatic:true});},bump:scope=>this.bump(scope),
    });
    this.physiology=new PhysiologyStore(db,{
      state:scope=>this.state(scope),modeOf:scope=>this.interactions.modeOf(scope),fullRoleplay:scope=>this.interactions.isTavernRoleplay(scope),
      clock:(scope,now)=>{const clock=this.interactions.clock(scope,now);return {...clock,timeMs:typeof clock.timeMs==='number'?clock.timeMs:null};},
      transaction:action=>this.transaction(action),
      checkpoint:(scope,reason)=>{this.lifecycle.checkpoint(scope,reason,{automatic:true});},
      bump:scope=>this.bump(scope),
    });
    this.presets=new CompanionPresets(db,{
      state:scope=>this.state(scope),
      configure:(scope,roster,now)=>this.configure(scope,roster,now,false),
      transaction:action=>this.transaction(action),
    });
    this.lifecycle=new SceneLifecycle(db,scope=>{
      this.rebuildEmotionStates(scope);
      this.rebuildDerived(scope);
      this.director.invalidate(scope);
    });
    if(migrateEmotionStates)this.migrateEmotionStates();
  }

  state(scope: SceneScope, includeEmotionStates = false): SceneState {
    const row = this.db.prepare('SELECT roster,version,created FROM scene_worlds WHERE key=?').get(scopeKey(scope)) as
      {roster:string;version:number;created:number} | undefined;
    if (!row) return {scope, version:0, createdAtMs:0, roster:{characters:[]}, sources:[]};
    const sources = this.db.prepare(`SELECT message,revision,observed,status,processing,${includeEmotionStates?'analysis':"json_remove(analysis,'$.emotionStates') AS analysis"} FROM scene_sources WHERE scope=? ORDER BY rowid`)
      .all(scopeKey(scope)) as {message:string;revision:number;observed:number;status:SceneSource['status'];processing:SceneSource['processing'];analysis:string|null}[];
    return {scope, version:row.version, createdAtMs:row.created, roster:JSON.parse(row.roster), sources:sources.map(source => ({
      ...JSON.parse(source.message), revision:source.revision, observedAtMs:source.observed, status:source.status,
      processing:source.processing, analysis:source.analysis ? JSON.parse(source.analysis) : null,
    }))};
  }

  /** Explicitly bind the real user only for an active Agent/ST companion scope. */
  bindSubject(scope:SceneScope,subjectId:string,nowMs=Date.now()):SceneSubjectBinding {
    return this.transaction(()=>{
      const context=this.companionContext(scope);
      if(!context)throw new Error('invalid_companion_subject_scope');
      const previousSubject=this.subject(scope)?.subjectId;
      const bindingId=subjectBindingId(context.host,context.baseScope);
      const binding=this.userModel.bindSubject(context.host,bindingId,subjectId,nowMs);
      if(context.host==='agent')this.geography.rebindCompanionLocation(scope,previousSubject??null,binding.subjectId);
      if(previousSubject!==binding.subjectId){
        this.relationshipAssessments.clearModels(scope);
        if(this.state(scope).version>0)this.bump(scope);
      }
      this.rebuildDerived(scope,nowMs);
      return {...context,bindingId:binding.bindingId,subjectId:binding.subjectId,createdAtMs:binding.createdAtMs};
    });
  }

  subject(scope:SceneScope):SceneSubjectBinding|null {
    const context=this.companionContext(scope);if(!context)return null;
    const bindingId=subjectBindingId(context.host,context.baseScope);
    const binding=this.userModel.resolveSubject(context.host,bindingId);
    return binding?{...context,bindingId:binding.bindingId,subjectId:binding.subjectId,createdAtMs:binding.createdAtMs}:null;
  }

  recordSubjectActivity(scope:SceneScope,nowMs=Date.now()) {
    const binding=this.subject(scope);if(!binding)throw new Error('companion_subject_not_bound');
    return this.companion.recordUserActivity(binding.subjectId,nowMs);
  }

  correctRelationshipAssessment(scope:SceneScope,characterId:string,correction:RelationshipCorrection,expectedRevision:number) {
    return this.transaction(()=>{
      const input=this.relationshipAssessmentInput(scope,characterId);
      if(!input)throw new Error('relationship_assessment_disabled');
      const result=this.relationshipAssessments.correct(input,correction,expectedRevision);
      this.personalLearning.synchronizeCorrections(this.personalLearning.key(scope,input.subjectId,characterId),result);
      this.companion.cancelPendingForTarget(input.subjectId,this.companionTarget(scope,characterId));
      return result;
    });
  }

  relationshipAssessmentInput(scope:SceneScope,characterId:string,nowMs=Date.now()):RelationshipAssessmentInput|null {
    const subject=this.subject(scope),state=this.state(scope);
    if(subject?.host!=='agent'||this.interactions.modeOf(scope)!=='companion')return null;
    if(!state.roster.characters.some(character=>character.id===characterId))throw new Error('invalid_scene_character');
    const controls=this.userModel.controls(subject.subjectId);
    if(!controls.profileLearningEnabled||!controls.personalizationEnabled)return null;
    const sources=state.sources.filter(source=>source.status==='accepted'&&source.processing==='ready'&&
      source.envelope.mode==='direct'&&source.envelope.targetId===characterId&&
      source.envelope.presentIds.length===1&&source.envelope.presentIds[0]===characterId&&
      (source.role==='user'||source.role==='assistant'&&source.speakerId===characterId))
      .slice(-12).map(source=>({id:source.id,revision:source.revision,text:source.text,role:source.role,
        acceptedAtMs:source.acceptedAtMs}));
    const projection=this.contactEmotionProjection(scope,characterId,nowMs,state);
    const options={characterId,sessionId:scope.sessionId,nowMs,advanced:false} as const;
    const replyEntries=this.userModel.listEntries(subject.subjectId,{purpose:'strategy',taskPurpose:'reply',...options});
    const proactiveIds=new Set(this.userModel.listEntries(subject.subjectId,
      {purpose:'proactive',taskPurpose:'proactive',...options}).map(entry=>entry.id));
    const profileEntries=replyEntries.filter(entry=>proactiveIds.has(entry.id));
    const commitments=this.commitments.list(scope,{readerId:characterId,status:'active',mode:'companion'});
    const contactWindowState=this.commitments.listActiveContactRestrictions(scope,{obligorId:characterId,readerId:characterId})
      .flatMap(record=>{const window=contactRestrictionWindow(record,nowMs);
        return window?[`${window.commitmentId}@${window.revision}:${window.level}:${window.key}`]:[];});
    const auxiliaryContext=relationshipAuxiliaryContext({nowMs,timeZone:this.interactions.clock(scope).timeZone??'UTC',
      affect:projection.affect,profileEntries,commitments,emotion:projection.emotion,contactWindowState});
    return {scope,subjectId:subject.subjectId,characterId,sourceVersion:state.version,controlsRevision:controls.revision,sources,
      personalParameterVersion:this.personalWeights.version(this.personalLearning.key(scope,subject.subjectId,characterId),'relationship',this.personalModelIdentity),
      auxiliaryContext};
  }

  markSubjectActivityReady(scope:SceneScope,activityRevision:number,nowMs=Date.now()) {
    const binding=this.subject(scope);if(!binding)throw new Error('companion_subject_not_bound');
    return this.companion.markSemanticReady(binding.subjectId,activityRevision,nowMs);
  }

  companionTarget(scope:SceneScope,actorId:string):string {
    if(!this.subject(scope))throw new Error('companion_subject_not_bound');
    if(!this.state(scope).roster.characters.some(character=>character.id===actorId))throw new Error('invalid_scene_character');
    return companionTargetId(scope,actorId);
  }

  /** Needed after interaction inheritance, which occurs after lifecycle fork materialization. */
  refreshDerived(scope:SceneScope,nowMs=Date.now()):void {this.transaction(()=>this.rebuildDerived(scope,nowMs));}

  configure(scope: SceneScope, roster: SceneRoster, now = Date.now(), captureCheckpoint=true) {
    return this.transaction(() => {
      const state = this.state(scope);
      if (state.version && JSON.stringify(state.roster) === JSON.stringify(roster)) return {version:state.version,roster,
        needsProcessing:state.sources.some(source=>source.status==='accepted'&&source.processing!=='ready')};
      const ids=new Set(roster.characters.map(character=>character.id));
      if (state.sources.some(source=>source.status!=='deleted' && [source.envelope.targetId,...source.envelope.presentIds,...(source.speakerId?[source.speakerId]:[])].some(id=>!ids.has(id)))) throw new Error('invalid_scene_character_in_use');
      if(state.version&&captureCheckpoint)this.lifecycle.checkpoint(scope,'角色配置变更',{automatic:true});
      if(state.version)this.processing.clearScope(scope);
      this.db.prepare(`INSERT INTO scene_worlds VALUES(?,?,?,1,?)
        ON CONFLICT(key) DO UPDATE SET roster=excluded.roster,version=scene_worlds.version+1`)
        .run(scopeKey(scope), JSON.stringify(scope), JSON.stringify(roster), now);
      this.relationshipAssessments.clearModels(scope);
      this.invalidateConfigurationChanges(scope,state,roster);
      const worldSettings=this.worldSettings(scope);
      if(worldSettings){
        const updated={...worldSettings,actorLabels:Object.fromEntries(roster.characters.map(actor=>[actor.id,[actor.name,...actor.aliases]]))};
        foldWorldState(updated,[]);
        if(JSON.stringify(updated)!==JSON.stringify(worldSettings)){
          this.db.prepare('UPDATE scene_world_settings SET settings=? WHERE scope=?').run(JSON.stringify(updated),scopeKey(scope));
          this.markAllPending(scope);
        }
      }
      this.rebuildDerived(scope);
      const next=this.state(scope);
      return {version:next.version,roster,needsProcessing:next.sources.some(source=>source.status==='accepted'&&source.processing!=='ready')};
    });
  }

  /** Accepted raw text is durable independently of whether background analysis succeeds. */
  reconcile(scope: SceneScope, messages: SceneMessage[], replace = true, now = Date.now(), guard?:SceneWriteGuard) {
    return this.transaction(() => {
      const state = this.state(scope);
      if (!state.version) throw new Error('invalid_scene_not_configured');
      if (new Set(messages.map(message => message.id)).size !== messages.length) throw new Error('duplicate_message_id');
      const requestHash=createHash('sha256').update(JSON.stringify([messages,replace,guard?.expectedVersion,guard?.reconfirmIds??[]])).digest('hex');
      if(guard){
        if(!Number.isSafeInteger(guard.expectedVersion)||guard.expectedVersion<0||!guard.operationId||guard.operationId.length>200)throw new Error('invalid_scene_operation');
        const previous=this.db.prepare('SELECT request_hash,sources_hash FROM scene_write_operations WHERE scope=? AND id=?')
          .get(scopeKey(scope),guard.operationId) as {request_hash:string;sources_hash:string}|undefined;
        if(previous){
          if(previous.request_hash!==requestHash)throw new Error('invalid_scene_operation');
          if(previous.sources_hash!==sourcesHash(state))throw new Error('context_changed_retry');
          return {removed:0,changed:false,duplicate:true,...this.syncState(scope)};
        }
        if(state.version!==guard.expectedVersion)throw new Error('context_changed_retry');
      }
      let changed = false;
      let userActivityChanged = false;
      let removed = 0;
      const causalChanges:{index:number;characters:Set<string>}[]=[];
      const deletedSourceIds = new Set(state.sources.filter(source=>source.status==='deleted').map(source=>source.id));
      const incoming = new Map(messages.map(message => [message.id,message]));
      const changing=messages.some(message=>guard?.reconfirmIds?.includes(message.id)||!state.sources.some(source=>source.id===message.id&&sameContent(source,message)))
        || (replace&&state.sources.some(source=>source.status!=='deleted'&&!incoming.has(source.id)));
      if(changing)this.lifecycle.checkpoint(scope,'正文接受、编辑或删除',{automatic:true});
      for (const message of messages) {
        const previous = state.sources.find(source => source.id === message.id);
        if (previous?.status === 'deleted') throw new Error('invalid_scene_deleted_source');
        const reconfirm=guard?.reconfirmIds?.includes(message.id)===true;
        if (previous && sameContent(previous,message) && !reconfirm) continue;
        if(previous&&(message.revision<previous.revision||message.revision>previous.revision+1))throw new Error('context_changed_retry');
        const revision = previous ? previous.revision + 1 : 1;
        const acceptedAtMs = previous?.acceptedAtMs ?? Math.min(message.acceptedAtMs,now);
        // Editing an existing source is an explicit user correction, not a replay of its old derivation.
        const replyTo=message.replyTo??previous?.replyTo;
        const acceptedTimeZone=previous?previous.acceptedTimeZone:(this.interactions.modeOf(scope)
          ?this.interactions.clock(scope).timeZone??'UTC':'UTC');
        const next: SceneMessage = {...message,revision,acceptedAtMs,acceptedTimeZone,
          dependencies:message.dependencies??previous?.dependencies??[],...(replyTo?{replyTo}:{})};
        if(replyTo){
          const current=this.state(scope).sources,origin=current.find(source=>source.id===replyTo.id);
          if(next.role!=='assistant'||!origin||origin.status!=='accepted'||origin.revision!==replyTo.revision||origin.id===next.id||
            (previous&&current.indexOf(origin)>=current.findIndex(source=>source.id===previous.id)))throw new Error('invalid_scene_reply_to');
          if(!next.dependencies!.some(item=>item.id===replyTo.id&&item.revision===replyTo.revision))next.dependencies=[...next.dependencies!,replyTo];
        }
        if(previous){
          this.processing.clearSources(scope,[previous.id]);
          const characters=new Set([
            ...Object.keys(previous.analysis?.characters??{}),message.envelope.targetId,...message.envelope.presentIds,
            ...(message.speakerId?[message.speakerId]:[]),
          ]);
          causalChanges.push({index:state.sources.indexOf(previous),characters});
        }
        const retained=previous?.analysis?withoutUserModelCandidates(withoutEmotionStates({...previous.analysis,plan:null,controlRevision:previous.analysis.controlRevision??previous.revision})):null;
        this.db.prepare(`INSERT INTO scene_sources VALUES(?,?,?,?,?,'accepted','pending',?)
          ON CONFLICT(scope,id) DO UPDATE SET revision=excluded.revision,message=excluded.message,
          observed=excluded.observed,status='accepted',processing='pending',analysis=excluded.analysis`)
          .run(scopeKey(scope),next.id,revision,JSON.stringify(next),now,retained?JSON.stringify(retained):null);
        if(next.role==='user')userActivityChanged=true;
        changed = true;
      }
      if (replace) for (const source of state.sources) {
        if (source.status === 'deleted' || incoming.has(source.id)) continue;
        this.processing.clearSources(scope,[source.id]);
        causalChanges.push({index:state.sources.indexOf(source),characters:new Set(Object.keys(source.analysis?.characters??{}))});
        const erased = {...source,text:'',dependencies:[],revision:source.revision+1};
        delete (erased as Partial<SceneSource>).analysis;
        this.db.prepare("UPDATE scene_sources SET revision=revision+1,message=?,observed=?,status='deleted',processing='ready',analysis=NULL WHERE scope=? AND id=?")
          .run(JSON.stringify(erased),now,scopeKey(scope),source.id);
        if(source.id.startsWith('proactive:')&&source.role==='assistant'&&source.speakerId){
          const binding=this.subject(scope);
          if(binding)this.companion.redactDeliveryBody(source.id.slice('proactive:'.length),binding.subjectId,
            this.companionTarget(scope,source.speakerId));
        }
        const preferences=this.db.prepare('SELECT character,id FROM scene_preference_controls WHERE scope=?').all(scopeKey(scope)) as {character:string;id:string}[];
        for(const preference of preferences)if(preferenceSourceId(preference.id)===source.id)this.db.prepare('DELETE FROM scene_preference_controls WHERE scope=? AND character=? AND id=?').run(scopeKey(scope),preference.character,preference.id);
        deletedSourceIds.add(source.id);
        changed = true; removed++;
      }
      this.lifecycle.redactUnsafeCheckpoints(scope, deletedSourceIds);
      if (changed) {
        const dependentChanges=this.invalidateDependents(scope);
        this.invalidateCausalSuffix(scope,[...causalChanges,...dependentChanges]);
        this.bump(scope);
        if(userActivityChanged&&this.subject(scope))this.recordSubjectActivity(scope,now);
        this.rebuildDerived(scope);
      }
      const next = this.state(scope);
      if(removed)for(const character of state.roster.characters)this.db.prepare('INSERT OR REPLACE INTO scene_index_cleanup VALUES(?,?,?)').run(scopeKey(scope),character.id,next.version);
      if(guard?.reconfirmIds?.some(id=>next.sources.find(source=>source.id===id)?.status!=='accepted'))throw new Error('invalid_scene_dependencies');
      if(guard)this.db.prepare('INSERT INTO scene_write_operations VALUES(?,?,?,?)').run(scopeKey(scope),guard.operationId,requestHash,sourcesHash(next));
      return {removed,changed,duplicate:false,...this.syncState(scope)};
    });
  }

  syncState(scope:SceneScope) {
    const state=this.state(scope);
    return {version:state.version,needsReview:state.sources.filter(source=>source.status==='needs_review').map(source=>source.id),
      bindings:state.sources.map(source=>({id:source.id,revision:source.revision,status:source.status,dependencies:source.dependencies??[]}))};
  }
  pendingIndexCleanup(scope:SceneScope) {
    return this.db.prepare('SELECT character,version FROM scene_index_cleanup WHERE scope=?').all(scopeKey(scope)) as {character:string;version:number}[];
  }
  /** Recomputing an older degraded source must also discard analyses based on its old projection. */
  invalidateAfterDegraded(scope:SceneScope,sourceId:string,revision:number):void {
    this.transaction(()=>{
      const accepted=this.state(scope).sources.filter(source=>source.status==='accepted');
      const index=accepted.findIndex(source=>source.id===sourceId&&source.revision===revision&&source.analysis?.skippedStages?.length);
      if(index<0)throw new Error('context_changed_retry');
      for(const source of accepted.slice(index+1)){
        const analysis=source.analysis?withoutEmotionStates(source.analysis):null;
        const next=analysis&&source.envelope.mode==='scene'?{...analysis,plan:null}:analysis;
        this.db.prepare("UPDATE scene_sources SET processing='pending',analysis=? WHERE scope=? AND id=?")
          .run(next?JSON.stringify(next):null,scopeKey(scope),source.id);
        this.processing.clearSources(scope,[source.id]);
      }
      if(index+1<accepted.length){this.rebuildEmotionStates(scope);this.bump(scope);this.rebuildDerived(scope);}
    });
  }
  indexCleanupScopes():SceneScope[] {
    const rows=this.db.prepare('SELECT DISTINCT scope FROM scene_index_cleanup').all() as {scope:string}[];
    return rows.map(row=>{const [worldId,sessionId,branchId,characterId]=JSON.parse(row.scope);return {worldId,sessionId,branchId,characterId};});
  }
  finishIndexCleanup(scope:SceneScope,character:string,version:number) {
    this.db.prepare('DELETE FROM scene_index_cleanup WHERE scope=? AND character=? AND version=?').run(scopeKey(scope),character,version);
  }
  isOpen(){return this.db.isOpen;}

  deferredEmotionScopes():SceneScope[] {
    const rows=this.db.prepare("SELECT DISTINCT scope FROM scene_sources WHERE status='accepted' AND processing='ready' AND json_array_length(json_extract(analysis,'$.emotionCandidateReadyIds'))>0")
      .all() as {scope:string}[];
    return rows.map(row=>{
      const [worldId,sessionId,branchId,characterId]=JSON.parse(row.scope);
      return {worldId,sessionId,branchId,characterId};
    });
  }

  /** Consume one background candidate, or all prepared history for one foreground NPC. */
  completeDeferredEmotion(scope:SceneScope,foregroundCharacterId?:string):boolean {
    return this.transaction(()=>{
      const state=this.state(scope),blocked=new Set<string>();
      let completed=false;
      for(const source of state.sources){
        if(source.status!=='accepted'||source.processing!=='ready'||!source.analysis?.plan)continue;
        for(const id of source.analysis.emotionPendingIds??[]){
          if(foregroundCharacterId&&id!==foregroundCharacterId)continue;
          if(blocked.has(id))continue;
          if(!source.analysis.emotionCandidateReadyIds?.includes(id)){
            blocked.add(id);continue;
          }
          if(source.analysis.skippedStages?.some(item=>item.stage==='emotion'&&item.characterId===id)){
            blocked.add(id);continue;
          }
          if(!source.analysis.characters[id])throw new Error('invalid_scene_emotion_schedule');
          const remaining=source.analysis.emotionPendingIds!.filter(item=>item!==id);
          const ready=source.analysis.emotionCandidateReadyIds.filter(item=>item!==id);
          this.db.prepare("UPDATE scene_sources SET analysis=json_set(analysis,'$.emotionPendingIds',json(?),'$.emotionCandidateReadyIds',json(?)) WHERE scope=? AND id=? AND revision=? AND status='accepted' AND processing='ready'")
            .run(JSON.stringify(remaining),JSON.stringify(ready),scopeKey(scope),source.id,source.revision);
          completed=true;
          if(!foregroundCharacterId){this.rebuildEmotionStates(scope,id);return true;}
        }
      }
      if(completed)this.rebuildEmotionStates(scope,foregroundCharacterId);
      return completed;
    });
  }

  /** Install a real model candidate for a pre-upgrade placeholder after explicit processing. */
  recordLegacyEmotionCandidate(scope:SceneScope,expectedVersion:number,sourceId:string,revision:number,
    characterId:string,result:import('../core/models.ts').SceneEmotionResult):void {
    this.transaction(()=>{
      const state=this.state(scope,true);
      if(state.version!==expectedVersion)throw new Error('context_changed_retry');
      const source=state.sources.find(item=>item.id===sourceId&&item.revision===revision&&item.status==='accepted'
        &&item.processing==='ready'&&item.analysis?.plan&&item.analysis.emotionPendingIds?.includes(characterId)
        &&!item.analysis.emotionCandidateReadyIds?.includes(characterId));
      if(!source?.analysis?.plan||!source.analysis.characters[characterId])throw new Error('context_changed_retry');
      const relationships=validateRelationships(result.relationships,
        relationshipValidationContext(source,source.analysis.plan,state.roster,characterId));
      const prior=source.analysis.characters[characterId]!;
      const analysis={...source.analysis,characters:{...source.analysis.characters,
        [characterId]:{...prior,emotion:{...result.emotion,stableRelationDelta:{}},
          ...(relationships.length?{relationships}:{})}},
        emotionCandidateReadyIds:[...(source.analysis.emotionCandidateReadyIds??[]),characterId]};
      this.db.prepare("UPDATE scene_sources SET analysis=? WHERE scope=? AND id=? AND revision=? AND status='accepted' AND processing='ready'")
        .run(JSON.stringify(analysis),scopeKey(scope),sourceId,revision);
    });
  }

  commit(scope: SceneScope, expectedVersion: number, results: {id:string;revision:number;analysis:SceneAnalysis}[]) {
    return this.transaction(() => {
      const state = this.state(scope);
      if (state.version !== expectedVersion) throw new Error('context_changed_retry');
      const prepared=results.map(result=>{
        const source=state.sources.find(item=>item.id===result.id);
        if(!source||source.status!=='accepted'||source.revision!==result.revision)throw new Error('context_changed_retry');
        return {...result,analysis:localAnalysis(result.analysis,source)};
      });
      const settings=this.worldSettings(scope);
      const effective=[...state.sources];
      for(const [index,source] of state.sources.entries()){
        const result=prepared.find(item=>item.id===source.id);if(!result)continue;
        effective[index]={...source,processing:'ready',analysis:result.analysis};
        result.analysis=validateCommitmentAnalysis(source,result.analysis,state.roster,{
          realClockTimeMs:source.acceptedAtMs,
          // Replay this source's accepted story effects; never consult current time.
          storyClockTimeMs:settings?.mode==='story'?this.emotionTime(scope,effective.slice(0,index+1),source.acceptedAtMs):undefined,
          timeZone:source.acceptedTimeZone,
        });
        effective[index]={...source,processing:'ready',analysis:result.analysis};
      }
      const windowSelections=new Map<string,Set<string>>();
      for(const source of effective){
        if(source.status!=='accepted'||source.processing!=='ready'||!source.analysis)continue;
        const schedule=source.analysis.emotionSchedule;
        const pending=source.analysis.emotionPendingIds??[];
        const ready=source.analysis.emotionCandidateReadyIds??[];
        if(pending.some(id=>!source.analysis!.characters[id]||!schedule?.deferredIds.includes(id)))
          throw new Error('invalid_scene_emotion_schedule');
        if(new Set(ready).size!==ready.length||ready.some(id=>!pending.includes(id)||
          source.analysis!.skippedStages?.some(item=>item.stage==='emotion'&&item.characterId===id)))
          throw new Error('invalid_scene_emotion_schedule');
        if(!schedule)continue;
        if(!schedule.windowId||new Set(schedule.eligibleIds).size!==schedule.eligibleIds.length||
          new Set(schedule.selectedIds).size!==schedule.selectedIds.length||new Set(schedule.forcedIds).size!==schedule.forcedIds.length||
          new Set(schedule.deferredIds).size!==schedule.deferredIds.length||
          schedule.selectedIds.some(id=>!schedule.eligibleIds.includes(id)||
            (schedule.deferredIds.includes(id)&&!source.analysis?.skippedStages?.some(item=>item.stage==='emotion'&&item.characterId===id)))||
          schedule.forcedIds.some(id=>!schedule.selectedIds.includes(id)))throw new Error('invalid_scene_emotion_schedule');
        const selected=windowSelections.get(schedule.windowId)??new Set<string>();
        for(const id of schedule.selectedIds)if(!schedule.forcedIds.includes(id))selected.add(id);
        if(selected.size>4)throw new Error('invalid_scene_emotion_budget');
        windowSelections.set(schedule.windowId,selected);
      }
      const acceptedResults=prepared;
      if(settings){
        const folded=foldWorldState(settings,this.worldSources(effective));
        if(folded.issues.length) throw new Error('invalid_world_'+folded.issues[0]!.code.replace(/^invalid_world_/,''));
      }
      for (const result of acceptedResults) {
        const source = state.sources.find(item => item.id === result.id);
        if (!source || source.status !== 'accepted' || source.revision !== result.revision) throw new Error('context_changed_retry');
        if (result.analysis.plan.unresolved.length) throw new Error('invalid_scene_unresolved');
        if(result.analysis.physiologyOperations!==undefined)
          result.analysis.physiologyOperations=this.physiology.validateStored(result.analysis.physiologyOperations,source,result.analysis.plan,state.roster);
        if(result.analysis.geographyOperations!==undefined)
          result.analysis.geographyOperations=this.geography.validateStored(result.analysis.geographyOperations,source,result.analysis.plan,state.roster);
        const allowedIds = new Set(result.analysis.plan.observations.flatMap(observation => observation.readers));
        for (const [characterId,analysis] of Object.entries(result.analysis.characters)) {
          if (!allowedIds.has(characterId) || !state.roster.characters.some(character => character.id === characterId)) throw new Error('invalid_scene_character');
          const quotes = result.analysis.plan.observations.filter(observation => observation.readers.includes(characterId)).map(observation => observation.quote);
          if (analysis.memories.some(memory => !quotes.some(quote => quote.includes(memory.detail)) ||
            memory.protectedFacts.some(fact => !quotes.some(quote => quote.includes(fact))) ||
            (memory.episode?.evidenceQuotes??[]).some(evidence=>!quotes.some(quote=>quote.includes(evidence))))) throw new Error('invalid_scene_memory_source');
          if (analysis.relationships !== undefined) analysis.relationships=validateRelationships(analysis.relationships,
            relationshipValidationContext(source,result.analysis.plan,state.roster,characterId));
        }
        this.migrateControls(scope,source,result.analysis);
        const dependencies=[...(source.dependencies??[])];
        for(const observation of result.analysis.plan.observations) for(const reference of observation.identityEvidence??[]) {
          const origin=state.sources.find(item=>item.id===reference.sourceId && item.status==='accepted' && item.revision===reference.revision);
          if(!origin || origin.id===source.id) throw new Error('invalid_scene_evidence');
          if(!dependencies.some(item=>item.id===origin.id)) dependencies.push({id:origin.id,revision:origin.revision});
        }
        const {analysis:_analysis,observedAtMs:_observed,status:_status,processing:_processing,...message}=source;
        this.db.prepare("UPDATE scene_sources SET processing='ready',analysis=?,message=? WHERE scope=? AND id=? AND revision=?")
          .run(JSON.stringify(result.analysis),JSON.stringify({...message,dependencies}),scopeKey(scope),result.id,result.revision);
      }
      if (acceptedResults.length) {
        this.rebuildEmotionStates(scope);
        this.bump(scope);
        this.rebuildDerived(scope);
        const next=this.state(scope),binding=this.subject(scope);
        if(binding&&next.sources.filter(source=>source.status==='accepted').every(source=>source.processing==='ready')){
          const activity=this.companion.activity(binding.subjectId);
          if(activity.semanticReadyRevision!==activity.revision)this.markSubjectActivityReady(scope,activity.revision);
        }
      }
      return this.state(scope).version;
    });
  }

  fail(scope: SceneScope, version: number, sourceIds?:readonly string[]) {
    this.transaction(() => {
      if (this.state(scope).version !== version) return;
      if(sourceIds?.length){
        const fail=this.db.prepare("UPDATE scene_sources SET processing='failed' WHERE scope=? AND id=? AND status='accepted' AND processing='pending'");
        for(const sourceId of new Set(sourceIds))fail.run(scopeKey(scope),sourceId);
      }else this.db.prepare("UPDATE scene_sources SET processing='failed' WHERE scope=? AND status='accepted' AND processing='pending'").run(scopeKey(scope));
    });
  }

  snapshot(scope: SceneScope, characterId: string, state = this.state(scope)): MemorySnapshot {
    if (!state.roster.characters.some(character => character.id === characterId)) throw new Error('invalid_scene_character');
    const roleScope = npcScope(scope,characterId);
    const sources = state.sources.filter(source => source.status === 'accepted' && source.processing === 'ready' && source.analysis);
    const controls = this.db.prepare('SELECT id,revision,access FROM scene_controls WHERE scope=? AND character=?').all(scopeKey(scope),characterId) as {id:string;revision:number;access:Access}[];
    const memories = new Map<string,Memory>();
    for (const source of sources) {
      const plan=source.analysis!.plan;
      if(!plan)continue;
      const observations = plan.observations.filter(observation => observation.readers.includes(characterId));
      const analysis = source.analysis!.characters[characterId];
      if (!analysis) continue;
      for (const [index,candidate] of analysis.memories.entries()) {
        const observation = observations.find(item => item.quote.includes(candidate.detail));
        if (!observation) continue;
        const id = `${source.id}:${characterId}#${index}`;
        const controlId=memoryControlId(source.id,characterId,candidate);
        const control = controls.find(control=>control.id===controlId&&control.revision===0) ?? controls.find(control => control.id === id && control.revision === source.revision);
        const access=control?.access??'clear';
        const rehearsed=candidate.retention?.cues.length?state.sources.slice(state.sources.indexOf(source)+1).filter(later=>
          later.status==='accepted'&&later.processing==='ready'&&later.analysis?.plan?.observations.some(item=>
            item.readers.includes(characterId)&&candidate.retention!.cues.some(cue=>item.quote.includes(cue)))).at(-1):undefined;
        const retentionSource=rehearsed??source;
        const retentionAtMs=this.emotionTime(scope,state.sources.slice(0,state.sources.indexOf(retentionSource)+1),retentionSource.acceptedAtMs);
        memories.set(id,{...candidate,id,scope:roleScope,status:'accepted',access,accessOverride:control!==undefined,retentionAtMs,
          source:{messageId:source.id,revision:source.revision,occurredAtMs:source.acceptedAtMs,knownAtMs:Math.max(source.acceptedAtMs,source.observedAtMs),
            author:{role:source.role,actorId:source.role==='user'?'player':source.automatic?'narrator':source.speakerId!},
            knowledge:{kind:observation.kind,...(source.role==='user'&&source.envelope.mode==='direct'
              ?{actorId:'player'}:observation.actorId?{actorId:observation.actorId}:{}),
              observationId:observation.id,start:observation.start,end:observation.end}}});
      }
    }
    const references=this.transfer.projection(scope,characterId);
    for(const [id,memory] of references.memories)memories.set(id,memory);
    const messages=new Map<string,{revision:number;status:'accepted'|'deleted'}>(sources.map(source => [source.id,{revision:source.revision,status:'accepted' as const}]));
    for(const [id,message] of references.messages)messages.set(id,message);
    const replyParents=new Map<string,{assistantRevision:number;parentMessageId:string;parentRevision:number}>();
    for(const [index,assistant] of sources.entries()){
      if(assistant.role!=='assistant'||!assistant.replyTo)continue;
      const parent=sources.slice(0,index).find(candidate=>candidate.id===assistant.replyTo!.id&&
        candidate.revision===assistant.replyTo!.revision&&candidate.role==='user');
      if(parent)replyParents.set(assistant.id,{assistantRevision:assistant.revision,parentMessageId:parent.id,parentRevision:parent.revision});
    }
    const storyClock=this.worldSettings(scope)?.mode==='story'||this.interactions.frozenRoleplayTime(scope)!==undefined;
    return {scope:roleScope,version:state.version,messages,memories,
      ...(replyParents.size?{replyParents}:{}),
      ...(storyClock?{memoryTimeMs:this.emotionTime(scope,state.sources,Date.now())}:{})};
  }

  emotion(scope: SceneScope, characterId: string, now = Date.now(), state = this.state(scope)) {
    const character = state.roster.characters.find(character=>character.id===characterId);
    if (!character) throw new Error('invalid_scene_character');
    // The ordinary state read omits neural snapshots. Read them once and fingerprint
    // the actual role history, so unrelated world-version changes keep this replay.
    const rows=this.db.prepare("SELECT s.id,s.revision,j.value AS body FROM scene_sources s,json_each(s.analysis,'$.emotionStates') j WHERE s.scope=? AND s.status='accepted' AND s.processing='ready' AND j.key=?")
      .all(scopeKey(scope),characterId) as {id:string;revision:number;body:string}[];
    const storedBySource=new Map(rows.map(row=>[JSON.stringify([row.id,row.revision]),row.body]));
    const initialTime=this.emotionTime(scope,[],state.createdAtMs);
    const events: {stored:EmotionState|undefined;body:string|undefined;delta:import('../emotion/openher.ts').EmotionDelta;at:number|undefined}[]=[];
    for(const [index,source] of state.sources.entries()){
      if(source.status!=='accepted'||source.processing!=='ready')continue;
      const analysis=source.analysis?.characters[characterId];
      if(!analysis||source.analysis?.emotionPendingIds?.includes(characterId))continue;
      const stored=source.analysis?.emotionStates?.[characterId];
      const body=stored?JSON.stringify(stored):storedBySource.get(JSON.stringify([source.id,source.revision]));
      events.push({stored,body,delta:analysis.emotion,
        at:body===undefined?this.emotionTime(scope,state.sources.slice(0,index+1),source.acceptedAtMs):undefined});
    }
    const replayKey=createHash('sha256').update(JSON.stringify([scopeKey(scope),characterId,character.emotion,
      initialTime,events.map(event=>[event.body,event.body===undefined?event.delta:undefined,event.at])])).digest('hex');
    let emotion=this.emotionReplayCache.get(replayKey);
    if(!emotion){
      emotion=createEmotion(initialTime,character.emotion,emotionIdentitySeed(scope,characterId));
      for(const event of events)emotion=event.body!==undefined
        ?validateEmotionState(event.stored??JSON.parse(event.body))
        :advanceEmotion(emotion,event.delta,event.at!,character.emotion);
      this.emotionReplayCache.delete(replayKey);
      this.emotionReplayCache.set(replayKey,emotion);
      if(this.emotionReplayCache.size>64)this.emotionReplayCache.delete(this.emotionReplayCache.keys().next().value!);
    }
    const clock=this.interactions.modeOf(scope)?this.interactions.clock(scope,now):null;
    return emotionAt(emotion,this.emotionTime(scope,state.sources,now),character.emotion,
      clock===null?this.worldSettings(scope)?.mode==='story'?'UTC':null:clock.known?clock.timeZone:null);
  }

  /** Expression uses one explicit addressee, never the legacy global relation. */
  responseEmotion(scope:SceneScope,characterId:string,now=Date.now(),state=this.state(scope),targetId:string|null='player') {
    const emotion=this.emotion(scope,characterId,now,state);
    const relation=targetId===null?undefined:this.relationshipAnchor(scope,characterId,targetId,state);
    return {...emotion,stableRelations:relation?.relations??{depth:0,trust:0,valence:0}};
  }

  /** One source-bound contact projection shared by foreground, proactive, and relationship reads. */
  contactEmotionProjection(scope:SceneScope,characterId:string,nowMs:number,state=this.state(scope),
    currentReply:{sourceId:string;revision:number}|null=null){
    const base=this.responseEmotion(scope,characterId,nowMs,state);
    const subject=this.subject(scope);
    if(subject?.host!=='agent'||this.interactions.modeOf(scope)!=='companion')return {emotion:base,affect:null};
    const targetId=this.companionTarget(scope,characterId);
    const confirmed=this.companion.confirmedContactDeliveries(subject.subjectId,targetId);
    const confirmedById=new Map(confirmed.map(item=>[item.deliveryId,item]));
    const outgoing:ContactOutgoing[]=state.sources.flatMap((source,index)=>{
      if(source.status!=='accepted'||source.processing!=='ready'||source.role!=='assistant'||
        source.envelope.mode!=='direct'||source.envelope.targetId!==characterId||source.speakerId!==characterId)return [];
      const delivery=source.id.startsWith('proactive:')?confirmedById.get(source.id.slice('proactive:'.length)):undefined;
      return [{id:source.id,targetId:characterId,atMs:source.acceptedAtMs,body:source.text,kind:'accepted_assistant' as const,
        sequence:index,hostMessageId:delivery?.hostMessageId,
        responseExpectation:delivery?.replyTimingKnown===false?{expected:null,quote:null}:
          source.analysis?.contactResponseExpectation??{expected:null,quote:null},quietException:delivery?.quietException??false}];
    });
    outgoing.push(...confirmed.map((item,index)=>({id:item.deliveryId,targetId:characterId,atMs:item.confirmedSentAtMs,
      body:item.body,kind:'confirmed_proactive' as const,sequence:-confirmed.length+index,
      hostMessageId:item.hostMessageId,responseExpectation:{expected:null,quote:null},quietException:item.quietException})));
    const replies=state.sources.flatMap((source,index)=>source.status==='accepted'&&source.processing==='ready'&&source.role==='user'&&
      source.envelope.mode==='direct'&&source.envelope.targetId===characterId&&source.envelope.presentIds.length===1&&
      source.envelope.presentIds[0]===characterId?[{sourceId:source.id,revision:source.revision,targetId:characterId,
        acceptedAtMs:source.acceptedAtMs,sequence:index}]:[]);
    const replySource=currentReply?state.sources.find(source=>source.id===currentReply.sourceId&&source.revision===currentReply.revision):null;
    const currentExplanation=replySource?.analysis?.absenceExplanation?.kind==='return'
      ?replySource.analysis.absenceExplanation.quote:null;
    const affect=projectContactAffect({targetId:characterId,nowMs,outgoing,replies,
      explanations:absenceExplanationTimeline(state.sources,characterId),currentReply,currentExplanation,emotion:base});
    const actor=state.roster.characters.find(item=>item.id===characterId);
    return {emotion:projectContactEmotion(base,affect,actor?.emotion),affect};
  }

  /** Story metabolism follows accepted narrative time, not wall-clock waiting. */
  emotionTime(scope:SceneScope,sources:SceneSource[],fallbackMs:number):number {
    const settings=this.worldSettings(scope);
    if(!settings){
      const frozen=this.interactions.frozenRoleplayTime(scope);
      if(frozen!==undefined)return frozen;
    }
    if(settings?.mode!=='story')return fallbackMs;
    const folded=foldWorldState(settings,this.worldSources(sources));
    if(folded.issues.length)throw new Error('invalid_world_'+folded.issues[0]!.code.replace(/^invalid_world_/,''));
    return folded.state.timeMs;
  }

  preferences(scope: SceneScope, characterId: string, state = this.state(scope), currentReplySourceId?:string): Preference[] {
    const result = new Map<string,Preference>();
    const controls=this.db.prepare('SELECT id,body FROM scene_preference_controls WHERE scope=? AND character=?').all(scopeKey(scope),characterId) as {id:string;body:string}[];
    for (const source of state.sources) {
      if (source.status !== 'accepted' || source.processing !== 'ready') continue;
      for (const [i,preference] of (source.analysis?.characters[characterId]?.preferences ?? []).entries()) {
        if(preference.duration==='turn'&&source.id!==currentReplySourceId)continue;
        const control=controls.find(row=>row.id===preferenceControlId(source.id,preference));
        const override=control?JSON.parse(control.body):{};
        result.set(preference.category,{...preference,...override,id:`${source.id}:${characterId}:pref:${i}`,sourceId:source.id,revision:source.revision,enabled:override.enabled??true,corrected:override.text!==undefined});
      }
    }
    return [...result.values()];
  }

  /** Current source-backed relations from one NPC. Deleted, pending and stale source analyses do not participate. */
  relationships(scope:SceneScope,characterId:string,state=this.state(scope)):FoldedRelationship[] {
    const character=state.roster.characters.find(item=>item.id===characterId);
    if(!character) throw new Error('invalid_scene_character');
    return foldRelationships(state.sources,characterId,emotionSettingsOf(character.emotion).stableRelationRate);
  }

  relationshipAnchor(scope:SceneScope,characterId:string,targetId:string,state=this.state(scope)):FoldedRelationship|undefined {
    const character=state.roster.characters.find(item=>item.id===characterId);
    if(!character) throw new Error('invalid_scene_character');
    return foldedRelationshipAnchor(state.sources,characterId,targetId,emotionSettingsOf(character.emotion).stableRelationRate);
  }

  inspect(scope: SceneScope, characterId?: string, now = Date.now()) {
    const state = this.state(scope);
    const characters = state.roster.characters.filter(character => characterId === undefined || character.id === characterId);
    return {version:state.version,roster:state.roster,world:this.world(scope,undefined,now),worldSettings:this.worldSettings(scope),needsReview:state.sources.filter(source => source.status === 'needs_review').map(source => source.id),
      sources:state.sources.map(({analysis,...source}) => ({...source,observations:analysis?.plan?.observations ?? []})),
      views:characters.map(character => {
        const snapshot = retentionSnapshot(this.snapshot(scope,character.id,state),now);
        return {characterId:character.id,name:character.name,
          memories:projectMemories(snapshot,{scope:snapshot.scope,asOfMs:now,ids:[...snapshot.memories.keys()]}).memories,
          emotion:emotionSummary(this.responseEmotion(scope,character.id,now,state)),preferences:this.preferences(scope,character.id),
          relationships:this.relationships(scope,character.id,state)};
      })};
  }

  worldSettings(scope:SceneScope):WorldSettings|null {
    let settings=this.rawWorldSettings(scope);
    if(!settings&&this.interactions.isTavernRoleplay(scope)){
      const state=this.state(scope);
      if(state.version)settings=initialStorySettings(state,this.transfer.references(scope),this.interactions.get(scope,'sillytavern').timeZone);
    }
    return settings?this.initialization.mergeAssets(scope,settings):null;
  }

  private rawWorldSettings(scope:SceneScope):WorldSettings|null {
    const row=this.db.prepare('SELECT settings FROM scene_world_settings WHERE scope=?').get(scopeKey(scope)) as {settings:string}|undefined;
    return row?JSON.parse(row.settings):null;
  }

  configureWorld(scope:SceneScope,value:WorldSettings|null,captureCheckpoint=true) {
    return this.transaction(()=>{
      const state=this.state(scope);
      if(!state.version)throw new Error('invalid_scene_not_configured');
      this.interactions.assertWorldMode(scope,value?.mode??null);
      if(value){
        const known=new Set(['player',...state.roster.characters.map(actor=>actor.id)]);
        if(Object.keys(value.actorLabels).some(id=>!known.has(id)))throw new Error('invalid_world_actor');
        foldWorldState(value,[]);
      }
      if(JSON.stringify(this.rawWorldSettings(scope))===JSON.stringify(value))return {version:state.version};
      if(captureCheckpoint)this.lifecycle.checkpoint(scope,'世界初始设置变更',{automatic:true});
      this.processing.clearScope(scope);
      if(value)this.db.prepare('INSERT OR REPLACE INTO scene_world_settings VALUES(?,?,?)').run(scopeKey(scope),JSON.stringify(value),value.startTimeMs);
      else this.db.prepare('DELETE FROM scene_world_settings WHERE scope=?').run(scopeKey(scope));
      this.markAllPending(scope);
      this.bump(scope);
      this.rebuildDerived(scope);
      return {version:this.state(scope).version};
    });
  }

  world(scope:SceneScope,readerId?:string,now=Date.now(),state=this.state(scope)) {
    const settings=this.worldSettings(scope);
    if(!settings)return null;
    const row=this.db.prepare('SELECT clock_floor FROM scene_world_settings WHERE scope=?').get(scopeKey(scope)) as {clock_floor:number}|undefined;
    const folded=foldWorldState(settings,this.worldSources(state.sources),{nowMs:now,monotonicFloorMs:row?.clock_floor??settings.startTimeMs});
    if(settings.mode==='companion'&&row&&folded.state.timeMs>row.clock_floor)this.db.prepare('UPDATE scene_world_settings SET clock_floor=? WHERE scope=?').run(folded.state.timeMs,scopeKey(scope));
    return readerId===undefined?folded:projectWorldState(folded,readerId);
  }

  worldContext(scope:SceneScope,readerId:string,state=this.state(scope)) {
    const world=this.world(scope,readerId,Date.now(),state);
    return world?'\n脚本确认的当前世界状态（仅此角色可见；不得自行改算或补全未知余额）：'+JSON.stringify(world):'';
  }

  private worldSources(sources:SceneSource[]):WorldSourceEffects[] {
    return sources.filter(source=>source.status==='accepted'&&source.processing==='ready'&&source.analysis?.plan).map(source=>({
      sourceId:source.id,revision:source.revision,role:source.role,text:source.text,acceptedAtMs:source.acceptedAtMs,
      plan:source.analysis!.plan!,candidates:source.analysis!.worldEffects??[],
    }));
  }

  setAccess(scope: SceneScope, characterId: string, memoryId: string, access: Access) {
    if (!['clear','gist','feeling','anchor','hidden'].includes(access)) throw new Error('invalid_access');
    this.transaction(() => {
      const memory = this.snapshot(scope,characterId).memories.get(memoryId);
      if (!memory) throw new Error('record_not_found');
      if(memory.source.reference)throw new Error('invalid_reference_access_use_delete');
      this.lifecycle.checkpoint(scope,'记忆访问设置变更',{automatic:true});
      this.db.prepare('INSERT OR REPLACE INTO scene_controls VALUES(?,?,?,?,?)')
        .run(scopeKey(scope),characterId,memoryControlId(memory.source.messageId,characterId,memory),0,access);
      this.bump(scope);
    });
  }

  setPreference(scope:SceneScope,characterId:string,id:string,enabled:boolean,newText?:string) {
    if(typeof enabled!=='boolean'||(newText!==undefined&&(typeof newText!=='string'||!newText.trim()||newText.length>500)))throw new Error('invalid_preference');
    this.transaction(()=>{
      const preference=this.preferences(scope,characterId).find(item=>item.id===id);
      if(!preference)throw new Error('record_not_found');
      this.lifecycle.checkpoint(scope,'偏好设置变更',{automatic:true});
      const controlId=preferenceControlId(preference.sourceId,preference);
      const stored=this.db.prepare('SELECT body FROM scene_preference_controls WHERE scope=? AND character=? AND id=?').get(scopeKey(scope),characterId,controlId) as {body:string}|undefined;
      const previous=stored?JSON.parse(stored.body):{};
      this.db.prepare('INSERT OR REPLACE INTO scene_preference_controls VALUES(?,?,?,?)').run(scopeKey(scope),characterId,controlId,JSON.stringify({...previous,enabled,...(newText===undefined?{}:{text:newText})}));
      this.bump(scope);
    });
  }

  private invalidateDependents(scope: SceneScope) {
    const invalidated:{index:number;characters:Set<string>}[]=[];
    let changed = true;
    while (changed) {
      changed = false;
      const sources = this.state(scope).sources;
      for (const source of sources) {
        if (source.status !== 'accepted') continue;
        const valid = (source.dependencies ?? []).every(dependency => sources.some(origin => origin.id === dependency.id && origin.revision === dependency.revision && origin.status === 'accepted'));
        if (valid) continue;
        invalidated.push({index:sources.indexOf(source),characters:new Set(Object.keys(source.analysis?.characters??{}))});
        this.processing.clearSources(scope,[source.id]);
        this.db.prepare("UPDATE scene_sources SET status='needs_review',processing='failed',analysis=NULL WHERE scope=? AND id=?").run(scopeKey(scope),source.id);
        changed = true;
      }
    }
    return invalidated;
  }
  private companionContext(scope:SceneScope):{host:'agent'|'sillytavern';baseScope:SceneScope}|null {
    const row=this.db.prepare(`SELECT i.host,i.base_scope,i.active_mode,b.mode FROM scene_interaction_bindings b
      JOIN scene_interactions i ON i.owner=b.owner WHERE b.physical_key=?`).get(scopeKey(scope)) as
      {host:string;base_scope:string;active_mode:string;mode:string}|undefined;
    if(!row||row.mode!=='companion'||row.active_mode!=='companion'||(row.host!=='agent'&&row.host!=='sillytavern'))return null;
    return {host:row.host,baseScope:JSON.parse(row.base_scope) as SceneScope};
  }
  private rebuildDerived(scope:SceneScope,nowMs=Date.now()):void {
    const state=this.state(scope);
    this.commitments.replaceProjection(scope,state.sources);
    const binding=this.subject(scope);
    if(!binding){this.relationshipAssessments.clearModels(scope);return;}
    const agentCompanion=binding.host==='agent'&&this.companionContext(scope)?.host==='agent';
    if(!agentCompanion)this.relationshipAssessments.clearModels(scope);
    this.userModel.rebuildProjection(binding.subjectId,scope,agentCompanion?state.sources.filter(source=>source.role==='user'&&
      source.envelope.mode==='direct'&&source.envelope.presentIds.length===1&&source.envelope.presentIds[0]===source.envelope.targetId)
      .map(source=>({id:source.id,revision:source.revision,status:source.status,text:source.text,acceptedAtMs:source.acceptedAtMs,
        characterId:source.envelope.targetId,candidates:source.analysis?.userModelCandidates})):[],nowMs,agentCompanion);
    this.companion.invalidateSources(binding.subjectId,state.version,state.roster.characters.map(character=>companionTargetId(scope,character.id)),nowMs);
    for(const character of agentCompanion?state.roster.characters:[]){
      const controls=this.userModel.controls(binding.subjectId);
      const learningSources=state.sources.filter(source=>source.status==='accepted'&&source.processing==='ready'&&
        source.envelope.mode==='direct'&&source.envelope.targetId===character.id&&source.envelope.presentIds.length===1&&
        source.envelope.presentIds[0]===character.id&&(source.role==='user'||source.role==='assistant'&&source.speakerId===character.id));
      this.personalLearning.synchronize(this.personalLearning.key(scope,binding.subjectId,character.id),learningSources,
        controls.revision,controls.personalizationEnabled&&controls.profileLearningEnabled);
      const input=this.relationshipAssessmentInput(scope,character.id,nowMs);
      if(input)this.relationshipAssessments.clearStale(input);else this.relationshipAssessments.clearModels(scope);
    }
  }
  private invalidateCausalSuffix(scope:SceneScope,changes:{index:number;characters:Set<string>}[]) {
    if(!changes.length)return;
    const hasWorld=Boolean(this.worldSettings(scope));
    for(const [index,source] of this.state(scope).sources.entries()){
      if(source.status!=='accepted'||!source.analysis)continue;
      const characters=Object.keys(source.analysis.characters);
      if(!changes.some(change=>change.index<index&&(hasWorld||characters.some(character=>change.characters.has(character)))))continue;
      // Keep the old plan and candidates for a scoped retry and access-control migration.
      this.db.prepare("UPDATE scene_sources SET processing='pending',analysis=? WHERE scope=? AND id=?")
        .run(source.analysis?JSON.stringify(withoutEmotionStates(source.analysis)):null,scopeKey(scope),source.id);
      this.processing.clearSources(scope,[source.id]);
      // The source is reanalyzed as a unit, so every participating role may get
      // a new delta. Its downstream analyses must use those new deltas too.
      changes.push({index,characters:new Set([...characters,source.envelope.targetId,...source.envelope.presentIds,...(source.speakerId?[source.speakerId]:[])])});
    }
  }
  private invalidateConfigurationChanges(scope:SceneScope,state:SceneState,roster:SceneRoster) {
    const previous=new Map(state.roster.characters.map(character=>[character.id,character]));
    const changedModel=new Set<string>();
    const changedPerspective=new Set<string>();
    for(const character of roster.characters){
      const before=previous.get(character.id);
      if(!before)continue;
      if(before.name!==character.name||before.persona!==character.persona||JSON.stringify(before.emotion??null)!==JSON.stringify(character.emotion??null))changedModel.add(character.id);
      if(before.name!==character.name||JSON.stringify(before.aliases)!==JSON.stringify(character.aliases))changedPerspective.add(character.id);
    }
    if(!changedModel.size&&!changedPerspective.size)return;
    const changes:{index:number;characters:Set<string>}[]=[];
    for(const [index,source] of state.sources.entries()){
      if(source.status!=='accepted'||!source.analysis)continue;
      const analyzed=Object.keys(source.analysis.characters);
      const modelAffected=analyzed.some(character=>changedModel.has(character));
      const envelopeCharacters=[source.envelope.targetId,...source.envelope.presentIds,...(source.speakerId?[source.speakerId]:[])];
      const replan=source.envelope.mode==='scene'&&envelopeCharacters.some(character=>changedPerspective.has(character));
      if(!modelAffected&&!replan)continue;
      const retained=withoutEmotionStates(replan?{...source.analysis,plan:null}:source.analysis);
      // plan:null intentionally preserves old candidates for mask migration while
      // making SceneCore obtain a fresh perspective plan.
      this.db.prepare("UPDATE scene_sources SET processing='pending',analysis=? WHERE scope=? AND id=?")
        .run(JSON.stringify(retained),scopeKey(scope),source.id);
      changes.push({index,characters:new Set([...analyzed,...envelopeCharacters])});
    }
    this.invalidateCausalSuffix(scope,changes);
  }
  private migrateControls(scope:SceneScope,source:SceneSource,next:SceneAnalysis) {
    const ranking:Access[]=['clear','gist','feeling','anchor','hidden'];
    for(const [characterId,nextAnalysis] of Object.entries(next.characters)){
      const prefix=`${source.id}:${characterId}#`;
      const stored=(this.db.prepare('SELECT id,revision,access FROM scene_controls WHERE scope=? AND character=? AND revision<=?')
        .all(scopeKey(scope),characterId,source.revision) as {id:string;revision:number;access:Access}[]).filter(row=>row.id.startsWith(prefix)&&/^(?:\d+|@[a-f0-9]{64})$/.test(row.id.slice(prefix.length)));
      const durable=new Map(stored.filter(row=>row.revision===0).map(row=>[row.id,row.access]));
      const existingDurable=new Set(durable.keys());
      const legacy=stored.filter(row=>row.revision>0);
      const expectedRevision=source.analysis?.controlRevision??source.revision;
      const previous=source.analysis?.characters[characterId];
      const restrictions:Access[]=[];
      // Upgrade the old position-based controls when their source candidates are
      // available. Unknown legacy positions keep their conservative restriction.
      for(const row of legacy){
        const memory=row.revision===expectedRevision?previous?.memories[Number(row.id.slice(prefix.length))]:undefined;
        if(memory){
          const id=memoryControlId(source.id,characterId,memory);
          if(!existingDurable.has(id)&&ranking.indexOf(row.access)>=ranking.indexOf(durable.get(id)??'clear'))durable.set(id,row.access);
          this.db.prepare('DELETE FROM scene_controls WHERE scope=? AND character=? AND id=? AND revision=?').run(scopeKey(scope),characterId,row.id,row.revision);
        }else if(row.access!=='clear')restrictions.push(row.access);
      }
      const current=nextAnalysis.memories.map(memory=>memoryControlId(source.id,characterId,memory));
      for(const [id,access] of durable)if(!current.includes(id)&&access!=='clear')restrictions.push(access);
      if(restrictions.length){
        const fallback=restrictions.reduce((strictest,current)=>ranking.indexOf(current)>ranking.indexOf(strictest)?current:strictest,'clear' as Access);
        for(const id of current)if(!durable.has(id))durable.set(id,fallback);
      }
      // Keep unmatched identities too: a model may omit a memory on one pass and
      // extract it again later. Omission must not erase the user's restriction.
      for(const [id,access] of durable)this.db.prepare('INSERT OR REPLACE INTO scene_controls VALUES(?,?,?,?,?)')
        .run(scopeKey(scope),characterId,id,0,access);
    }
  }
  private bump(scope: SceneScope) { this.director.invalidate(scope);this.db.prepare('UPDATE scene_worlds SET version=version+1 WHERE key=?').run(scopeKey(scope)); }
  private markAllPending(scope:SceneScope) {
    for(const source of this.state(scope).sources) {
      if(source.status!=='accepted')continue;
      this.db.prepare("UPDATE scene_sources SET processing='pending',analysis=? WHERE scope=? AND id=?")
        .run(source.analysis?JSON.stringify(withoutEmotionStates(source.analysis)):null,scopeKey(scope),source.id);
    }
  }
  private migrateEmotionStates() {
    this.transaction(()=>{
      const worlds=this.db.prepare('SELECT scope FROM scene_worlds').all() as {scope:string}[];
      for(const row of worlds) {
        const scope=JSON.parse(row.scope) as SceneScope;
        if(this.rebuildEmotionStates(scope))this.bump(scope);
        this.rebuildDerived(scope);
      }
    });
  }
  /** Rebuild local neural snapshots only from recorded accepted candidates. */
  private rebuildEmotionStates(scope:SceneScope,onlyCharacterId?:string):boolean {
    const state=this.state(scope),key=scopeKey(scope);
    let changed=false;
    // Validate one persisted group at a time; ordinary scene state holds none.
    for(const source of state.sources) {
      const rows=this.db.prepare("SELECT j.key,j.value FROM scene_sources s,json_each(s.analysis,'$.emotionStates') j WHERE s.scope=? AND s.id=?")
        .iterate(key,source.id);
      const obsolete:string[]=[];
      for(const row of rows) {
        const actorId=String(row.key);
        if(onlyCharacterId&&actorId!==onlyCharacterId)continue;
        validateStoredEmotionStates({[actorId]:JSON.parse(String(row.value))});
        if(source.status!=='accepted'||source.processing!=='ready'||!source.analysis?.plan||!source.analysis.characters[actorId]||
          source.analysis.emotionPendingIds?.includes(actorId))obsolete.push(actorId);
      }
      for(const actorId of obsolete){
        this.db.prepare("UPDATE scene_sources SET analysis=json_set(analysis,'$.emotionStates',json_patch(json_extract(analysis,'$.emotionStates'),json_object(?,NULL))) WHERE scope=? AND id=?")
          .run(actorId,key,source.id);
        changed=true;
      }
    }
    // Replaying one role across its history avoids an all-NPC neural map.
    for(const character of state.roster.characters.filter(item=>!onlyCharacterId||item.id===onlyCharacterId)) {
      let emotion=createEmotion(this.emotionTime(scope,[],state.createdAtMs),character.emotion,emotionIdentitySeed(scope,character.id));
      for(const [index,source] of state.sources.entries()) {
        if(source.status!=='accepted'||source.processing!=='ready'||!source.analysis?.plan)continue;
        const candidate=source.analysis.characters[character.id];
        if(!candidate||source.analysis.emotionPendingIds?.includes(character.id))continue;
        emotion=advanceEmotion(emotion,candidate.emotion,this.emotionTime(scope,state.sources.slice(0,index+1),source.acceptedAtMs),character.emotion);
        const body=JSON.stringify(validateEmotionState(emotion));
        const previous=this.db.prepare("SELECT j.value AS body FROM scene_sources s,json_each(s.analysis,'$.emotionStates') j WHERE s.scope=? AND s.id=? AND j.key=?")
          .get(key,source.id,character.id) as {body:string}|undefined;
        if(previous?.body!==body){
          this.db.prepare("UPDATE scene_sources SET analysis=json_set(analysis,'$.emotionStates',json_patch(COALESCE(json_extract(analysis,'$.emotionStates'),'{}'),json_object(?,json(?)))) WHERE scope=? AND id=?")
            .run(character.id,body,key,source.id);
          changed=true;
        }
      }
    }
    return changed;
  }
  transaction<T>(action:()=>T):T {
    const savepoint=`scene_authority_${++this.savepointSequence}`;
    const outer=!this.db.isTransaction;
    this.db.exec(outer?'BEGIN IMMEDIATE':`SAVEPOINT ${savepoint}`);
    try { const result = action(); this.db.exec(outer?'COMMIT':`RELEASE ${savepoint}`); return result; }
    catch(error) { this.db.exec(outer?'ROLLBACK':`ROLLBACK TO ${savepoint}`);if(!outer)this.db.exec(`RELEASE ${savepoint}`);throw error; }
  }
}

function sameContent(left: SceneMessage, right: SceneMessage) {
  return left.text === right.text && left.role === right.role && left.automatic === right.automatic && left.speakerId === right.speakerId &&
    JSON.stringify(left.envelope) === JSON.stringify(right.envelope) &&
    (right.dependencies===undefined||JSON.stringify(left.dependencies??[])===JSON.stringify(right.dependencies)) &&
    (right.replyTo===undefined||JSON.stringify(left.replyTo)===JSON.stringify(right.replyTo));
}
function sourcesHash(state:SceneState) {
  return createHash('sha256').update(JSON.stringify(state.sources.map(source=>[source.id,source.revision,source.status]))).digest('hex');
}
function subjectBindingId(host:'agent'|'sillytavern',baseScope:SceneScope):string {
  return createHash('sha256').update(JSON.stringify(['xldb-subject-binding-v1',host,scopeKey(baseScope)])).digest('hex');
}
function companionTargetId(scope:SceneScope,actorId:string):string {
  return createHash('sha256').update(JSON.stringify(['xldb-companion-target-v1',scopeKey(scope),actorId])).digest('hex');
}
function memoryControlId(sourceId:string,characterId:string,memory:{kind?:string;detail:string}) {
  const identity=createHash('sha256').update(JSON.stringify([memory.kind??'legacy',memory.detail])).digest('hex');
  return `${sourceId}:${characterId}#@${identity}`;
}
function preferenceControlId(sourceId:string,preference:{category:string;quote:string}) {
  return `${sourceId}:pref:@${createHash('sha256').update(JSON.stringify([preference.category,preference.quote])).digest('hex')}`;
}
function preferenceSourceId(id:string) { return id.slice(0,id.lastIndexOf(':pref:@')); }
function localAnalysis(value:SceneAnalysis,source:SceneSource):SceneAnalysis {
  const input=value as SceneAnalysis&{emotionStates?:unknown};
  const expectation=input.contactResponseExpectation;
  if(expectation!==undefined&&(typeof expectation!=='object'||expectation===null||
    ![true,false,null].includes(expectation.expected)||
    (expectation.quote!==null&&(typeof expectation.quote!=='string'||!expectation.quote||!source.text.includes(expectation.quote)))))
    throw new Error('invalid_contact_response_expectation');
  const absence=input.absenceExplanation;
  if(absence!==undefined&&absence!==null&&(source.role!=='user'||source.envelope.mode!=='direct'||
    absence.sourceId!==source.id||absence.sourceRevision!==source.revision||
    absence.sourceAcceptedAtMs!==source.acceptedAtMs||absence.characterId!==source.envelope.targetId||
    !source.text.includes(absence.quote)))throw new Error('invalid_absence_evidence');
  const characters=Object.fromEntries(Object.entries(input.characters).map(([id,analysis])=>[id,
    {...analysis,emotion:{...analysis.emotion,stableRelationDelta:{}}}]));
  return {plan:input.plan,characters,
    ...(input.skippedStages===undefined?{}:{skippedStages:input.skippedStages}),
    ...(input.emotionSchedule===undefined?{}:{emotionSchedule:input.emotionSchedule}),
    ...(input.emotionPendingIds===undefined?{}:{emotionPendingIds:input.emotionPendingIds}),
    ...(input.emotionCandidateReadyIds===undefined?{}:{emotionCandidateReadyIds:input.emotionCandidateReadyIds}),
    ...(expectation===undefined?{}:{contactResponseExpectation:expectation}),
    ...(absence===undefined?{}:{absenceExplanation:absence}),
    ...(input.worldEffects===undefined?{}:{worldEffects:input.worldEffects}),
    ...(input.commitmentOperations===undefined?{}:{commitmentOperations:input.commitmentOperations}),
    ...(input.physiologyOperations===undefined?{}:{physiologyOperations:input.physiologyOperations}),
    ...(input.geographyOperations===undefined?{}:{geographyOperations:input.geographyOperations}),
    ...(input.userModelCandidates===undefined?{}:{userModelCandidates:validateUserModelCandidates(input.userModelCandidates,source.text)})};
}
function relationshipValidationContext(source:SceneSource,plan:import('./types.ts').PerspectivePlan,roster:SceneRoster,subjectId:string) {
  const observations=plan.observations.filter(observation=>observation.readers.includes(subjectId));
  const participantIds=new Set<string>([subjectId]);
  for(const observation of observations) {
    if(observation.actorId)participantIds.add(observation.actorId);
    for(const recipient of observation.recipients??[])participantIds.add(recipient);
  }
  const actors=roster.characters.filter(character=>participantIds.has(character.id));
  return {subjectId,actorIds:roster.characters.map(character=>character.id),userActorId:'player',actors,observations,messageRole:source.role};
}
function validateUserModelCandidates(value:unknown,sourceText:string):ProfileCandidate[] {
  return decodeProfileCandidates(JSON.stringify({schema:'xldb-profile-candidates-v1',candidates:value}),sourceText);
}
function validateCommitmentAnalysis(source:SceneSource,analysis:SceneAnalysis,roster:SceneRoster,
  time:{realClockTimeMs:number;storyClockTimeMs?:number;timeZone?:string}):SceneAnalysis {
  if(analysis.commitmentOperations===undefined)return analysis;
  if(!Array.isArray(analysis.commitmentOperations))throw new Error('invalid_commitment_operations');
  const actorIds=[...roster.characters.map(character=>character.id),'player'];
  const commitmentOperations=analysis.commitmentOperations.map(operation=>{
    if(!operation||typeof operation!=='object'||Array.isArray(operation))throw new Error('invalid_commitment_operation');
    if(operation.sourceId!==source.id||operation.sourceRevision!==source.revision||operation.sourceAcceptedAtMs!==source.acceptedAtMs)
      throw new Error('invalid_commitment_source');
    if(operation.mode!=='roleplay'&&operation.mode!=='companion')throw new Error('invalid_commitment_mode');
    const candidate=commitmentCandidate(operation);
    return validateCommitmentOperations({source,plan:analysis.plan,actorIds,userActorId:'player',mode:operation.mode,
      clockTimeMs:operation.mode==='companion'?time.realClockTimeMs:time.storyClockTimeMs,timeZone:time.timeZone},
      {operations:[candidate]})[0]!;
  });
  return {...analysis,commitmentOperations};
}
function commitmentCandidate(operation:ValidatedCommitmentOperation):CommitmentCandidate {
  const {sourceId:_sourceId,sourceRevision:_sourceRevision,sourceAcceptedAtMs:_acceptedAt,mode:_mode,...candidate}=operation;
  return candidate;
}
function withoutEmotionStates<T extends {emotionStates?:Record<string,EmotionState>}>(value:T):Omit<T,'emotionStates'> {
  const {emotionStates:_ignored,...rest}=value;
  return rest;
}
function withoutUserModelCandidates<T extends {userModelCandidates?:ProfileCandidate[]}>(value:T):Omit<T,'userModelCandidates'> {
  const {userModelCandidates:_ignored,...rest}=value;
  return rest;
}
function validateStoredEmotionStates(value:unknown):void {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError('invalid_scene_emotion_states');
  for(const state of Object.values(value as Record<string,unknown>))validateEmotionState(state);
}

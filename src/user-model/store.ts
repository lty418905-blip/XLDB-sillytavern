import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {communicationStrategyPrompt,profileExtractionPrompt,profileReflectionPrompt} from './codec.ts';
import {defaultProfileControls,ensureUserModelSchema,readProfileControls,validateCategories,writeProfileControls} from './schema.ts';
import {profileThemes,strategyFeedbackChanges} from './types.ts';
import type {CommunicationStrategy,FrontendStrategy,ProfileCandidate,ProfileControls,ProfileEntry,ProfileExtractionTask,
  ProfileListOptions,ProfileMergeAction,ProfileReflectionSource,ProfileReflectionTask,ProfileProjectionResult,ProfileProjectionSource,StrategyFeedback,StrategyFeedbackChange,StrategyFeedbackResult,
  StrategyTask,SubjectBinding} from './types.ts';
import type {SceneScope} from '../scene/types.ts';

interface EntryRow {id:string;subject:string;semantic_key:string;category:string;body:string;status:string;corrected:number;revision:number;updated:number}
interface EvidenceRow {entry_id:string;source_id:string;source_revision:number;candidate_key:string;polarity:'support'|'counter';body:string}
interface OverrideRow {status:'corrected'|'deleted';body:string|null}
interface StrategyRow {id:string;profile_revision:number;controls_revision:number;body:string}
interface FeedbackRow {id:string;subject:string;storage_key:string;strategy_id:string;change:string;detail:string;created:number;profile_revision:number}
interface ReflectionRow {fingerprint:string;controls_revision:number;after_profile_revision:number;sources:string;actions:string}

export interface ProfileControlPatch {
  profileLearningEnabled?:boolean;
  personalizationEnabled?:boolean;
  proactiveCompanionEnabled?:boolean;
  scheduledWakeEnabled?:boolean;
  learningCategories?:unknown;
  readCategories?:unknown;
  strategyCategories?:unknown;
  proactiveCategories?:unknown;
}

export class UserModelStore {
  private db:DatabaseSync;
  private savepointSequence=0;
  constructor(db:DatabaseSync){this.db=db;ensureUserModelSchema(db);}

  bindSubject(host:string,bindingId:string,subjectId:string,nowMs=Date.now()):SubjectBinding {
    host=id(host);bindingId=id(bindingId);subjectId=id(subjectId);nowMs=time(nowMs);
    return this.transaction(()=>{
      const row=this.db.prepare('SELECT subject,created FROM user_subject_bindings WHERE host=? AND binding_id=?')
        .get(host,bindingId) as {subject:string;created:number}|undefined;
      if(row&&row.subject!==subjectId)throw new Error('subject_binding_conflict');
      if(!row)this.db.prepare('INSERT INTO user_subject_bindings VALUES(?,?,?,?)').run(host,bindingId,subjectId,nowMs);
      return {host,bindingId,subjectId,createdAtMs:row?.created??nowMs};
    });
  }

  resolveSubject(host:string,bindingId:string):SubjectBinding|null {
    const row=this.db.prepare('SELECT subject,created FROM user_subject_bindings WHERE host=? AND binding_id=?')
      .get(id(host),id(bindingId)) as {subject:string;created:number}|undefined;
    return row?{host,bindingId,subjectId:row.subject,createdAtMs:row.created}:null;
  }

  controls(subjectId:string):ProfileControls {return readProfileControls(this.db,id(subjectId));}

  setControls(subjectId:string,patch:ProfileControlPatch,expectedRevision:number,nowMs=Date.now(),advanced=true):ProfileControls {
    subjectId=id(subjectId);assertRevision(expectedRevision);nowMs=time(nowMs);
    if(!patch||typeof patch!=='object'||!Object.keys(patch).length)throw new Error('invalid_profile_controls');
    return this.transaction(()=>{
      const current=readProfileControls(this.db,subjectId);
      if(current.revision!==expectedRevision)throw new Error('context_changed_retry');
      const profileBefore=currentProfileSnapshot(this.db,subjectId);
      const next:ProfileControls={...current,
        profileLearningEnabled:boolean(patch.profileLearningEnabled,current.profileLearningEnabled),
        personalizationEnabled:boolean(patch.personalizationEnabled,current.personalizationEnabled),
        proactiveCompanionEnabled:boolean(patch.proactiveCompanionEnabled,current.proactiveCompanionEnabled),
        scheduledWakeEnabled:boolean(patch.scheduledWakeEnabled,current.scheduledWakeEnabled),
        learningCategories:patch.learningCategories===undefined?current.learningCategories:validateCategories(patch.learningCategories),
        readCategories:patch.readCategories===undefined?current.readCategories:validateCategories(patch.readCategories),
        strategyCategories:patch.strategyCategories===undefined?current.strategyCategories:validateCategories(patch.strategyCategories),
        proactiveCategories:patch.proactiveCategories===undefined?current.proactiveCategories:validateCategories(patch.proactiveCategories),
        revision:current.revision+1,updatedAtMs:nowMs};
      if(next.scheduledWakeEnabled&&!next.proactiveCompanionEnabled)throw new Error('invalid_scheduled_wake_without_proactive');
      writeProfileControls(this.db,next);
      this.db.prepare("DELETE FROM user_profile_evidence WHERE subject=? AND source_scope LIKE 'reflection:%'").run(subjectId);
      this.db.prepare('DELETE FROM user_profile_reflections WHERE subject=?').run(subjectId);
      if(patch.learningCategories!==undefined) {
        const placeholders=next.learningCategories.map(()=>'?').join(',');
        const sql=next.learningCategories.length
          ?`DELETE FROM user_profile_evidence WHERE subject=? AND entry_id IN (SELECT id FROM user_profile_entries WHERE subject=? AND category NOT IN (${placeholders}))`
          :'DELETE FROM user_profile_evidence WHERE subject=? AND entry_id IN (SELECT id FROM user_profile_entries WHERE subject=?)';
        this.db.prepare(sql).run(subjectId,subjectId,...next.learningCategories);
      }
      this.recomputeEntries(subjectId,nowMs,advanced);
      this.bumpProfileIfChanged(subjectId,profileBefore,nowMs);
      this.invalidateStrategies(subjectId);
      return next;
    });
  }

  profileRevision(subjectId:string):number {
    return (this.db.prepare('SELECT revision FROM user_profile_state WHERE subject=?').get(id(subjectId)) as {revision:number}|undefined)?.revision??0;
  }

  reflectionTask(subjectId:string,scope:SceneScope,characterId:string,sources:readonly ProfileReflectionSource[],activity?:unknown):ProfileReflectionTask|null {
    subjectId=id(subjectId);const controls=this.controls(subjectId);
    if(!controls.profileLearningEnabled||!controls.learningCategories.length)return null;
    characterId=id(characterId);
    const bounded=sources.filter(source=>source.characterId===characterId).slice(-12)
      .map(source=>({id:id(source.id),revision:source.revision,text:text(source.text,20000),acceptedAtMs:time(source.acceptedAtMs),characterId}));
    if(!bounded.length)return null;
    const fingerprint=hash([characterId,bounded.map(source=>[source.id,source.revision,source.text,source.acceptedAtMs])]);
    const row=this.db.prepare('SELECT fingerprint,controls_revision,after_profile_revision,sources,actions FROM user_profile_reflections WHERE subject=? AND source_scope=? AND fingerprint=?')
      .get(subjectId,JSON.stringify(scope),fingerprint) as ReflectionRow|undefined;
    if(row&&row.controls_revision===controls.revision)return null;
    const entries=this.listEntries(subjectId,{purpose:'user',sessionId:scope.sessionId,characterId})
      .filter(entry=>entry.attribution==='real_user'&&controls.learningCategories.includes(entry.category)&&
        this.hasApplicableScope(entry,{characterId,sessionId:scope.sessionId}));
    const allowedEntryRevisions=Object.fromEntries(entries.map(entry=>[entry.id,entry.revision]));
    return profileReflectionPrompt({subjectId,scope,characterId,profileRevision:this.profileRevision(subjectId),controlsRevision:controls.revision,
      sourceFingerprint:fingerprint,sources:bounded,allowedEntryRevisions,activity,
      entries:entries.map(entry=>({id:entry.id,revision:entry.revision,key:entry.key,category:entry.category,theme:entry.theme,
        claim:entry.claim,corrected:entry.corrected,purposes:entry.purposes,characterIds:entry.characterIds,sessionIds:entry.sessionIds}))});
  }

  saveReflection(subjectId:string,task:ProfileReflectionTask,actions:readonly ProfileMergeAction[],currentSources:readonly ProfileReflectionSource[],nowMs=Date.now()):boolean {
    subjectId=id(subjectId);nowMs=time(nowMs);
    return this.transaction(()=>{
      const controls=this.controls(subjectId),scopeKey=JSON.stringify(task.scope);
      if(task.subjectId!==subjectId||controls.revision!==task.controlsRevision||this.profileRevision(subjectId)!==task.profileRevision||
        !controls.profileLearningEnabled)throw new Error('context_changed_retry');
      const bounded=currentSources.filter(source=>source.characterId===task.characterId).slice(-12);
      if(hash([task.characterId,bounded.map(source=>[source.id,source.revision,source.text,source.acceptedAtMs])])!==task.sourceFingerprint)throw new Error('context_changed_retry');
      const checked=this.checkReflectionActions(subjectId,task,actions);
      const previous=this.db.prepare('SELECT fingerprint,controls_revision,after_profile_revision,sources,actions FROM user_profile_reflections WHERE subject=? AND source_scope=? AND fingerprint=?')
        .get(subjectId,scopeKey,task.sourceFingerprint) as ReflectionRow|undefined;
      if(previous&&previous.controls_revision===controls.revision&&previous.after_profile_revision===task.profileRevision)return false;
      const before=currentProfileSnapshot(this.db,subjectId);
      this.db.prepare('DELETE FROM user_profile_evidence WHERE subject=? AND source_scope=?').run(subjectId,`reflection:${scopeKey}:${task.sourceFingerprint}`);
      this.db.prepare('DELETE FROM user_profile_reflections WHERE subject=? AND source_scope=? AND fingerprint=?').run(subjectId,scopeKey,task.sourceFingerprint);
      this.applyReflection(subjectId,task.scope,task.sourceFingerprint,checked,task.sources,nowMs);
      this.recomputeEntries(subjectId,nowMs,true);
      const changed=this.bumpProfileIfChanged(subjectId,before,nowMs);
      if(changed)this.invalidateStrategies(subjectId);
      this.db.prepare('INSERT INTO user_profile_reflections VALUES(?,?,?,?,?,?,?,?)')
        .run(subjectId,scopeKey,task.sourceFingerprint,controls.revision,this.profileRevision(subjectId),
          JSON.stringify(task.sources.map(source=>({id:source.id,revision:source.revision,acceptedAtMs:source.acceptedAtMs}))),JSON.stringify(checked),nowMs);
      return changed;
    });
  }

  /** Rebuild from the whole accepted source projection. It is safe inside the scene commit transaction. */
  rebuildProjection(subjectId:string,scope:SceneScope,sources:readonly ProfileProjectionSource[],nowMs=Date.now(),advanced=true):ProfileProjectionResult {
    subjectId=id(subjectId);const sourceScope=JSON.stringify(scope);nowMs=time(nowMs);
    return this.transaction(()=>{
      const before=currentProfileSnapshot(this.db,subjectId),controls=readProfileControls(this.db,subjectId);
      const accepted=sources.filter(source=>source.status==='accepted').map(validateSource)
        .sort((left,right)=>left.acceptedAtMs-right.acceptedAtMs||left.id.localeCompare(right.id)||left.revision-right.revision);
      const current=new Map(accepted.map(source=>[source.id,source.revision]));
      const evidence=this.db.prepare(`SELECT entry_id,source_id,source_revision FROM user_profile_evidence
        WHERE subject=? AND source_scope=?`).all(subjectId,sourceScope) as unknown as EvidenceRow[];
      for(const row of evidence)if(current.get(row.source_id)!==row.source_revision)
        this.db.prepare('DELETE FROM user_profile_evidence WHERE subject=? AND source_scope=? AND source_id=?')
          .run(subjectId,sourceScope,row.source_id);

      const reflections=this.db.prepare('SELECT fingerprint,controls_revision,after_profile_revision,sources,actions FROM user_profile_reflections WHERE subject=? AND source_scope=?')
        .all(subjectId,sourceScope) as unknown as ReflectionRow[];
      for(const reflection of reflections){
        const reflectionScope=`reflection:${sourceScope}:${reflection.fingerprint}`;
        this.db.prepare('DELETE FROM user_profile_evidence WHERE subject=? AND source_scope=?').run(subjectId,reflectionScope);
        const refs=JSON.parse(reflection.sources) as ProfileReflectionSource[];
        if(reflection.controls_revision!==controls.revision||refs.some(ref=>current.get(ref.id)!==ref.revision)){
          this.db.prepare('DELETE FROM user_profile_reflections WHERE subject=? AND source_scope=? AND fingerprint=?').run(subjectId,sourceScope,reflection.fingerprint);
          continue;
        }
        this.applyReflection(subjectId,scope,reflection.fingerprint,JSON.parse(reflection.actions) as ProfileMergeAction[],refs,nowMs);
      }

      if(controls.profileLearningEnabled)for(const source of accepted) {
        this.db.prepare('DELETE FROM user_profile_evidence WHERE subject=? AND source_scope=? AND source_id=? AND source_revision=?')
          .run(subjectId,sourceScope,source.id,source.revision);
        for(const original of (source.candidates??[]).map(value=>validateCandidate(value,source.text))) {
          const candidate=source.characterId?{...original,characterIds:narrow(original.characterIds,[source.characterId]),
            sessionIds:narrow(original.sessionIds,[scope.sessionId])}:
            original.basis==='inferred'||original.basis==='observed'?{...original,sessionIds:narrow(original.sessionIds,[scope.sessionId])}:original;
          if(!controls.learningCategories.includes(candidate.category))continue;
          const {semanticKey,entryId}=this.candidateIdentity(subjectId,candidate);
          const existing=this.entryRow(entryId);
          if(!existing)this.db.prepare(`INSERT INTO user_profile_entries
            (id,subject,semantic_key,category,body,status,corrected,revision,updated) VALUES(?,?,?,?,?,'invalid',0,1,?)`)
            .run(entryId,subjectId,semanticKey,candidate.category,JSON.stringify(candidate),nowMs);
          this.db.prepare(`INSERT OR REPLACE INTO user_profile_evidence
            (subject,entry_id,source_scope,source_id,source_revision,candidate_key,polarity,body) VALUES(?,?,?,?,?,?,?,?)`)
            .run(subjectId,entryId,sourceScope,source.id,source.revision,candidate.key,candidate.polarity,
              JSON.stringify({candidate,acceptedAtMs:source.acceptedAtMs,evidence:source.text.includes(candidate.evidence)}));
        }
      }
      this.recomputeEntries(subjectId,nowMs,advanced);
      const changed=this.bumpProfileIfChanged(subjectId,before,nowMs);
      const invalidatedStrategies=changed?this.invalidateStrategies(subjectId):0;
      return {subjectId,profileRevision:this.profileRevision(subjectId),changed,
        activeEntries:(this.db.prepare("SELECT COUNT(*) AS count FROM user_profile_entries WHERE subject=? AND status='active'").get(subjectId) as {count:number}).count,
        invalidatedStrategies};
    });
  }

  listEntries(subjectId:string,options:ProfileListOptions={purpose:'user'}):ProfileEntry[] {
    subjectId=id(subjectId);const now=options.nowMs===undefined?Date.now():time(options.nowMs),controls=readProfileControls(this.db,subjectId);
    if(options.purpose==='read'&&!controls.readCategories.length)return [];
    if(options.purpose==='strategy'&&!controls.personalizationEnabled)return [];
    if(options.purpose==='proactive'&&(!controls.personalizationEnabled||!controls.proactiveCompanionEnabled))return [];
    const allowed=options.purpose==='user'?null:options.purpose==='read'?controls.readCategories:
      options.purpose==='strategy'?controls.strategyCategories:controls.proactiveCategories;
    const rows=this.db.prepare("SELECT id,subject,semantic_key,category,body,status,corrected,revision,updated FROM user_profile_entries WHERE subject=? AND status='active' ORDER BY updated DESC,id")
      .all(subjectId) as unknown as EntryRow[];
    return rows.map(row=>this.entry(row)).filter(entry=>(!allowed||allowed.includes(entry.category))&&
      // Pre-upgrade model entries may have empty scope. Only an explicit user
      // correction may grant global use; original evidence remains visible to its owner.
      (options.purpose==='user'||this.hasApplicableScope(entry,options))&&
      (options.purpose==='user'||entry.attribution==='real_user'||options.advanced===false&&entry.attribution==='uncertain')&&
      (entry.validFromMs===null||entry.validFromMs<=now)&&(entry.validUntilMs===null||entry.validUntilMs>=now)&&
      (!options.taskPurpose||!entry.purposes.length||entry.purposes.includes(options.taskPurpose))&&
      (!options.characterId||!entry.characterIds.length||entry.characterIds.includes(options.characterId))&&
      (!options.sessionId||!entry.sessionIds.length||entry.sessionIds.includes(options.sessionId)));
  }

  correctEntry(subjectId:string,entryId:string,correction:{claim:string;category?:unknown;validFromMs?:number|null;validUntilMs?:number|null;
    purposes?:unknown;characterIds?:unknown;sessionIds?:unknown},nowMs=Date.now(),advanced=true):ProfileEntry {
    subjectId=id(subjectId);entryId=id(entryId);nowMs=time(nowMs);
    return this.transaction(()=>{
      const before=currentProfileSnapshot(this.db,subjectId),row=this.entryRow(entryId);
      if(!row||row.subject!==subjectId)throw new Error('profile_entry_not_found');
      const old=JSON.parse(row.body) as ProfileCandidate;
      const previousAuthorization=(old as ProfileCandidate&{scopeAuthorization?:{characterIds:boolean;sessionIds:boolean}}).scopeAuthorization;
      const candidate:ProfileCandidate&{scopeAuthorization:{characterIds:boolean;sessionIds:boolean}}={...old,
        scopeAuthorization:{characterIds:correction.characterIds!==undefined||previousAuthorization?.characterIds===true,
          sessionIds:correction.sessionIds!==undefined||previousAuthorization?.sessionIds===true},
        claim:text(correction.claim,1000),category:correction.category===undefined?old.category:singleCategory(correction.category),
        attribution:'real_user',basis:'explicit',polarity:'support',evidence:'用户直接纠正',
        validFromMs:correction.validFromMs===undefined?old.validFromMs:nullableTime(correction.validFromMs),
        validUntilMs:correction.validUntilMs===undefined?old.validUntilMs:nullableTime(correction.validUntilMs),
        purposes:correction.purposes===undefined?old.purposes:stringArray(correction.purposes,20,100),
        characterIds:correction.characterIds===undefined?old.characterIds:stringArray(correction.characterIds,50,200),
        sessionIds:correction.sessionIds===undefined?old.sessionIds:stringArray(correction.sessionIds,50,200),confidenceBasis:['用户直接纠正']};
      this.db.prepare(`INSERT INTO user_profile_overrides(entry_id,subject,status,body,updated) VALUES(?,?,'corrected',?,?)
        ON CONFLICT(entry_id) DO UPDATE SET status='corrected',body=excluded.body,updated=excluded.updated`)
        .run(entryId,subjectId,JSON.stringify(candidate),nowMs);
      this.invalidateReflectionsForEntry(subjectId,entryId);
      this.recomputeEntries(subjectId,nowMs,advanced);this.bumpProfileIfChanged(subjectId,before,nowMs);this.invalidateStrategies(subjectId);
      return this.entry(this.entryRow(entryId)!);
    });
  }

  deleteEntry(subjectId:string,entryId:string,nowMs=Date.now(),advanced=true):void {
    subjectId=id(subjectId);entryId=id(entryId);nowMs=time(nowMs);
    this.transaction(()=>{
      const before=currentProfileSnapshot(this.db,subjectId),row=this.entryRow(entryId);
      if(!row||row.subject!==subjectId)throw new Error('profile_entry_not_found');
      this.db.prepare(`INSERT INTO user_profile_overrides(entry_id,subject,status,body,updated) VALUES(?,?,'deleted',NULL,?)
        ON CONFLICT(entry_id) DO UPDATE SET status='deleted',body=NULL,updated=excluded.updated`).run(entryId,subjectId,nowMs);
      this.invalidateReflectionsForEntry(subjectId,entryId);
      this.recomputeEntries(subjectId,nowMs,advanced);this.bumpProfileIfChanged(subjectId,before,nowMs);this.invalidateStrategies(subjectId);
    });
  }

  profileTask(subjectId:string,scope:SceneScope,source:{id:string;revision:number;text:string;acceptedAtMs:number}):ProfileExtractionTask|null {
    const controls=readProfileControls(this.db,id(subjectId));
    return controls.profileLearningEnabled&&controls.learningCategories.length
      ?profileExtractionPrompt({subjectId,scope,source,allowedCategories:controls.learningCategories}):null;
  }

  private checkReflectionActions(subjectId:string,task:ProfileReflectionTask,actions:readonly ProfileMergeAction[]):ProfileMergeAction[] {
    if(actions.length>20)throw new Error('invalid_profile_reflection');
    const controls=this.controls(subjectId),sources=new Map(task.sources.map(source=>[source.id,source]));
    const seen=new Set<string>();
    return actions.map(action=>{
      if(!['add','update','nochange'].includes(action.action))throw new Error('invalid_profile_reflection');
      const target=action.targetEntryId?this.entryRow(action.targetEntryId):undefined;
      if(action.action!=='add'&&(action.action!=='nochange'||action.targetEntryId!==undefined)){
        if(!target||target.subject!==subjectId||target.revision!==action.targetRevision||task.allowedEntryRevisions[target.id]!==target.revision)
          throw new Error('invalid_profile_reflection_target');
      } else if(action.targetEntryId!==undefined)throw new Error('invalid_profile_reflection_target');
      if(action.action==='nochange')return {action:'nochange',...(target?{targetEntryId:target.id,targetRevision:target.revision}:{})};
      if(target&&(target.corrected===1||this.override(target.id)?.status==='deleted'))throw new Error('profile_entry_corrected');
      const candidate=action.candidate;
      if(!candidate||candidate.attribution!=='real_user'||!controls.learningCategories.includes(candidate.category)||
        candidate.theme!==undefined&&!profileThemes.includes(candidate.theme))throw new Error('invalid_profile_reflection');
      if(target){
        const current=JSON.parse(target.body) as ProfileCandidate;
        if(candidate.key!==current.key||candidate.category!==current.category)throw new Error('invalid_profile_reflection_target');
      }
      if(!action.sources?.length||action.sources.length>12)throw new Error('invalid_profile_reflection');
      const refs=action.sources.map(ref=>{
        const source=sources.get(ref.id);
        if(!source||source.revision!==ref.revision||!source.text.includes(text(ref.evidence,500)))throw new Error('profile_evidence_not_in_source');
        return {id:ref.id,revision:ref.revision,evidence:ref.evidence};
      });
      const semanticKey=`${candidate.category}:${candidate.key}`;
      if(seen.has(semanticKey))throw new Error('invalid_profile_reflection');seen.add(semanticKey);
      const current=target?JSON.parse(target.body) as ProfileCandidate:undefined;
      const explicitlyStated=refs.some(ref=>sources.get(ref.id)!.text.includes(candidate.claim));
      const narrowed:ProfileCandidate={...candidate,evidence:refs[0]!.evidence,
        basis:candidate.basis==='explicit'&&!explicitlyStated?'inferred':candidate.basis,
        purposes:narrow(candidate.purposes.length?candidate.purposes:['reply'],current?.purposes),
        characterIds:narrow(candidate.characterIds,[task.characterId]),
        sessionIds:narrow(candidate.sessionIds,task.scope.sessionId?[task.scope.sessionId]:[]),
      };
      if(current){
        narrowed.purposes=narrow(narrowed.purposes,current.purposes);
        narrowed.characterIds=narrow(narrowed.characterIds,current.characterIds);
        narrowed.sessionIds=narrow(narrowed.sessionIds,current.sessionIds);
      }
      const {entryId}=this.candidateIdentity(subjectId,narrowed);
      if(action.action==='add'&&this.entryRow(entryId))throw new Error('invalid_profile_reflection_target');
      return {action:action.action,targetEntryId:target?.id,targetRevision:target?.revision,candidate:narrowed,sources:refs};
    });
  }

  private applyReflection(subjectId:string,scope:SceneScope,fingerprint:string,actions:readonly ProfileMergeAction[],sources:readonly Pick<ProfileReflectionSource,'id'|'revision'|'acceptedAtMs'>[],nowMs:number):void {
    const sourceScope=`reflection:${JSON.stringify(scope)}:${fingerprint}`;
    const allowed=new Set(sources.map(source=>`${source.id}:${source.revision}`));
    for(const action of actions){
      if(action.action==='nochange'||!action.candidate||!action.sources)continue;
      const candidate=action.candidate;
      const target=action.targetEntryId?this.entryRow(action.targetEntryId):undefined;
      const {semanticKey,entryId}=target?{semanticKey:target.semantic_key,entryId:target.id}:this.candidateIdentity(subjectId,candidate);
      if(!this.entryRow(entryId))this.db.prepare(`INSERT INTO user_profile_entries
        (id,subject,semantic_key,category,body,status,corrected,revision,updated) VALUES(?,?,?,?,?,'invalid',0,1,?)`)
        .run(entryId,subjectId,semanticKey,candidate.category,JSON.stringify(candidate),nowMs);
      for(const ref of action.sources){
        if(!allowed.has(`${ref.id}:${ref.revision}`))continue;
        this.db.prepare(`INSERT OR REPLACE INTO user_profile_evidence
          (subject,entry_id,source_scope,source_id,source_revision,candidate_key,polarity,body) VALUES(?,?,?,?,?,?,?,?)`)
          .run(subjectId,entryId,sourceScope,ref.id,ref.revision,candidate.key,candidate.polarity,
            JSON.stringify({candidate:{...candidate,evidence:ref.evidence},acceptedAtMs:sources.find(source=>source.id===ref.id)?.acceptedAtMs??nowMs,
              reflectedAtMs:nowMs}));
      }
    }
  }

  strategyTask(subjectId:string,input:{purpose:string;storageKey?:string;currentContext?:string;characterId?:string;sessionId?:string;nowMs?:number;advanced?:boolean;activity?:unknown}):StrategyTask|null {
    subjectId=id(subjectId);const purpose=text(input.purpose,200),storageKey=input.storageKey===undefined?purpose:text(input.storageKey,500);
    const controls=readProfileControls(this.db,subjectId);
    if(!controls.personalizationEnabled)return null;
    const advanced=input.advanced!==false;
    const entries=this.listEntries(subjectId,{purpose:'strategy',taskPurpose:purpose,characterId:input.characterId,
      sessionId:input.sessionId,nowMs:input.nowMs,advanced});
    const feedback=advanced?this.feedbackForStorage(subjectId,storageKey):[];
    if(!entries.length&&!feedback.length)return null;
    return {...communicationStrategyPrompt({subjectId,purpose,storageKey,profileRevision:this.profileRevision(subjectId),controlsRevision:controls.revision,
      currentContext:input.currentContext,feedback,advanced,activity:input.activity,entries:entries.map(entry=>({id:entry.id,revision:entry.revision,category:entry.category,
        attribution:entry.attribution,basis:entry.basis,claim:entry.claim,confidenceBasis:entry.confidenceBasis}))}),
      ...(input.characterId===undefined?{}:{characterId:id(input.characterId)}),...(input.sessionId===undefined?{}:{sessionId:id(input.sessionId)})};
  }

  saveStrategy(subjectId:string,task:StrategyTask,strategy:CommunicationStrategy,nowMs=Date.now()):FrontendStrategy {
    subjectId=id(subjectId);const storageKey=text(task.storageKey,500);nowMs=time(nowMs);
    return this.transaction(()=>{
      if(task.subjectId!==subjectId||strategy.purpose!==task.purpose)throw new Error('invalid_profile_strategy');
      const controls=readProfileControls(this.db,subjectId),profileRevision=this.profileRevision(subjectId);
      if(!controls.personalizationEnabled||controls.revision!==task.controlsRevision||profileRevision!==task.profileRevision)
        throw new Error('context_changed_retry');
      if(strategy.sourceVersions.controlsRevision!==controls.revision||strategy.sourceVersions.profileRevision!==profileRevision)
        throw new Error('context_changed_retry');
      const entries=this.listEntries(subjectId,{purpose:'strategy',taskPurpose:task.purpose,characterId:task.characterId,sessionId:task.sessionId,nowMs,advanced:task.advanced});
      const allowed=new Map(entries.map(entry=>[entry.id,entry.revision]));
      const cited=new Set([...strategy.knownFacts,...strategy.uncertainFacts].map(fact=>fact.entryId));
      for(const entryId of cited)if(!task.allowedEntryIds.includes(entryId)||strategy.sourceVersions.entryRevisions[entryId]!==task.allowedEntryRevisions[entryId])
        throw new Error('invalid_profile_strategy_reference');
      for(const [entryId,revision] of Object.entries(strategy.sourceVersions.entryRevisions))
        if(allowed.get(entryId)!==revision)throw new Error('context_changed_retry');
      const strategyId=randomUUID();
      this.db.prepare("UPDATE user_model_strategies SET status='invalid' WHERE subject=? AND purpose=? AND status='active'")
        .run(subjectId,storageKey);
      const bounded=task.advanced?applyFeedback(groundStrategy(strategy,entries),task.feedback):strategy;
      this.db.prepare('INSERT INTO user_model_strategies VALUES(?,?,?,?,?,?,?,?)')
        .run(strategyId,subjectId,storageKey,profileRevision,controls.revision,JSON.stringify({...bounded,contextScope:{characterId:task.characterId??null,sessionId:task.sessionId??null}}),'active',nowMs);
      return frontend(strategyId,bounded);
    });
  }

  recordStrategyFeedback(subjectId:string,input:{strategyId?:string;storageKey:string;feedbackId:string;
    expectedProfileRevision:number;change:StrategyFeedbackChange;detail?:unknown},nowMs=Date.now()):StrategyFeedbackResult {
    subjectId=id(subjectId);const strategyId=input.strategyId===undefined?'manual':id(input.strategyId);
    const storageKey=text(input.storageKey,500),feedbackId=id(input.feedbackId);
    assertRevision(input.expectedProfileRevision);nowMs=time(nowMs);
    if(!strategyFeedbackChanges.includes(input.change))throw new Error('invalid_profile_feedback');
    if(strategyId==='manual'&&input.change!=='wait'&&input.change!=='resume')throw new Error('profile_strategy_not_found');
    const detail=input.detail===undefined?'':optionalText(input.detail,300);
    if(['repeated_question','avoid_topic','allow_topic'].includes(input.change)&&!detail)throw new Error('invalid_profile_feedback');
    return this.transaction(()=>{
      const previous=this.db.prepare('SELECT id,subject,storage_key,strategy_id,change,detail,created,profile_revision FROM user_model_feedback WHERE id=?')
        .get(feedbackId) as FeedbackRow|undefined;
      if(previous){
        if(previous.subject!==subjectId||previous.storage_key!==storageKey||previous.strategy_id!==strategyId||
          previous.change!==input.change||previous.detail!==detail)throw new Error('profile_feedback_conflict');
        return {feedbackId,profileRevision:previous.profile_revision,change:input.change};
      }
      const controls=readProfileControls(this.db,subjectId);
      if(!controls.personalizationEnabled&&input.change!=='wait'&&input.change!=='resume')
        throw new Error('profile_personalization_disabled');
      if(this.profileRevision(subjectId)!==input.expectedProfileRevision)throw new Error('context_changed_retry');
      if(strategyId!=='manual'){
        const row=this.db.prepare('SELECT id,profile_revision,controls_revision,body FROM user_model_strategies WHERE id=? AND subject=? AND purpose=?')
          .get(strategyId,subjectId,storageKey) as StrategyRow|undefined;
        if(!row)throw new Error('profile_strategy_not_found');
      }
      const nextRevision=this.profileRevision(subjectId)+1;
      this.db.prepare(`INSERT INTO user_profile_state(subject,revision,updated) VALUES(?,?,?)
        ON CONFLICT(subject) DO UPDATE SET revision=excluded.revision,updated=excluded.updated`).run(subjectId,nextRevision,nowMs);
      this.db.prepare('INSERT INTO user_model_feedback VALUES(?,?,?,?,?,?,?,?)')
        .run(feedbackId,subjectId,storageKey,strategyId,input.change,detail,nowMs,nextRevision);
      if(input.change==='wait'||input.change==='resume'){
        const target=feedbackTarget(storageKey);
        this.db.prepare(`INSERT INTO user_model_contact_pauses(subject,target,paused,updated) VALUES(?,?,?,?)
          ON CONFLICT(subject,target) DO UPDATE SET paused=excluded.paused,updated=excluded.updated`)
          .run(subjectId,target,input.change==='wait'?1:0,nowMs);
      }
      this.invalidateStrategies(subjectId);
      return {feedbackId,profileRevision:nextRevision,change:input.change};
    });
  }

  contactPaused(subjectId:string,target:string):boolean {
    const row=this.db.prepare('SELECT paused FROM user_model_contact_pauses WHERE subject=? AND target=?')
      .get(id(subjectId),text(target,500)) as {paused:number}|undefined;
    return row?.paused===1;
  }

  private feedbackForStorage(subjectId:string,storageKey:string):StrategyFeedback[] {
    const rows=this.db.prepare(`SELECT id,subject,storage_key,strategy_id,change,detail,created,profile_revision
      FROM user_model_feedback WHERE subject=? AND storage_key=? ORDER BY created DESC,id DESC LIMIT 30`)
      .all(subjectId,storageKey) as unknown as FeedbackRow[];
    return rows.reverse().filter(row=>row.change!=='wait'&&row.change!=='resume')
      .map(row=>({change:row.change as StrategyFeedbackChange,detail:row.detail,createdAtMs:row.created}));
  }

  strategyForFrontend(subjectId:string,purpose:string,context:{storageKey?:string;characterId?:string;sessionId?:string;advanced?:boolean}={}):FrontendStrategy|null {
    subjectId=id(subjectId);purpose=text(purpose,200);const storageKey=context.storageKey===undefined?purpose:text(context.storageKey,500);const controls=readProfileControls(this.db,subjectId);
    if(!controls.personalizationEnabled)return null;
    const row=this.db.prepare(`SELECT id,profile_revision,controls_revision,body FROM user_model_strategies
      WHERE subject=? AND purpose=? AND status='active' ORDER BY rowid DESC LIMIT 1`).get(subjectId,storageKey) as StrategyRow|undefined;
    if(!row||row.profile_revision!==this.profileRevision(subjectId)||row.controls_revision!==controls.revision)return null;
    const strategy=JSON.parse(row.body) as CommunicationStrategy&{contextScope?:{characterId:string|null;sessionId:string|null}};
    if(strategy.purpose!==purpose)return null;
    const stored=strategy.contextScope??{characterId:null,sessionId:null};
    if(stored.characterId!==(context.characterId??null)||stored.sessionId!==(context.sessionId??null))return null;
    const entries=this.listEntries(subjectId,{purpose:'strategy',taskPurpose:purpose,characterId:context.characterId,sessionId:context.sessionId,advanced:context.advanced});
    const allowed=new Map(entries.map(entry=>[entry.id,entry.revision]));
    const cited=new Set([...strategy.knownFacts,...strategy.uncertainFacts].map(fact=>fact.entryId));
    if([...cited].some(entryId=>strategy.sourceVersions.entryRevisions[entryId]===undefined))return null;
    if(Object.entries(strategy.sourceVersions.entryRevisions).some(([entryId,revision])=>allowed.get(entryId)!==revision))return null;
    return frontend(row.id,context.advanced===false?strategy:groundStrategy(strategy,entries));
  }

  private recomputeEntries(subjectId:string,nowMs:number,advanced:boolean):void {
    const rows=this.db.prepare('SELECT id,subject,semantic_key,category,body,status,corrected,revision,updated FROM user_profile_entries WHERE subject=?')
      .all(subjectId) as unknown as EntryRow[];
    for(const row of rows) {
      const override=this.override(row.id);
      const candidate=JSON.parse(row.body) as ProfileCandidate;
      const allEvidence=this.evidence(subjectId,row.id);
      const preferred=allEvidence.filter(item=>item.polarity==='support')
        .sort((a,b)=>compareCandidates(a.candidate,b.candidate)||a.acceptedAtMs-b.acceptedAtMs).at(-1);
      const attribution=preferred?.candidate.attribution??candidate.attribution;
      const evidence=allEvidence.filter(item=>item.candidate.attribution===attribution);
      const counterTime=Math.max(-1,...evidence.filter(item=>item.polarity==='counter').map(item=>item.acceptedAtMs));
      const supporting=evidence.filter(item=>item.polarity==='support'&&item.acceptedAtMs>counterTime);
      // A model-supplied occurrence time cannot manufacture independent observations.
      const supportedDays=new Set(supporting.map(item=>Math.floor(item.acceptedAtMs/86_400_000)));
      const inferredPattern=(candidate.category==='habit'||candidate.category==='hypothesis')&&
        !supporting.some(item=>item.candidate.basis==='explicit');
      const supported=supporting.length>0&&(!inferredPattern||(supporting.length>=3&&supportedDays.size>=3));
      const scopes=intersectCandidateScopes(supporting.map(item=>item.candidate));
      const status=override?.status==='deleted'?'deleted':override?.status==='corrected'||
        (scopes&&(advanced?supported:evidence.some(item=>item.polarity==='support')))?'active':'invalid';
      const corrected=override?.status==='corrected'?1:0;
      const newest=supporting.sort((a,b)=>compareCandidates(a.candidate,b.candidate)||a.acceptedAtMs-b.acceptedAtMs).at(-1);
      const body=override?.status==='corrected'&&override.body?override.body:
        newest?JSON.stringify({...newest.candidate,...(scopes??{})}):preferred?JSON.stringify(preferred.candidate):row.body;
      const category=(JSON.parse(body) as ProfileCandidate).category;
      if(status!==row.status||corrected!==row.corrected||body!==row.body||category!==row.category)
        this.db.prepare('UPDATE user_profile_entries SET category=?,body=?,status=?,corrected=?,revision=revision+1,updated=? WHERE id=?')
          .run(category,body,status,corrected,nowMs,row.id);
    }
  }

  private entry(row:EntryRow):ProfileEntry {
    const value=JSON.parse(row.body) as ProfileCandidate;
    const evidence=this.evidence(row.subject,row.id).filter(item=>item.candidate.attribution===value.attribution);
    const references=this.db.prepare(`SELECT DISTINCT source_scope,source_id,source_revision,polarity FROM user_profile_evidence
      WHERE subject=? AND entry_id=? ORDER BY source_scope,source_id,source_revision,polarity`).all(row.subject,row.id) as
      {source_scope:string;source_id:string;source_revision:number;polarity:'support'|'counter'}[];
    return {id:row.id,subjectId:row.subject,key:value.key,category:value.category,attribution:value.attribution,basis:value.basis,
      theme:value.theme??themeFor(value.category),
      claim:value.claim,occurredAtMs:value.occurredAtMs,validFromMs:value.validFromMs,validUntilMs:value.validUntilMs,
      purposes:value.purposes,characterIds:value.characterIds,sessionIds:value.sessionIds,confidenceBasis:value.confidenceBasis,
      evidenceReferences:references.map(ref=>({sourceId:ref.source_id,sourceRevision:ref.source_revision,
        sourceScope:JSON.parse(ref.source_scope.startsWith('reflection:')?ref.source_scope.slice(11,-65):ref.source_scope) as SceneScope,
        polarity:ref.polarity})),
      supportCount:evidence.filter(item=>item.polarity==='support').length,counterCount:evidence.filter(item=>item.polarity==='counter').length,
      corrected:row.corrected===1,status:row.status as ProfileEntry['status'],
      revision:row.revision,updatedAtMs:row.updated};
  }
  private evidence(subjectId:string,entryId:string):{polarity:'support'|'counter';acceptedAtMs:number;candidate:ProfileCandidate}[] {
    const rows=this.db.prepare(`SELECT entry_id,source_id,source_revision,candidate_key,polarity,body
      FROM user_profile_evidence WHERE subject=? AND entry_id=? ORDER BY source_id,source_revision,candidate_key,polarity`)
      .all(subjectId,entryId) as unknown as EvidenceRow[];
    const unique=new Map<string,{polarity:'support'|'counter';acceptedAtMs:number;candidate:ProfileCandidate;reflectedAtMs:number}>();
    for(const row of rows) {
      const key=JSON.stringify([row.source_id,row.source_revision,row.candidate_key,row.polarity]);
      const body=JSON.parse(row.body) as {candidate:ProfileCandidate;acceptedAtMs:number;reflectedAtMs?:number};
      const previous=unique.get(key);
      if(previous&&(compareCandidates(previous.candidate,body.candidate)>0||
        compareCandidates(previous.candidate,body.candidate)===0&&previous.reflectedAtMs>=(body.reflectedAtMs??0)))continue;
      unique.set(key,{polarity:row.polarity,acceptedAtMs:body.acceptedAtMs,candidate:body.candidate,reflectedAtMs:body.reflectedAtMs??0});
    }
    return [...unique.values()];
  }
  private entryRow(entryId:string):EntryRow|undefined {
    return this.db.prepare('SELECT id,subject,semantic_key,category,body,status,corrected,revision,updated FROM user_profile_entries WHERE id=?')
      .get(entryId) as EntryRow|undefined;
  }
  private hasApplicableScope(entry:ProfileEntry,context:{characterId?:string;sessionId?:string}):boolean {
    const override=this.override(entry.id);
    const authorization=override?.status==='corrected'&&override.body?
      (JSON.parse(override.body) as {scopeAuthorization?:{characterIds?:boolean;sessionIds?:boolean}}).scopeAuthorization:undefined;
    return (!context.characterId||entry.characterIds.length>0||authorization?.characterIds===true)&&
      (!context.sessionId||entry.sessionIds.length>0||authorization?.sessionIds===true);
  }
  private candidateIdentity(subjectId:string,candidate:ProfileCandidate):{semanticKey:string;entryId:string} {
    const base=`${candidate.category}:${candidate.key}`;
    const legacyId=hash([subjectId,base]),legacy=this.entryRow(legacyId);
    const scopes=(item:ProfileCandidate)=>[item.characterIds,item.sessionIds,item.purposes].map(values=>[...values].sort());
    if(legacy){
      const old=JSON.parse(legacy.body) as ProfileCandidate;
      const same=JSON.stringify(scopes(old))===JSON.stringify(scopes(candidate));
      const override=this.override(legacyId);
      const covers=([old.characterIds,old.sessionIds,old.purposes]).every((values,index)=>
        !values.length||scopes(candidate)[index]!.length>0&&scopes(candidate)[index]!.every(value=>values.includes(value)));
      if(same||override&&covers)return {semanticKey:base,entryId:legacyId};
    }
    const dimensions=scopes(candidate);
    const semanticKey=dimensions.some(values=>values.length)?JSON.stringify(['scoped-profile-v1',base,...dimensions]):base;
    return {semanticKey,entryId:hash([subjectId,semanticKey])};
  }
  private override(entryId:string):OverrideRow|undefined {
    return this.db.prepare('SELECT status,body FROM user_profile_overrides WHERE entry_id=?').get(entryId) as OverrideRow|undefined;
  }
  private bumpProfileIfChanged(subjectId:string,before:string,nowMs:number):boolean {
    if(before===currentProfileSnapshot(this.db,subjectId))return false;
    this.db.prepare(`INSERT INTO user_profile_state(subject,revision,updated) VALUES(?,1,?)
      ON CONFLICT(subject) DO UPDATE SET revision=revision+1,updated=excluded.updated`).run(subjectId,nowMs);
    return true;
  }
  private invalidateStrategies(subjectId:string):number {
    return Number(this.db.prepare("UPDATE user_model_strategies SET status='invalid' WHERE subject=? AND status='active'").run(subjectId).changes);
  }
  private invalidateReflectionsForEntry(subjectId:string,entryId:string):void {
    const rows=this.db.prepare('SELECT source_scope,fingerprint,actions FROM user_profile_reflections WHERE subject=?')
      .all(subjectId) as {source_scope:string;fingerprint:string;actions:string}[];
    for(const row of rows){
      const actions=JSON.parse(row.actions) as ProfileMergeAction[];
      if(!actions.some(action=>action.targetEntryId===entryId||action.candidate&&this.candidateIdentity(subjectId,action.candidate).entryId===entryId))continue;
      this.db.prepare('DELETE FROM user_profile_evidence WHERE subject=? AND source_scope=?')
        .run(subjectId,`reflection:${row.source_scope}:${row.fingerprint}`);
      this.db.prepare('DELETE FROM user_profile_reflections WHERE subject=? AND source_scope=? AND fingerprint=?')
        .run(subjectId,row.source_scope,row.fingerprint);
    }
  }
  private transaction<T>(work:()=>T):T {
    const savepoint=`user_model_${this.savepointSequence++}`;this.db.exec(`SAVEPOINT ${savepoint}`);
    try{const result=work();this.db.exec(`RELEASE ${savepoint}`);return result;}
    catch(error){this.db.exec(`ROLLBACK TO ${savepoint}`);this.db.exec(`RELEASE ${savepoint}`);throw error;}
  }
}

function currentProfileSnapshot(db:DatabaseSync,subjectId:string):string {
  const entries=db.prepare('SELECT id,category,body,status,corrected,revision FROM user_profile_entries WHERE subject=? ORDER BY id').all(subjectId);
  // Branches may carry the same accepted source. Keep every scope as provenance,
  // but do not turn the duplicated projection into new behavioral evidence.
  const evidence=db.prepare(`SELECT DISTINCT entry_id,source_id,source_revision,candidate_key,polarity,body
    FROM user_profile_evidence WHERE subject=? ORDER BY entry_id,source_id,source_revision,candidate_key,polarity,body`).all(subjectId);
  return JSON.stringify({entries,evidence});
}
function groundStrategy(strategy:CommunicationStrategy,entries:readonly ProfileEntry[]):CommunicationStrategy {
  const byId=new Map(entries.map(entry=>[entry.id,entry]));
  const known:CommunicationStrategy['knownFacts']=[],uncertain:CommunicationStrategy['uncertainFacts']=[];
  const seen=new Set<string>();
  for(const fact of [...strategy.knownFacts,...strategy.uncertainFacts]){
    if(seen.has(fact.entryId))continue;
    const entry=byId.get(fact.entryId);
    if(!entry)continue;
    seen.add(fact.entryId);
    const target=(entry.category==='hypothesis'||entry.basis==='inferred'||entry.basis==='planned'||
      strategy.uncertainFacts.some(item=>item.entryId===fact.entryId))?uncertain:known;
    target.push({entryId:entry.id,text:fact.text});
  }
  return {...strategy,knownFacts:known,uncertainFacts:uncertain};
}
function applyFeedback(strategy:CommunicationStrategy,feedback:readonly StrategyFeedback[]):CommunicationStrategy {
  const result:CommunicationStrategy=structuredClone(strategy);
  for(const item of feedback){
    if(item.change==='shorter')result.length='short';
    if(item.change==='longer')result.length='long';
    if(item.change==='fewer_questions'||item.change==='repeated_question')result.questionBudget=0;
    if(item.change==='repeated_question')result.avoidRepeating=[...new Set([...result.avoidRepeating,item.detail])].slice(0,20);
    if(item.change==='avoid_topic'){
      result.allowedTopics=result.allowedTopics.filter(topic=>!topic.includes(item.detail));
      result.avoidRepeating=[...new Set([...result.avoidRepeating,`不要主动提及：${item.detail}`])].slice(0,20);
    }
    if(item.change==='allow_topic'){
      result.avoidRepeating=result.avoidRepeating.filter(value=>value!==`不要主动提及：${item.detail}`);
      if(!result.allowedTopics.includes(item.detail))result.allowedTopics=[...result.allowedTopics,item.detail].slice(0,20);
    }
  }
  return result;
}
function feedbackTarget(storageKey:string):string {
  let value:unknown;
  try{value=JSON.parse(storageKey);}catch{throw new Error('invalid_profile_feedback_scope');}
  if(!Array.isArray(value)||value.length!==3||value[0]!=='xldb-user-model-strategy-v1'||typeof value[2]!=='string')
    throw new Error('invalid_profile_feedback_scope');
  return text(value[2],500);
}
function frontend(strategyId:string,strategy:CommunicationStrategy):FrontendStrategy {
  return {strategyId,purpose:strategy.purpose,supportMode:strategy.supportMode,allowedTopics:strategy.allowedTopics,
    knownFacts:strategy.knownFacts,uncertainFacts:strategy.uncertainFacts,tone:strategy.tone,length:strategy.length,
    questionBudget:strategy.questionBudget,avoidRepeating:strategy.avoidRepeating,stopConditions:strategy.stopConditions,
    sourceVersions:strategy.sourceVersions};
}
function validateSource(value:ProfileProjectionSource):ProfileProjectionSource {
  id(value.id);assertRevision(value.revision);text(value.text,20000);time(value.acceptedAtMs);return value;
}
function validateCandidate(value:ProfileCandidate,sourceText:string):ProfileCandidate {
  if(!value||typeof value!=='object'||!sourceText.includes(text(value.evidence,500)))throw new Error('profile_evidence_not_in_source');
  singleCategory(value.category);id(value.key);text(value.claim,1000);
  if(value.theme!==undefined&&!profileThemes.includes(value.theme))throw new Error('invalid_profile_theme');
  if(!['real_user','roleplay','quoted_third_party','uncertain'].includes(value.attribution)||!['explicit','observed','inferred','planned'].includes(value.basis)||
    !['support','counter'].includes(value.polarity))throw new Error('invalid_profile_candidate');
  nullableTime(value.occurredAtMs);nullableTime(value.validFromMs);nullableTime(value.validUntilMs);
  stringArray(value.purposes,20,100);stringArray(value.characterIds,50,200);stringArray(value.sessionIds,50,200);stringArray(value.confidenceBasis,20,300);
  return structuredClone(value);
}
function compareCandidates(next:ProfileCandidate,current:ProfileCandidate):number {
  const attribution={roleplay:0,quoted_third_party:0,uncertain:1,real_user:2};
  if(attribution[next.attribution]!==attribution[current.attribution])return attribution[next.attribution]-attribution[current.attribution];
  const rank={planned:0,inferred:1,observed:2,explicit:3};return rank[next.basis]-rank[current.basis];
}
function themeFor(category:ProfileCandidate['category']):ProfileEntry['theme'] {
  if(category==='experience')return 'life_background';
  if(category==='schedule'||category==='habit')return 'daily_routine';
  if(category==='preference')return 'communication';
  if(category==='current_context')return 'support';
  if(category==='hypothesis')return 'other';
  return 'other';
}
function narrow(next:string[],current?:string[]):string[] {
  if(!current?.length)return next;
  if(!next.length)return current;
  const shared=next.filter(item=>current.includes(item));
  if(!shared.length)throw new Error('invalid_profile_scope');
  return shared;
}
function intersectCandidateScopes(candidates:ProfileCandidate[]):Pick<ProfileCandidate,'purposes'|'characterIds'|'sessionIds'>|null {
  try{return candidates.reduce<Pick<ProfileCandidate,'purposes'|'characterIds'|'sessionIds'>>((scope,candidate)=>({purposes:narrow(scope.purposes,candidate.purposes),
    characterIds:narrow(scope.characterIds,candidate.characterIds),sessionIds:narrow(scope.sessionIds,candidate.sessionIds)}),
  {purposes:[],characterIds:[],sessionIds:[]});}catch{return null;}
}
function singleCategory(value:unknown):ProfileCandidate['category'] {const result=validateCategories([value]);return result[0]!;}
function hash(value:unknown):string{return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
function boolean(value:unknown,fallback:boolean):boolean {if(value===undefined)return fallback;if(typeof value!=='boolean')throw new Error('invalid_profile_controls');return value;}
function id(value:unknown):string{return text(value,200);}
function text(value:unknown,max:number):string {if(typeof value!=='string'||!value.trim()||value.length>max)throw new Error('invalid_profile_value');return value.trim();}
function optionalText(value:unknown,max:number):string {if(typeof value!=='string'||value.length>max)throw new Error('invalid_profile_feedback');return value.trim();}
function stringArray(value:unknown,max:number,itemMax:number):string[]{if(!Array.isArray(value)||value.length>max)throw new Error('invalid_profile_value');return [...new Set(value.map(item=>text(item,itemMax)))];}
function time(value:unknown):number {if(!Number.isSafeInteger(value)||(value as number)<0)throw new Error('invalid_profile_time');return value as number;}
function nullableTime(value:unknown):number|null{return value===null||value===undefined?null:time(value);}
function assertRevision(value:unknown):asserts value is number {if(!Number.isSafeInteger(value)||(value as number)<0)throw new Error('invalid_profile_revision');}

import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {ensureUserModelSchema,readProfileControls,writeProfileControls} from '../user-model/schema.ts';
import type {FrontendStrategy,ProfileControls} from '../user-model/types.ts';
import {validateContactWindows,validateDate,validateTimeZone} from './time.ts';
import type {CompanionActivity,CompanionBasis,CompanionDecision,CompanionDelivery,CompanionOpportunity,CompanionState,ConfirmedContactDelivery,
  CompanionStatus,ContactException,ContactSettings,DeliveryClaim,OpportunityClaim,QuietExceptionBinding,QuietExceptionStatus,
  ScheduleOpportunityInput} from './types.ts';

interface ContactRow {subject:string;revision:number;time_zone:string;windows:string;exceptions:string;minimum_interval:number;max_unanswered:number;updated:number}
interface ActivityRow {subject:string;revision:number;semantic_ready_revision:number;last_user_activity:number|null;busy_until:number|null;unanswered_count:number;last_sent:number|null}
interface StateRow {subject:string;target:string;state:CompanionState;revision:number;opportunity_id:string|null;reason:string|null;next_check:number|null;updated:number}
interface OpportunityRow {
  id:string;subject:string;target:string;kind:CompanionOpportunity['kind'];purpose:string;topic:string;basis:string;occurrence_id:string;
  source_version:number;profile_revision:number;activity_revision:number;controls_revision:number;contact_revision:number;
  check_at:number;window_start:number;window_end:number;expires_at:number;status:CompanionOpportunity['status'];defer_count:number;
  decision:CompanionOpportunity['decision'];strategy:string|null;claim_token:string|null;claim_until:number|null;created:number;updated:number;
}
interface DeliveryRow {
  id:string;opportunity_id:string;subject:string;target:string;body:string;status:CompanionDelivery['status'];source_version:number;
  profile_revision:number;activity_revision:number;controls_revision:number;contact_revision:number;claim_token:string|null;
  claim_until:number|null;host:string|null;host_message_id:string|null;result_code:string|null;created:number;updated:number;
}
interface QuietExceptionRow {
  delivery_id:string;subject:string;target:string;scope_key:string;commitment_id:string;commitment_revision:number;
  window_key:string;source_id:string;source_revision:number;status:'reserved'|'consumed'|'released';updated:number;
}

export class CompanionStore {
  private db:DatabaseSync;
  private savepointSequence=0;
  constructor(db:DatabaseSync){this.db=db;ensureUserModelSchema(db);this.ensureSchema();}

  controls(subjectId:string):ProfileControls{return readProfileControls(this.db,id(subjectId));}

  setControls(subjectId:string,patch:{proactiveCompanionEnabled?:boolean;scheduledWakeEnabled?:boolean},expectedRevision:number,nowMs=Date.now()):ProfileControls {
    subjectId=id(subjectId);assertRevision(expectedRevision);nowMs=time(nowMs);
    if(patch.proactiveCompanionEnabled===undefined&&patch.scheduledWakeEnabled===undefined)throw new Error('invalid_companion_controls');
    return this.transaction(()=>{
      const current=readProfileControls(this.db,subjectId);if(current.revision!==expectedRevision)throw new Error('context_changed_retry');
      const proactive=flag(patch.proactiveCompanionEnabled,current.proactiveCompanionEnabled);
      const scheduled=flag(patch.scheduledWakeEnabled,current.scheduledWakeEnabled);
      if(scheduled&&!proactive)throw new Error('invalid_scheduled_wake_without_proactive');
      const next={...current,proactiveCompanionEnabled:proactive,scheduledWakeEnabled:scheduled,revision:current.revision+1,updatedAtMs:nowMs};
      writeProfileControls(this.db,next);
      if(!proactive) {
        this.cancelUnsent(subjectId,'proactive_disabled',nowMs);
        for(const row of this.states(subjectId))this.writeState(subjectId,row.target,this.hasUncertainDelivery(subjectId,row.target)?'suspended':'disabled',
          null,'proactive_disabled',null,nowMs);
      } else {
        for(const row of this.states(subjectId))if(row.state==='disabled')this.writeState(subjectId,row.target,'waiting',null,'enabled',null,nowMs);
      }
      return next;
    });
  }

  contactSettings(subjectId:string):ContactSettings {
    subjectId=id(subjectId);const row=this.db.prepare(`SELECT subject,revision,time_zone,windows,exceptions,minimum_interval,max_unanswered,updated
      FROM companion_contact_settings WHERE subject=?`).get(subjectId) as ContactRow|undefined;
    return row?contactOf(row):{subjectId,revision:0,timeZone:'UTC',windows:[],exceptions:[],minimumIntervalMs:4*3_600_000,maxUnanswered:2,updatedAtMs:0};
  }

  setContactSettings(subjectId:string,patch:{timeZone?:string;windows?:unknown;exceptions?:unknown;minimumIntervalMs?:number;maxUnanswered?:number},
    expectedRevision:number,nowMs=Date.now()):ContactSettings {
    subjectId=id(subjectId);assertRevision(expectedRevision);nowMs=time(nowMs);
    return this.transaction(()=>{
      const current=this.contactSettings(subjectId);if(current.revision!==expectedRevision)throw new Error('context_changed_retry');
      const timeZone=patch.timeZone??current.timeZone;validateTimeZone(timeZone);
      const windows=patch.windows===undefined?current.windows:validateContactWindows(patch.windows);
      const exceptions=patch.exceptions===undefined?current.exceptions:validateExceptions(patch.exceptions);
      const minimumIntervalMs=patch.minimumIntervalMs??current.minimumIntervalMs;
      if(!Number.isSafeInteger(minimumIntervalMs)||minimumIntervalMs<60_000||minimumIntervalMs>30*86_400_000)throw new Error('invalid_contact_interval');
      const maxUnanswered=patch.maxUnanswered??current.maxUnanswered;
      if(!Number.isSafeInteger(maxUnanswered)||maxUnanswered<0||maxUnanswered>20)throw new Error('invalid_contact_unanswered');
      const next:ContactSettings={subjectId,revision:current.revision+1,timeZone,windows,exceptions,minimumIntervalMs,maxUnanswered,updatedAtMs:nowMs};
      this.db.prepare(`INSERT INTO companion_contact_settings VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(subject) DO UPDATE SET revision=excluded.revision,time_zone=excluded.time_zone,windows=excluded.windows,
        exceptions=excluded.exceptions,minimum_interval=excluded.minimum_interval,max_unanswered=excluded.max_unanswered,updated=excluded.updated`)
        .run(subjectId,next.revision,timeZone,JSON.stringify(windows),JSON.stringify(exceptions),minimumIntervalMs,maxUnanswered,nowMs);
      this.cancelUnsent(subjectId,'contact_settings_changed',nowMs);
      return next;
    });
  }

  activity(subjectId:string):CompanionActivity {
    subjectId=id(subjectId);const row=this.db.prepare(`SELECT subject,revision,semantic_ready_revision,last_user_activity,busy_until,unanswered_count,last_sent
      FROM companion_activity WHERE subject=?`).get(subjectId) as ActivityRow|undefined;
    return row?activityOf(row):{subjectId,revision:0,semanticReadyRevision:0,lastUserActivityAtMs:null,busyUntilMs:null,unansweredCount:0,lastSentAtMs:null};
  }

  recordUserActivity(subjectId:string,atMs=Date.now()):CompanionActivity {
    subjectId=id(subjectId);atMs=time(atMs);
    return this.transaction(()=>{
      const current=this.activity(subjectId),next={...current,revision:current.revision+1,semanticReadyRevision:-1,
        lastUserActivityAtMs:atMs,busyUntilMs:current.busyUntilMs&&current.busyUntilMs>atMs?current.busyUntilMs:null,unansweredCount:0};
      this.writeActivity(next);this.cancelUnsent(subjectId,'user_activity',atMs);
      const controls=readProfileControls(this.db,subjectId);
      for(const row of this.states(subjectId))this.writeState(subjectId,row.target,controls.proactiveCompanionEnabled?'suspended':'disabled',
        null,'semantic_processing_pending',null,atMs);
      return next;
    });
  }

  markSemanticReady(subjectId:string,activityRevision:number,nowMs=Date.now()):CompanionActivity {
    subjectId=id(subjectId);assertRevision(activityRevision);nowMs=time(nowMs);
    return this.transaction(()=>{
      const current=this.activity(subjectId);if(current.revision!==activityRevision)throw new Error('context_changed_retry');
      const next={...current,semanticReadyRevision:activityRevision};this.writeActivity(next);
      const controls=readProfileControls(this.db,subjectId);
      if(controls.proactiveCompanionEnabled&&!this.hasUnknown(subjectId))for(const row of this.states(subjectId))
        if(row.state==='suspended'&&row.reason==='semantic_processing_pending')this.writeState(subjectId,row.target,'waiting',null,'semantic_ready',row.next_check,nowMs);
      return next;
    });
  }

  setBusyUntil(subjectId:string,busyUntilMs:number|null,expectedActivityRevision:number,nowMs=Date.now()):CompanionActivity {
    subjectId=id(subjectId);assertRevision(expectedActivityRevision);nowMs=time(nowMs);if(busyUntilMs!==null)time(busyUntilMs);
    return this.transaction(()=>{
      const current=this.activity(subjectId);if(current.revision!==expectedActivityRevision)throw new Error('context_changed_retry');
      const revision=current.revision+1,next={...current,revision,semanticReadyRevision:revision,busyUntilMs};
      this.writeActivity(next);this.cancelUnsent(subjectId,'busy_changed',nowMs);return next;
    });
  }

  schedule(input:ScheduleOpportunityInput):CompanionOpportunity|null {
    const subjectId=id(input.subjectId),targetId=id(input.targetId),opportunityKey=id(input.opportunityKey),nowMs=time(input.nowMs??Date.now());
    assertRevision(input.sourceVersion);const purpose=text(input.purpose,200),topic=text(input.topic,500),basis=validateBasis(input.basis,input.kind);
    return this.transaction(()=>{
      const controls=readProfileControls(this.db,subjectId);if(!controls.proactiveCompanionEnabled)throw new Error('proactive_companion_disabled');
      if(this.hasUnknown(subjectId))return null;
      const activity=this.activity(subjectId);if(activity.semanticReadyRevision!==activity.revision)throw new Error('companion_semantic_pending');
      const settings=this.contactSettings(subjectId);
      const checkAtMs=Math.max(nowMs,input.notBeforeMs===undefined?0:time(input.notBeforeMs),activity.busyUntilMs??0);
      // The former contact windows and frequency fields remain readable for old data, but do not authorize or limit contact.
      const expiresAtMs=input.expiresAtMs===undefined?checkAtMs+86_400_000:time(input.expiresAtMs);
      if(expiresAtMs<=checkAtMs)return null;
      const profileRevision=this.profileRevision(subjectId);
      const occurrenceId=hash([subjectId,targetId,opportunityKey,input.kind]);
      // Accepting our own delivery changes the scene version, but does not create
      // another reason to send the same opportunity. New source revisions and
      // scheduler wakes already have distinct caller-supplied opportunity keys.
      const consumed=this.db.prepare("SELECT * FROM companion_opportunities WHERE subject=? AND target=? AND occurrence_id=? AND status='consumed' LIMIT 1")
        .get(subjectId,targetId,occurrenceId) as OpportunityRow|undefined;
      if(consumed)return opportunityOf(consumed);
      const opportunityId=hash([subjectId,targetId,opportunityKey,input.kind,occurrenceId,input.sourceVersion,
        profileRevision,activity.revision,controls.revision,settings.revision]);
      const existing=this.opportunityRow(opportunityId);if(existing)return opportunityOf(existing);
      this.db.prepare(`INSERT INTO companion_opportunities
        (id,subject,target,kind,purpose,topic,basis,occurrence_id,source_version,profile_revision,activity_revision,controls_revision,contact_revision,
        check_at,window_start,window_end,expires_at,status,defer_count,decision,strategy,claim_token,claim_until,created,updated)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'waiting',0,NULL,NULL,NULL,NULL,?,?)`)
        .run(opportunityId,subjectId,targetId,input.kind,purpose,topic,JSON.stringify(basis),occurrenceId,input.sourceVersion,
          profileRevision,activity.revision,controls.revision,settings.revision,checkAtMs,checkAtMs,expiresAtMs,expiresAtMs,nowMs,nowMs);
      this.writeState(subjectId,targetId,'waiting',opportunityId,'scheduled',checkAtMs,nowMs);
      return opportunityOf(this.opportunityRow(opportunityId)!);
    });
  }

  due(subjectId:string,trigger:'event'|'scheduled',nowMs=Date.now(),limit=20):CompanionOpportunity[] {
    subjectId=id(subjectId);nowMs=time(nowMs);if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error('invalid_companion_limit');
    const controls=readProfileControls(this.db,subjectId);if(!controls.proactiveCompanionEnabled||(trigger==='scheduled'&&!controls.scheduledWakeEnabled))return [];
    const activity=this.activity(subjectId);if(activity.semanticReadyRevision!==activity.revision||(activity.busyUntilMs??0)>nowMs||this.hasUnknown(subjectId))return [];
    const contact=this.contactSettings(subjectId),profileRevision=this.profileRevision(subjectId);
    const rows=this.db.prepare(`SELECT * FROM companion_opportunities WHERE subject=? AND status IN ('waiting','deferred','evaluating')
      AND check_at<=? AND window_start<=? AND window_end>=? AND expires_at>=? ORDER BY check_at,id LIMIT ?`)
      .all(subjectId,nowMs,nowMs,nowMs,nowMs,limit) as unknown as OpportunityRow[];
    return rows.filter(row=>row.controls_revision===controls.revision&&row.contact_revision===contact.revision&&
      row.profile_revision===profileRevision&&row.activity_revision===activity.revision&&
      (row.status!=='evaluating'||row.claim_until===null||row.claim_until<=nowMs)).map(opportunityOf);
  }

  claim(opportunityId:string,owner:string,currentSourceVersion:number,nowMs=Date.now(),leaseMs=60_000):OpportunityClaim {
    opportunityId=id(opportunityId);owner=id(owner);assertRevision(currentSourceVersion);nowMs=time(nowMs);lease(leaseMs);
    return this.transaction(()=>{
      const row=this.opportunityRow(opportunityId);if(!row)throw new Error('companion_opportunity_not_found');
      this.assertOpportunityCurrent(row,currentSourceVersion,nowMs);
      if(!['waiting','deferred','evaluating'].includes(row.status))throw new Error('companion_opportunity_unavailable');
      if(row.status==='evaluating'&&(row.claim_until??0)>nowMs)throw new Error('companion_opportunity_claimed');
      if(nowMs<row.check_at)throw new Error('companion_opportunity_not_due');
      if(nowMs>row.window_end||nowMs>row.expires_at){this.dismissExpired(row,nowMs);throw new Error('companion_opportunity_expired');}
      const claimToken=randomUUID(),claimUntilMs=nowMs+leaseMs;
      this.db.prepare("UPDATE companion_opportunities SET status='evaluating',claim_token=?,claim_until=?,updated=? WHERE id=?")
        .run(claimToken,claimUntilMs,nowMs,opportunityId);
      this.writeState(row.subject,row.target,'evaluating',row.id,`claimed:${owner}`,row.check_at,nowMs);
      return {opportunity:opportunityOf(this.opportunityRow(opportunityId)!),claimToken,claimUntilMs};
    });
  }

  decide(opportunityId:string,claimToken:string,decision:CompanionDecision,currentSourceVersion:number,nowMs=Date.now()):CompanionOpportunity {
    opportunityId=id(opportunityId);claimToken=id(claimToken);assertRevision(currentSourceVersion);nowMs=time(nowMs);
    return this.transaction(()=>{
      const row=this.opportunityRow(opportunityId);if(!row)throw new Error('companion_opportunity_not_found');
      this.assertClaim(row,claimToken,nowMs);this.assertOpportunityCurrent(row,currentSourceVersion,nowMs);
      if(decision.decision==='approve') {
        validateStrategy(decision.strategy,row);
        this.db.prepare("UPDATE companion_opportunities SET status='approved',decision='approve',strategy=?,claim_token=NULL,claim_until=NULL,updated=? WHERE id=?")
          .run(JSON.stringify(decision.strategy),nowMs,row.id);
        this.writeState(row.subject,row.target,'evaluating',row.id,'approved_generation_pending',null,nowMs);
      } else if(decision.decision==='defer') {
        const next=time(decision.nextCheckAtMs);text(decision.reason,300);
        if(next<=nowMs||next>row.window_end||next>row.expires_at||row.defer_count>=3)throw new Error('invalid_companion_defer');
        this.db.prepare("UPDATE companion_opportunities SET status='deferred',decision='defer',defer_count=defer_count+1,check_at=?,claim_token=NULL,claim_until=NULL,updated=? WHERE id=?")
          .run(next,nowMs,row.id);
        this.writeState(row.subject,row.target,'cooldown',row.id,decision.reason,next,nowMs);
      } else {
        text(decision.reason,300);
        this.db.prepare("UPDATE companion_opportunities SET status='dismissed',decision='dismiss',claim_token=NULL,claim_until=NULL,updated=? WHERE id=?")
          .run(nowMs,row.id);
        this.writeState(row.subject,row.target,'cooldown',row.id,decision.reason,null,nowMs);
      }
      return opportunityOf(this.opportunityRow(row.id)!);
    });
  }

  queueDelivery(opportunityId:string,body:string,currentSourceVersion:number,nowMs=Date.now(),
    quietExceptions:readonly QuietExceptionBinding[]=[]):CompanionDelivery {
    opportunityId=id(opportunityId);body=text(body,20_000);assertRevision(currentSourceVersion);nowMs=time(nowMs);
    const bindings=validateQuietBindings(quietExceptions);
    return this.transaction(()=>{
      const opportunity=this.opportunityRow(opportunityId);if(!opportunity)throw new Error('companion_opportunity_not_found');
      this.assertOpportunityCurrent(opportunity,currentSourceVersion,nowMs);
      if(opportunity.status!=='approved'||!opportunity.strategy)throw new Error('companion_opportunity_not_approved');
      const deliveryId=hash([opportunityId,body]);const existing=this.deliveryRow(deliveryId);
      if(existing){
        if(!sameQuietBindings(this.getDeliveryExceptionBindings(deliveryId),bindings))throw new Error('companion_quiet_exception_changed');
        return deliveryOf(existing);
      }
      this.db.prepare(`INSERT INTO companion_outbox
        (id,opportunity_id,subject,target,body,status,source_version,profile_revision,activity_revision,controls_revision,contact_revision,
        claim_token,claim_until,host,host_message_id,result_code,created,updated)
        VALUES(?,?,?,?,?,'ready',?,?,?,?,?,NULL,NULL,NULL,NULL,NULL,?,?)`)
        .run(deliveryId,opportunityId,opportunity.subject,opportunity.target,body,opportunity.source_version,opportunity.profile_revision,
          opportunity.activity_revision,opportunity.controls_revision,opportunity.contact_revision,nowMs,nowMs);
      for(const binding of bindings){
        const claimed=this.db.prepare(`SELECT status FROM companion_quiet_exceptions WHERE subject=? AND target=? AND scope_key=?
          AND commitment_id=? AND commitment_revision=? AND window_key=? AND status IN ('reserved','consumed') LIMIT 1`)
          .get(opportunity.subject,opportunity.target,binding.scopeKey,binding.commitmentId,binding.revision,binding.key);
        if(claimed)throw new Error('companion_quiet_exception_unavailable');
        this.db.prepare(`INSERT INTO companion_quiet_exceptions
          (delivery_id,subject,target,scope_key,commitment_id,commitment_revision,window_key,source_id,source_revision,status,updated)
          VALUES(?,?,?,?,?,?,?,?,?,'reserved',?)`)
          .run(deliveryId,opportunity.subject,opportunity.target,binding.scopeKey,binding.commitmentId,binding.revision,
            binding.key,binding.sourceId,binding.sourceRevision,nowMs);
      }
      return deliveryOf(this.deliveryRow(deliveryId)!);
    });
  }

  approveAndQueueDelivery(opportunityId:string,claimToken:string,strategy:FrontendStrategy,body:string,
    currentSourceVersion:number,nowMs=Date.now(),quietExceptions:readonly QuietExceptionBinding[]=[]):CompanionDelivery {
    return this.transaction(()=>{
      this.decide(opportunityId,claimToken,{decision:'approve',strategy},currentSourceVersion,nowMs);
      return this.queueDelivery(opportunityId,body,currentSourceVersion,nowMs,quietExceptions);
    });
  }

  quietExceptionStatus(subjectId:string,targetId:string,binding:QuietExceptionBinding):QuietExceptionStatus {
    subjectId=id(subjectId);targetId=id(targetId);const current=validateQuietBindings([binding])[0]!;
    const row=this.db.prepare(`SELECT status FROM companion_quiet_exceptions WHERE subject=? AND target=? AND scope_key=?
      AND commitment_id=? AND commitment_revision=? AND window_key=? AND status IN ('reserved','consumed') LIMIT 1`)
      .get(subjectId,targetId,current.scopeKey,current.commitmentId,current.revision,current.key) as {status:'reserved'|'consumed'}|undefined;
    return row?.status??'available';
  }

  getDeliveryExceptionBindings(deliveryId:string):QuietExceptionBinding[] {
    deliveryId=id(deliveryId);
    const rows=this.db.prepare('SELECT * FROM companion_quiet_exceptions WHERE delivery_id=? ORDER BY rowid')
      .all(deliveryId) as unknown as QuietExceptionRow[];
    return rows.map(row=>({scopeKey:row.scope_key,commitmentId:row.commitment_id,revision:row.commitment_revision,
      key:row.window_key,sourceId:row.source_id,sourceRevision:row.source_revision}));
  }

  claimDelivery(deliveryId:string,host:string,currentSourceVersion:number,nowMs=Date.now(),leaseMs=60_000,
    currentQuietExceptions?:()=>readonly QuietExceptionBinding[]|null):DeliveryClaim {
    deliveryId=id(deliveryId);host=id(host);assertRevision(currentSourceVersion);nowMs=time(nowMs);lease(leaseMs);
    const result=this.transaction(()=>{
      const row=this.deliveryRow(deliveryId);if(!row)throw new Error('companion_delivery_not_found');
      if(row.status==='unknown')throw new Error('companion_delivery_unknown');
      if(row.status==='sending'&&(row.claim_until??0)>nowMs)throw new Error('companion_delivery_claimed');
      if(row.status==='sending')return {unknown:this.finishDelivery(row,{status:'unknown',code:'claim_lease_expired'},nowMs)} as const;
      if(row.status!=='ready')throw new Error('companion_delivery_unavailable');
      this.assertDeliveryCurrent(row,currentSourceVersion,nowMs);
      if(!currentQuietExceptions&&this.getDeliveryExceptionBindings(deliveryId).length)
        throw new Error('companion_quiet_validation_required');
      const claimToken=randomUUID(),claimUntilMs=nowMs+leaseMs;
      this.db.prepare("UPDATE companion_outbox SET status='sending',claim_token=?,claim_until=?,host=?,updated=? WHERE id=?")
        .run(claimToken,claimUntilMs,host,nowMs,deliveryId);
      if(currentQuietExceptions){
        const current=currentQuietExceptions();
        if(current===null||!sameQuietBindings(this.getDeliveryExceptionBindings(deliveryId),validateQuietBindings(current))){
          this.db.prepare(`UPDATE companion_outbox SET status='cancelled',claim_token=NULL,claim_until=NULL,
            result_code='quiet_rule_changed',updated=? WHERE id=?`).run(nowMs,deliveryId);
          this.releaseQuietExceptions(deliveryId,nowMs);
          return {blocked:true} as const;
        }
      }
      return {claim:{delivery:deliveryOf(this.deliveryRow(deliveryId)!),claimToken,claimUntilMs}} as const;
    });
    if('unknown' in result)throw new Error('companion_delivery_unknown');
    if('blocked' in result)throw new Error('companion_quiet_exception_changed');
    return result.claim;
  }

  recordDelivery(deliveryId:string,claimToken:string,outcome:{status:'sent';hostMessageId:string}|{status:'failed';code:string}|{status:'unknown';code:string},
    nowMs=Date.now()):CompanionDelivery {
    deliveryId=id(deliveryId);claimToken=id(claimToken);nowMs=time(nowMs);
    return this.transaction(()=>{
      const row=this.deliveryRow(deliveryId);if(!row)throw new Error('companion_delivery_not_found');
      if(row.status==='host_committed'&&outcome.status==='sent'&&row.host_message_id===id(outcome.hostMessageId))return deliveryOf(row);
      if(row.status!=='sending'||row.claim_token!==claimToken)throw new Error('companion_delivery_claim_mismatch');
      return this.finishDelivery(row,outcome,nowMs);
    });
  }

  reconcileUnknown(deliveryId:string,outcome:{status:'sent';hostMessageId:string}|{status:'failed';code:string},nowMs=Date.now()):CompanionDelivery {
    deliveryId=id(deliveryId);nowMs=time(nowMs);
    return this.transaction(()=>{
      const row=this.deliveryRow(deliveryId);if(!row)throw new Error('companion_delivery_not_found');
      if(row.status!=='unknown')throw new Error('companion_delivery_not_unknown');
      return this.finishDelivery(row,outcome,nowMs);
    });
  }

  invalidateSources(subjectId:string,currentSourceVersion:number,targetIdsOrNow?:readonly string[]|number,atMs=Date.now()):void {
    subjectId=id(subjectId);assertRevision(currentSourceVersion);
    const targetIds=Array.isArray(targetIdsOrNow)?[...new Set(targetIdsOrNow.map(target=>id(target)))]:undefined;
    const nowMs=time(typeof targetIdsOrNow==='number'?targetIdsOrNow:atMs);
    if(targetIds?.length===0)return;
    this.transaction(()=>{
      const targetClause=targetIds?` AND target IN (${targetIds.map(()=>'?').join(',')})`:'';
      this.db.prepare(`UPDATE companion_opportunities SET status='cancelled',claim_token=NULL,claim_until=NULL,updated=?
        WHERE subject=? AND source_version<>?${targetClause} AND status IN ('waiting','deferred','evaluating','approved')`)
        .run(nowMs,subjectId,currentSourceVersion,...(targetIds??[]));
      this.db.prepare(`UPDATE companion_outbox SET status='cancelled',claim_token=NULL,claim_until=NULL,result_code='source_changed',updated=?
        WHERE subject=? AND source_version<>?${targetClause} AND status IN ('draft','ready')`)
        .run(nowMs,subjectId,currentSourceVersion,...(targetIds??[]));
      this.releaseCancelledQuietExceptions(subjectId,nowMs);
      const selected=targetIds?new Set(targetIds):null;
      for(const row of this.states(subjectId))if((!selected||selected.has(row.target))&&!this.hasUncertainDelivery(subjectId,row.target))
        this.writeState(subjectId,row.target,readProfileControls(this.db,subjectId).proactiveCompanionEnabled?'waiting':'disabled',null,'source_changed',null,nowMs);
    });
  }

  /** Apply profile/control/contact revisions changed through another same-DB module. */
  refreshControls(subjectId:string,nowMs=Date.now()):void {
    subjectId=id(subjectId);nowMs=time(nowMs);
    this.transaction(()=>{
      const controls=readProfileControls(this.db,subjectId),contact=this.contactSettings(subjectId),profileRevision=this.profileRevision(subjectId);
      const parameters=[subjectId,controls.revision,contact.revision,profileRevision] as const;
      const staleTargets=new Set<string>();
      for(const row of this.db.prepare(`SELECT DISTINCT target FROM companion_opportunities WHERE subject=?
        AND (controls_revision<>? OR contact_revision<>? OR profile_revision<>?)
        AND status IN ('waiting','deferred','evaluating','approved')`).all(...parameters) as {target:string}[])staleTargets.add(row.target);
      for(const row of this.db.prepare(`SELECT DISTINCT target FROM companion_outbox WHERE subject=?
        AND (controls_revision<>? OR contact_revision<>? OR profile_revision<>?) AND status IN ('draft','ready')`).all(...parameters) as {target:string}[])staleTargets.add(row.target);
      this.db.prepare(`UPDATE companion_opportunities SET status='cancelled',claim_token=NULL,claim_until=NULL,updated=? WHERE subject=?
        AND (controls_revision<>? OR contact_revision<>? OR profile_revision<>?) AND status IN ('waiting','deferred','evaluating','approved')`)
        .run(nowMs,...parameters);
      this.db.prepare(`UPDATE companion_outbox SET status='cancelled',claim_token=NULL,claim_until=NULL,result_code='controls_changed',updated=? WHERE subject=?
        AND (controls_revision<>? OR contact_revision<>? OR profile_revision<>?) AND status IN ('draft','ready')`)
        .run(nowMs,...parameters);
      this.releaseCancelledQuietExceptions(subjectId,nowMs);
      for(const row of this.states(subjectId))if(!controls.proactiveCompanionEnabled||staleTargets.has(row.target))
        this.writeState(subjectId,row.target,this.hasUncertainDelivery(subjectId,row.target)?'suspended':controls.proactiveCompanionEnabled?'waiting':'disabled',
          null,'controls_changed',null,nowMs);
    });
  }

  /** A revised relationship assessment invalidates unsent wording for this one companion. */
  cancelPendingForTarget(subjectId:string,targetId:string,reason='relationship_corrected',nowMs=Date.now()):void {
    subjectId=id(subjectId);targetId=id(targetId);reason=id(reason);nowMs=time(nowMs);
    this.transaction(()=>{
      this.db.prepare(`UPDATE companion_opportunities SET status='cancelled',claim_token=NULL,claim_until=NULL,updated=?
        WHERE subject=? AND target=? AND status IN ('waiting','deferred','evaluating','approved')`).run(nowMs,subjectId,targetId);
      this.db.prepare(`UPDATE companion_outbox SET status='cancelled',claim_token=NULL,claim_until=NULL,result_code=?,updated=?
        WHERE subject=? AND target=? AND status IN ('draft','ready')`).run(reason,nowMs,subjectId,targetId);
      this.releaseCancelledQuietExceptions(subjectId,nowMs);
      this.writeState(subjectId,targetId,this.hasUncertainDelivery(subjectId,targetId)?'suspended':
        readProfileControls(this.db,subjectId).proactiveCompanionEnabled?'waiting':'disabled',null,reason,null,nowMs);
    });
  }

  status(subjectId:string,targetId:string):CompanionStatus {
    subjectId=id(subjectId);targetId=id(targetId);const state=this.stateRow(subjectId,targetId),controls=readProfileControls(this.db,subjectId);
    const deliveries=(this.db.prepare(`SELECT id,status,host_message_id,result_code,updated FROM companion_outbox
      WHERE subject=? AND target=? ORDER BY rowid`).all(subjectId,targetId) as unknown as {id:string;status:CompanionDelivery['status'];host_message_id:string|null;result_code:string|null;updated:number}[])
      .map(row=>({deliveryId:row.id,status:row.status,hostMessageId:row.host_message_id,resultCode:row.result_code,updatedAtMs:row.updated}));
    return {subjectId,targetId,state:state?.state??(controls.proactiveCompanionEnabled?'waiting':'disabled'),revision:state?.revision??0,
      opportunityId:state?.opportunity_id??null,reason:state?.reason??null,nextCheckAtMs:state?.next_check??null,activity:this.activity(subjectId),deliveries};
  }

  getOpportunity(opportunityId:string):CompanionOpportunity|null {
    const row=this.opportunityRow(id(opportunityId));return row?opportunityOf(row):null;
  }

  getDelivery(deliveryId:string):CompanionDelivery|null {
    const row=this.deliveryRow(id(deliveryId));return row?deliveryOf(row):null;
  }

  /** Remove the derived text when its accepted scene source is deleted. Keep the receipt for deduplication. */
  redactDeliveryBody(deliveryId:string,subjectId:string,targetId:string):void {
    this.db.prepare("UPDATE companion_outbox SET body='' WHERE id=? AND subject=? AND target=? AND status='host_committed'")
      .run(id(deliveryId),id(subjectId),id(targetId));
  }

  /** Only actual host-confirmed sends can begin a wait-for-reply episode. */
  confirmedContactDeliveries(subjectId:string,targetId:string):ConfirmedContactDelivery[] {
    subjectId=id(subjectId);targetId=id(targetId);
    const rows=this.db.prepare(`SELECT o.id,o.body,o.host_message_id,o.updated,o.result_code,
      EXISTS(SELECT 1 FROM companion_quiet_exceptions q WHERE q.delivery_id=o.id AND q.status='consumed') AS quiet_exception
      FROM companion_outbox o WHERE o.subject=? AND o.target=? AND o.status='host_committed'
      ORDER BY o.updated,o.id`).all(subjectId,targetId) as unknown as
      {id:string;body:string;host_message_id:string;updated:number;result_code:string;quiet_exception:number}[];
    return rows.map(row=>({deliveryId:row.id,subjectId,targetId,body:row.body,hostMessageId:row.host_message_id,
      confirmedSentAtMs:row.updated,replyTimingKnown:row.result_code!=='sent_time_unknown',quietException:Boolean(row.quiet_exception)}));
  }

  private finishDelivery(row:DeliveryRow,outcome:{status:'sent';hostMessageId:string}|{status:'failed'|'unknown';code:string},nowMs:number):CompanionDelivery {
    if(outcome.status==='sent') {
      const hostMessageId=id(outcome.hostMessageId);
      this.db.prepare(`UPDATE companion_outbox SET status='host_committed',claim_token=NULL,claim_until=NULL,host_message_id=?,result_code=?,updated=? WHERE id=?`)
        .run(hostMessageId,row.status==='unknown'?'sent_time_unknown':'sent',nowMs,row.id);
      this.consumeQuietExceptions(row.id,nowMs);
      this.db.prepare("UPDATE companion_opportunities SET status='consumed',updated=? WHERE id=?").run(nowMs,row.opportunity_id);
      const activity=this.activity(row.subject),revision=activity.revision+1;
      this.writeActivity({...activity,revision,semanticReadyRevision:revision,unansweredCount:activity.unansweredCount+1,lastSentAtMs:nowMs});
      const enabled=readProfileControls(this.db,row.subject).proactiveCompanionEnabled;
      this.writeState(row.subject,row.target,enabled?'awaiting_reply':'disabled',row.opportunity_id,'host_committed',null,nowMs);
    } else {
      const code=id(outcome.code),status=outcome.status==='unknown'?'unknown':'failed';
      this.db.prepare('UPDATE companion_outbox SET status=?,claim_token=NULL,claim_until=NULL,result_code=?,updated=? WHERE id=?')
        .run(status,code,nowMs,row.id);
      if(status==='unknown')this.consumeQuietExceptions(row.id,nowMs);
      else this.releaseQuietExceptions(row.id,nowMs);
      this.writeState(row.subject,row.target,status==='unknown'?'suspended':'cooldown',row.opportunity_id,code,null,nowMs);
    }
    return deliveryOf(this.deliveryRow(row.id)!);
  }

  private assertOpportunityCurrent(row:OpportunityRow,currentSourceVersion:number,nowMs:number):void {
    const controls=readProfileControls(this.db,row.subject),contact=this.contactSettings(row.subject),activity=this.activity(row.subject);
    if(!controls.proactiveCompanionEnabled)throw new Error('proactive_companion_disabled');
    if(row.source_version!==currentSourceVersion||row.profile_revision!==this.profileRevision(row.subject)||row.activity_revision!==activity.revision||
      row.controls_revision!==controls.revision||row.contact_revision!==contact.revision)throw new Error('context_changed_retry');
    if(activity.semanticReadyRevision!==activity.revision)throw new Error('companion_semantic_pending');
    if((activity.busyUntilMs??0)>nowMs)throw new Error('companion_busy');
  }
  private assertDeliveryCurrent(row:DeliveryRow,currentSourceVersion:number,nowMs:number):void {
    const opportunity=this.opportunityRow(row.opportunity_id);if(!opportunity)throw new Error('companion_opportunity_not_found');
    this.assertOpportunityCurrent(opportunity,currentSourceVersion,nowMs);
    if(nowMs>opportunity.window_end||nowMs>opportunity.expires_at)throw new Error('companion_delivery_expired');
    if(row.source_version!==opportunity.source_version||row.profile_revision!==opportunity.profile_revision||
      row.activity_revision!==opportunity.activity_revision||row.controls_revision!==opportunity.controls_revision||row.contact_revision!==opportunity.contact_revision)
      throw new Error('context_changed_retry');
  }
  private assertClaim(row:OpportunityRow,claimToken:string,nowMs:number):void {
    if(row.status!=='evaluating'||row.claim_token!==claimToken)throw new Error('companion_claim_mismatch');
    if((row.claim_until??0)<nowMs)throw new Error('companion_claim_expired');
  }
  private dismissExpired(row:OpportunityRow,nowMs:number):void {
    this.db.prepare("UPDATE companion_opportunities SET status='dismissed',decision='dismiss',claim_token=NULL,claim_until=NULL,updated=? WHERE id=?")
      .run(nowMs,row.id);this.writeState(row.subject,row.target,'cooldown',row.id,'window_expired',null,nowMs);
  }
  private cancelUnsent(subjectId:string,reason:string,nowMs:number):void {
    this.db.prepare(`UPDATE companion_opportunities SET status='cancelled',claim_token=NULL,claim_until=NULL,updated=?
      WHERE subject=? AND status IN ('waiting','deferred','evaluating','approved')`).run(nowMs,subjectId);
    this.db.prepare(`UPDATE companion_outbox SET status='cancelled',claim_token=NULL,claim_until=NULL,result_code=?,updated=?
      WHERE subject=? AND status IN ('draft','ready')`).run(reason,nowMs,subjectId);
    this.releaseCancelledQuietExceptions(subjectId,nowMs);
  }
  private consumeQuietExceptions(deliveryId:string,nowMs:number):void {
    this.db.prepare("UPDATE companion_quiet_exceptions SET status='consumed',updated=? WHERE delivery_id=? AND status='reserved'")
      .run(nowMs,deliveryId);
  }
  private releaseQuietExceptions(deliveryId:string,nowMs:number):void {
    this.db.prepare("UPDATE companion_quiet_exceptions SET status='released',updated=? WHERE delivery_id=? AND status IN ('reserved','consumed')")
      .run(nowMs,deliveryId);
  }
  private releaseCancelledQuietExceptions(subjectId:string,nowMs:number):void {
    this.db.prepare(`UPDATE companion_quiet_exceptions SET status='released',updated=? WHERE subject=? AND status='reserved'
      AND delivery_id IN (SELECT id FROM companion_outbox WHERE status='cancelled')`).run(nowMs,subjectId);
  }
  private hasUnknown(subjectId:string):boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM companion_outbox WHERE subject=? AND status IN ('sending','unknown') LIMIT 1").get(subjectId));
  }
  private hasUncertainDelivery(subjectId:string,targetId:string):boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM companion_outbox WHERE subject=? AND target=? AND status IN ('sending','unknown') LIMIT 1").get(subjectId,targetId));
  }
  private profileRevision(subjectId:string):number {
    return (this.db.prepare('SELECT revision FROM user_profile_state WHERE subject=?').get(subjectId) as {revision:number}|undefined)?.revision??0;
  }
  private writeActivity(value:CompanionActivity):void {
    this.db.prepare(`INSERT INTO companion_activity VALUES(?,?,?,?,?,?,?) ON CONFLICT(subject) DO UPDATE SET revision=excluded.revision,
      semantic_ready_revision=excluded.semantic_ready_revision,last_user_activity=excluded.last_user_activity,busy_until=excluded.busy_until,
      unanswered_count=excluded.unanswered_count,last_sent=excluded.last_sent`)
      .run(value.subjectId,value.revision,value.semanticReadyRevision,value.lastUserActivityAtMs,value.busyUntilMs,value.unansweredCount,value.lastSentAtMs);
  }
  private writeState(subjectId:string,targetId:string,state:CompanionState,opportunityId:string|null,reason:string|null,nextCheck:number|null,nowMs:number):void {
    this.db.prepare(`INSERT INTO companion_state(subject,target,state,revision,opportunity_id,reason,next_check,updated) VALUES(?,?,?,1,?,?,?,?)
      ON CONFLICT(subject,target) DO UPDATE SET state=excluded.state,revision=companion_state.revision+1,
      opportunity_id=excluded.opportunity_id,reason=excluded.reason,next_check=excluded.next_check,updated=excluded.updated`)
      .run(subjectId,targetId,state,opportunityId,reason,nextCheck,nowMs);
  }
  private states(subjectId:string):StateRow[]{return this.db.prepare('SELECT * FROM companion_state WHERE subject=?').all(subjectId) as unknown as StateRow[];}
  private stateRow(subjectId:string,targetId:string):StateRow|undefined{return this.db.prepare('SELECT * FROM companion_state WHERE subject=? AND target=?').get(subjectId,targetId) as StateRow|undefined;}
  private opportunityRow(value:string):OpportunityRow|undefined{return this.db.prepare('SELECT * FROM companion_opportunities WHERE id=?').get(value) as OpportunityRow|undefined;}
  private deliveryRow(value:string):DeliveryRow|undefined{return this.db.prepare('SELECT * FROM companion_outbox WHERE id=?').get(value) as DeliveryRow|undefined;}
  private ensureSchema():void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS companion_contact_settings (
      subject TEXT PRIMARY KEY, revision INTEGER NOT NULL, time_zone TEXT NOT NULL, windows TEXT NOT NULL, exceptions TEXT NOT NULL,
      minimum_interval INTEGER NOT NULL, max_unanswered INTEGER NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS companion_activity (
        subject TEXT PRIMARY KEY, revision INTEGER NOT NULL, semantic_ready_revision INTEGER NOT NULL,
        last_user_activity INTEGER, busy_until INTEGER, unanswered_count INTEGER NOT NULL, last_sent INTEGER);
      CREATE TABLE IF NOT EXISTS companion_state (
        subject TEXT NOT NULL,target TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,opportunity_id TEXT,
        reason TEXT,next_check INTEGER,updated INTEGER NOT NULL,PRIMARY KEY(subject,target));
      CREATE TABLE IF NOT EXISTS companion_opportunities (
        id TEXT PRIMARY KEY,subject TEXT NOT NULL,target TEXT NOT NULL,kind TEXT NOT NULL,purpose TEXT NOT NULL,topic TEXT NOT NULL,basis TEXT NOT NULL,
        occurrence_id TEXT NOT NULL,source_version INTEGER NOT NULL,profile_revision INTEGER NOT NULL,activity_revision INTEGER NOT NULL,
        controls_revision INTEGER NOT NULL,contact_revision INTEGER NOT NULL,check_at INTEGER NOT NULL,window_start INTEGER NOT NULL,
        window_end INTEGER NOT NULL,expires_at INTEGER NOT NULL,status TEXT NOT NULL,defer_count INTEGER NOT NULL,decision TEXT,strategy TEXT,
        claim_token TEXT,claim_until INTEGER,created INTEGER NOT NULL,updated INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS companion_opportunities_due ON companion_opportunities(subject,status,check_at);
      CREATE TABLE IF NOT EXISTS companion_outbox (
        id TEXT PRIMARY KEY,opportunity_id TEXT NOT NULL UNIQUE,subject TEXT NOT NULL,target TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL,
        source_version INTEGER NOT NULL,profile_revision INTEGER NOT NULL,activity_revision INTEGER NOT NULL,controls_revision INTEGER NOT NULL,
        contact_revision INTEGER NOT NULL,claim_token TEXT,claim_until INTEGER,host TEXT,host_message_id TEXT,result_code TEXT,
        created INTEGER NOT NULL,updated INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS companion_outbox_status ON companion_outbox(subject,target,status);
      CREATE TABLE IF NOT EXISTS companion_quiet_exceptions (
        delivery_id TEXT NOT NULL,subject TEXT NOT NULL,target TEXT NOT NULL,scope_key TEXT NOT NULL,
        commitment_id TEXT NOT NULL,commitment_revision INTEGER NOT NULL,window_key TEXT NOT NULL,
        source_id TEXT NOT NULL,source_revision INTEGER NOT NULL,status TEXT NOT NULL,updated INTEGER NOT NULL,
        PRIMARY KEY(delivery_id,scope_key,commitment_id,commitment_revision,window_key));
      CREATE UNIQUE INDEX IF NOT EXISTS companion_quiet_exception_once ON companion_quiet_exceptions
        (subject,target,scope_key,commitment_id,commitment_revision,window_key) WHERE status IN ('reserved','consumed');`);
  }
  private transaction<T>(work:()=>T):T {
    const savepoint=`companion_${this.savepointSequence++}`;this.db.exec(`SAVEPOINT ${savepoint}`);
    try{const result=work();this.db.exec(`RELEASE ${savepoint}`);return result;}
    catch(error){this.db.exec(`ROLLBACK TO ${savepoint}`);this.db.exec(`RELEASE ${savepoint}`);throw error;}
  }
}

function opportunityOf(row:OpportunityRow):CompanionOpportunity {
  return {opportunityId:row.id,subjectId:row.subject,targetId:row.target,kind:row.kind,purpose:row.purpose,topic:row.topic,
    basis:JSON.parse(row.basis) as CompanionBasis[],occurrenceId:row.occurrence_id,sourceVersion:row.source_version,
    profileRevision:row.profile_revision,activityRevision:row.activity_revision,controlsRevision:row.controls_revision,
    contactRevision:row.contact_revision,checkAtMs:row.check_at,windowStartMs:row.window_start,windowEndMs:row.window_end,
    expiresAtMs:row.expires_at,status:row.status,deferCount:row.defer_count,decision:row.decision,
    strategy:row.strategy?JSON.parse(row.strategy) as FrontendStrategy:null,claimToken:row.claim_token,claimUntilMs:row.claim_until,
    createdAtMs:row.created,updatedAtMs:row.updated};
}
function deliveryOf(row:DeliveryRow):CompanionDelivery {
  return {deliveryId:row.id,opportunityId:row.opportunity_id,subjectId:row.subject,targetId:row.target,body:row.body,status:row.status,
    sourceVersion:row.source_version,profileRevision:row.profile_revision,activityRevision:row.activity_revision,
    controlsRevision:row.controls_revision,contactRevision:row.contact_revision,claimToken:row.claim_token,claimUntilMs:row.claim_until,
    host:row.host,hostMessageId:row.host_message_id,resultCode:row.result_code,createdAtMs:row.created,updatedAtMs:row.updated};
}
function contactOf(row:ContactRow):ContactSettings {
  return {subjectId:row.subject,revision:row.revision,timeZone:row.time_zone,windows:JSON.parse(row.windows),exceptions:JSON.parse(row.exceptions),
    minimumIntervalMs:row.minimum_interval,maxUnanswered:row.max_unanswered,updatedAtMs:row.updated};
}
function activityOf(row:ActivityRow):CompanionActivity {
  return {subjectId:row.subject,revision:row.revision,semanticReadyRevision:row.semantic_ready_revision,lastUserActivityAtMs:row.last_user_activity,
    busyUntilMs:row.busy_until,unansweredCount:row.unanswered_count,lastSentAtMs:row.last_sent};
}
function validateExceptions(value:unknown):ContactException[] {
  if(!Array.isArray(value)||value.length>100)throw new Error('invalid_contact_exceptions');
  return value.map(item=>{
    if(!item||typeof item!=='object')throw new Error('invalid_contact_exceptions');const row=item as Record<string,unknown>;
    const date=validateDate(row.date);if(row.mode!=='skip'&&row.mode!=='replace')throw new Error('invalid_contact_exceptions');
    const windows=row.mode==='replace'?validateContactWindows((Array.isArray(row.windows)?row.windows:[]).map(window=>({...window as object,days:[0]})))
      .map(({start,end})=>({start,end})):undefined;
    return {date,mode:row.mode,...(windows?{windows}:{})};
  });
}
function validateBasis(value:unknown,kind:string):CompanionBasis[] {
  if(!Array.isArray(value)||value.length>50||(kind!=='daily'&&!value.length))throw new Error('invalid_companion_basis');
  return value.map(item=>{if(!item||typeof item!=='object')throw new Error('invalid_companion_basis');const row=item as Record<string,unknown>;
    if(!['source','profile','schedule','daily'].includes(row.kind as string))throw new Error('invalid_companion_basis');
    return {kind:row.kind as CompanionBasis['kind'],id:id(row.id),revision:revision(row.revision)};});
}
function validateQuietBindings(value:readonly QuietExceptionBinding[]):QuietExceptionBinding[] {
  if(!Array.isArray(value)||value.length>50)throw new Error('invalid_quiet_exception_bindings');
  const result=value.map(item=>{
    if(!item||typeof item!=='object')throw new Error('invalid_quiet_exception_bindings');
    return {scopeKey:text(item.scopeKey,500),commitmentId:id(item.commitmentId),revision:revision(item.revision),
      key:text(item.key,500),sourceId:id(item.sourceId),sourceRevision:revision(item.sourceRevision)};
  });
  const keys=result.map(item=>JSON.stringify([item.scopeKey,item.commitmentId,item.revision,item.key]));
  if(new Set(keys).size!==keys.length)throw new Error('invalid_quiet_exception_bindings');
  return result;
}
function sameQuietBindings(a:readonly QuietExceptionBinding[],b:readonly QuietExceptionBinding[]):boolean {
  const key=(item:QuietExceptionBinding)=>JSON.stringify([item.scopeKey,item.commitmentId,item.revision,item.key,item.sourceId,item.sourceRevision]);
  const left=a.map(key).sort(),right=b.map(key).sort();
  return left.length===right.length&&left.every((value,index)=>value===right[index]);
}
function validateStrategy(strategy:FrontendStrategy,row:OpportunityRow):void {
  if(!strategy||typeof strategy!=='object'||strategy.sourceVersions.profileRevision!==row.profile_revision||
    strategy.sourceVersions.controlsRevision!==row.controls_revision)throw new Error('context_changed_retry');
}
function hash(value:unknown):string{return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
function flag(value:unknown,fallback:boolean):boolean {if(value===undefined)return fallback;if(typeof value!=='boolean')throw new Error('invalid_companion_controls');return value;}
function id(value:unknown):string{return text(value,200);}
function text(value:unknown,max:number):string {if(typeof value!=='string'||!value.trim()||value.length>max)throw new Error('invalid_companion_value');return value.trim();}
function time(value:unknown):number {if(!Number.isSafeInteger(value)||(value as number)<0)throw new Error('invalid_companion_time');return value as number;}
function revision(value:unknown):number {assertRevision(value);return value;}
function assertRevision(value:unknown):asserts value is number {if(!Number.isSafeInteger(value)||(value as number)<0)throw new Error('invalid_companion_revision');}
function lease(value:unknown):asserts value is number {if(!Number.isSafeInteger(value)||(value as number)<1_000||(value as number)>3_600_000)throw new Error('invalid_companion_lease');}

import {scopeKey,type Configurations} from '../core/types.ts';
import type {Core} from '../core/service.ts';
import type {ModelTasks} from '../core/models.ts';
import type {SceneAuthority} from './store.ts';
import type {SceneScope,SceneMessage} from './types.ts';
import {visibleText} from './perspective.ts';
import {decodeProfileCandidates,decodeCommunicationStrategy} from '../user-model/codec.ts';
import type {FrontendStrategy,ProfileCandidate} from '../user-model/types.ts';
import {summarizeUserActivity} from '../user-model/activity.ts';
import {companionDecisionPrompt,decodeCompanionDecision} from '../companion/codec.ts';
import {formatRelationshipGuidance} from '../companion/relationship-assessment.ts';
import type {RelationshipAssessment,RelationshipAssessmentTask} from '../companion/relationship-assessment.ts';
import type {CompanionOpportunity} from '../companion/types.ts';
import type {QuietExceptionBinding} from '../companion/types.ts';
import {contactRestrictionWindow} from '../commitments/index.ts';
import {contactSources,contactSummaryTask,decodeContactSummary,contactContext,contactClock} from '../companion/contact-context.ts';
import type {ContactContext} from '../companion/contact-context.ts';
import {compactOpenHerForContact} from '../companion/relationship-context.ts';
import {companionIdentityGuidance,companionIdentityIssue,ensureCompanionIdentityBody} from '../companion/identity-expression.ts';
import type {LearningTrace} from '../companion/personal-weights.ts';
import {sceneExpressionOptions} from './address.ts';

export interface ContactJudgment {choice:'send'|'wait'|'skip';rawChoice?:'send'|'wait'|'skip';experience:'positive'|'uncertain'|'negative';emotion:'aligned'|'uncertain'|'conflicting';learningTraces?:LearningTrace[]}

export interface CompanionDecisionProvider {
  assess(task:RelationshipAssessmentTask,extraction:unknown,personalScopeKey?:string):Promise<unknown>;
  evaluateWithTrace?:(payload:unknown,learning:{scopeKey:string;taskType:'contact'|'relationship'})=>Promise<{learningTraces:LearningTrace[]}>;
  identity?():string;
  summarizeContact?(messages:{role:'system'|'user';content:string}[]):Promise<string>;
  decideContact(input:{context:ContactContext;opportunity:Pick<CompanionOpportunity,'purpose'|'topic'|'basis'>;candidateBody?:string},personalScopeKey?:string):Promise<ContactJudgment>;
  decideQuietException?(input:{context:ContactContext;quiet:{content:string;windowKey:string}[];candidateBody:string},personalScopeKey?:string):Promise<'positive'|'uncertain'|'negative'|{verdict:'positive'|'uncertain'|'negative';learningTraces:LearningTrace[]}>;
  close():void;
}

/** Host-neutral companion orchestration. The host alone commits an outgoing message. */
export class CompanionFlow {
  private authority:SceneAuthority;
  private core:Core;
  private models:ModelTasks;
  private relationshipInFlight=new Map<string,Promise<RelationshipAssessment|null>>();
  decisionProvider:CompanionDecisionProvider|null=null;
  evidenceExtractor:((task:RelationshipAssessmentTask)=>Promise<unknown>)|null=null;
  responseExpectationExtractor:((messages:{role:'system'|'user';content:string}[])=>Promise<string>)|null=null;
  absenceExplanationExtractor:((messages:{role:'system'|'user';content:string}[])=>Promise<string>)|null=null;
  requireLocalDecisions=false;
  constructor(authority:SceneAuthority,core:Core,models:ModelTasks){this.authority=authority;this.core=core;this.models=models;}
  async extract(scope:SceneScope,source:SceneMessage,configs:Configurations,assertCurrent:()=>void):Promise<ProfileCandidate[]>{
    const subject=this.authority.subject(scope);
    if(!subject||subject.host!=='agent'||source.role!=='user'||this.authority.interactions.modeOf(scope)!=='companion'||
      source.envelope.mode!=='direct'||source.envelope.presentIds.length!==1||source.envelope.presentIds[0]!==source.envelope.targetId)return [];
    const controls=this.authority.userModel.controls(subject.subjectId);
    const task=this.authority.userModel.profileTask(subject.subjectId,scope,source);
    if(!task)return [];
    const raw=await this.models.structuredTask(configs.profile,task.messages);
    assertCurrent();
    if(this.authority.userModel.controls(subject.subjectId).revision!==controls.revision)throw new Error('context_changed_retry');
    return decodeProfileCandidates(raw,source.text).map(candidate=>({...candidate,
      characterIds:[source.envelope.targetId],sessionIds:[scope.sessionId]}));
  }
  async strategy(scope:SceneScope,characterId:string,currentContext:string,configs:Configurations,assertCurrent:()=>void,purpose='reply'):Promise<FrontendStrategy|null>{
    const subject=this.authority.subject(scope);if(!subject||subject.host!=='agent'||this.authority.interactions.modeOf(scope)!=='companion')return null;
    const target=this.target(scope,characterId);
    const assessment=await this.assessRelationship(scope,characterId);assertCurrent();
    if(assessment)currentContext+='\n'+formatRelationshipGuidance(assessment,purpose==='proactive'?'proactive':'reply');
    const activity=summarizeUserActivity(this.authority.state(scope).sources.filter(source=>source.envelope.mode==='direct'&&
      source.envelope.targetId===characterId&&source.envelope.presentIds.length===1&&source.envelope.presentIds[0]===characterId)
      .map(source=>({id:source.id,revision:source.revision,role:source.role,status:source.status,acceptedAtMs:source.acceptedAtMs})),
      {timeZone:this.authority.interactions.clock(scope).timeZone??'UTC'});
    const task=this.authority.userModel.strategyTask(subject.subjectId,{purpose,storageKey:JSON.stringify(['xldb-user-model-strategy-v1',purpose,target]),
      currentContext,characterId,sessionId:scope.sessionId,advanced:true,activity});
    if(!task)return null;
    const raw=await this.models.structuredTask(configs.strategy,task.messages);assertCurrent();
    return this.authority.userModel.saveStrategy(subject.subjectId,task,decodeCommunicationStrategy(raw,task));
  }
  async systemContext(scope:SceneScope,characterId:string,legalContext:string,configs:Configurations,assertCurrent:()=>void,
    currentUserSourceId?:string,nowMs=Date.now()){
    const strategy=await this.strategy(scope,characterId,legalContext,configs,assertCurrent);
    const input=this.authority.relationshipAssessmentInput(scope,characterId);
    const assessment=input?this.authority.relationshipAssessments.read(input):null;
    const latest=this.authority.state(scope).sources.filter(source=>source.status==='accepted'&&source.processing==='ready').at(-1);
    const harden=latest?.role==='user'&&latest.envelope.mode==='direct'&&latest.envelope.targetId===characterId&&
      latest.analysis?.commitmentOperations?.some(operation=>operation.action==='harden');
    const subject=this.authority.subject(scope);
    const agentCompanion=subject?.host==='agent'&&this.authority.interactions.modeOf(scope)==='companion';
    const clock=agentCompanion?contactClock(nowMs,this.authority.interactions.clock(scope).timeZone??'UTC'):null;
    return (clock?'\n当前伴侣现实时间：'+JSON.stringify(clock):'')+
      (strategy?'\n本轮沟通建议（依据已授权资料，推断不是事实，当前用户意愿优先）：'+JSON.stringify(strategy):'')+
      (assessment?'\n'+formatRelationshipGuidance(assessment,'reply'):'')+
      (harden?'\n用户刚明确表示此前勿扰时段的破例联系让其不快。请按当前角色人设在本轮正常回复中真诚、简短道歉，承认已收到边界；不要主动补发道歉，也不要再把该承诺当作可破例。':'');
  }
  async assessRelationship(scope:SceneScope,characterId:string){
    const learningKey=this.learningScope(scope,characterId);
    if(learningKey&&this.decisionProvider?.identity)this.authority.personalLearning.contactFeedback(learningKey,
      this.learningSources(scope,characterId),this.decisionProvider.identity());
    const input=this.authority.relationshipAssessmentInput(scope,characterId);
    if(!input)return null;
    const task=this.authority.relationshipAssessments.task(input);
    if(task&&input.sources.length&&this.decisionProvider){
      if(!this.evidenceExtractor)throw new Error('relationship_evidence_extractor_required');
      const key=JSON.stringify([scope,input.subjectId,characterId,task.sourceFingerprint]);
      const running=this.relationshipInFlight.get(key);if(running)return running;
      const work=(async()=>{
        const extraction=this.authority.relationshipAssessments.reusableEvidence(input)??await this.evidenceExtractor!(task);
        if(learningKey){
          const correction=this.authority.relationshipAssessments.read(input);
          this.authority.personalLearning.relationship(learningKey,input,extraction,correction,()=>{
              if(this.authority.state(scope).version!==input.sourceVersion||
                this.authority.relationshipAssessments.read(input)?.revision!==correction?.revision||
                this.learningScope(scope,characterId)!==learningKey||
                this.authority.userModel.controls(input.subjectId).revision!==input.controlsRevision)
                throw new Error('context_changed_retry');
            });
        }
        const refreshed=this.authority.relationshipAssessmentInput(scope,characterId);
        if(!refreshed)throw new Error('context_changed_retry');
        const effectiveTask=this.authority.relationshipAssessments.task(refreshed)??task;
        const result=await this.decisionProvider!.assess(effectiveTask,extraction,learningKey??undefined);
        const current=this.authority.relationshipAssessmentInput(scope,characterId);
        if(!current)throw new Error('context_changed_retry');
        try{return this.authority.relationshipAssessments.save(effectiveTask,result,current);}
        catch(error){
          if(error instanceof Error&&error.message==='context_changed_retry')return this.authority.relationshipAssessments.read(current);
          throw error;
        }
      })();
      this.relationshipInFlight.set(key,work);
      try{return await work;}finally{if(this.relationshipInFlight.get(key)===work)this.relationshipInFlight.delete(key);}
    }
    return this.authority.relationshipAssessments.read(input);
  }
  private learningSources(scope:SceneScope,characterId:string){
    return this.authority.state(scope).sources.filter(s=>s.status==='accepted'&&s.processing==='ready'&&
      s.envelope.mode==='direct'&&s.envelope.targetId===characterId&&s.envelope.presentIds.length===1&&
      s.envelope.presentIds[0]===characterId&&(s.role==='user'||s.role==='assistant'&&s.speakerId===characterId));
  }
  private learningScope(scope:SceneScope,characterId:string){
    const subject=this.authority.subject(scope);
    if(subject?.host!=='agent'||this.authority.interactions.modeOf(scope)!=='companion')return null;
    const controls=this.authority.userModel.controls(subject.subjectId),key=this.authority.personalLearning.key(scope,subject.subjectId,characterId);
    const enabled=controls.profileLearningEnabled&&controls.personalizationEnabled;
    this.authority.personalLearning.synchronize(key,this.learningSources(scope,characterId),controls.revision,enabled);
    return enabled?key:null;
  }
  status(scope:SceneScope,characterId:string){
    this.actor(scope,characterId);const subject=this.requireSubject(scope);
    return {subject,controls:this.authority.userModel.controls(subject.subjectId),contact:this.authority.companion.contactSettings(subject.subjectId),
      contactPaused:subject.host==='agent'&&this.authority.userModel.contactPaused(subject.subjectId,this.target(scope,characterId)),
      status:this.authority.companion.status(subject.subjectId,this.target(scope,characterId))};
  }
  contactEmotion(scope:SceneScope,characterId:string,nowMs:number,state=this.authority.state(scope),
    currentReply:{sourceId:string;revision:number}|null=null){
    return this.authority.contactEmotionProjection(scope,characterId,nowMs,state,currentReply);
  }
  async poll(scope:SceneScope,characterId:string,trigger:'event'|'scheduled',configs:Configurations,assertCurrent:()=>void){
    const actor=this.actor(scope,characterId),subject=this.requireSubject(scope),state=this.authority.state(scope);
    const controls=this.authority.userModel.controls(subject.subjectId);
    if(!controls.proactiveCompanionEnabled||(trigger==='scheduled'&&!controls.scheduledWakeEnabled))return {status:'disabled'};
    if(state.sources.some(source=>source.status==='accepted'&&source.processing!=='ready'))return {status:'waiting',reason:'semantic_pending'};
    const now=Date.now(),targetId=this.target(scope,characterId),companion=this.authority.companion;
    if(subject.host==='agent'&&this.authority.userModel.contactPaused(subject.subjectId,targetId))
      return {status:'disabled',reason:'user_feedback_pause'};
    const initialAssessmentInput=this.authority.relationshipAssessmentInput(scope,characterId);
    const initialAssessment=initialAssessmentInput?this.authority.relationshipAssessments.read(initialAssessmentInput):null;
    if(initialAssessment?.contactCorrected&&['wait','skip'].includes(initialAssessment.contactChoice))
      return {status:initialAssessment.contactChoice==='skip'?'skipped':'waiting',reason:'relationship_contact_correction'};
    const quiet=this.quietAt(scope,characterId,now);
    if(quiet===null){companion.cancelPendingForTarget(subject.subjectId,targetId,'contact_restriction_hard',now);
      return {status:'waiting',reason:'contact_restriction_hard'};}
    if(subject.host!=='agent'&&quiet.length){companion.cancelPendingForTarget(subject.subjectId,targetId,'contact_restriction_soft',now);
      return {status:'waiting',reason:'contact_restriction_soft'};}
    const activityNow=companion.activity(subject.subjectId),contactNow=companion.contactSettings(subject.subjectId);
    for(const receipt of companion.status(subject.subjectId,targetId).deliveries.filter(item=>item.status==='ready')){
      const pending=companion.getDelivery(receipt.deliveryId),basis=pending?companion.getOpportunity(pending.opportunityId):null;
      if(pending&&companionIdentityIssue(pending.body,null))throw new Error('companion_identity_expression_invalid');
      if(pending&&basis&&pending.sourceVersion===state.version&&pending.controlsRevision===controls.revision&&
        pending.profileRevision===this.authority.userModel.profileRevision(subject.subjectId)&&pending.activityRevision===activityNow.revision&&
        pending.contactRevision===contactNow.revision&&now<=basis.windowEndMs&&now<=basis.expiresAtMs&&
        this.contactWindowCurrent(state.sources,characterId,pending.createdAtMs,now)&&
        this.sameQuietBindings(companion.getDeliveryExceptionBindings(pending.deliveryId),quiet))
        return {status:'ready',deliveryId:pending.deliveryId,body:pending.body,characterId};
      if(pending)companion.cancelPendingForTarget(subject.subjectId,targetId,'contact_context_expired',now);
    }
    if(quiet.some(binding=>companion.quietExceptionStatus(subject.subjectId,targetId,binding)!=='available'))
      return {status:'waiting',reason:'contact_exception_used'};
    // A source opportunity is limited to text this recipient actually knows.
    const lastUser=state.sources.filter(source=>source.status==='accepted'&&source.role==='user'&&source.processing==='ready'&&
      source.envelope.mode==='direct'&&source.envelope.targetId===characterId&&
      source.envelope.presentIds.length===1&&source.envelope.presentIds[0]===characterId&&source.acceptedAtMs<=now).at(-1);
    const current=lastUser?.analysis?.plan?visibleText(lastUser.analysis.plan,characterId):'';
    if(current)companion.schedule({subjectId:subject.subjectId,targetId,kind:'experience',purpose:'followup',
      opportunityKey:`source:${lastUser!.id}:${lastUser!.revision}`,topic:current.slice(0,500),basis:[{kind:'source',id:lastUser!.id,revision:lastUser!.revision}],sourceVersion:state.version,nowMs:now});
    // A daily contact is an opportunity to evaluate, never an invented user event.
    if(!current)
      companion.schedule({subjectId:subject.subjectId,targetId,kind:'daily',purpose:'gentle_contact',
      opportunityKey:trigger==='scheduled'?`wake:${Math.floor(now/60_000)}`:'daily',
      topic:'一次不要求回复的简短问候，不假定用户正在做什么。',basis:[],sourceVersion:state.version,nowMs:now});
    const reminders=this.authority.commitments.dueTodos(scope,{realNowMs:now,storyNowMs:0},'companion');
    for(const reminder of reminders){
      const record=this.authority.commitments.get(scope,reminder.commitmentId);
      if(!record?.readers.includes(characterId))continue;
      companion.schedule({subjectId:subject.subjectId,targetId,kind:'schedule',purpose:'commitment_reminder',
      opportunityKey:`commitment:${reminder.commitmentId}:${reminder.revision}`,topic:record.content.slice(0,500),
      basis:[{kind:'schedule',id:reminder.commitmentId,revision:reminder.revision}],sourceVersion:state.version,nowMs:now});
    }
    const opportunity=companion.due(subject.subjectId,trigger,now).find(item=>item.targetId===targetId);
    if(!opportunity)return {status:'waiting',state:companion.status(subject.subjectId,targetId)};
    if(subject.host==='agent'&&this.requireLocalDecisions&&!this.decisionProvider&&(!initialAssessment?.contactCorrected||quiet.length>0))
      throw new Error('agentjev_unavailable');
    const contactEmotion=this.contactEmotion(scope,characterId,now,state);
    const priorAddress=state.sources.filter(source=>source.status==='accepted'&&source.envelope.targetId===characterId).at(-1);
    const context=await this.core.contextFrom(this.authority.snapshot(scope,characterId,state),quiet.length?'此刻适合表达思念的真实共同经历':opportunity.topic,configs,
      contactEmotion.emotion,this.authority.preferences(scope,characterId,state),assertCurrent,now,
      sceneExpressionOptions(this.authority,scope,characterId,
        priorAddress?.envelope??{targetId:characterId,mode:'direct',presentIds:[characterId]},state,
        contactEmotion.emotion,now,contactEmotion.affect));
    context.context+=this.authority.worldContext(scope,characterId,state);
    context.context+=this.authority.commitments.projectPersistent(scope,{characterId,purpose:'expression',mode:'companion'}).systemText;
    // Turning off personalization must not prevent an independently enabled greeting.
    const strategy=await this.strategy(scope,characterId,context.context,configs,assertCurrent,'proactive')??this.basicStrategy(subject.subjectId,opportunity.purpose);
    const activity=companion.activity(subject.subjectId);
    const task=companionDecisionPrompt(opportunity,strategy,{nowMs:now,unansweredCount:activity.unansweredCount,
      busyUntilMs:activity.busyUntilMs,lastUserActivityAtMs:activity.lastUserActivityAtMs});
    const assessmentInput=this.authority.relationshipAssessmentInput(scope,characterId);
    const assessment=assessmentInput?this.authority.relationshipAssessments.read(assessmentInput):null;
    const correctedChoice=assessment?.contactCorrected?assessment.contactChoice:null;
    let quietCandidate=quiet.length?await this.models.generate(
      `你只扮演${actor.name}。${actor.persona}${companionIdentityGuidance(null)}\n现在是你已承诺不主动联系的时段。只有在另行审定这条候选正文确实会让用户开心后才可能破例。请写一条最多300字的简短思念表达，不要求用户回复，不提醒其它事情，不催促，不解释后台判断，也不编造用户此刻的情况。只输出将实际发送的角色正文。`,
      context.context+'\n沟通建议：'+JSON.stringify(strategy),JSON.stringify({purpose:'quiet_exception_longing',nowMs:now}),configs.proactive):null;
    if(quietCandidate!==null)quietCandidate=await ensureCompanionIdentityBody(quietCandidate,null,
      (instruction,original)=>this.models.generate(instruction,context.context,JSON.stringify({original}),configs.proactive));
    if(quietCandidate!==null&&(!quietCandidate.trim()||quietCandidate.length>300))throw new Error('invalid_quiet_exception_body');
    let judgment:ContactJudgment|null=null;
    const personalKey=this.learningScope(scope,characterId);
    const learningTraces:LearningTrace[]=[];
    let detail:ContactContext|null=null;
    if((quiet.length>0||correctedChoice!=='send'&&correctedChoice!=='initiate'&&correctedChoice!=='wait'&&correctedChoice!=='skip')&&
      this.decisionProvider&&subject.host==='agent'){
      if(!this.decisionProvider.summarizeContact)throw new Error('contact_summary_provider_required');
      const sources=contactSources(state.sources,characterId,now);
      const summary=sources.length?await (async()=>{
        const summaryTask=contactSummaryTask(sources,now);
        const raw=await this.decisionProvider!.summarizeContact!(summaryTask.messages);assertCurrent();
        return decodeContactSummary(raw,sources);
      })():{summary:'无近期互动',sources:[]};
      const entries=this.authority.userModel.listEntries(subject.subjectId,{purpose:'proactive',taskPurpose:'proactive',
        characterId,sessionId:scope.sessionId,nowMs:now,advanced:false});
      const commitments=this.authority.commitments.list(scope,{readerId:characterId,status:'active',mode:'companion'});
      const emotion=contactEmotion.emotion;
      const currentEmotion=JSON.stringify(compactOpenHerForContact(emotion));
      detail=contactContext({sources,nowMs:now,summary,entries,commitments,persona:actor.persona,emotion:currentEmotion,
        timeZone:this.authority.interactions.clock(scope).timeZone??'UTC',affect:contactEmotion.affect});
      judgment=await this.decisionProvider.decideContact({context:detail,
        opportunity:quiet.length?{purpose:'longing_exception',topic:'仅简短诉说思念，不提醒或要求回复',basis:opportunity.basis}:
          {purpose:opportunity.purpose,topic:opportunity.topic,basis:opportunity.basis},
        ...(quietCandidate===null?{}:{candidateBody:quietCandidate})},personalKey??undefined);
      learningTraces.push(...judgment.learningTraces??[]);
      if(!judgment||!['send','wait','skip'].includes(judgment.choice)||
        !['positive','uncertain','negative'].includes(judgment.experience)||
        !['aligned','uncertain','conflicting'].includes(judgment.emotion))throw new Error('agentjev_invalid_response');
      if(judgment.choice==='send'&&(judgment.experience!=='positive'||judgment.emotion!=='aligned'))
        judgment={...judgment,rawChoice:'send',choice:judgment.experience==='negative'||judgment.emotion==='conflicting'?'skip':'wait'};
    }
    let choice=quiet.length?judgment?.choice??null:correctedChoice==='send'||correctedChoice==='initiate'?'send':
      correctedChoice==='wait'||correctedChoice==='skip'?correctedChoice:judgment?.choice??null;
    let quietVerdict:'positive'|'uncertain'|'negative'|null=null;
    if(quiet.length&&choice==='send'){
      if(!this.decisionProvider?.decideQuietException||!detail||!quietCandidate)throw new Error('agentjev_quiet_exception_unavailable');
      const restrictions=quiet.map(binding=>({windowKey:binding.key,
        content:this.authority.commitments.get(scope,binding.commitmentId)?.content??''}));
      const result=await this.decisionProvider.decideQuietException({context:detail,quiet:restrictions,candidateBody:quietCandidate},personalKey??undefined);
      quietVerdict=typeof result==='string'?result:result.verdict;
      if(typeof result!=='string')learningTraces.push(...result.learningTraces);
      if(quietVerdict!=='positive'&&quietVerdict!=='uncertain'&&quietVerdict!=='negative')throw new Error('agentjev_invalid_response');
      if(quietVerdict!=='positive')choice=quietVerdict==='negative'?'skip':'wait';
    }
    this.assertContactCurrent(scope,characterId,state.version,controls.revision,opportunity,assessment?.revision??0,quiet);
    let decision=decodeCompanionDecision(choice?JSON.stringify({schema:'xldb-companion-decision-v1',
      decision:choice==='send'?'approve':'dismiss',reason:judgment?
        `AgentJev: experience=${judgment.experience}; emotion=${judgment.emotion}; choice=${choice}; raw=${judgment.rawChoice??judgment.choice}; quiet=${quietVerdict??'none'}`:'用户明确联系纠正',
      nextCheckAtMs:null}):await this.models.structuredTask(configs.proactiveDecision,task.messages),task);assertCurrent();
    if(decision.decision==='defer'&&(opportunity.deferCount>=3||decision.nextCheckAtMs!>Math.min(opportunity.windowEndMs,opportunity.expiresAtMs)))
      decision={schema:'xldb-companion-decision-v1',decision:'dismiss',reason:'No remaining permitted check within this opportunity.',nextCheckAtMs:null};
    if(decision.decision!=='approve'){
      const claim=companion.claim(opportunity.opportunityId,'scene-companion',state.version);
      companion.decide(opportunity.opportunityId,claim.claimToken,decision.decision==='defer'
        ?{decision:'defer',nextCheckAtMs:decision.nextCheckAtMs!,reason:decision.reason}:{decision:'dismiss',reason:decision.reason},state.version);
      return {status:choice==='wait'?'waiting':decision.decision};
    }
    let body=quietCandidate??await this.models.generate(`你只扮演${actor.name}。${actor.persona}${companionIdentityGuidance(null)}\n这是没有用户新输入时、已经批准的主动联系机会，此刻应执行该机会的沟通目的。输入中的来源是过去已接受的正文，不是用户正在对你说的新消息。若目的为提醒，现在给出提醒，不要再次答应以后提醒；不要向用户解释后台检查或调度。主动发起一次简短陪伴，不替用户说话，不推测未回复原因，不催促。按真实来源和用户边界决定措辞；只输出待发给用户的角色正文。`,
      context.context+'\n沟通建议：'+JSON.stringify(strategy),JSON.stringify({purpose:opportunity.purpose,trigger,nowMs:now,acceptedBasis:opportunity.topic}),configs.proactive);assertCurrent();
    body=await ensureCompanionIdentityBody(body,null,(instruction,original)=>this.models.generate(instruction,
      context.context,JSON.stringify({original}),configs.proactive));assertCurrent();
    this.assertContactCurrent(scope,characterId,state.version,controls.revision,opportunity,assessment?.revision??0,quiet);
    const claim=companion.claim(opportunity.opportunityId,'scene-companion',state.version);
    let delivery;
    try{delivery=companion.approveAndQueueDelivery(opportunity.opportunityId,claim.claimToken,strategy,body,state.version,Date.now(),quiet);}
    catch(error){
      if(error instanceof Error&&error.message==='companion_quiet_exception_unavailable'){
        companion.decide(opportunity.opportunityId,claim.claimToken,{decision:'dismiss',reason:'quiet_exception_already_used'},state.version);
        return {status:'waiting',reason:'contact_exception_used'};
      }
      throw error;
    }
    if(personalKey)this.authority.personalLearning.captureDelivery(personalKey,delivery.deliveryId,learningTraces);
    return {status:'ready',deliveryId:delivery.deliveryId,body:delivery.body,characterId};
  }
  claim(scope:SceneScope,characterId:string,deliveryId:string,host:string){
    const subject=this.requireSubject(scope);
    if(subject.host==='agent'&&this.authority.userModel.contactPaused(subject.subjectId,this.target(scope,characterId)))
      throw new Error('companion_contact_paused');
    const assessmentInput=this.authority.relationshipAssessmentInput(scope,characterId);
    const assessment=assessmentInput?this.authority.relationshipAssessments.read(assessmentInput):null;
    if(assessment?.contactCorrected&&['wait','skip'].includes(assessment.contactChoice))throw new Error('companion_contact_paused');
    const delivery=this.checkDelivery(scope,characterId,deliveryId);
    if(companionIdentityIssue(delivery.body,null))throw new Error('companion_identity_expression_invalid');
    if(!this.contactWindowCurrent(this.authority.state(scope).sources,characterId,delivery.createdAtMs,Date.now()))
      throw new Error('companion_delivery_unavailable');
    const claim=this.authority.companion.claimDelivery(deliveryId,host,this.authority.state(scope).version,Date.now(),60_000,
      ()=>this.quietAt(scope,characterId,Date.now()));
    return {deliveryId,claimToken:claim.claimToken,body:claim.delivery.body,characterId};
  }
  receipt(scope:SceneScope,characterId:string,deliveryId:string,claimToken:string,outcome:{status:'sent';hostMessageId:string}|{status:'failed'|'unknown';code:string}){
    this.checkDelivery(scope,characterId,deliveryId);
    return this.authority.companion.recordDelivery(deliveryId,claimToken,outcome);
  }
  reconcile(scope:SceneScope,characterId:string,deliveryId:string,outcome:{status:'sent';hostMessageId:string}|{status:'failed';code:string}){
    this.checkDelivery(scope,characterId,deliveryId);
    return this.authority.companion.reconcileUnknown(deliveryId,outcome);
  }
  acceptedMessage(scope:SceneScope,characterId:string,deliveryId:string):SceneMessage{
    const delivery=this.checkDelivery(scope,characterId,deliveryId);
    if(delivery.status!=='host_committed')throw new Error('companion_delivery_not_accepted');
    return {id:`proactive:${deliveryId}`,revision:1,role:'assistant',text:delivery.body,acceptedAtMs:delivery.updatedAtMs,
      envelope:{targetId:characterId,mode:'direct',presentIds:[characterId]},speakerId:characterId};
  }
  private checkDelivery(scope:SceneScope,characterId:string,deliveryId:string){
    this.actor(scope,characterId);const subject=this.requireSubject(scope),delivery=this.authority.companion.getDelivery(deliveryId);
    if(!delivery||delivery.subjectId!==subject.subjectId||delivery.targetId!==this.target(scope,characterId))throw new Error('companion_delivery_not_found');
    return delivery;
  }
  private basicStrategy(subjectId:string,purpose:string):FrontendStrategy{
    const controls=this.authority.userModel.controls(subjectId);
    return {strategyId:'basic',purpose,supportMode:'gentle',allowedTopics:[],knownFacts:[],uncertainFacts:[],tone:'温和自然',length:'short',questionBudget:0,
      avoidRepeating:[],stopConditions:['用户忙碌、拒绝或不想回复时停止。'],sourceVersions:{profileRevision:this.authority.userModel.profileRevision(subjectId),controlsRevision:controls.revision,entryRevisions:{}}};
  }
  private target(scope:SceneScope,characterId:string){return this.authority.companionTarget(scope,characterId);}
  private assertRelationshipRevision(scope:SceneScope,characterId:string,revision:number):void {
    const input=this.authority.relationshipAssessmentInput(scope,characterId);
    if(!input)return;
    if((this.authority.relationshipAssessments.read(input)?.revision??0)!==revision)throw new Error('context_changed_retry');
  }
  private assertContactCurrent(scope:SceneScope,characterId:string,sourceVersion:number,controlsRevision:number,
    opportunity:CompanionOpportunity,relationshipRevision:number,quiet:readonly QuietExceptionBinding[]):void {
    const subject=this.requireSubject(scope);
    if(this.authority.state(scope).version!==sourceVersion||this.authority.userModel.controls(subject.subjectId).revision!==controlsRevision||
      this.authority.userModel.profileRevision(subject.subjectId)!==opportunity.profileRevision||
      this.authority.companion.activity(subject.subjectId).revision!==opportunity.activityRevision||
      this.authority.companion.contactSettings(subject.subjectId).revision!==opportunity.contactRevision||
      this.authority.userModel.contactPaused(subject.subjectId,this.target(scope,characterId))||
      !this.sameQuietBindings(this.quietAt(scope,characterId,Date.now())??[],quiet)||this.quietAt(scope,characterId,Date.now())===null)
      throw new Error('context_changed_retry');
    this.assertRelationshipRevision(scope,characterId,relationshipRevision);
  }
  private contactWindowCurrent(sources:readonly import('./types.ts').SceneSource[],characterId:string,createdAtMs:number,nowMs:number):boolean {
    if(nowMs-createdAtMs>5*60_000)return false;
    const refs=(atMs:number)=>contactSources(sources,characterId,atMs).map(source=>`${source.id}@${source.revision}`);
    return JSON.stringify(refs(createdAtMs))===JSON.stringify(refs(nowMs));
  }
  private quietAt(scope:SceneScope,characterId:string,nowMs:number):QuietExceptionBinding[]|null {
    const current=this.authority.commitments.listActiveContactRestrictions(scope,{obligorId:characterId,readerId:characterId})
      .map(record=>contactRestrictionWindow(record,nowMs)).filter(window=>window!==null);
    if(current.some(window=>window.level==='hard'))return null;
    return current.map(window=>({scopeKey:scopeKey(scope),commitmentId:window.commitmentId,revision:window.revision,
      key:window.key,sourceId:window.sourceId,sourceRevision:window.sourceRevision}));
  }
  private sameQuietBindings(left:readonly QuietExceptionBinding[],right:readonly QuietExceptionBinding[]):boolean {
    const canonical=(rows:readonly QuietExceptionBinding[])=>rows.map(row=>JSON.stringify([row.scopeKey,row.commitmentId,row.revision,
      row.key,row.sourceId,row.sourceRevision])).sort();
    return JSON.stringify(canonical(left))===JSON.stringify(canonical(right));
  }
  private actor(scope:SceneScope,characterId:string){const actor=this.authority.state(scope).roster.characters.find(character=>character.id===characterId);if(!actor)throw new Error('invalid_scene_character');return actor;}
  private requireSubject(scope:SceneScope){const subject=this.authority.subject(scope);if(!subject)throw new Error('companion_subject_not_bound');return subject;}
}

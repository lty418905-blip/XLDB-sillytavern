import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {scopeKey} from '../core/types.ts';
import type {SceneAuthority} from './store.ts';
import type {SceneScope} from './types.ts';
import {
  buildCalendarExtractionPrompt,calendarSourceManifest,calendarSourcesFromScene,
  decodeCalendarCandidate,projectSceneCalendar,
} from './calendar.ts';
import type {CalendarCandidate,CalendarSource,CalendarViewer} from './calendar.ts';
import {resolveStoryLocalDateTime} from './story-initial-clock.ts';

interface StoredCalendar {candidate:string;source_manifest:string;updated:number}
export interface CalendarApplyGuard {expectedVersion:number;previewId:string}
export interface CalendarMonthQuery {year:number;month:number;timeZone:string;view:CalendarViewer;characterId?:string}
export type CalendarStructuredTask=(prompt:ReturnType<typeof buildCalendarExtractionPrompt>)=>Promise<unknown>;
export interface ManualCalendarTodo {id:string;revision:number;title:string;dueAtMs:number;status:'active'|'completed'|'deleted';createdAtMs:number;updatedAtMs:number}
export interface PersistedCalendarTodoRow {id:string;revision:number;title:string;dueAtMs:number;status:ManualCalendarTodo['status'];createdAtMs:number;updatedAtMs:number}
export interface PersistedCalendarAckRow {id:string;revision:number;ackedAtMs:number}

/** Confirmed model summary is a disposable projection of current accepted sources. */
export class SceneCalendarStore {
  private readonly db:DatabaseSync;
  private readonly authority:SceneAuthority;
  constructor(db:DatabaseSync,authority:SceneAuthority){
    this.db=db;this.authority=authority;
    db.exec(`CREATE TABLE IF NOT EXISTS scene_calendar_summaries (
      scope TEXT PRIMARY KEY,candidate TEXT NOT NULL,source_manifest TEXT NOT NULL,updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS scene_calendar_todos (
      scope TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,title TEXT NOT NULL,due_at INTEGER NOT NULL,
      status TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(scope,id),
      CHECK(status IN ('active','completed','deleted')));
      CREATE TABLE IF NOT EXISTS scene_calendar_reminder_acks (
      scope TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,acked_at INTEGER NOT NULL,
      PRIMARY KEY(scope,id,revision));`);
  }

  private sources(scope:SceneScope):CalendarSource[]{
    return calendarSourcesFromScene(this.authority.state(scope),this.authority.transfer.references(scope));
  }

  async preview(scope:SceneScope,structuredTask:CalendarStructuredTask){
    const state=this.authority.state(scope);
    const sources=this.sources(scope);
    const ownerIds=['player',...state.roster.characters.map(character=>character.id)];
    const items:CalendarCandidate['items']=[];
    for(const batch of batches(sources)){
      const raw=await structuredTask(buildCalendarExtractionPrompt(batch,ownerIds));
      const decoded=decodeCalendarCandidate(raw,batch,ownerIds);
      for(const item of decoded.items)items.push({...item,id:createHash('sha256').update(`${item.sourceId}:${item.id}`).digest('hex')});
    }
    const candidate:CalendarCandidate={format:'xldb-calendar-v1',items};
    // Re-read after asynchronous model calls: a correction must invalidate this preview.
    const current=this.authority.state(scope),currentSources=this.sources(scope);
    if(current.version!==state.version||calendarSourceManifest(currentSources)!==calendarSourceManifest(sources))
      throw new Error('context_changed_retry');
    const sourceManifest=calendarSourceManifest(sources);
    return {expectedVersion:state.version,previewId:previewId(state.version,sourceManifest,candidate),
      candidate,sourceCount:sources.length,warnings:[]};
  }

  apply(scope:SceneScope,candidateValue:unknown,guard:CalendarApplyGuard){
    const state=this.authority.state(scope),sources=this.sources(scope);
    if(state.version!==guard.expectedVersion)throw new Error('context_changed_retry');
    const ownerIds=['player',...state.roster.characters.map(character=>character.id)];
    const candidate=decodeCalendarCandidate(candidateValue,sources,ownerIds);
    const manifest=calendarSourceManifest(sources);
    if(previewId(state.version,manifest,candidate)!==guard.previewId)throw new Error('context_changed_retry');
    const updatedAtMs=Date.now();
    this.db.prepare(`INSERT INTO scene_calendar_summaries(scope,candidate,source_manifest,updated) VALUES(?,?,?,?)
      ON CONFLICT(scope) DO UPDATE SET candidate=excluded.candidate,source_manifest=excluded.source_manifest,updated=excluded.updated`)
      .run(scopeKey(scope),JSON.stringify(candidate),manifest,updatedAtMs);
    return {applied:candidate.items.length,sourceCount:sources.length,updatedAtMs};
  }

  month(scope:SceneScope,query:CalendarMonthQuery){
    const state=this.authority.state(scope);
    if(query.characterId&&!state.roster.characters.some(character=>character.id===query.characterId))
      throw new Error('invalid_calendar_character');
    const sources=this.sources(scope),manifest=calendarSourceManifest(sources);
    const row=this.db.prepare('SELECT candidate,source_manifest,updated FROM scene_calendar_summaries WHERE scope=?')
      .get(scopeKey(scope)) as StoredCalendar|undefined;
    const candidate:CalendarCandidate=row?JSON.parse(row.candidate):{format:'xldb-calendar-v1',items:[]};
    const result=projectSceneCalendar({...query,sources,candidate,
      commitments:this.authority.commitments.list(scope),mode:this.authority.interactions.modeOf(scope)});
    if(query.view==='admin'&&!query.characterId||query.view==='player'){
      for(const todo of this.todoRows(scope).filter(item=>item.status==='active')){
        const local=localParts(todo.dueAtMs,query.timeZone);
        if(!local.date.startsWith(`${String(query.year).padStart(4,'0')}-${String(query.month).padStart(2,'0')}-`))continue;
        result.items.push({id:`manual:${todo.id}:${todo.revision}`,kind:'todo',title:todo.title,date:local.date,
          startTime:local.time,endTime:null,ownerIds:['player'],status:'active',manualId:todo.id,revision:todo.revision,
          source:{kind:'manual',id:todo.id,revision:todo.revision,quote:todo.title}});
      }
      result.items.sort((a,b)=>a.date!.localeCompare(b.date!)||(a.startTime??'').localeCompare(b.startTime??'')||a.title.localeCompare(b.title));
    }
    const needsRefresh=!row||row.source_manifest!==manifest;
    return {...result,version:state.version,sourceCount:sources.length,updatedAtMs:row?.updated??null,
      needsRefresh,warnings:needsRefresh?['calendar_summary_needs_refresh']:[]};
  }

  listTodos(scope:SceneScope,view:CalendarViewer,characterId?:string){
    if(view==='character'||view==='admin'&&characterId)return [];
    if(view!=='player'&&view!=='admin')throw new Error('invalid_calendar_view');
    const zone=this.storyZone(scope);
    return this.todoRows(scope).filter(item=>item.status!=='deleted')
      .map(item=>({...item,...localParts(item.dueAtMs,zone),ownerId:'player'}));
  }

  putTodo(scope:SceneScope,input:{id?:string;title:string;date:string;time:string},expectedRevision?:number){
    const clock=this.storyClock(scope);
    const title=input.title?.trim();
    if(!title||title.length>300)throw new Error('invalid_calendar_todo');
    const dueAtMs=resolveStoryLocalDateTime(input.date,input.time,clock.timeZone);
    if(dueAtMs===null)throw new Error('invalid_calendar_todo_time');
    if(dueAtMs<=clock.timeMs)throw new Error('calendar_todo_not_future');
    const id=input.id??randomUUID();
    if(typeof id!=='string'||!id||id.length>200)throw new Error('invalid_calendar_todo');
    return this.authority.transaction(()=>{
      const current=this.todoRows(scope).find(item=>item.id===id);
      if(current){
        if(current.status==='deleted')throw new Error('calendar_todo_deleted');
        if(current.revision!==expectedRevision)throw new Error('context_changed_retry');
      }else if(input.id!==undefined||expectedRevision!==undefined)throw new Error('calendar_todo_not_found');
      this.authority.lifecycle.checkpoint(scope,'calendar_todo',{automatic:true});
      const now=Date.now(),revision=(current?.revision??0)+1;
      this.db.prepare(`INSERT INTO scene_calendar_todos(scope,id,revision,title,due_at,status,created_at,updated_at)
        VALUES(?,?,?,?,?,'active',?,?) ON CONFLICT(scope,id) DO UPDATE SET
        revision=excluded.revision,title=excluded.title,due_at=excluded.due_at,status='active',updated_at=excluded.updated_at`)
        .run(scopeKey(scope),id,revision,title,dueAtMs,current?.createdAtMs??now,now);
      this.bump(scope);
      return {id,revision,title,dueAtMs,status:'active' as const,createdAtMs:current?.createdAtMs??now,updatedAtMs:now,
        ...localParts(dueAtMs,clock.timeZone),ownerId:'player' as const};
    });
  }

  completeTodo(scope:SceneScope,id:string,revision:number){return this.changeTodoStatus(scope,id,revision,'completed');}
  deleteTodo(scope:SceneScope,id:string,revision:number){return this.changeTodoStatus(scope,id,revision,'deleted');}

  reminds(scope:SceneScope,storyClockMs:number){
    if(!Number.isSafeInteger(storyClockMs)||storyClockMs<0)throw new Error('invalid_calendar_clock');
    const zone=this.storyZone(scope);
    const acknowledged=new Set(this.ackRows(scope).map(item=>`${item.id}:${item.revision}`));
    return this.todoRows(scope).filter(todo=>{
      if(todo.status!=='active'||storyClockMs>=todo.dueAtMs||acknowledged.has(`${todo.id}:${todo.revision}`))return false;
      const dayBefore=previousLocalDate(localParts(todo.dueAtMs,zone).date);
      const start=resolveStoryLocalDateTime(dayBefore,'00:00',zone);
      return start!==null&&storyClockMs>=start;
    }).map(todo=>({id:todo.id,revision:todo.revision,title:todo.title,dueAtMs:todo.dueAtMs,
      ...localParts(todo.dueAtMs,zone),ownerId:'player' as const}));
  }

  ackReminder(scope:SceneScope,id:string,revision:number){
    const todo=this.todoRows(scope).find(item=>item.id===id);
    if(!todo||todo.status!=='active')throw new Error('calendar_todo_not_found');
    if(todo.revision!==revision)throw new Error('context_changed_retry');
    const acknowledgedAtMs=Date.now();
    this.db.prepare(`INSERT OR IGNORE INTO scene_calendar_reminder_acks(scope,id,revision,acked_at) VALUES(?,?,?,?)`)
      .run(scopeKey(scope),id,revision,acknowledgedAtMs);
    return {id,revision,acknowledged:true};
  }

  private changeTodoStatus(scope:SceneScope,id:string,revision:number,status:'completed'|'deleted'){
    return this.authority.transaction(()=>{
      const current=this.todoRows(scope).find(item=>item.id===id);
      if(!current||current.status==='deleted')throw new Error('calendar_todo_not_found');
      if(current.revision!==revision)throw new Error('context_changed_retry');
      if(current.status===status)return {id,revision,status};
      this.authority.lifecycle.checkpoint(scope,'calendar_todo',{automatic:true});
      const nextRevision=revision+1;
      this.db.prepare('UPDATE scene_calendar_todos SET revision=?,status=?,updated_at=? WHERE scope=? AND id=?')
        .run(nextRevision,status,Date.now(),scopeKey(scope),id);
      this.bump(scope);
      return {id,revision:nextRevision,status};
    });
  }

  private storyClock(scope:SceneScope):{timeMs:number;timeZone:string}{
    const clock=this.authority.interactions.clock(scope);
    if(clock.kind!=='story'||clock.known!==true||typeof clock.timeMs!=='number')throw new Error('calendar_story_clock_unknown');
    return {timeMs:clock.timeMs,timeZone:clock.timeZone};
  }
  private storyZone(scope:SceneScope):string{
    const clock=this.authority.interactions.clock(scope);
    if(clock.kind!=='story')throw new Error('invalid_calendar_mode');
    return clock.timeZone;
  }
  private todoRows(scope:SceneScope){return captureCalendarTodoRows(this.db,scope);}
  private ackRows(scope:SceneScope){return captureCalendarAckRows(this.db,scope);}
  private bump(scope:SceneScope){
    this.db.prepare('UPDATE scene_worlds SET version=version+1 WHERE key=?').run(scopeKey(scope));
  }
}

export function captureCalendarTodoRows(db:DatabaseSync,scope:SceneScope):PersistedCalendarTodoRow[]{
  if(!hasTable(db,'scene_calendar_todos'))return [];
  return (db.prepare(`SELECT id,revision,title,due_at AS dueAtMs,status,created_at AS createdAtMs,
    updated_at AS updatedAtMs FROM scene_calendar_todos WHERE scope=? ORDER BY rowid`).all(scopeKey(scope)) as unknown as PersistedCalendarTodoRow[]);
}
export function captureCalendarAckRows(db:DatabaseSync,scope:SceneScope):PersistedCalendarAckRow[]{
  if(!hasTable(db,'scene_calendar_reminder_acks'))return [];
  return db.prepare(`SELECT id,revision,acked_at AS ackedAtMs FROM scene_calendar_reminder_acks WHERE scope=? ORDER BY rowid`)
    .all(scopeKey(scope)) as unknown as PersistedCalendarAckRow[];
}
export function restoreCalendarRows(db:DatabaseSync,scope:SceneScope,todos:readonly PersistedCalendarTodoRow[],acks:readonly PersistedCalendarAckRow[]){
  db.exec(`CREATE TABLE IF NOT EXISTS scene_calendar_todos (
    scope TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,title TEXT NOT NULL,due_at INTEGER NOT NULL,
    status TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(scope,id),
    CHECK(status IN ('active','completed','deleted')));
    CREATE TABLE IF NOT EXISTS scene_calendar_reminder_acks (
    scope TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,acked_at INTEGER NOT NULL,
    PRIMARY KEY(scope,id,revision));`);
  const key=scopeKey(scope);
  db.prepare('DELETE FROM scene_calendar_reminder_acks WHERE scope=?').run(key);
  db.prepare('DELETE FROM scene_calendar_todos WHERE scope=?').run(key);
  for(const item of todos)db.prepare(`INSERT INTO scene_calendar_todos
    (scope,id,revision,title,due_at,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`)
    .run(key,item.id,item.revision,item.title,item.dueAtMs,item.status,item.createdAtMs,item.updatedAtMs);
  for(const item of acks)db.prepare('INSERT INTO scene_calendar_reminder_acks(scope,id,revision,acked_at) VALUES(?,?,?,?)')
    .run(key,item.id,item.revision,item.ackedAtMs);
}

function hasTable(db:DatabaseSync,name:string){return !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name);}
function localParts(value:number,timeZone:string){
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(value);
  const part=(kind:string)=>parts.find(item=>item.type===kind)?.value??'';
  return {date:`${part('year').padStart(4,'0')}-${part('month')}-${part('day')}`,
    time:`${part('hour')}:${part('minute')}`};
}
function previousLocalDate(value:string){
  const [year,month,day]=value.split('-').map(Number);
  const date=new Date(0);date.setUTCFullYear(year!,month!-1,day!-1);date.setUTCHours(0,0,0,0);
  return `${String(date.getUTCFullYear()).padStart(4,'0')}-${String(date.getUTCMonth()+1).padStart(2,'0')}-${String(date.getUTCDate()).padStart(2,'0')}`;
}

function previewId(version:number,manifest:string,candidate:CalendarCandidate){
  return createHash('sha256').update(JSON.stringify({version,manifest,candidate})).digest('hex');
}

function batches(sources:readonly CalendarSource[]):CalendarSource[][]{
  const result:CalendarSource[][]=[];let current:CalendarSource[]=[],length=0;
  for(const source of sources){
    if(current.length&&(current.length>=40||length+source.text.length>40_000)){
      result.push(current);current=[];length=0;
    }
    current.push(source);length+=source.text.length;
  }
  if(current.length)result.push(current);
  return result;
}

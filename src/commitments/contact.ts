import {resolveCommitmentTime} from './time.ts';
import type {CommitmentRecord, ContactRestriction, ContactRestrictionCandidate} from './types.ts';

export function resolveContactRestriction(value:ContactRestrictionCandidate, context:{timeZone?:string;clockTimeMs?:number}):ContactRestriction|null {
  if(value.kind==='interval'){
    const startAtMs=resolveCommitmentTime(value.startQuote,context);
    const endAtMs=resolveCommitmentTime(value.endQuote,context);
    if(startAtMs===null||endAtMs===null||startAtMs>=endAtMs)return null;
    if(value.startAtMs!==undefined&&value.startAtMs!==startAtMs)throw new Error('invalid_contact_time');
    if(value.endAtMs!==undefined&&value.endAtMs!==endAtMs)throw new Error('invalid_contact_time');
    return {...value,startAtMs,endAtMs,level:value.level??'soft'};
  }
  const timeZone=context.timeZone;
  if(!timeZone)return null;
  const startMinute=contactMinute(value.startQuote),endMinute=contactMinute(value.endQuote);
  if(startMinute===null||endMinute===null||startMinute===endMinute)return null;
  if(value.timeZone!==undefined&&value.timeZone!==timeZone)throw new Error('invalid_contact_time_zone');
  if(value.startMinute!==undefined&&value.startMinute!==startMinute)throw new Error('invalid_contact_time');
  if(value.endMinute!==undefined&&value.endMinute!==endMinute)throw new Error('invalid_contact_time');
  return {...value,timeZone,startMinute,endMinute,level:value.level??'soft'};
}

/** Only explicit 24-hour clocks or clearly qualified Chinese hours are accepted. */
function contactMinute(quote:string):number|null {
  const value=quote.trim();
  const clock=/^(\d{1,2}):(\d{2})$/.exec(value);
  if(clock){const hour=Number(clock[1]),minute=Number(clock[2]);return hour<24&&minute<60?hour*60+minute:null;}
  const local=/^(凌晨|清晨|早上|上午|中午|下午|傍晚|晚上)\s*(\d{1,2})点(?:(半)|(\d{1,2})分?)?$/.exec(value);
  if(!local)return null;
  let hour=Number(local[2]);const minute=local[3]?30:local[4]===undefined?0:Number(local[4]);
  if(hour>12||minute>59)return null;
  if(local[1]==='凌晨'||local[1]==='清晨'||local[1]==='早上'||local[1]==='上午'){
    if(hour===12)return null;
  } else if(local[1]==='中午'){
    if(hour<11||hour>12)return null;
  } else if(local[1]==='傍晚'){
    if(hour>=5&&hour<=7)hour+=12;
    else if(hour<17||hour>19)return null;
  } else if(hour<12)hour+=12;
  return hour*60+minute;
}

export interface ContactRestrictionWindow {
  key:string;startsAtMs:number;endsAtMs:number;level:'soft'|'hard';
  commitmentId:string;revision:number;sourceId:string;sourceRevision:number;
}

export function contactRestrictionWindow(record:CommitmentRecord,nowMs:number):ContactRestrictionWindow|null {
  if(record.mode!=='companion'||record.status!=='active'||!record.contactRestriction||!Number.isSafeInteger(nowMs)||nowMs<0)return null;
  const rule=record.contactRestriction;
  let startsAtMs:number,endsAtMs:number,key:string;
  if(rule.kind==='interval'){
    startsAtMs=rule.startAtMs;endsAtMs=rule.endAtMs;key=`interval:${startsAtMs}:${endsAtMs}`;
  }else{
    const local=localParts(nowMs,rule.timeZone);
    const currentDay=Date.UTC(local.year,local.month-1,local.day);
    const dayStarts=rule.startMinute>rule.endMinute?[currentDay,currentDay-86_400_000]:[currentDay];
    const windows=dayStarts.map(day=>{
      const endDay=day+(rule.startMinute>rule.endMinute?86_400_000:0);
      const start=localBoundary(day,rule.startMinute,rule.timeZone,false);
      const end=localBoundary(endDay,rule.endMinute,rule.timeZone,true);
      return {start,end,day};
    });
    const match=windows.find(item=>item.start!==null&&item.end!==null&&nowMs>=item.start&&nowMs<item.end);
    if(!match)return null;
    startsAtMs=match.start!;endsAtMs=match.end!;
    key=`daily:${rule.timeZone}:${new Date(match.day).toISOString().slice(0,10)}:${rule.startMinute}:${rule.endMinute}`;
  }
  if(record.term.kind==='deadline'&&record.term.clock==='real')endsAtMs=Math.min(endsAtMs,record.term.dueAtMs);
  if(nowMs<startsAtMs||nowMs>=endsAtMs)return null;
  return {key,startsAtMs,endsAtMs,level:rule.level,commitmentId:record.id,revision:record.revision,
    sourceId:record.latestSourceId,sourceRevision:record.latestSourceRevision};
}

function localParts(ms:number,timeZone:string){
  let formatter=localFormatters.get(timeZone);
  if(!formatter){formatter=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});localFormatters.set(timeZone,formatter);}
  const parts=formatter.formatToParts(ms);
  const part=(name:string)=>Number(parts.find(item=>item.type===name)?.value);
  return {year:part('year'),month:part('month'),day:part('day'),hour:part('hour'),minute:part('minute')};
}
const localFormatters=new Map<string,Intl.DateTimeFormat>();
function localBoundary(day:number,minute:number,timeZone:string,last:boolean):number|null {
  const date=new Date(day),year=date.getUTCFullYear(),month=date.getUTCMonth()+1,dayOfMonth=date.getUTCDate();
  const nominal=day+minute*60_000,matches:number[]=[];
  for(let offset=-14*60;offset<=14*60;offset+=15){
    const candidate=nominal+offset*60_000,actual=localParts(candidate,timeZone);
    if(actual.year===year&&actual.month===month&&actual.day===dayOfMonth&&actual.hour===Math.floor(minute/60)&&actual.minute===minute%60)
      matches.push(candidate);
  }
  return matches.length?(last?matches.at(-1)!:matches[0]!):null;
}

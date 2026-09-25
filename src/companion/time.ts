import {createHash} from 'node:crypto';
import type {ContactOccurrence,ContactSettings,LocalContactWindow} from './types.ts';

interface DateParts {year:number;month:number;day:number;hour:number;minute:number}

/** Computes each local occurrence from the IANA zone; it never advances a prior UTC result by 24 hours. */
export function nextContactOccurrence(settings:ContactSettings,afterMs:number,horizonDays=21):ContactOccurrence|null {
  assertTime(afterMs);if(!Number.isSafeInteger(horizonDays)||horizonDays<1||horizonDays>366)throw new Error('invalid_contact_horizon');
  validateTimeZone(settings.timeZone);
  const local=partsAt(afterMs,settings.timeZone);const base=Date.UTC(local.year,local.month-1,local.day);
  for(let offset=0;offset<=horizonDays;offset++) {
    const date=new Date(base+offset*86_400_000);const year=date.getUTCFullYear(),month=date.getUTCMonth()+1,day=date.getUTCDate();
    const dateText=dateString(year,month,day),exception=settings.exceptions.find(item=>item.date===dateText);
    if(exception?.mode==='skip')continue;
    const weekday=new Date(Date.UTC(year,month-1,day)).getUTCDay();
    const windows=exception?.mode==='replace'?(exception.windows??[]):settings.windows.filter(window=>window.days.includes(weekday));
    for(const [windowIndex,window] of windows.entries()) {
      const parsedStart=clock(window.start),parsedEnd=clock(window.end);
      const startCandidates=resolveLocal(settings.timeZone,{year,month,day,...parsedStart});
      if(!startCandidates.length)continue;
      const crosses=parsedEnd.hour<parsedStart.hour||(parsedEnd.hour===parsedStart.hour&&parsedEnd.minute<=parsedStart.minute);
      const endDate=new Date(Date.UTC(year,month-1,day)+(crosses?86_400_000:0));
      const endCandidates=resolveLocal(settings.timeZone,{year:endDate.getUTCFullYear(),month:endDate.getUTCMonth()+1,day:endDate.getUTCDate(),...parsedEnd});
      if(!endCandidates.length)continue;
      const startAtMs=startCandidates[0]!,endAtMs=endCandidates.at(-1)!;
      if(endAtMs<=afterMs||endAtMs<=startAtMs)continue;
      return {occurrenceId:createHash('sha256').update(JSON.stringify([settings.subjectId,settings.revision,dateText,windowIndex,window.start,window.end])).digest('hex'),
        localDate:dateText,windowIndex,startAtMs,endAtMs,timeZone:settings.timeZone,settingsRevision:settings.revision};
    }
  }
  return null;
}

export function validateContactWindows(value:unknown):LocalContactWindow[] {
  if(!Array.isArray(value)||value.length>50)throw new Error('invalid_contact_windows');
  return value.map(item=>{
    if(!item||typeof item!=='object')throw new Error('invalid_contact_windows');
    const row=item as Record<string,unknown>;
    if(!Array.isArray(row.days)||!row.days.length||row.days.length>7)throw new Error('invalid_contact_windows');
    const days=[...new Set(row.days.map(day=>{if(!Number.isSafeInteger(day)||(day as number)<0||(day as number)>6)throw new Error('invalid_contact_windows');return day as number;}))];
    const start=clockText(row.start),end=clockText(row.end);return {days,start,end};
  });
}

export function validateTimeZone(value:string):void {
  if(typeof value!=='string'||!value.trim()||value.length>100)throw new Error('invalid_contact_time_zone');
  try{new Intl.DateTimeFormat('en-US',{timeZone:value}).format(0);}catch{throw new Error('invalid_contact_time_zone');}
}

export function validateDate(value:unknown):string {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new Error('invalid_contact_date');
  const [year,month,day]=value.split('-').map(Number);const date=new Date(Date.UTC(year!,month!-1,day!));
  if(dateString(date.getUTCFullYear(),date.getUTCMonth()+1,date.getUTCDate())!==value)throw new Error('invalid_contact_date');
  return value;
}

function resolveLocal(timeZone:string,wanted:DateParts):number[] {
  const nominal=Date.UTC(wanted.year,wanted.month-1,wanted.day,wanted.hour,wanted.minute),matches:number[]=[];
  for(let candidate=nominal-18*3_600_000;candidate<=nominal+18*3_600_000;candidate+=15*60_000) {
    const actual=partsAt(candidate,timeZone);
    if(actual.year===wanted.year&&actual.month===wanted.month&&actual.day===wanted.day&&actual.hour===wanted.hour&&actual.minute===wanted.minute)
      matches.push(candidate);
  }
  return matches;
}
function partsAt(value:number,timeZone:string):DateParts {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(value);
  const item=(type:string)=>Number(parts.find(part=>part.type===type)?.value);
  return {year:item('year'),month:item('month'),day:item('day'),hour:item('hour'),minute:item('minute')};
}
function clockText(value:unknown):string {if(typeof value!=='string')throw new Error('invalid_contact_clock');clock(value);return value;}
function clock(value:string):{hour:number;minute:number} {
  const match=/^(\d{2}):(\d{2})$/.exec(value);if(!match)throw new Error('invalid_contact_clock');
  const hour=Number(match[1]),minute=Number(match[2]);if(hour>23||minute>59)throw new Error('invalid_contact_clock');return {hour,minute};
}
function dateString(year:number,month:number,day:number):string{return `${year.toString().padStart(4,'0')}-${month.toString().padStart(2,'0')}-${day.toString().padStart(2,'0')}`;}
function assertTime(value:unknown):asserts value is number {if(!Number.isSafeInteger(value)||(value as number)<0)throw new Error('invalid_contact_time');}

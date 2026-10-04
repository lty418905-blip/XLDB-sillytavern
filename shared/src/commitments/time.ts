import {parseRelativeFuture,type RelativeFutureParse} from '../scene/time-expressions.ts';
import {storyClockParts,storyClockFromParts,STORY_CLOCK_RULE_V1} from '../scene/story-clock.ts';
import {STORY_CLOCK_MAX_MS} from '../scene/story-clock-types.ts';

export interface StoryDeadlineClock {atMs:number;dateKnown:boolean;yearKnown:boolean;timeOfDayKnown:boolean}

/** SC1 parses each bounded quote once; O(n) for at most 200 UTF-16 units, then O(1) arithmetic. */
export function resolveStoryDeadline(quote:string,clock:StoryDeadlineClock):number|null {
  try{
    if(typeof quote!=='string'||quote.length>200||!quote.trim())return null;
    if(clock===null||typeof clock!=='object')return null;
    const atMs=clock.atMs;
    if(!storyDeadlineValue(atMs))return null;
    const dateKnown=clock.dateKnown===true,yearKnown=clock.yearKnown===true,timeOfDayKnown=clock.timeOfDayKnown===true;
    const parsed=parseRelativeFuture(quote);
    if(parsed===null)return null;
    const parts=storyClockParts(atMs)!;
    const day0=atMs-parts.msOfDay,day=86_400_000;
    let result:number|null;
    if(parsed.kind==='after')result=atMs+parsed.minutes*60_000;
    else if(parsed.kind==='day'){
      if(parsed.time!==null)result=day0+parsed.dayOffset*day+deadlineTimeOffset(parsed.time);
      else if(parsed.timeOfDay!==null)result=timeOfDayKnown
        ?day0+parsed.dayOffset*day+deadlineTimeOffset(STORY_CLOCK_RULE_V1.timeOfDayRepresentativeTimes[parsed.timeOfDay]):null;
      else result=parsed.dayOffset>=1?atMs+parsed.dayOffset*day:null;
    }else{
      if(!dateKnown||!yearKnown)return null;
      if(parsed.kind==='weekday'){
        const today=Math.floor(atMs/day)%7,wanted=parsed.weekday-1;
        let offset=parsed.qualifier==='next'?7-today+wanted:wanted-today;
        if(parsed.qualifier==='this'&&offset<0)return null;
        if(parsed.qualifier==='none'){
          if(offset===0)return null;
          if(offset<0)offset+=7;
        }
        if(parsed.time!==null)result=day0+offset*day+deadlineTimeOffset(parsed.time);
        else result=parsed.timeOfDay!==null&&timeOfDayKnown
          ?day0+offset*day+deadlineTimeOffset(STORY_CLOCK_RULE_V1.timeOfDayRepresentativeTimes[parsed.timeOfDay]):null;
      }else{
        if(parsed.time!==null){
          result=storyClockFromParts(parsed.date,parsed.time);
          if(result!==null&&parsed.time.nextDay)result+=day;
        }else result=parsed.timeOfDay!==null
          ?storyClockFromParts(parsed.date,STORY_CLOCK_RULE_V1.timeOfDayRepresentativeTimes[parsed.timeOfDay]):null;
      }
    }
    return storyDeadlineValue(result)?result:null;
  }catch{return null;}
}

function storyDeadlineValue(value:unknown):value is number {
  return Number.isSafeInteger(value)&&(value as number)>=0&&(value as number)<=STORY_CLOCK_MAX_MS;
}
function deadlineTimeOffset(time:Pick<NonNullable<Extract<RelativeFutureParse,{kind:'day'}>['time']>,'hour'|'minute'>&{nextDay?:boolean}):number {
  return (time.hour*60+time.minute)*60_000+(time.nextDay?86_400_000:0);
}

interface DeadlineTimeContext {clockTimeMs?:number;timeZone?:string}
interface DateParts {year:number;month:number;day:number;hour:number;minute:number}

/** Resolve only explicit, bounded forms. Null means the phrase lacks enough deterministic time information. */
export function resolveCommitmentTime(quote:string,context:DeadlineTimeContext):number|null {
  if(typeof quote!=='string'||!quote.trim()||quote.length>200)return null;
  let value=quote.trim();
  // A single explicit reschedule keeps its stated day and, when omitted on
  // the new clock, its period. Never guess from an unrelated old record.
  const change=/^(今天|明天)\s*(清晨|早上|早晨|上午|中午|下午|傍晚|晚上|凌晨)?\s*([^改换调整]+?)(?:改为|改到|改成|调整为|调整到|换成)\s*(.+)$/.exec(value);
  if(change){
    const oldClock=localClock((change[2]??'')+change[3]!.trim());
    const replacement=change[4]!.trim();
    const newClock=localClock(replacement);
    if(!oldClock||!newClock)return null;
    const hasPeriod=/^(清晨|早上|早晨|上午|中午|下午|傍晚|晚上|凌晨)/.test(replacement);
    value=change[1]+(hasPeriod?'':change[2]??'')+replacement;
  }
  const iso=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if(iso){
    const [year,month,day,hour,minute,second,offsetHour,offsetMinute]=[iso[1],iso[2],iso[3],iso[4],iso[5],iso[6]??'0',iso[9]??'0',iso[10]??'0'].map(Number);
    const calendar=new Date(Date.UTC(year!,month!-1,day!));
    if(calendar.getUTCFullYear()!==year||calendar.getUTCMonth()+1!==month||calendar.getUTCDate()!==day||hour!>23||minute!>59||second!>59||offsetHour!>14||offsetMinute!>59)return null;
    const parsed=Date.parse(value);return Number.isSafeInteger(parsed)&&parsed>=0?parsed:null;
  }

  const relative=/^(半|\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万]+)\s*(?:个)?\s*(分钟|小时|天)\s*(?:后|内|之内)$/.exec(value);
  if(relative){
    if(!validTime(context.clockTimeMs))return null;
    const amount=relative[1]==='半'?0.5:numberOf(relative[1]!);if(amount===null||amount<=0)return null;
    const unit=relative[2]==='分钟'?60_000:relative[2]==='小时'?3_600_000:86_400_000;
    const result=context.clockTimeMs!+amount*unit;return Number.isSafeInteger(result)&&result>=0?result:null;
  }

  const absolute=/^(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})[日号]\s*(.*)$/.exec(value);
  if(absolute){
    if(!validTimeZone(context.timeZone))return null;
    const year=Number(absolute[1]),month=Number(absolute[2]),day=Number(absolute[3]);
    const date=new Date(Date.UTC(year,month-1,day)),clock=localClock(absolute[4]!);
    if(year<1970||date.getUTCFullYear()!==year||date.getUTCMonth()+1!==month||date.getUTCDate()!==day||!clock)return null;
    const next=new Date(Date.UTC(year,month-1,day)+(clock.nextDay?86_400_000:0));
    const candidates=resolveLocal(context.timeZone,{year:next.getUTCFullYear(),month:next.getUTCMonth()+1,day:next.getUTCDate(),
      hour:clock.hour,minute:clock.minute});
    return candidates.length===1?candidates[0]!:null;
  }
  const local=/^(今天|明天|后天|後天)\s*(.*)$/.exec(value);
  const colloquial=/^(今晚|今夜|明晚|明夜|今早|今晨|明早|明晨)\s*(.+)$/.exec(value);
  const weekday=/^(下|本|这|這)?\s*(周|週|星期|礼拜|禮拜)\s*([一二三四五六日天])\s*(.*)$/.exec(value);
  if((!local&&!colloquial&&!weekday)||!validTime(context.clockTimeMs)||!validTimeZone(context.timeZone))return null;
  let clock=localClock(simplifiedClock((local?local[2]:colloquial?colloquial[2]!.trim():weekday![4])!));if(!clock)return null;
  const base=partsAt(context.clockTimeMs!,context.timeZone!);
  const today=Date.UTC(base.year,base.month-1,base.day);
  let offsetDays:number;
  if(local)offsetDays=local[1]==='今天'?0:local[1]==='明天'?1:2;
  else if(colloquial){
    // 今晚/今夜 and 明晚/明夜 are that evening of the message's local day (or the next): 5-11 o'clock is 17-23, 12 or 0
    // o'clock is the following midnight, and a clock outside the evening fails. 今早/今晨 and 明早/明晨 are that
    // morning, before noon.
    offsetDays=colloquial[1]!.startsWith('明')?1:0;
    if(clock.nextDay)return null;
    if(/[晚夜]/.test(colloquial[1]!)){
      if(clock.hour>=5&&clock.hour<=11)clock={...clock,hour:clock.hour+12};
      else if(clock.hour===0||clock.hour===12){clock={...clock,hour:0};offsetDays+=1;}
      else if(clock.hour<17)return null;
    } else if(clock.hour>=12)return null;
  }
  else {
    // Monday-first week on the scope-zone calendar date: Monday=0 ... Sunday=6.
    const todayIndex=(new Date(today).getUTCDay()+6)%7;
    const wantedIndex='一二三四五六日'.indexOf(weekday![3]==='天'?'日':weekday![3]!);
    if(weekday![1]==='下')offsetDays=7-todayIndex+wantedIndex;
    else if(weekday![1]){offsetDays=wantedIndex-todayIndex;if(offsetDays<0)return null;}
    else {offsetDays=wantedIndex-todayIndex;if(offsetDays===0)return null;if(offsetDays<0)offsetDays+=7;}
  }
  // 今天晚上12点 / 明天晚上12点 close that day: midnight at its end.
  const date=new Date(today+(offsetDays+(clock.nextDay?1:0))*86_400_000);
  const candidates=resolveLocal(context.timeZone!,{year:date.getUTCFullYear(),month:date.getUTCMonth()+1,day:date.getUTCDate(),
    hour:clock.hour,minute:clock.minute});
  return candidates.length===1?candidates[0]!:null;
}

/** Map the few traditional characters used in clock phrases onto the simplified forms localClock accepts. */
function simplifiedClock(value:string):string {return value.replace(/點/g,'点').replace(/兩/g,'两');}

/** `nextDay`: 晚上12点 / 晚上0点 is the midnight that ends the named day. */
function localClock(value:string):(Pick<DateParts,'hour'|'minute'>&{nextDay?:boolean})|null {
  const match=/^(清晨|早上|早晨|上午|中午|下午|傍晚|晚上|凌晨)?\s*(\d{1,2}|[零〇一二两三四五六七八九十]+)(?::(\d{1,2})|点(?:(半)|((?:\d{1,2}|[零〇一二两三四五六七八九十]+))分?)?)$/.exec(value);
  if(!match)return null;
  let hour=numberOf(match[2]!);
  const minute=match[3]===undefined?(match[4]?30:match[5]===undefined?0:numberOf(match[5]!)):Number(match[3]);
  if(hour===null||minute===null||minute>59||hour>23)return null;
  if(match[1]==='上午'||match[1]==='凌晨'||match[1]==='早上'||match[1]==='早晨'||match[1]==='清晨'){if(hour>=12)return null;}
  else if(match[1]==='中午'){if(hour!==11&&hour!==12)return null;}
  else if(match[1]==='傍晚'){
    if(hour>=5&&hour<=7)hour+=12;
    else if(hour<17||hour>19)return null;
  }
  else if(match[1]==='晚上'&&(hour===0||hour===12))return {hour:0,minute,nextDay:true};
  else if(match[1]==='下午'||match[1]==='晚上'){
    if(hour===0)return null;
    if(hour<12)hour+=12;
  }
  return {hour,minute};
}

/** Arabic or plain Chinese numerals (零 to 万); null for anything else. */
export function commitmentNumber(value:string):number|null {return numberOf(value);}
function numberOf(value:string):number|null {
  if(/^\d+(?:\.\d+)?$/.test(value)){const result=Number(value);return Number.isFinite(result)?result:null;}
  const digit:Record<string,number>={零:0,'〇':0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
  if(!/[十百千万]/.test(value)){
    let result=0;for(const character of value){if(digit[character]===undefined)return null;result=result*10+digit[character];}return result;
  }
  const unit:Record<string,number>={十:10,百:100,千:1000,万:10000};let total=0,section=0,current=0;
  for(const character of value){
    if(digit[character]!==undefined){current=digit[character];continue;}
    const scale=unit[character];if(scale===undefined)return null;
    if(scale===10000){section+=current;total+=section*scale;section=0;current=0;}
    else {section+=(current||1)*scale;current=0;}
  }
  return total+section+current;
}

function resolveLocal(timeZone:string,wanted:DateParts):number[] {
  const nominal=Date.UTC(wanted.year,wanted.month-1,wanted.day,wanted.hour,wanted.minute),matches:number[]=[];
  for(let candidate=nominal-18*3_600_000;candidate<=nominal+18*3_600_000;candidate+=15*60_000){
    const actual=partsAt(candidate,timeZone);
    if(actual.year===wanted.year&&actual.month===wanted.month&&actual.day===wanted.day&&actual.hour===wanted.hour&&actual.minute===wanted.minute)matches.push(candidate);
  }
  return matches;
}
function partsAt(value:number,timeZone:string):DateParts {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(value);
  const item=(type:string)=>Number(parts.find(part=>part.type===type)?.value);
  return {year:item('year'),month:item('month'),day:item('day'),hour:item('hour'),minute:item('minute')};
}
function validTime(value:unknown):value is number{return Number.isSafeInteger(value)&&(value as number)>=0;}
function validTimeZone(value:unknown):value is string {
  if(typeof value!=='string'||!value.trim()||value.length>100)return false;
  try{new Intl.DateTimeFormat('en-US',{timeZone:value}).format(0);return true;}catch{return false;}
}

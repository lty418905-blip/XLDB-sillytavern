interface DeadlineTimeContext {clockTimeMs?:number;timeZone?:string}
interface DateParts {year:number;month:number;day:number;hour:number;minute:number}

/** Resolve only explicit, bounded forms. Null means the phrase lacks enough deterministic time information. */
export function resolveCommitmentTime(quote:string,context:DeadlineTimeContext):number|null {
  if(typeof quote!=='string'||!quote.trim()||quote.length>200)return null;
  let value=quote.trim();
  // A single explicit reschedule keeps its stated day and, when omitted on
  // the new clock, its period. Never guess from an unrelated old record.
  const change=/^(今天|明天)\s*(清晨|早上|上午|中午|下午|傍晚|晚上|凌晨)?\s*([^改换调整]+?)(?:改为|改到|改成|调整为|调整到|换成)\s*(.+)$/.exec(value);
  if(change){
    const oldClock=localClock((change[2]??'')+change[3]!.trim());
    const replacement=change[4]!.trim();
    const newClock=localClock(replacement);
    if(!oldClock||!newClock)return null;
    const hasPeriod=/^(清晨|早上|上午|中午|下午|傍晚|晚上|凌晨)/.test(replacement);
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
    const candidates=resolveLocal(context.timeZone,{year,month,day,...clock});
    return candidates.length===1?candidates[0]!:null;
  }
  const local=/^(今天|明天)\s*(.*)$/.exec(value);
  if(!local||!validTime(context.clockTimeMs)||!validTimeZone(context.timeZone))return null;
  const clock=localClock(local[2]!);if(!clock)return null;
  const base=partsAt(context.clockTimeMs!,context.timeZone!);
  const date=new Date(Date.UTC(base.year,base.month-1,base.day)+(local[1]==='明天'?86_400_000:0));
  const candidates=resolveLocal(context.timeZone!,{year:date.getUTCFullYear(),month:date.getUTCMonth()+1,day:date.getUTCDate(),...clock});
  return candidates.length===1?candidates[0]!:null;
}

function localClock(value:string):Pick<DateParts,'hour'|'minute'>|null {
  const match=/^(清晨|早上|上午|中午|下午|傍晚|晚上|凌晨)?\s*(\d{1,2}|[零〇一二两三四五六七八九十]+)(?::(\d{1,2})|点(?:(半)|((?:\d{1,2}|[零〇一二两三四五六七八九十]+))分?)?)$/.exec(value);
  if(!match)return null;
  let hour=numberOf(match[2]!);
  const minute=match[3]===undefined?(match[4]?30:match[5]===undefined?0:numberOf(match[5]!)):Number(match[3]);
  if(hour===null||minute===null||minute>59||hour>23)return null;
  if(match[1]==='上午'||match[1]==='凌晨'||match[1]==='早上'||match[1]==='清晨'){if(hour>=12)return null;}
  else if(match[1]==='中午'){if(hour!==11&&hour!==12)return null;}
  else if(match[1]==='傍晚'){
    if(hour>=5&&hour<=7)hour+=12;
    else if(hour<17||hour>19)return null;
  }
  else if(match[1]==='下午'||match[1]==='晚上'){
    if(hour===0)return null;
    if(hour<12)hour+=12;
  }
  return {hour,minute};
}

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

import type {SceneReference} from './transfer.ts';
import type {SceneState} from './types.ts';
import type {WorldSettings} from './world-state.ts';

interface DateClue {date:string;time:string;year:number}
const datePattern=/(?<!\d)(\d{4})(?:-(\d{1,2})-(\d{1,2})|年\s*(\d{1,2})月\s*(\d{1,2})[日号])(?:[ T]\s*([01]?\d|2[0-3]):([0-5]\d))?(?!\d)/g;
const yearPattern=/(?<!\d)(\d{4})\s*年(?!\s*\d{1,2}月\s*\d{1,2}[日号])/g;
const openingCue=/(?:剧情|故事)(?:起始|开始|开场|当前时间|当前日期|发生于)|故事背景|设定年代|开场(?:时间|日期|是|于)?|当前(?:日期|时间|是)|现在是|今天是|开始时间|起始日期|^\s*(?:起始|时间|日期)\s*[:：]|start date|current date|story start/i;

/** Derives a fixed opening clock only; later prose belongs to ordinary world effects. */
export function initialStorySettings(state:SceneState,references:readonly SceneReference[],timeZone:string):WorldSettings|null{
  if(!Number.isSafeInteger(state.createdAtMs)||state.createdAtMs<=0||!validZone(timeZone))return null;
  const initialReferences=references.filter(reference=>
    !/^initialization\/(example_dialogue|future_idea)(?:\/|$)/.test(reference.table));
  const referenceClues=clues(initialReferences.map(reference=>reference.text));
  // The opening position is fixed. Deleting it cannot promote a later turn
  // into a new opening date and silently reinterpret earlier elapsed time.
  const firstAccepted=state.sources[0]?.status==='accepted'?state.sources[0]:undefined;
  const openingClues=firstAccepted?clues([firstAccepted.text]):{dates:[],years:[]};
  // A selected world's opening setting outranks the first exchange. The first
  // exchange is considered only when world material has no year/date clue.
  const selected=referenceClues.dates.length||referenceClues.years.length?referenceClues:openingClues;
  let startTimeMs=state.createdAtMs;
  if(selected.dates.length){
    const unique=[...new Set(selected.dates.map(item=>`${item.date}T${item.time}`))];
    if(unique.length!==1)return null;
    const date=selected.dates[0]!;
    if(selected.years.some(year=>year!==date.year))return null;
    const resolved=resolveLocal(date.date,date.time,timeZone);
    if(resolved===null)return null;
    startTimeMs=resolved;
  }else if(selected.years.length)return null;
  const playerName=firstAccepted?.envelope.playerName?.trim()||'玩家';
  const used=new Set<string>([playerName]);
  const actorLabels:Record<string,string[]>={};
  for(const actor of state.roster.characters){
    const labels=[actor.name,...actor.aliases].filter(label=>label&&label!=='我'&&!used.has(label));
    if(!labels.length)labels.push(actor.id);
    for(const label of labels)used.add(label);
    actorLabels[actor.id]=labels;
  }
  return {mode:'story',startTimeMs,actorLabels,playerName,publicTime:true,balances:[],inventory:[]};
}

function clues(texts:readonly string[]):{dates:DateClue[];years:number[]}{
  const dates:DateClue[]=[],years:number[]=[];
  for(const text of texts){
    for(const segment of text.split(/[。！？\n；;，,]/)){
      if(!openingCue.test(segment))continue;
      for(const match of segment.matchAll(datePattern)){
        const year=Number(match[1]),month=Number(match[2]??match[4]),day=Number(match[3]??match[5]);
        if(year<1970||year>9999||!validDate(year,month,day)){years.push(year);continue;}
        dates.push({date:`${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`,
          time:`${String(Number(match[6]??0)).padStart(2,'0')}:${match[7]??'00'}`,year});
      }
      for(const match of segment.matchAll(yearPattern))years.push(Number(match[1]));
    }
  }
  return {dates,years};
}

function validDate(year:number,month:number,day:number){
  const date=new Date(0);date.setUTCFullYear(year,month-1,day);date.setUTCHours(0,0,0,0);
  return date.getUTCFullYear()===year&&date.getUTCMonth()+1===month&&date.getUTCDate()===day;
}
function validZone(timeZone:string){
  try{new Intl.DateTimeFormat('en-US',{timeZone}).format(0);return true;}catch{return false;}
}
export function resolveStoryLocalDateTime(date:string,time:string,timeZone:string):number|null{
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)||!validZone(timeZone))return null;
  const [year,month,day]=date.split('-').map(Number),[hour,minute]=time.split(':').map(Number);
  if(year!<1970||year!>9999||!validDate(year!,month!,day!))return null;
  const nominal=Date.UTC(year!,month!-1,day!,hour!,minute!);
  const formatter=new Intl.DateTimeFormat('en-US',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const matches:number[]=[];
  for(let candidate=nominal-18*3_600_000;candidate<=nominal+18*3_600_000;candidate+=15*60_000){
    const parts=formatter.formatToParts(candidate);
    const value=(kind:string)=>Number(parts.find(part=>part.type===kind)?.value);
    if(value('year')===year&&value('month')===month&&value('day')===day&&
      value('hour')===hour&&value('minute')===minute)matches.push(candidate);
  }
  return matches.length===1&&Number.isSafeInteger(matches[0])&&matches[0]!>=0?matches[0]!:null;
}

const resolveLocal=resolveStoryLocalDateTime;

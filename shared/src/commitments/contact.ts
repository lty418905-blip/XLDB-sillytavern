import {foldForMatch} from '../common/script-fold.ts';
import {commitmentNumber,resolveCommitmentTime} from './time.ts';
import type {CommitmentRecord, ContactRestriction, ContactRestrictionCandidate, ContactRestrictionOrigin} from './types.ts';

const DAY=86_400_000;

/**
 * Resolves a quoted restriction and stamps the level and origin the caller derived from its source (the candidate's own
 * level and origin are never read here). Fails closed: quotes that carry any time word (a clock, a duration, a date, a day
 * such as 今晚 or 明天, a weekday, a period such as 下午) but do not resolve to one range throw `invalid_contact_time`, so a
 * time the user set is never silently lost. Only quotes with no time word at all (a state such as 这几天, 可能没空, 去睡了
 * or 晚安) resolve to null, which the caller drops. A supplied timestamp or minute that disagrees with the quotes throws.
 */
export function resolveContactRestriction(value:ContactRestrictionCandidate, context:{timeZone?:string;clockTimeMs?:number},
  stamp:{level:'soft'|'hard';origin?:ContactRestrictionOrigin}):ContactRestriction|null {
  const {level:_level,origin:_origin,...rule}=value;
  const stamped={level:stamp.level,...(stamp.origin===undefined?{}:{origin:stamp.origin})};
  let resolved:ContactRestriction|null=null;
  if(rule.kind==='interval'){
    const range=intervalRange(rule.startQuote,rule.endQuote,context);
    if(range){
      const [startAtMs,endAtMs]=range;
      if(rule.startAtMs!==undefined&&rule.startAtMs!==startAtMs)throw new Error('invalid_contact_time');
      if(rule.endAtMs!==undefined&&rule.endAtMs!==endAtMs)throw new Error('invalid_contact_time');
      resolved={...rule,startAtMs,endAtMs,...stamped};
    }
  } else {
    const timeZone=context.timeZone;
    const pair=timeZone?clockPair(rule.startQuote,rule.endQuote,timeZone,context.clockTimeMs):null;
    if(timeZone&&pair){
      const {startMinute,endMinute}=pair;
      if(rule.timeZone!==undefined&&rule.timeZone!==timeZone)throw new Error('invalid_contact_time_zone');
      if(rule.startMinute!==undefined&&rule.startMinute!==startMinute)throw new Error('invalid_contact_time');
      if(rule.endMinute!==undefined&&rule.endMinute!==endMinute)throw new Error('invalid_contact_time');
      resolved={...rule,timeZone,startMinute,endMinute,...stamped};
    }
  }
  if(resolved)return resolved;
  if(contactTimeWords(rule.startQuote)||contactTimeWords(rule.endQuote))throw new Error('invalid_contact_time');
  return null;
}

/**
 * A restriction exactly as it was stored, for revalidating a saved operation: its resolved times, zone, level and origin
 * stand and its quotes are not parsed again, so rows saved under older parsing rules (a legacy 晚上12点 stored as 720,
 * or a 傍晚18点 that older rules rejected) keep their stored meaning instead of failing. Null when the stored values are
 * incomplete or impossible; the caller then parses the quotes as for a fresh extraction.
 */
export function storedContactRestriction(value:ContactRestrictionCandidate,fallbackLevel:'soft'|'hard'):ContactRestriction|null {
  const level=value.level??fallbackLevel,stamped={level,...(value.origin===undefined?{}:{origin:value.origin}),
    ...(value.inheritedFrom===undefined?{}:{inheritedFrom:value.inheritedFrom})};
  if(value.kind==='interval'){
    if(!validTime(value.startAtMs)||!validTime(value.endAtMs)||value.startAtMs>=value.endAtMs)return null;
    return {kind:'interval',startQuote:value.startQuote,endQuote:value.endQuote,startAtMs:value.startAtMs,endAtMs:value.endAtMs,...stamped};
  }
  const minute=(item:unknown):item is number=>Number.isSafeInteger(item)&&(item as number)>=0&&(item as number)<1440;
  if(typeof value.timeZone!=='string'||!minute(value.startMinute)||!minute(value.endMinute)||value.startMinute===value.endMinute)return null;
  try{new Intl.DateTimeFormat('en-US',{timeZone:value.timeZone}).format(0);}catch{return null;}
  return {kind:'daily',startQuote:value.startQuote,endQuote:value.endQuote,timeZone:value.timeZone,startMinute:value.startMinute,
    endMinute:value.endMinute,...stamped};
}

/**
 * Whether a user message asks her not to contact them: a prohibition (别, 不要, 不许, 不准, 先别, 请勿, 勿, 免, 不想,
 * 不希望 and their traditional forms) followed within four characters by a contact verb or object (找, 打扰 (also 被打扰),
 * 打搅, 发, 联系, 联络, 烦, 吵, 理, 叫, 消息, 信息, 私信, 私聊, 打给, 打电话, @, 戳, call), or 免打扰/勿扰/请勿打扰, or
 * 不接电话. It is deliberately broad: on her agreement echoing a user message,
 * a missed request would silently soften the user's boundary, which is worse than a false hard window. It decides a
 * range in the user's own message and her echo alike (a bare schedule such as 我十一点到七点睡觉 or 我明天三点到五点开会
 * stays her soft window). A prohibition that asks her not to forget or miss contact is an invitation, not a request for
 * quiet: 别忘了给我发消息, 醒了别忘了找我, 不想错过你的消息 and 不要错过 do not count (记得找我 has no prohibition at all).
 * Neither does a double negation or a plea not to be kept waiting: 别不理我, 不要不理我, 醒了别不找我, 别让我等你消息 and
 * 别再忘了找我 (a prohibition followed at once by 不理/不找/不回/不联系/不联络, 再忘 or 让我等). Any other 不 after
 * the prohibition still asks for quiet: 别不停地发消息 and 不要不停给我发消息 count.
 */
export function noContactRequest(text:string):boolean {return NO_CONTACT_REQUEST.test(foldForMatch(text));}
const NO_CONTACT_REQUEST=new RegExp(foldForMatch('(?:先别|請勿|请勿|不要|不许|不許|不准|不準|不想|不希望|别|別|勿|免)(?!忘|错过|錯過|不(?:理|找|回|联系|聯繫|联络|聯絡)|再忘|让我等|讓我等)\\S{0,4}?'+
  '(?:被?(?:打扰|打擾)|找|打搅|打攪|发|發|联系|聯繫|联络|聯絡|烦|煩|吵|理|叫|消息|信息|私信|私聊|传讯息|传简讯|私讯|(?<![泄洩告保秘機机加解])密我|打给|打給|打电话|打電話|@|戳|call)'+
  '|免打扰|免打擾|勿扰|勿擾|请勿打扰|請勿打擾|不接\\S{0,2}(?:电话|電話)'),'i');

/**
 * Whether the user's words lift a no-contact window. Every cue is tied to contact: 可以…找/联系/发消息/打扰, 随时…找,
 * 不用…别找/不找/勿扰/安静/避开, 取消…约定/勿扰/限制/时段, 解除…限制/勿扰, 不(再)限制, in simplified and traditional
 * forms; words that, apart from the cue itself, also ask not to be contacted (noContactRequest) never lift. Only such words may clear the user's own
 * hard window in a replacement (我不用加班了, 可以发我文件吗, 你不用回了, 把会议取消了 do not).
 */
export function contactLiftRequest(text:string):boolean {
  text=foldForMatch(text);
  // A 取消/解除 cue may itself name 勿扰 (解除勿扰): only that token is removed before asking whether the rest of the
  // text asks for quiet, so 「可以找我，但别发消息」 or 「不用再避开了，别找我」 never lift.
  const rest=text.replace(/(?:取消|解除)\S{0,4}?(?:勿扰|勿擾)/g,cue=>cue.replace(/勿扰|勿擾/g,''));
  return CONTACT_LIFT_REQUEST.test(text)&&!noContactRequest(rest);
}
// 可以 is not negated (不可以, 别可以, 不太可以) and not followed by a negation (可以不找我吗, 可以别找我吗); 随时找 is not
// forbidden (别随时找我).
const CONTACT_LIFT_REQUEST=new RegExp(foldForMatch([
  '(?<!不|别|別|不太)可以(?![不别別])\\S{0,3}(?:找|联系|聯繫|聯絡|发消息|發消息|发信息|發信息|發訊息|传讯息|传简讯|私讯|打扰|打擾)',
  '(?<!别|別|不要|不许|不許)(?:随时|隨時)\\S{0,2}找',
  '不用\\S{0,6}(?:勿扰|勿擾|安静|安靜|避开|避開)','取消\\S{0,4}(?:约定|約定|勿扰|勿擾|限制|时段|時段)',
  '解除\\S{0,4}(?:限制|勿扰|勿擾)','不(?:再)?限制',
].join('|')));

/**
 * Whether `text` (the user's message) states a range, two time phrases joined by 到, 至, ~ or -, that resolves under
 * `context` to the same window as `rule` (the same kind, times and zone). Her echo may word the user's times differently
 * (「十点到七点别找我」 answered 「晚上十点到早上七点我不找你」): it is still the user's range only when both readings agree.
 * Each side is a phrase of at most twelve characters next to the joiner, cut at punctuation; phrases without a time word,
 * or that do not resolve, never match. Only the longest time-bearing phrases that resolve together are compared (the start
 * suffix first, then the end prefix): a shorter one would drop words the user said, so 「上午十点到七点别找我」 (10:00-19:00)
 * never matches 晚上十点 / 早上七点 through its bare 十点.
 */
export function userRangeMatches(text:string,rule:ContactRestrictionCandidate,context:{timeZone?:string;clockTimeMs?:number}):boolean {
  const target=quietResolve(rule,context);
  if(!target)return false;
  for(const joiner of text.matchAll(/到|至|~|～|-|－/g)){
    const at=joiner.index,left=RANGE_PHRASE_LEFT.exec(text.slice(Math.max(0,at-12),at))?.[0]??'';
    const right=RANGE_PHRASE_RIGHT.exec(text.slice(at+joiner[0].length,at+joiner[0].length+12))?.[0]??'';
    // Longest first on both sides.
    const starts=[...left].map((_,index)=>left.slice(index)).filter(contactTimeWords);
    const ends=[...right].map((_,index)=>right.slice(0,right.length-index)).filter(contactTimeWords);
    const resolved=longestResolved(starts,ends,rule.kind,context);
    if(resolved&&sameContactWindow(resolved,target))return true;
  }
  return false;
}
function longestResolved(starts:readonly string[],ends:readonly string[],kind:ContactRestrictionCandidate['kind'],
  context:{timeZone?:string;clockTimeMs?:number}):ContactRestriction|null {
  for(const startQuote of starts)for(const endQuote of ends){
    const resolved=quietResolve({kind,startQuote,endQuote},context);
    if(resolved)return resolved;
  }
  return null;
}
const RANGE_PHRASE_LEFT=/[^\s，。,.!！?？、；;：:“”"'（）()【】\[\]到至~～\-－]*$/;
const RANGE_PHRASE_RIGHT=/^[^\s，。,.!！?？、；;：:“”"'（）()【】\[\]到至~～\-－]*/;
function quietResolve(rule:ContactRestrictionCandidate,context:{timeZone?:string;clockTimeMs?:number}):ContactRestriction|null {
  try{return resolveContactRestriction(rule,context,{level:'soft'});}catch{return null;}
}
function sameContactWindow(left:ContactRestriction,right:ContactRestriction):boolean {
  if(left.kind==='interval')return right.kind==='interval'&&left.startAtMs===right.startAtMs&&left.endAtMs===right.endAtMs;
  return right.kind==='daily'&&left.timeZone===right.timeZone&&left.startMinute===right.startMinute&&left.endMinute===right.endMinute;
}

/**
 * Whether a restriction quote names any time: a digit, a Chinese numeral with a clock, date or duration unit, a duration
 * word, a day word (今晚, 今夜, 明早, 明晨, 今天, 明天, 后天), a weekday or week, or a period of the day (上午, 下午,
 * 晚上, 凌晨...). 这几天 and 这两天 are the colloquial "these days" and do not count.
 */
export function contactTimeWords(quote:string):boolean {return CONTACT_TIME_WORD.test(foldForMatch(quote));}
const CONTACT_TIME_WORD=new RegExp(foldForMatch([
  '\\d','[零〇一二两兩三四五六七八九十百半][个個]?(?:点|點|时|時|钟|鐘|月|号|號|日|周|週|星期|礼拜|禮拜)',
  '(?<![这這])[零〇一二两兩三四五六七八九十百半][个個]?天','小时|小時|分钟|分鐘|钟头|鐘頭',
  '今晚|今夜|今早|今晨|明早|明晚|明晨|明夜|今天|明天|后天|後天|昨天|今日|明日|今年|明年|月底|月初',
  '凌晨|清晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里|夜裡|半夜|午夜|深夜','周|週|星期|礼拜|禮拜',
].join('|')));

/**
 * An interval from dated or relative quotes (今天晚上10点 / 明天早上7点); one duration quote used as both ends
 * (两小时: from the message time); a dated start with a duration or a clock end; or two clock quotes (十点 / 七点), which
 * mean the local window instance containing the message time, or else the next one.
 */
function intervalRange(startQuote:string,endQuote:string,context:{timeZone?:string;clockTimeMs?:number}):[number,number]|null {
  // This helper returns only numbers; the caller retains both original quote fields.
  startQuote=foldForMatch(startQuote);endQuote=foldForMatch(endQuote);
  const clock=context.clockTimeMs;
  // Said in the small hours, a 明早/明天早上 start is the morning now coming, and a 明天-anchored end moves with it
  // (01:00「明早九点到明早十一点」is 09:00-11:00 today).
  const morningStart=morningInProgress(startQuote,context);
  // A start moved to this morning with an end anchored further out (后天, 下周, a weekday or a date) has no single
  // reading; fail closed.
  if(morningStart!==null&&/^(?:后天|後天|大后天|大後天|下周|下週|下星期|下礼拜|下禮拜|(?:本|这|這)?(?:周|週|星期|礼拜|禮拜)|\d{4}年|\d{1,2}月)/
    .test(endQuote.trim()))return null;
  const start=morningStart??resolveCommitmentTime(startQuote,context);
  const end=morningStart!==null&&/^(?:明早|明晨|明晚|明夜|明天)/.test(endQuote.trim())
    ?resolveCommitmentTime(endQuote,{...context,clockTimeMs:clock!-DAY}):resolveCommitmentTime(endQuote,context);
  if(start!==null&&end!==null){
    const night=nightInProgress(startQuote,endQuote,context);
    if(night)return night;
    return start<end?[start,end]:null;
  }
  const until=untilRange(startQuote,endQuote,context);
  if(until)return until;
  if(startQuote.trim()===endQuote.trim()){
    const duration=contactDuration(startQuote);
    return duration!==null&&validTime(clock)?[clock,clock+duration]:null;
  }
  if(start!==null){
    const duration=contactDuration(endQuote);
    if(duration!==null)return [start,start+duration];
    const minutes=clockCandidates(endQuote);
    if(!minutes||!context.timeZone)return null;
    const after=minutes.flatMap(minute=>nextLocalInstant(minute,context.timeZone!,start)).sort((a,b)=>a-b)[0];
    return after===undefined?null:[start,after];
  }
  if(end!==null||!context.timeZone||!validTime(clock))return null;
  const pair=clockPair(startQuote,endQuote,context.timeZone,clock);
  if(!pair)return null;
  const instance=localInstance(pair.startMinute,pair.endMinute,context.timeZone,clock);
  return instance?[instance.start,instance.end]:null;
}

/**
 * Whether `outer` covers every instant `inner` does, in the daily/interval sense: two intervals nest; a daily window
 * covers a daily window in the same zone whose arc lies inside its own; a daily window covers an interval that lies inside
 * one of its instances; an interval never covers a daily window.
 */
export function contactWindowContains(outer:ContactRestriction,inner:ContactRestriction):boolean {
  if(outer.kind==='interval')return inner.kind==='interval'&&outer.startAtMs<=inner.startAtMs&&inner.endAtMs<=outer.endAtMs;
  if(inner.kind==='daily'){
    if(inner.timeZone!==outer.timeZone)return false;
    const length=(minute:number,from:number)=>(minute-from+1440)%1440;
    const outerLength=length(outer.endMinute,outer.startMinute)||1440,innerLength=length(inner.endMinute,inner.startMinute)||1440;
    return length(inner.startMinute,outer.startMinute)+innerLength<=outerLength;
  }
  const local=localParts(inner.startAtMs,outer.timeZone),today=Date.UTC(local.year,local.month-1,local.day);
  return [-1,0].some(offset=>{
    const window=dailyInstance(today+offset*DAY,outer.startMinute,outer.endMinute,outer.timeZone);
    return window!==null&&window.start<=inner.startAtMs&&inner.endAtMs<=window.end;
  });
}

/**
 * 今晚十点到明早七点 said in the small hours (local 00:00 to 06:00) means the night already in progress: from the message
 * time to that morning's clock, not the following night. Null when that morning has already passed or the quotes are not
 * of this form.
 */
function nightInProgress(startQuote:string,endQuote:string,context:{timeZone?:string;clockTimeMs?:number}):[number,number]|null {
  if(!/^(?:今晚|今夜|今天晚上|今天夜里|今天夜裡)/.test(startQuote.trim()))return null;
  const end=morningInProgress(endQuote,context);
  return end===null?null:[context.clockTimeMs!,end];
}

/**
 * A 明早/明晨/明天早上/明天早晨 clock said in the small hours (local 00:00 to 06:00) means the morning now coming, not the
 * next day's: resolved against the previous local day. Null outside the small hours, for other phrases, or when that
 * morning's clock has already passed.
 */
function morningInProgress(quote:string,context:{timeZone?:string;clockTimeMs?:number}):number|null {
  const clock=context.clockTimeMs;
  if(!context.timeZone||!validTime(clock)||localParts(clock,context.timeZone).hour>=6)return null;
  if(!/^(?:明早|明晨|明天早上|明天早晨|明天清晨)/.test(quote.trim()))return null;
  const at=resolveCommitmentTime(quote,{...context,clockTimeMs:clock-DAY});
  return at!==null&&at>clock?at:null;
}

/**
 * 七点前 / 七点之前 / 七点以前, 到七点为止, and 现在到七点 / 从现在到七点: from the message time to the next occurrence of
 * the clock after it (a dated clock such as 明早七点 is taken as said). The start is implicit: the model repeats the end
 * phrase as the start, or copies the user's 现在. A repeated phrase needs a 前/为止 or 到 marker; a bare repeated clock is
 * not a range.
 */
function untilRange(startQuote:string,endQuote:string,context:{timeZone?:string;clockTimeMs?:number}):[number,number]|null {
  const clock=context.clockTimeMs;
  if(!validTime(clock))return null;
  const start=simplified(startQuote),end=simplified(endQuote);
  const fromNow=/^(?:从|從)?\s*(?:现在|現在|此刻|这会儿)\s*(?:起|开始|開始)?$/.test(start);
  const marked=/^(?:到|直到|一直到)\s*(.+)$|^(.+?)\s*(?:之前|以前|前|为止|為止)$/.exec(end);
  if(!fromNow&&!(start===end&&marked))return null;
  const target=(marked?(marked[1]??marked[2])!:end).replace(/\s*(?:之前|以前|前|为止|為止)$/,'').trim();
  if(!target)return null;
  const dated=morningInProgress(target,context)??resolveCommitmentTime(target,context);
  if(dated!==null)return dated>clock?[clock,dated]:null;
  const minutes=clockCandidates(target);
  if(!minutes||!context.timeZone)return null;
  const next=minutes.flatMap(minute=>nextLocalInstant(minute,context.timeZone!,clock)).sort((a,b)=>a-b)[0];
  return next===undefined?null:[clock,next];
}

/**
 * Local start and end minutes for two clock quotes. A clock with a period (晚上十点) or in 24-hour form is taken as said;
 * a bare hour (十点) may be morning or evening, and the reading with the shorter window wins. When two readings are equally
 * short, one starting between 01:00 and 05:00 is dropped (三点到五点 is 15-17); if that leaves a tie (十点到七点: 10-19 or
 * 22-7), the one containing the message time, or else starting next, is meant; without a message time that tie stays
 * unresolved.
 */
function clockPair(startQuote:string,endQuote:string,timeZone:string,clockTimeMs:number|undefined):{startMinute:number;endMinute:number}|null {
  const starts=clockCandidates(startQuote),ends=clockCandidates(endQuote);
  if(!starts||!ends)return null;
  const pairs=starts.flatMap(startMinute=>ends.filter(endMinute=>endMinute!==startMinute).map(endMinute=>({startMinute,endMinute,
    length:(endMinute-startMinute+1440)%1440})));
  if(!pairs.length)return null;
  const shortest=Math.min(...pairs.map(pair=>pair.length)),equal=pairs.filter(pair=>pair.length===shortest);
  // Of two equally short readings, one starting in the small hours (01:00 to 05:00) is rarely meant: 三点到五点 is
  // 15:00-17:00. Said in the small hours themselves (local 00:00 to 06:00), such a reading is dropped only when its
  // instance already began before the message (04:30「三点到五点」is still 15:00-17:00), and kept when it is still ahead
  // (04:30「五点到七点」is 05:00-07:00 today); the message time then decides.
  const smallHours=validTime(clockTimeMs)&&localParts(clockTimeMs,timeZone).hour<6;
  const awake=equal.filter(pair=>pair.startMinute<60||pair.startMinute>300||
    (smallHours&&(localInstance(pair.startMinute,pair.endMinute,timeZone,clockTimeMs!)?.start??-1)>=clockTimeMs!));
  const best=awake.length?awake:equal;
  if(best.length===1)return {startMinute:best[0]!.startMinute,endMinute:best[0]!.endMinute};
  if(!validTime(clockTimeMs))return null;
  const ranked=best.flatMap(pair=>{
    const instance=localInstance(pair.startMinute,pair.endMinute,timeZone,clockTimeMs);
    return instance?[{pair,rank:instance.start<=clockTimeMs?-1:instance.start-clockTimeMs}]:[];
  }).sort((a,b)=>a.rank-b.rank);
  if(!ranked.length||(ranked.length>1&&ranked[0]!.rank===ranked[1]!.rank))return null;
  return {startMinute:ranked[0]!.pair.startMinute,endMinute:ranked[0]!.pair.endMinute};
}

/** The local window instance containing `atMs`, or else the next one to start. */
function localInstance(startMinute:number,endMinute:number,timeZone:string,atMs:number):{start:number;end:number}|null {
  const local=localParts(atMs,timeZone),today=Date.UTC(local.year,local.month-1,local.day);
  const instances=[-1,0,1,2].flatMap(offset=>{
    const window=dailyInstance(today+offset*DAY,startMinute,endMinute,timeZone);return window?[window]:[];
  });
  return instances.find(item=>item.start<=atMs&&atMs<item.end)??instances.find(item=>item.start>atMs)??null;
}
function dailyInstance(day:number,startMinute:number,endMinute:number,timeZone:string):{start:number;end:number}|null {
  const start=localBoundary(day,startMinute,timeZone,false);
  const end=localBoundary(day+(startMinute>endMinute?DAY:0),endMinute,timeZone,true);
  return start!==null&&end!==null&&start<end?{start,end}:null;
}
function nextLocalInstant(minute:number,timeZone:string,afterMs:number):number[] {
  const local=localParts(afterMs,timeZone),today=Date.UTC(local.year,local.month-1,local.day);
  for(const offset of [0,1,2]){const at=localBoundary(today+offset*DAY,minute,timeZone,false);if(at!==null&&at>afterMs)return [at];}
  return [];
}

/** Map the traditional characters used in clock and duration phrases onto the simplified forms parsed here. */
function simplified(value:string):string {
  return foldForMatch(value).trim();
}

/**
 * A duration counted from the message time: 两小时, 这两个小时, 一个半小时, 三十分钟, 三天内. 这两天 and 这几天 are the
 * colloquial "these days", a state and not a range.
 */
export function contactDuration(quote:string):number|null {
  const value=simplified(quote);
  const match=/^(这|接下来|未来)?\s*(半|\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)\s*(?:个)?\s*(半)?\s*(分钟|小时|钟头|天)\s*(?:之内|以内|内)?$/.exec(value);
  if(!match)return null;
  if(match[4]==='天'&&match[1]==='这')return null;
  if(match[2]==='半'&&match[3])return null;
  const whole=match[2]==='半'?0.5:commitmentNumber(match[2]!);
  if(whole===null)return null;
  const amount=whole+(match[3]?0.5:0);
  const result=amount*(match[4]==='分钟'?60_000:match[4]==='天'?DAY:3_600_000);
  return amount>0&&Number.isSafeInteger(result)&&result<=30*DAY?result:null;
}

/**
 * Local minutes a clock quote can mean: one for a 24-hour clock or a stated period, two (morning and evening) for a bare
 * hour from 1 to 12. Null when the quote is not a clock.
 */
function clockCandidates(quote:string):number[]|null {
  const value=simplified(quote);
  const clock=/^(\d{1,2}):(\d{2})$/.exec(value);
  if(clock){const hour=Number(clock[1]),minute=Number(clock[2]);return hour<24&&minute<60?[hour*60+minute]:null;}
  const local=/^(凌晨|清晨|早上|上午|中午|下午|傍晚|晚上|夜里)?\s*(\d{1,2}|[零〇一二两三四五六七八九十]+)\s*点(?:钟)?(?:(半)|(\d{1,2}|[零〇一二两三四五六七八九十]+)分?)?$/.exec(value);
  if(!local)return null;
  let hour=commitmentNumber(local[2]!);
  const minute=local[3]?30:local[4]===undefined?0:commitmentNumber(local[4]!);
  if(hour===null||minute===null||minute>59||hour>23)return null;
  if(!local[1])return hour===0||hour>12?[hour*60+minute]:[(hour%12)*60+minute,(hour%12+12)*60+minute];
  // A 24-hour clock after an afternoon or evening period (傍晚18点, 晚上21点, 下午15点) is taken as said.
  if(hour>12)return ['下午','傍晚','晚上','夜里'].includes(local[1])?[hour*60+minute]:null;
  if(local[1]==='夜里'){
    // 夜里十点 is 22:00, 夜里十二点 midnight, 夜里两点 02:00.
    return [(hour===12?0:hour>=6?hour+12:hour)*60+minute];
  }
  // 晚上零点 / 晚上0点 (and 凌晨零点) is midnight, like 晚上十二点.
  if(hour===0)return local[1]==='晚上'||local[1]==='凌晨'?[minute]:null;
  if(local[1]==='凌晨'||local[1]==='清晨'||local[1]==='早上'||local[1]==='上午'){
    if(hour===12)return null;
  } else if(local[1]==='中午'){
    if(hour<11)return null;
  } else if(local[1]==='傍晚'){
    if(hour<5||hour>7)return null;
    hour+=12;
  } else if(hour===12)hour=local[1]==='晚上'?0:12;
  else hour+=12;
  return [hour*60+minute];
}
function validTime(value:unknown):value is number {return Number.isSafeInteger(value)&&(value as number)>=0;}

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
    const dayStarts=rule.startMinute>rule.endMinute?[currentDay,currentDay-DAY]:[currentDay];
    const windows=dayStarts.map(day=>{
      const endDay=day+(rule.startMinute>rule.endMinute?DAY:0);
      const start=localBoundary(day,rule.startMinute,rule.timeZone,false);
      const end=localBoundary(endDay,rule.endMinute,rule.timeZone,true);
      return {start,end,day};
    });
    const match=windows.find(item=>item.start!==null&&item.end!==null&&nowMs>=item.start&&nowMs<item.end);
    if(!match)return null;
    startsAtMs=match.start!;endsAtMs=match.end!;
    key=dailyKey(rule,match.day);
  }
  if(record.term.kind==='deadline'&&record.term.clock==='real')endsAtMs=Math.min(endsAtMs,record.term.dueAtMs);
  if(nowMs<startsAtMs||nowMs>=endsAtMs)return null;
  return {key,startsAtMs,endsAtMs,level:rule.level,commitmentId:record.id,revision:record.revision,
    sourceId:record.latestSourceId,sourceRevision:record.latestSourceRevision};
}

/**
 * The latest instance of an active restriction that has already ended at `nowMs` (an interval after its end, a daily
 * window after that day's end, both clipped by a real deadline), keyed like contactRestrictionWindow; null when none has.
 */
export function lastEndedContactWindow(record:CommitmentRecord,nowMs:number):ContactRestrictionWindow|null {
  if(record.mode!=='companion'||record.status!=='active'||!record.contactRestriction||!validTime(nowMs))return null;
  const rule=record.contactRestriction;
  const due=record.term.kind==='deadline'&&record.term.clock==='real'?record.term.dueAtMs:Number.POSITIVE_INFINITY;
  let instances:{start:number;end:number;key:string}[];
  if(rule.kind==='interval')instances=[{start:rule.startAtMs,end:rule.endAtMs,key:`interval:${rule.startAtMs}:${rule.endAtMs}`}];
  else {
    const local=localParts(nowMs,rule.timeZone),today=Date.UTC(local.year,local.month-1,local.day);
    instances=[-2,-1,0].flatMap(offset=>{
      const day=today+offset*DAY,window=dailyInstance(day,rule.startMinute,rule.endMinute,rule.timeZone);
      return window?[{...window,key:dailyKey(rule,day)}]:[];
    });
  }
  const ended=instances.map(item=>({...item,end:Math.min(item.end,due)})).filter(item=>item.start<item.end&&item.end<=nowMs)
    .sort((a,b)=>b.end-a.end)[0];
  return ended?{key:ended.key,startsAtMs:ended.start,endsAtMs:ended.end,level:rule.level,commitmentId:record.id,revision:record.revision,
    sourceId:record.latestSourceId,sourceRevision:record.latestSourceRevision}:null;
}

function dailyKey(rule:Extract<ContactRestriction,{kind:'daily'}>,day:number):string {
  return `daily:${rule.timeZone}:${new Date(day).toISOString().slice(0,10)}:${rule.startMinute}:${rule.endMinute}`;
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

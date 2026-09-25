import { createHash } from 'node:crypto';
import type { Access } from '../memory/access.ts';

export interface StoredControl {
  id:string;
  revision:number;
  kind:string;
  body:string;
}

export interface PreferenceOverride {
  enabled?:boolean;
  text?:string;
}

type MemoryIdentity={kind?:string;detail:string};
type PreferenceIdentity={category:string;quote:string};

const accessOrder:Access[]=['clear','gist','feeling','anchor','hidden'];

export function memoryControlId(sourceId:string,memory:MemoryIdentity):string {
  return `${sourceId}#@${contentIdentity([memory.kind??'legacy',memory.detail])}`;
}

export function preferenceControlId(sourceId:string,preference:PreferenceIdentity):string {
  return `${sourceId}:preference:@${contentIdentity([preference.category,preference.quote])}`;
}

export function isSourceControl(control:StoredControl,sourceId:string):boolean {
  return (control.kind==='access'&&belongs(control,`${sourceId}#`))
    ||(control.kind==='preference'&&belongs(control,`${sourceId}:preference:`));
}

export function memoryAccesses(
  sourceId:string,
  revision:number,
  memories:readonly MemoryIdentity[],
  controls:readonly StoredControl[],
):Access[] {
  const prefix=`${sourceId}#`;
  const scoped=controls.filter(control=>control.kind==='access'&&belongs(control,prefix));
  const used=new Set<StoredControl>();
  const exact=memories.map((memory,index)=>{
    const stableId=memoryControlId(sourceId,memory);
    const control=scoped.find(item=>item.id===stableId&&item.revision===0)
      ?? scoped.find(item=>item.id===`${sourceId}#${index}`&&item.revision===revision);
    if(control)used.add(control);
    return control ? JSON.parse(control.body) as Access : undefined;
  });
  // Unknown old identities can only tighten current candidates. They never
  // become a durable identity for new content.
  const fallback=scoped.filter(control=>!used.has(control)).map(control=>JSON.parse(control.body) as Access)
    .filter(access=>access!=='clear')
    .reduce((strictest,current)=>accessOrder.indexOf(current)>accessOrder.indexOf(strictest)?current:strictest,'clear' as Access);
  return exact.map(access=>access??fallback);
}

export function preferenceOverrides(
  sourceId:string,
  revision:number,
  preferences:readonly PreferenceIdentity[],
  controls:readonly StoredControl[],
):(PreferenceOverride|undefined)[] {
  const prefix=`${sourceId}:preference:`;
  const scoped=controls.filter(control=>control.kind==='preference'&&belongs(control,prefix));
  const used=new Set<StoredControl>();
  const exact=preferences.map((preference,index)=>{
    const stableId=preferenceControlId(sourceId,preference);
    const control=scoped.find(item=>item.id===stableId&&item.revision===0)
      ?? scoped.find(item=>item.id===`${sourceId}:preference:${index}`&&item.revision===revision);
    if(control)used.add(control);
    return control ? JSON.parse(control.body) as PreferenceOverride : undefined;
  });
  const unmatched=scoped.filter(control=>!used.has(control)).map(control=>JSON.parse(control.body) as PreferenceOverride);
  const disabled=unmatched.some(control=>control.enabled===false);
  const texts=[...new Set(unmatched.map(control=>control.text).filter((text):text is string=>typeof text==='string'))];
  const open=exact.map((control,index)=>control?undefined:index).filter((index):index is number=>index!==undefined);
  for(const index of open) {
    // Disabling is safe to widen. A correction is attached only when both
    // sides are unique, and is not stored under the candidate's new identity.
    const fallback:PreferenceOverride={...(disabled?{enabled:false}:{}),...(open.length===1&&texts.length===1?{text:texts[0]}:{})};
    if(Object.keys(fallback).length)exact[index]=fallback;
  }
  return exact;
}

function belongs(control:StoredControl,prefix:string):boolean {
  if(!control.id.startsWith(prefix))return false;
  const suffix=control.id.slice(prefix.length);
  return control.revision===0 ? /^@[a-f0-9]{64}$/.test(suffix) : /^\d+$/.test(suffix);
}

function contentIdentity(value:readonly string[]):string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

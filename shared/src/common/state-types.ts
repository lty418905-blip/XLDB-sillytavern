import type {AcceptedMessage} from '../core/types.ts';
import type {Scope} from '../memory/access.ts';
import type {TavernEventAddress} from '../scene/tavern-engine/types.ts';

/** Shared state needs only the host's accepted source and reader boundary. */
export type StateScope=Scope;
export interface StateRoster {characters:Array<{id:string;name:string;aliases:string[]}>}
export interface StateMessage extends AcceptedMessage {
  envelope:{targetId:string;mode:'direct'|'scene';presentIds:string[];playerName?:string};
  speakerId?:string;
}
/** Shared observation; optional attribution/audience fields remain absent on historical records. */
export interface StateObservation {
  id: string;
  kind: string;
  quote: string;
  readers: string[];
  playerVisible?: boolean;
  actorId?: string;
  /** Optional Tavern v2 marker: actorId is the event author; absence keeps the legacy identity semantics. */
  attributed?: boolean;
  /** Optional Tavern v2 audience; absence keeps the legacy readers-only representation. */
  recipients?: string[];
  /** Event observations use a structural address; omission retains the historical message representation. */
  channel?: 'message' | 'event';
  ref?: TavernEventAddress;
  /** Positive event order within the accepted source, never a text offset. */
  sequence?: number;
}
export interface StatePlan {observations:StateObservation[]}

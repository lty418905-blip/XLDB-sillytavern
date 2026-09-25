import type {AcceptedMessage} from '../core/types.ts';
import type {Scope} from '../memory/access.ts';

/** Shared state needs only the host's accepted source and reader boundary. */
export type StateScope=Scope;
export interface StateRoster {characters:Array<{id:string;name:string;aliases:string[]}>}
export interface StateMessage extends AcceptedMessage {
  envelope:{targetId:string;mode:'direct'|'scene';presentIds:string[];playerName?:string};
  speakerId?:string;
}
export interface StateObservation {
  id:string;kind:string;quote:string;readers:string[];playerVisible?:boolean;actorId?:string;
}
export interface StatePlan {observations:StateObservation[]}

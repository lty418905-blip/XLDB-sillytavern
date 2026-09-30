import type { DatabaseSync } from 'node:sqlite';
import { scopeKey } from '../core/types.ts';
import type { SceneScope } from './types.ts';

/** Configuration seed only. Tune from measured host memory/latency later. */
export const DEFAULT_MAX_ACTIVE_NPC_GROUPS = 2;

export interface NpcResourceConfiguration {
  maxActive: number;
  priorityIds: string[];
  expectedRevision?: number;
}

export interface NpcResourceStatus {
  controlRevision: number;
  maxActive: number;
  priorityIds: string[];
  selectedIds: string[];
  activeIds: string[];
  pausedIds: string[];
}

export interface NpcActivationRequest {
  rosterIds: string[];
  npcIds: string[];
  interactionIds?: string[];
  presentIds?: string[];
}

export interface NpcActivationContext<T> {
  npcId: string;
  group: T;
}

export interface NpcActivationCallbacks<T, R> {
  /** Load the persisted group lazily, normally from SceneAuthority.emotion. */
  materialize(npcId: string, signal: AbortSignal): T | Promise<T>;
  /** A batch may run model work in parallel; every requested NPC occurs exactly once. */
  runBatch(batch: readonly NpcActivationContext<T>[], signal: AbortSignal): R | Promise<R>;
  dispose?(npcId: string, group: T): void | Promise<void>;
  /** Called immediately when a resource control change invalidates in-flight work. */
  onInvalidated?(expectedRevision: number, actualRevision: number): void;
}

interface StoredConfiguration {
  revision: number;
  maxActive: number;
  priorityIds: string[];
}

interface Pool {
  groups: Map<string, unknown>;
}

interface Flight {
  revision: number;
  controller: AbortController;
  callback?: (expectedRevision: number, actualRevision: number) => void;
}

const MAX_GROUPS = 32;
const MAX_ID_LENGTH = 300;

/**
 * Persistent selection policy plus an in-process bounded pool of materialized
 * neural groups. Neural weights stay in scene source analysis; this class does
 * not create another learning authority.
 */
export class NpcResourceController {
  private readonly db: DatabaseSync;
  private readonly defaultMaxActive: number;
  private readonly pools = new Map<string, Pool>();
  private readonly flights = new Map<string, Set<Flight>>();
  private readonly activationTails = new Map<string, Promise<void>>();

  constructor(db: DatabaseSync, options: {defaultMaxActive?: number} = {}) {
    this.db = db;
    this.defaultMaxActive = boundedLimit(options.defaultMaxActive ?? DEFAULT_MAX_ACTIVE_NPC_GROUPS);
    db.exec(`CREATE TABLE IF NOT EXISTS scene_npc_resources (
      scope TEXT PRIMARY KEY,
      control_revision INTEGER NOT NULL,
      max_active INTEGER NOT NULL,
      priority_ids TEXT NOT NULL,
      CHECK(control_revision >= 1),
      CHECK(max_active >= 1 AND max_active <= ${MAX_GROUPS})
    );`);
  }

  configure(scope: SceneScope, rosterIds: readonly string[], value: NpcResourceConfiguration): NpcResourceStatus {
    const roster = validIds(rosterIds, 'invalid_npc_resource_roster');
    const maxActive = boundedLimit(value.maxActive);
    const priorityIds = validIds(value.priorityIds, 'invalid_npc_resource_priority');
    if (priorityIds.some(id => !roster.includes(id))) throw new Error('invalid_npc_resource_priority');
    if (value.expectedRevision !== undefined && (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0)) {
      throw new Error('invalid_npc_resource_revision');
    }
    const key = scopeKey(scope);
    const current = this.read(scope);
    if (value.expectedRevision !== undefined && value.expectedRevision !== current.revision) {
      throw new Error('context_changed_retry');
    }
    if (current.maxActive === maxActive && sameIds(current.priorityIds, priorityIds)) {
      return this.status(scope, roster);
    }
    const revision = current.revision + 1;
    this.db.prepare(`INSERT INTO scene_npc_resources(scope,control_revision,max_active,priority_ids)
      VALUES(?,?,?,?) ON CONFLICT(scope) DO UPDATE SET
      control_revision=excluded.control_revision,max_active=excluded.max_active,priority_ids=excluded.priority_ids`)
      .run(key, revision, maxActive, JSON.stringify(priorityIds));
    this.invalidate(key, revision);
    this.trimPool(key, new Set(roster), maxActive);
    return this.status(scope, roster);
  }

  status(scope: SceneScope, rosterIds: readonly string[]): NpcResourceStatus {
    const roster = validIds(rosterIds, 'invalid_npc_resource_roster');
    const stored = this.ensure(scope);
    const priorityIds = stored.priorityIds.filter(id => roster.includes(id));
    const selectedIds = orderedUnique([...priorityIds, ...roster]).slice(0, stored.maxActive);
    const pool = this.pools.get(scopeKey(scope));
    const activeIds = roster.filter(id => pool?.groups.has(id));
    return {
      controlRevision: stored.revision,
      maxActive: stored.maxActive,
      priorityIds,
      selectedIds,
      activeIds,
      pausedIds: roster.filter(id => !activeIds.includes(id)),
    };
  }

  activationBatches(scope: SceneScope, request: NpcActivationRequest): string[][] {
    const roster = validIds(request.rosterIds, 'invalid_npc_resource_roster');
    const wanted = validIds(request.npcIds, 'invalid_npc_resource_request');
    const interaction = validIds(request.interactionIds ?? [], 'invalid_npc_resource_request');
    const present = validIds(request.presentIds ?? [], 'invalid_npc_resource_request');
    for (const id of [...wanted, ...interaction, ...present]) {
      if (!roster.includes(id)) throw new Error('invalid_scene_character');
    }
    const settings = this.ensure(scope);
    // Current interaction, presence, and explicit user priority stay distinct
    // inputs; this stable order only decides which bounded batch goes first.
    const ordered = orderedUnique([
      ...interaction.filter(id => wanted.includes(id)),
      ...present.filter(id => wanted.includes(id)),
      ...settings.priorityIds.filter(id => wanted.includes(id)),
      ...wanted,
    ]);
    const result: string[][] = [];
    for (let index = 0; index < ordered.length; index += settings.maxActive) {
      result.push(ordered.slice(index, index + settings.maxActive));
    }
    return result;
  }

  async runActivationBatches<T, R>(
    scope: SceneScope,
    request: NpcActivationRequest,
    callbacks: NpcActivationCallbacks<T, R>,
  ): Promise<R[]> {
    const key = scopeKey(scope);
    const previous = this.activationTails.get(key) ?? Promise.resolve();
    let releaseTurn!: () => void;
    const turn = new Promise<void>(resolve => { releaseTurn = resolve; });
    const tail = previous.catch(() => {}).then(() => turn);
    this.activationTails.set(key, tail);
    await previous.catch(() => {});
    try {
      // A new operation may use a newer accepted snapshot. Refresh only after
      // acquiring the scope lease, never while another actor is still running.
      await this.evictOutside<T>(key, new Set(), callbacks.dispose);
      const settings = this.ensure(scope);
      const batches = this.activationBatches(scope, request);
      const flight: Flight = {
        revision: settings.revision,
        controller: new AbortController(),
        callback: callbacks.onInvalidated,
      };
      let activeFlights = this.flights.get(key);
      if (!activeFlights) this.flights.set(key, activeFlights = new Set());
      activeFlights.add(flight);
      const results: R[] = [];
      try {
        for (const ids of batches) {
          this.assertCurrent(scope, flight);
          await this.evictOutside<T>(key, new Set(ids), callbacks.dispose);
          const pool = this.pool(key);
          for (const npcId of ids) {
            if (!pool.groups.has(npcId)) {
              const group = await callbacks.materialize(npcId, flight.controller.signal);
              this.assertCurrent(scope, flight);
              pool.groups.set(npcId, group);
            }
            if (pool.groups.size > settings.maxActive) throw new Error('npc_resource_limit_exceeded');
          }
          this.assertCurrent(scope, flight);
          const batch = ids.map(npcId => ({npcId, group: pool.groups.get(npcId) as T}));
          results.push(await callbacks.runBatch(batch, flight.controller.signal));
          this.assertCurrent(scope, flight);
        }
        return results;
      } finally {
        activeFlights.delete(flight);
        if (!activeFlights.size) this.flights.delete(key);
      }
    } finally {
      releaseTurn();
      if (this.activationTails.get(key) === tail) this.activationTails.delete(key);
    }
  }

  async release<T>(scope: SceneScope, dispose?: (npcId: string, group: T) => void | Promise<void>): Promise<void> {
    const key = scopeKey(scope);
    await this.evictOutside<T>(key, new Set(), dispose);
  }

  private ensure(scope: SceneScope): StoredConfiguration {
    const current = this.read(scope);
    if (current.revision) return current;
    this.db.prepare('INSERT OR IGNORE INTO scene_npc_resources(scope,control_revision,max_active,priority_ids) VALUES(?,1,?,\'[]\')')
      .run(scopeKey(scope), this.defaultMaxActive);
    return this.read(scope);
  }

  private read(scope: SceneScope): StoredConfiguration {
    const row = this.db.prepare('SELECT control_revision,max_active,priority_ids FROM scene_npc_resources WHERE scope=?')
      .get(scopeKey(scope)) as {control_revision:number;max_active:number;priority_ids:string} | undefined;
    if (!row) return {revision: 0, maxActive: this.defaultMaxActive, priorityIds: []};
    const priorityIds = validIds(JSON.parse(row.priority_ids), 'invalid_npc_resource_storage');
    return {revision: row.control_revision, maxActive: boundedLimit(row.max_active), priorityIds};
  }

  private pool(key: string): Pool {
    let pool = this.pools.get(key);
    if (!pool) this.pools.set(key, pool = {groups: new Map()});
    return pool;
  }

  private invalidate(key: string, actualRevision: number): void {
    for (const flight of this.flights.get(key) ?? []) {
      flight.controller.abort(new Error('npc_resource_control_changed'));
      flight.callback?.(flight.revision, actualRevision);
    }
  }

  private assertCurrent(scope: SceneScope, flight: Flight): void {
    if (flight.controller.signal.aborted || this.ensure(scope).revision !== flight.revision) {
      throw new Error('npc_resource_control_changed');
    }
  }

  private trimPool(key: string, roster: Set<string>, maxActive: number): void {
    const pool = this.pools.get(key);
    if (!pool) return;
    for (const id of [...pool.groups.keys()]) if (!roster.has(id)) pool.groups.delete(id);
    while (pool.groups.size > maxActive) pool.groups.delete(pool.groups.keys().next().value as string);
  }

  private async evictOutside<T>(
    key: string,
    retained: Set<string>,
    dispose?: (npcId: string, group: T) => void | Promise<void>,
  ): Promise<void> {
    const pool = this.pool(key);
    for (const [npcId, value] of [...pool.groups]) {
      if (retained.has(npcId)) continue;
      pool.groups.delete(npcId);
      await dispose?.(npcId, value as T);
    }
  }
}

function boundedLimit(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_GROUPS) {
    throw new Error('invalid_npc_resource_limit');
  }
  return value as number;
}

function validIds(value: readonly string[] | unknown, code: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_GROUPS || value.some(id => typeof id !== 'string' || !id.trim() || id.length > MAX_ID_LENGTH)) {
    throw new Error(code);
  }
  const result = orderedUnique(value as string[]);
  if (result.length !== value.length) throw new Error(code);
  return result;
}

function orderedUnique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

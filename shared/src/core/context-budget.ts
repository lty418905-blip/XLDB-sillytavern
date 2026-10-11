import type {MemoryView} from '../memory/access.ts';

/**
 * UTF-16 code units in one actor's core context per call, excluding later scene additions.
 * The inherited value has no recorded source; exceeding it starts whole-row removal, then fails if nothing fits.
 */
export const CORE_CONTEXT_LIMIT = 32_000;

/** Selection dependencies and priorities for already admitted relevant rows; all maps use record ids. */
export interface ContextBudgetPlan {
  parents: ReadonlyMap<string, readonly string[]>;
  ranks: ReadonlyMap<string, number>;
  admissions: ReadonlyMap<string, string>;
  events: ReadonlyMap<string, string>;
  reactivatedEvents: ReadonlySet<string>;
  strongEvents: ReadonlySet<string>;
}

/** Numeric removal diagnostics, never memory text; positions and ranks are zero-based, steps start at one. */
export interface RemovedContextRow {
  id: string;
  position: number;
  rank?: number;
  admission?: string;
  access: MemoryView['access'];
  kind: MemoryView['kind'];
  ageDays: number;
  reactivated: boolean;
  reference: boolean;
  protectedFacts: number;
  step: number;
  unitIds: string[];
}

/** Per-call omission report. Lengths are UTF-16 code units; counts are rows, and assemblies include the first try. */
export interface ContextOmissions {
  characterId: string;
  selection: {reason: 'memory_selection_budget'; count: number; ids: string[]};
  trim: {
    reason: 'core_context_budget';
    count: number;
    ids: string[];
    rows: RemovedContextRow[];
    initialCharacters: number;
    finalCharacters: number;
    assemblies: number;
  };
}

/** One priority decision: recalled events include their unreactivated twins and override label admission. */
function removalStage(id: string, plan: ContextBudgetPlan): number {
  const event = plan.events.get(id);
  if (event !== undefined && plan.reactivatedEvents.has(event)) {
    return 2;
  }

  return plan.admissions.get(id) === 'label' ? 1 : 0;
}

/** Event strength combines both admitted recall tables; missing entries are weak. */
function isStrongEvent(event: string, plan: ContextBudgetPlan): boolean {
  return plan.strongEvents.has(event);
}

/** A unit can leave only when no remaining relevant child needs any row in it. Fixed blocks are outside this test. */
function canRemove(ids: ReadonlySet<string>, relevant: readonly MemoryView[], plan: ContextBudgetPlan): boolean {
  return relevant.every(memory => ids.has(memory.id) ||
    !(plan.parents.get(memory.id) ?? []).some(parent => ids.has(parent)));
}

/**
 * Choose the next removable whole unit from the current relevant subsequence; an empty list means none is movable.
 * Priorities restart at every call. Work is O((r + p)^2 + r log r) per decision, with r admitted rows and p parent edges;
 * it never scans the authority snapshot or reads a clock. Every nonempty result removes at least one admitted row.
 */
export function nextContextRemoval(relevant: readonly MemoryView[], plan: ContextBudgetPlan): string[] {
  const byId = new Map(relevant.map(memory => [memory.id, memory]));
  const candidates: {stage: number; ids: string[]}[] = [];
  for (let stage = 0; stage < 2; stage++) {
    for (let index = relevant.length - 1; index >= 0; index--) {
      const memory = relevant[index]!;
      if (removalStage(memory.id, plan) === stage) {
        candidates.push({stage, ids: [memory.id]});
      }
    }
  }

  const recalledEvents = new Map<string, {ids: string[]; position: number}>();
  relevant.forEach((memory, position) => {
    if (removalStage(memory.id, plan) !== 2) {
      return;
    }

    const event = plan.events.get(memory.id)!;
    const group = recalledEvents.get(event) ?? {ids: [], position};
    group.ids.push(memory.id);
    recalledEvents.set(event, group);
  });
  const orderedEvents = [...recalledEvents].sort(([leftEvent, left], [rightEvent, right]) =>
    Number(isStrongEvent(leftEvent, plan)) - Number(isStrongEvent(rightEvent, plan)) ||
    left.position - right.position);
  for (const [, group] of orderedEvents) {
    candidates.push({stage: 2, ids: group.ids});
  }

  for (const candidate of candidates) {
    const unit = new Set(candidate.ids);
    for (const child of candidate.ids) {
      for (const parent of plan.parents.get(child) ?? []) {
        if (!byId.has(parent) || unit.has(parent)) {
          continue;
        }

        const parentStage = removalStage(parent, plan);
        // Recalled parents always leave with their own event, even when ranked after their child.
        if (parentStage === 2 || parentStage > candidate.stage) {
          continue;
        }

        const parentRank = plan.ranks.get(parent);
        const childRank = plan.ranks.get(child);
        if (parentRank !== undefined && (childRank === undefined || parentRank < childRank)) {
          continue;
        }

        const expanded = new Set([...unit, parent]);
        if (canRemove(expanded, relevant, plan)) {
          unit.add(parent);
        }
      }
    }

    if (canRemove(unit, relevant, plan)) {
      return relevant.filter(memory => unit.has(memory.id)).map(memory => memory.id);
    }
  }

  return [];
}

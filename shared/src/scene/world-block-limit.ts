import type {WorldProjection} from './world-state.ts';

/** Provisional rows per reader and per call, chosen for the world block; remeasure after ledger activation. */
export const WORLD_BLOCK_ROW_LIMIT = 20;

/** Provisional story days, borrowed from clear episodic retention; equality remains visible in this block. */
export const WORLD_BLOCK_HISTORY_DAYS = 30;

/** Source position and elapsed story milliseconds; null or missing values mean no available reading. */
export interface WorldBlockCoordinate {
  position?: number | null;
  ageMs?: number | null;
}

/** Visible folded identity and serialized key; target is absent when the row has no target relation. */
export interface WorldBlockLink {
  sourceId: string;
  revision: number;
  key: string;
  target?: string | null;
}

/** Counts of visible rows omitted from history and the two independently bounded open lists. */
export interface WorldBlockOmissions {
  history: number;
  pending: number;
  committed: number;
}

/** Plain projected data and positional companions. Missing link arrays conservatively keep every deposit. */
export interface WorldBlockLimitInput {
  projection: WorldProjection;
  receiptCoordinates?: readonly WorldBlockCoordinate[] | null;
  entryCoordinates?: readonly WorldBlockCoordinate[] | null;
  lastPosition?: number | null;
  committedLinks?: readonly WorldBlockLink[] | null;
  depositLinks?: readonly WorldBlockLink[] | null;
}

/** Actual row visits and ordering comparisons, with no wall-clock or database measurements. */
export interface WorldBlockWork {
  historyRows: number;
  selectionComparisons: number;
  projectionRows: number;
  openRows: number;
  alignmentRows: number;
}

/** Detached bounded projection, nonnegative omitted-row counts and deterministic work measurements. */
export interface WorldBlockLimitResult {
  projection: WorldProjection;
  omissions: WorldBlockOmissions;
  work: WorldBlockWork;
}

/** Exact history wording with one count placeholder; generated from the authoritative wording document. */
export const WORLD_HISTORY_OMISSION = "更早还有{N}笔往来没有列在上面的 receipts 与 entries 里，它们的影响已经算在余额与库存里；上面列出的不是全部，不要用它们去推算余额。上面列出的余额与库存是准确的，被问到时照实说。对那些没有列出的往来，此角色只有记忆里留下的模糊印象，不知道确切的数目，也不知道这个笔数：被问起其中一笔时像平常人那样，凭记得的说个大约、反问对方，或承认记不清了；记忆里没有的不要编，不要为它说出一个精确的数字，不要翻账本或查记录，也不要用“没有记录”这类话回答。";

/** Exact pending wording with one count placeholder; generated from the authoritative wording document. */
export const WORLD_PENDING_OMISSION = "更早还有{N}笔待确认的事项（pending）没有列在上面。此角色知道还有些事没定下来，只是记不全是哪几件；对方提起其中一件时不要否认，说个大概或反问对方，不要报出具体的数目。";

/** Exact committed wording with one count placeholder; generated from the authoritative wording document. */
export const WORLD_COMMITTED_OMISSION = "更早还有{N}笔还没结清的往来（committed）没有列在上面。此角色知道还有往来没结清，只是记不清是哪几笔、各是多少；对方提起其中一件时不要否认，也不要说已经结清，说个大概或反问对方，不要报出具体的数目。";

interface RankedRow {
  kind: number;
  index: number;
  position: number;
  ageMs: number | null;
}

function laterThan(left: RankedRow, right: RankedRow, work: WorldBlockWork): boolean {
  work.selectionComparisons++;
  return left.position > right.position || left.position === right.position &&
    (left.kind > right.kind || left.kind === right.kind && left.index > right.index);
}

function alignedLinks(
  rows: readonly {sourceId: string; revision: number}[],
  links: readonly WorldBlockLink[] | null | undefined,
  work: WorldBlockWork,
): boolean {
  if (links == null || rows.length !== links.length) {
    return false;
  }

  for (let index = 0; index < rows.length; index++) {
    work.alignmentRows++;
    if (rows[index]!.sourceId !== links[index]!.sourceId || rows[index]!.revision !== links[index]!.revision) {
      return false;
    }
  }

  return true;
}

/**
 * Limit one reader's story block without modifying input. History selection uses at most 20 comparisons per row
 * plus one admission comparison: O(21H + P + C + D), with at most 20 retained history references. Missing positions
 * share the last folded source's position; missing ages never exclude a row. Getter failures propagate unchanged.
 */
export function limitWorldBlock(input: WorldBlockLimitInput): WorldBlockLimitResult {
  const projection = input.projection;
  const omissions: WorldBlockOmissions = {history: 0, pending: 0, committed: 0};
  const work: WorldBlockWork = {
    historyRows: 0,
    selectionComparisons: 0,
    projectionRows: 0,
    openRows: 0,
    alignmentRows: 0,
  };
  if (projection.mode !== 'story') {
    return {projection, omissions, work};
  }

  const selected: RankedRow[] = [];
  const groups = [
    {kind: 0, rows: projection.receipts, coordinates: input.receiptCoordinates},
    {kind: 1, rows: projection.ledger?.entries ?? [], coordinates: input.entryCoordinates},
  ];
  for (const group of groups) {
    for (let index = 0; index < group.rows.length; index++) {
      work.historyRows++;
      const coordinate = group.coordinates?.[index];
      const candidate: RankedRow = {
        kind: group.kind,
        index,
        position: coordinate?.position ?? input.lastPosition ?? -1,
        ageMs: coordinate?.ageMs ?? null,
      };
      if (selected.length === WORLD_BLOCK_ROW_LIMIT) {
        if (!laterThan(candidate, selected[0]!, work)) {
          continue;
        }

        selected.shift();
      }

      let insertion = selected.length;
      while (insertion > 0 && laterThan(selected[insertion - 1]!, candidate, work)) {
        insertion--;
      }

      selected.splice(insertion, 0, candidate);
    }
  }

  const receiptIndices = new Set<number>();
  const entryIndices = new Set<number>();
  // Filtering age after selecting the final rows prevents older rows from filling expired slots.
  for (const row of selected) {
    if (row.ageMs === null || row.ageMs <= WORLD_BLOCK_HISTORY_DAYS * 86_400_000) {
      (row.kind === 0 ? receiptIndices : entryIndices).add(row.index);
    }
  }

  omissions.history = work.historyRows - receiptIndices.size - entryIndices.size;
  const receipts = projection.receipts.filter((_row, index) => {
    work.projectionRows++;
    return receiptIndices.has(index);
  });
  const ledger = projection.ledger;
  if (!ledger) {
    return {projection: omissions.history ? {...projection, receipts} : projection, omissions, work};
  }

  const entries = ledger.entries.filter((_row, index) => {
    work.projectionRows++;
    return entryIndices.has(index);
  });
  const open = ledger.open;
  omissions.pending = Math.max(0, open.pending.length - WORLD_BLOCK_ROW_LIMIT);
  omissions.committed = Math.max(0, open.committed.length - WORLD_BLOCK_ROW_LIMIT);
  const pending = open.pending.filter((_row, index) => {
    work.openRows++;
    return index >= omissions.pending;
  });
  const committed = open.committed.filter((_row, index) => {
    work.openRows++;
    return index >= omissions.committed;
  });

  const blocked = new Set<string>();
  const aligned = alignedLinks(open.committed, input.committedLinks, work) &&
    alignedLinks(open.deposits, input.depositLinks, work);
  if (aligned) {
    for (let index = 0; index < omissions.committed; index++) {
      blocked.add(input.committedLinks![index]!.key);
    }
  }

  const deposits = open.deposits.filter((_row, index) => {
    work.openRows++;
    const target = aligned ? input.depositLinks![index]!.target : null;
    return target == null || !blocked.has(target);
  });
  if (omissions.history === 0 && omissions.pending === 0 && omissions.committed === 0) {
    return {projection, omissions, work};
  }

  return {
    projection: {...projection, receipts, ledger: {...ledger, entries, open: {...open, pending, committed, deposits}}},
    omissions,
    work,
  };
}

/** Render at most three LF-prefixed lines from integer row counts; zero counts render no line or trailing LF. */
export function worldBlockOmissionLines(omissions: WorldBlockOmissions): string {
  return [
    [omissions.history, WORLD_HISTORY_OMISSION],
    [omissions.pending, WORLD_PENDING_OMISSION],
    [omissions.committed, WORLD_COMMITTED_OMISSION],
  ].map(([count, sentence]) => Number(count) > 0
    ? '\n' + String(sentence).replace('{N}', String(count)) : '').join('');
}

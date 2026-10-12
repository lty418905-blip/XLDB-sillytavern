import {createHash} from 'node:crypto';
import {recordRetrievalFallback} from '../core/runtime-log.ts';
import type {ModelConfig} from '../core/types.ts';
import type {CurrentSource} from './context.ts';
import type {RecallJudgeOutcome} from './recall-judge.ts';
import type {RetrievalDegradation} from './retrieval.ts';

/** Selected per-context detail limits: milliseconds, uncached unique texts and process-local cached vectors. */
export const RECALL_DETAIL_EMBEDDING = Object.freeze({timeoutMs: 1000, texts: 32, vectors: 512, candidates: 8});
/** Original distance seam rows; identities remain local and never enter an embedding body. */
export interface RecallDetailRequest {
  readonly id: string;
  readonly gist: string;
  readonly feeling?: string;
  readonly candidates: readonly string[];
}
/** One distance per candidate, or no distances for an entire record. */
export type RecallDetailDistances = (readonly number[] | undefined)[];
/** Per-call state passed separately from the unchanged seam list; never stored on a Core instance. */
export interface RecallDetailCall {
  embedding: ModelConfig;
  currentSource?: CurrentSource;
  degraded?: RetrievalDegradation;
  judgment: RecallJudgeOutcome['outcome'];
  turnKey: string;
}
/** Existing provider failure classifier; only fixed categories and HTTP status leave the request boundary. */
export interface RecallDetailFailure {
  failure: string;
  attention: 'configuration' | 'transient';
  httpStatus?: number;
}
/** Retrieval supplies its own cache and existing checked distance/embed functions; no other state is retained. */
export interface RecallDetailEmbeddingPort {
  identity: string;
  cache: Map<string, readonly number[]>;
  deadline: number;
  reserve: () => boolean;
  embed: (texts: string[], deadline: number) => Promise<number[][]>;
  distance: (left: readonly number[], right: readonly number[]) => number | undefined;
  failure: (error: unknown) => RecallDetailFailure;
}

type Vector = {key: string; text: string; vector?: readonly number[]; cached: boolean};

/**
 * Prepare one deduplicated request in row order; whole-row overflow stops admission of later rows.
 * Work O(text bytes + candidate vectors * dimension); returns synchronously when no request is sent.
 * Provider failures never reject and preserve cache-only rows. The cache belongs to Retrieval, not this helper.
 */
export function recallDetailEmbedding(
  requests: readonly RecallDetailRequest[],
  port: RecallDetailEmbeddingPort
): RecallDetailDistances | Promise<RecallDetailDistances> {
  const vectors = new Map<string, Vector>();
  const missing = new Map<string, Vector>();
  const rows: (Vector[] | undefined)[] = [];
  let overflow = false;
  for (const request of requests) {
    if (overflow || request.candidates.length < 2 || request.candidates.length > RECALL_DETAIL_EMBEDDING.candidates) {
      rows.push(undefined);
      continue;
    }
    const texts = [request.gist, ...(request.feeling == null ? [] : [request.feeling]), ...request.candidates];
    const row = texts.map(text => {
      const key = JSON.stringify([port.identity, createHash('sha256').update(text).digest('hex')]);
      const held = vectors.get(key);
      if (held) return held;
      const vector = port.cache.get(key);
      if (vector) {
        port.cache.delete(key);
        port.cache.set(key, vector);
      }
      const entry: Vector = {key, text, cached: vector !== undefined, ...(vector === undefined ? {} : {vector})};
      vectors.set(key, entry);
      return entry;
    });
    const rowMissing = new Map(row.filter(entry => !entry.vector && !missing.has(entry.key))
      .map(entry => [entry.key, entry]));
    if (missing.size + rowMissing.size > RECALL_DETAIL_EMBEDDING.texts) {
      overflow = true;
      rows.push(undefined);
      continue;
    }
    for (const [key, entry] of rowMissing) missing.set(key, entry);
    rows.push(row);
  }

  function distances(): RecallDetailDistances {
    return rows.map((row, index) => {
      if (!row) return undefined;
      const targetCount = requests[index]!.feeling == null ? 1 : 2;
      let unavailable = false;
      const values: number[] = [];
      for (const candidate of row.slice(targetCount)) {
        let nearest = Infinity;
        for (const target of row.slice(0, targetCount)) {
          if (!target.vector || !candidate.vector) {
            unavailable = true;
            continue;
          }
          const distance = port.distance(target.vector, candidate.vector);
          if (distance === undefined) {
            unavailable = true;
            // New response vectors are valid; evict only cached vectors involved in mismatched pairs.
            if (target.cached && port.cache.get(target.key) === target.vector) port.cache.delete(target.key);
            if (
              candidate.cached && port.cache.get(candidate.key) === candidate.vector
            ) port.cache.delete(candidate.key);
          } else {
            nearest = Math.min(nearest, distance);
          }
        }
        values.push(nearest);
      }
      return unavailable ? undefined : values;
    });
  }

  if (!missing.size) return distances();
  if (!port.reserve()) return requests.map(() => undefined);
  const pending = [...missing.values()];
  return new Promise<RecallDetailDistances>(resolve => {
    let finished = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = () => {
      finished = true;
      try {
        clearTimeout(timer);
      } catch {
        // An injected cleanup failure cannot change the completed embedding result.
      }
      try {
        resolve(distances());
      } catch {
        resolve(requests.map(() => undefined));
      }
    };
    const fail = (error: unknown) => {
      if (finished) return;
      let failure: RecallDetailFailure = {failure: 'provider_error', attention: 'transient'};
      try {
        failure = port.failure(error);
      } catch {
        // Classification is bookkeeping; it cannot leave a failed request unsettled.
      }
      recordRetrievalFallback('recall_details_fallback', {...failure, stage: 'recall_details'});
      finish();
    };
    try {
      // The deadline was captured at method entry, before preparation, and this method is not serialized.
      timer = setTimeout(() => fail(new Error('recall_detail_timeout')), Math.max(0, port.deadline - Date.now()));
      Promise.resolve(port.embed(pending.map(entry => entry.text), port.deadline)).then(embedded => {
        if (finished) return;
        try {
          pending.forEach((entry, index) => {
            entry.vector = embedded[index]!;
            port.cache.delete(entry.key);
            port.cache.set(entry.key, entry.vector);
            if (port.cache.size > RECALL_DETAIL_EMBEDDING.vectors) port.cache.delete(port.cache.keys().next().value!);
          });
          finish();
        } catch (error) {
          fail(error);
        }
      }, fail);
    } catch (error) {
      fail(error);
    }
  });
}

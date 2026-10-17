import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';

/** Highest authority-store format understood by this release; unmarked stores are format 1 by contract. */
export const CURRENT_STORE_FORMAT = 2;

/** Opaque writer identifier stored with the first readable-appraisal record; no ordering semantics. */
export const STORE_WRITER_VERSION = 'readable-appraisal-1';

/**
 * Reads the singleton format number. Missing table means 1; a malformed marker means unsupported (Infinity).
 * At most two marker rows are read, independent of the number of chat sources. SQLite read errors propagate.
 */
export function readStoreFormat(database: DatabaseSync): number {
  const table = database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='xldb_store_format' COLLATE NOCASE").get();
  if (!table) return 1;

  let rows: {format: unknown}[];
  try {
    rows = database.prepare('SELECT format FROM xldb_store_format LIMIT 2').all() as {format: unknown}[];
  } catch {
    // An existing marker with an unreadable layout cannot be treated as an unmarked old store.
    return Infinity;
  }
  const format = rows[0]?.format;
  return rows.length === 1 && Number.isSafeInteger(format) && (format as number) >= 1 ? format as number : Infinity;
}

/**
 * Stamps a positive safe-integer format inside the caller's transaction. Equal or higher markers are unchanged.
 * writerVersion is opaque nonempty release text. Invalid arguments or a missing transaction throw without writing.
 * New readable appraisals and their processing candidates stamp this marker in their writing transaction.
 */
export function stampStoreFormat(database: DatabaseSync, format: number, writerVersion: string): void {
  if (!Number.isSafeInteger(format) || format < 1 || typeof writerVersion !== 'string' || !writerVersion) {
    throw new TypeError('invalid_store_format');
  }
  if (!database.isTransaction) throw new Error('store_format_transaction_required');

  const table = database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='xldb_store_format' COLLATE NOCASE").get();
  if (table) {
    if (readStoreFormat(database) >= format) return;
    database.prepare('UPDATE xldb_store_format SET format=?,writer_version=?').run(format, writerVersion);
    return;
  }
  database.exec('CREATE TABLE xldb_store_format (format INTEGER NOT NULL, writer_version TEXT NOT NULL)');
  database.prepare('INSERT INTO xldb_store_format VALUES(?,?)').run(format, writerVersion);
}

/**
 * Reads a caller-checked path; the function itself never deletes, renames, or truncates files.
 * Missing/non-database files return 1. Requested recovery permits SQLite to rewrite pages and remove a hot journal.
 * Clean stores use immutable read-only mode without sidecars. Other stores normally use ordinary read-only mode.
 * recoverJournal permits SELECT-only writable access only with a journal and no nonempty WAL beside the store.
 * Only the authority's first opening check opts in; backup checks never recover. SQLite errors otherwise propagate.
 */
export function readStoreFormatFile(filename: string, recoverJournal = false): number {
  if (filename === ':memory:' || !fs.existsSync(filename)) {
    return 1;
  }

  const wal = fs.statSync(`${filename}-wal`, {throwIfNoEntry: false});
  const journalExists = fs.existsSync(`${filename}-journal`);
  const immutable = (!wal || wal.size === 0) && !journalExists;
  const readPath = immutable ? `${pathToFileURL(filename).href}?immutable=1` : filename;
  let database: DatabaseSync | undefined;

  try {
    // A hot journal makes even SELECT require recovery; no other writable statement belongs in this check.
    database = new DatabaseSync(readPath, {readOnly: !(recoverJournal && journalExists && (!wal || wal.size === 0))});
    return readStoreFormat(database);
  } catch (error) {
    // SQLITE_NOTADB is not a format declaration; let the existing writable-open error describe that file.
    if ((error as {errcode?: number}).errcode === 26) {
      return 1;
    }
    throw error;
  } finally {
    database?.close();
  }
}

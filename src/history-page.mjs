// Shared wire validation and cursor format for the SQLite and MySQL history readers.
export class HistoryPageError extends Error {
  constructor(code) { super(code); this.name = code; }
}

export function parseHistoryPage(params, kind, scope) {
  for (const name of ['limit', 'before']) if (params.getAll(name).length > 1) throw new HistoryPageError('invalid_history_page');
  const raw = params.get('limit') ?? '25';
  if (!/^[1-9][0-9]?$/.test(raw) || Number(raw) > 50) throw new HistoryPageError('invalid_history_page');
  const input = { limit: Number(raw), cursor: null };
  const encoded = params.get('before');
  if (encoded === null) return input;
  if (!encoded || encoded.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new HistoryPageError('invalid_history_cursor');
  let cursor;
  try {
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) throw new Error();
    cursor = JSON.parse(bytes.toString('utf8'));
  } catch { throw new HistoryPageError('invalid_history_cursor'); }
  if (!cursor || cursor.v !== 1 || cursor.kind !== kind || cursor.scope !== scope
    || typeof cursor.snapshot !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(cursor.snapshot)
    || BigInt(cursor.snapshot) > 18446744073709551615n
    || typeof cursor.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,6}Z$/.test(cursor.at)
    || typeof cursor.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(cursor.id)
    || Object.keys(cursor).sort().join(',') !== 'at,id,kind,scope,snapshot,v') throw new HistoryPageError('invalid_history_cursor');
  const date = new Date(cursor.at);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== cursor.at.slice(0, 19)) throw new HistoryPageError('invalid_history_cursor');
  input.cursor = cursor;
  return input;
}

export function finishHistoryPage(rows, input, kind, scope, snapshot, idKey) {
  const items = rows.slice(0, input.limit);
  const hasMore = rows.length > input.limit;
  const last = items.at(-1);
  return {
    items,
    has_more: hasMore,
    next_cursor: hasMore && last ? Buffer.from(JSON.stringify({ v: 1, kind, scope, snapshot: String(snapshot), at: last.created_at, id: last[idKey] })).toString('base64url') : null,
  };
}

export function parseEventAfter(params) {
  if (params.getAll('after').length > 1) throw new HistoryPageError('invalid_event_cursor');
  const raw = params.get('after') ?? '0';
  if (!/^(0|[1-9][0-9]{0,15})$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new HistoryPageError('invalid_event_cursor');
  return Number(raw);
}

// Old events can be large. Both databases project a maximum 64 KiB per payload;
// refuse an oversized historical event rather than silently advancing its cursor.
export function finishEventPage(head, rows, after) {
  if (after > head.last_seq) throw new HistoryPageError('event_cursor_ahead');
  const events = [];
  let bytes = 0;
  let cursor = after;
  for (const row of rows) {
    if (Number(row.seq) !== cursor + 1) throw new HistoryPageError('event_sequence_gap');
    if (row.payload_json === null) throw new HistoryPageError('event_too_large');
    const event = { seq: Number(row.seq), type: String(row.type), at: String(row.at), payload: typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json };
    const size = Buffer.byteLength(JSON.stringify(event)) + 40;
    if (events.length && bytes + size > 131072) break;
    bytes += size;
    events.push(event);
    cursor = event.seq;
  }
  if (!events.length && after < head.last_seq) throw new HistoryPageError('event_sequence_gap');
  return { head, events, has_more: cursor < head.last_seq };
}

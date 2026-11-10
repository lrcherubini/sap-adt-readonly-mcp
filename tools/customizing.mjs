// adt_customizing -- rows of ONE customizing table from a closed list, through the ADT data
// preview. The first POST this server sends; the decision, dated, is in docs/security.md.
//
// What it answers: "which pricing procedure step calls routine 953?", "which copy control
// carries requirement 653?" -- the question the VOFM catalogue could not answer, because a
// routine's USE is table content and not a repository property.
//
// What it refuses, before any socket: a table outside CUSTOMIZING_TABLES, a field or
// value the grammar cannot express, more than MAX_ROWS rows. A long statement goes out on
// several lines (the server cuts each line at MAX_LINE). After the answer: rows whose
// executedQueryString is not the statement sent (a cut line still answers 200 --
// lib/data-preview.mjs). The fence is the client
// (measured: the server answers VBAK), so the fence is tested, not assumed.
//
// What the audit line carries: table, row count, bytes. Never a row. What the journal
// carries: TABLE_NOT_READ when the read failed (a failed read is not an empty table),
// SHAPE_DRIFT when the measured shape aged.

import { record } from '../lib/audit.mjs';
import {
  buildSelect,
  previewPost,
  parsePreview,
  truncationOf,
  assertRanAsSent,
  CUSTOMIZING_TABLES,
  MAX_ROWS,
  DEFAULT_ROWS,
  DRIFT_CODE,
  SelectViolation,
} from '../lib/data-preview.mjs';

const asText = (value) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});

export function customizingTool(cfg, session, journal) {
  return {
    definition: {
      name: 'adt_customizing',
      description:
        'Rows of ONE customizing table from a closed allow-list (' +
        [...CUSTOMIZING_TABLES.keys()].join(', ') +
        '), via the data preview. `where` is ANDed; `totalRows` counts without the row cap. ' +
        'NUMC compares at full width (routine 953 is "0000953" in T683S). An empty TVARVC ' +
        'answer means "not in this system" only: it is not transported. One call.',
      inputSchema: {
        type: 'object',
        properties: {
          table: { type: 'string', description: 'One of the allow-listed customizing tables' },
          fields: { type: 'array', items: { type: 'string' }, description: 'Columns to return; absent = all' },
          where: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                field: { type: 'string' },
                op: { type: 'string', enum: ['=', '<>', 'IN', 'LIKE'] },
                value: { description: 'string; array for IN; for LIKE a name with * wildcards' },
              },
              required: ['field', 'value'],
            },
          },
          rows: { type: 'integer', description: `1..${MAX_ROWS}, default ${DEFAULT_ROWS}` },
        },
        required: ['table'],
      },
    },
    async handler({ table, fields, where, rows }) {
      // The grammar refuses before the session is even looked at: a bad request costs nothing.
      const built = buildSelect({ table, fields, where, rows });
      if (!session?.raw) {
        throw new SelectViolation('this session has no raw client: the data preview cannot be asked.');
      }
      let out;
      try {
        out = await previewPost(session.raw, built.sql, built.rows);
      } catch (e) {
        if (e?.name !== 'SelectViolation') {
          journal?.gap?.({
            code: 'TABLE_NOT_READ',
            subject: built.table,
            detail: `HTTP ${e?.status ?? '?'}: ${e?.message}`,
            impact: `no statement can be made about the rows of ${built.table}; this is NOT an empty table`,
            fallback: 'SE16N / SM30 in the SAP GUI, or the data preview in Eclipse ADT',
          });
        }
        throw e;
      } finally {
        // One line per ADT call: table and count, never a row.
        record(cfg, 'adt_customizing', `${built.table} rows<=${built.rows}`, out?.bytes ?? 0);
      }
      const parsed = parsePreview(out.body);
      try {
        assertRanAsSent(built.sql, parsed.executedQuery);
      } catch (e) {
        journal?.gap?.({
          code: 'TABLE_NOT_READ',
          subject: built.table,
          detail: e.message,
          impact: `the server ran another statement than the one sent; no statement about the rows of ${built.table} -- the rows it returned answer a different question`,
          fallback: 'SE16N in the SAP GUI, or the data preview in Eclipse ADT',
        });
        throw e;
      }
      if (parsed.drift.length && journal?.enabled) {
        journal.gap({
          code: DRIFT_CODE,
          subject: `${built.table} data preview`,
          detail: parsed.drift.map((d) => (d.attribute ? `metadata/@${d.attribute}` : `<${d.node}> x${d.count}${d.where ? ` (${d.where})` : ''}`)).join('; '),
          impact: 'the rows stand; the measured shape of the data preview has aged and the parser may be dropping something',
          fallback: 'compare with the data preview in Eclipse ADT; re-measure (docs/adt-api-reference.md)',
        });
      }
      return asText({
        table: built.table,
        why: CUSTOMIZING_TABLES.get(built.table).why,
        sql: built.sql,
        executedQuery: parsed.executedQuery,
        status: out.status,
        bytes: out.bytes,
        ms: out.ms,
        totalRows: parsed.totalRows,
        count: parsed.rows.length,
        truncated: truncationOf(parsed, built.rows),
        ...(parsed.countNote ? { countNote: parsed.countNote } : {}),
        columns: parsed.columns,
        rows: parsed.rows,
        ...(parsed.drift.length ? { drift: parsed.drift } : {}),
      });
    },
  };
}

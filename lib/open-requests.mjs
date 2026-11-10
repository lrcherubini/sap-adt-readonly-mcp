// The open requests that hold one object, as the repository information system answers them.
//
// `GET /sap/bc/adt/repository/informationsystem/objectproperties/transports?uri=<object URI>`,
// MEASURED 2026-11-10 (docs/adt-api-reference.md, "Backlog reads"): for an object in a
// modifiable request it names that request -- number, description, owner, status `D`, dates,
// counts; for objects that sit only in released requests it answered empty. So the resource
// lists OPEN requests only, and an empty answer means "in no open request now", never "never
// transported": the version history answers that.

const ATTRIBUTES = new Set([
  'number',
  'description',
  'owner',
  'status',
  'createdAt',
  'changedAt',
  'numberOfEntries',
  'numberOfObjects',
]);
const ELEMENTS = new Set(['tpr:transportProperties', 'tpr:transport', 'atom:link']);

const unescapeXml = (s) =>
  String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/** @returns {{requests:object[], drift:{node:string, attribute:string|null, count:number}[]}} */
export function parseOpenRequests(xml) {
  const body = String(xml ?? '');
  const requests = [];
  const drift = new Map();
  const note = (node, attribute) => {
    const k = `${node}|${attribute ?? ''}`;
    const row = drift.get(k) ?? { node, attribute, count: 0 };
    row.count += 1;
    drift.set(k, row);
  };
  for (const [, name] of body.matchAll(/<([\w]+:[\w]+)[\s/>]/g)) if (!ELEMENTS.has(name)) note(name, null);
  for (const [, attrs] of body.matchAll(/<tpr:transport\s([^>]*?)\/?>/g)) {
    const row = {};
    for (const [, k, v] of attrs.matchAll(/([\w:]+)="([^"]*)"/g)) {
      if (ATTRIBUTES.has(k)) row[k] = unescapeXml(v);
      else if (!k.startsWith('xmlns')) note('tpr:transport', k);
    }
    const count = (v) => (v === undefined || v === '' ? null : Number(v));
    requests.push({
      number: row.number ?? null,
      description: row.description ?? null,
      owner: row.owner ?? null,
      status: row.status ?? null,
      createdAt: row.createdAt ?? null,
      changedAt: row.changedAt ?? null,
      entries: count(row.numberOfEntries),
      objects: count(row.numberOfObjects),
    });
  }
  return { requests, drift: [...drift.values()] };
}

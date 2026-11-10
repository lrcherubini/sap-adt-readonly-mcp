// The saved search of the IDE's Transport Organizer: the configuration a user already saved,
// read and never created.
//
// MEASURED 2026-11-10 (docs/adt-api-reference.md, "Backlog reads"):
//   GET …/searchconfiguration/configurations         the user's configurations, each an
//                                                     atom:link to …/configurations/<32 hex>
//   GET …/searchconfiguration/configurations/<id>     its properties: WorkbenchRequests,
//                                                     CustomizingRequests, TransportOfCopies,
//                                                     Modifiable, Released, User, DateFilter,
//                                                     FromDate, ToDate, the facet order
//   GET /sap/bc/adt/cts/transportrequests?targets=true&configUri=<href>
//                                                     the tree the IDE shows, modifiable AND
//                                                     released, with every object inline
//                                                     (874 KB for 858 objects)

export const CONFIGURATION_HREF = /^\/sap\/bc\/adt\/cts\/transportrequests\/searchconfiguration\/configurations\/([0-9A-Fa-f]{32})$/;

const unescapeXml = (s) =>
  String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/** The configurations the server lists for the logged-on user: `{id, href}` each, in order. */
export function parseConfigurations(xml) {
  const out = [];
  for (const [, href] of String(xml ?? '').matchAll(/<atom:link\s[^>]*?href="([^"]+)"/g)) {
    const m = CONFIGURATION_HREF.exec(unescapeXml(href));
    if (m && !out.some((c) => c.id === m[1])) out.push({ id: m[1], href: m[0] });
  }
  return out;
}

/** The properties of one configuration, key -> value ('' for an empty one). */
export function parseConfiguration(xml) {
  const properties = {};
  for (const m of String(xml ?? '').matchAll(/<configuration:property\s([^>]*?)(?:\/>|>([^<]*)<\/configuration:property>)/g)) {
    const key = /\skey="([^"]*)"/.exec(` ${m[1]}`)?.[1];
    if (key) properties[unescapeXml(key)] = unescapeXml(m[2] ?? '');
  }
  return properties;
}

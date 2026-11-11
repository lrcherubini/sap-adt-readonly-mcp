// The package document: what a package declares about its boundary.
//
// MEASURED 2026-11-10 (docs/adt-api-reference.md, "Package interfaces"): GET
// /sap/bc/adt/packages/<name>, application/vnd.sap.adt.packages.v2+xml, 3-12 KB. Read here:
//   pak:attributes/@pak:isEncapsulated        whether the package restricts its use to its interfaces
//   pak:useAccesses/pak:useAccess              each interface this package declares it may use:
//     pak:packageInterfaceRef/@adtcore:name    the interface
//     pak:packageRef/@adtcore:name             the package that owns it (empty on some rows)
//     @pak:severity                            the severity the package check gives a use outside it
//   pak:packageInterfaces/pak:packageInterfaceRef  the interfaces this package publishes
//   pak:superPackage/@adtcore:name             its parent
// The members of an interface (which objects it exposes) are not in any ADT document: the IDE
// opens an interface in SAP GUI. So nothing here can say a use is allowed or not; it says what
// is declared.

const unescapeXml = (s) =>
  String(s ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

const attrsOf = (raw) => {
  const out = {};
  for (const m of String(raw ?? '').matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = unescapeXml(m[2]);
  return out;
};
const bool = (v) => (v === 'true' ? true : v === 'false' ? false : null);

/** {name, isEncapsulated, superPackage, useAccesses, interfaces} from one package document. */
export function parsePackageDocument(xml) {
  const body = String(xml ?? '');
  const root = attrsOf(/<pak:package\s([^>]*)>/.exec(body)?.[1]);
  const attributes = attrsOf(/<pak:attributes\s([^>]*?)\/?>/.exec(body)?.[1]);
  const superPackage = attrsOf(/<pak:superPackage\s([^>]*?)\/?>/.exec(body)?.[1])['adtcore:name'] || null;
  const useAccesses = [...body.matchAll(/<pak:useAccess\s([^>]*)>([\s\S]*?)<\/pak:useAccess>/g)].map(([, raw, inner]) => {
    const a = attrsOf(raw);
    return {
      interface: attrsOf(/<pak:packageInterfaceRef\s([^>]*?)\/?>/.exec(inner)?.[1])['adtcore:name'] || null,
      package: attrsOf(/<pak:packageRef\s([^>]*?)\/?>/.exec(inner)?.[1])['adtcore:name'] || null,
      severity: a['pak:severity'] ?? null,
    };
  });
  const published = /<pak:packageInterfaces\b[^>]*>([\s\S]*?)<\/pak:packageInterfaces>/.exec(body)?.[1] ?? '';
  const interfaces = [...published.matchAll(/<pak:packageInterfaceRef\s([^>]*?)\/?>/g)]
    .map(([, raw]) => attrsOf(raw)['adtcore:name'])
    .filter(Boolean);
  return {
    name: root['adtcore:name'] ?? null,
    isEncapsulated: bool(attributes['pak:isEncapsulated']),
    superPackage,
    useAccesses,
    interfaces,
  };
}

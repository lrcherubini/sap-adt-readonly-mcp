// The OData metadata a consumer actually holds -- read as evidence, not as a rule.
//
// The contract between a service definition and its consumers is that
// `expose <entity> as <alias>` produces an EntitySet named exactly `<alias>` and an
// EntityType named `<alias>Type`. That rule is not derived here from documentation: it
// is READ BACK from the $metadata that the CPI packages and the Fiori apps keep in the
// repository. Two versions, both measured in a measured workspace:
//
//   V4  ZAPI_DEMO_ERP.edmx              Schema Namespace="com.sap.gateway.srvd_a2x.zapi_demo_erp.v0001"
//                                    EntitySet A_ProductPlant -> EntityType A_ProductPlantType
//   V2  ZAPI_DEMO_INVMAP_O2.edmx    Schema Namespace="cds_zapi_demo_invmap_o2"
//                                    EntitySet DemoInventoryMapping -> ...MappingType
//
// ⚠️ THE NAMESPACE IS THE ONLY THING THAT SAYS WHOSE CONTRACT IT IS, and it has to,
// because the names collide on purpose. Our ZAPI_DEMO_ERP deliberately exposes
// `I_ProductPlantBasic as A_ProductPlant` so that a mapping written against SAP's
// API_PRODUCT_SRV keeps working -- so `A_ProductPlantType` appears in BOTH our edmx and
// SAP's, in the same repository, three directories apart. Attributing that name to our
// contract on sight would invent an coupling; attributing it to SAP would miss a real
// one. The bundle that holds the file decides, and the bundle's own edmx says which.
//
// No XML dependency: this reads element names and attributes with a scanner, because
// the files are single-line, multi-megabyte, and only four attributes are wanted.


/** `<Tag attr="v" ...>` occurrences, as {tag, attrs}. */
function* elements(text, tags) {
  const set = new Set(tags.map((t) => t.toLowerCase()));
  const re = /<([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*"[^"]*")*)\s*\/?>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const tag = m[1].includes(':') ? m[1].slice(m[1].indexOf(':') + 1) : m[1];
    if (!set.has(tag.toLowerCase())) continue;
    const attrs = {};
    for (const a of m[2].matchAll(/([\w.:-]+)\s*=\s*"([^"]*)"/g)) attrs[a[1]] = a[2];
    yield { tag, attrs };
  }
}

/**
 * The service a schema namespace belongs to.
 *
 * Both forms are measured: V4 A2X services publish
 * `com.sap.gateway.srvd_a2x.<service>.v0001`, V2 ones publish `cds_<service>`. Anything
 * else is returned as-is and is, in a measured workspace, a SAP-owned service (`API_PRODUCT_SRV`).
 */
export function serviceOfNamespace(namespace) {
  const ns = String(namespace ?? '');
  // srvd_a2x (API services), srvd_f4 (the generated value-help services a Fiori app
  // caches one metadata document per), and plain srvd all appear in a measured workspace.
  const v4 = /(?:^|\.)srvd(?:_[a-z0-9]+)?\.([a-z0-9_]+)\.v\d+$/i.exec(ns);
  if (v4) return v4[1].toUpperCase();
  const v2 = /^cds_([a-z0-9_]+)$/i.exec(ns);
  if (v2) return v2[1].toUpperCase();
  return ns.toUpperCase();
}

/**
 * Parse one $metadata document.
 *
 * @returns {{file:string|null, version:string|null, namespace:string|null,
 *            service:string|null, entityTypes:string[],
 *            entitySets:{name:string, type:string}[]}}
 */
export function parseEdmx(text, file = null) {
  const src = String(text ?? '');
  const version =
    /<edmx:Edmx[^>]*\sVersion="([^"]+)"/i.exec(src)?.[1] ??
    (/ado\/2008\/09\/edm/.test(src) ? '2.0' : null);
  let namespace = null;
  const entityTypes = [];
  const entitySets = [];
  for (const { tag, attrs } of elements(src, ['Schema', 'EntityType', 'EntitySet'])) {
    if (tag === 'Schema') {
      // The FIRST schema is the service's own; the rest are referenced vocabularies.
      namespace ??= attrs.Namespace ?? null;
      continue;
    }
    if (tag === 'EntityType' && attrs.Name) entityTypes.push(attrs.Name);
    if (tag === 'EntitySet' && attrs.Name) {
      const type = String(attrs.EntityType ?? '');
      entitySets.push({ name: attrs.Name, type: type.slice(type.lastIndexOf('.') + 1) || null });
    }
  }
  return {
    file,
    version,
    namespace,
    service: namespace ? serviceOfNamespace(namespace) : null,
    entityTypes,
    entitySets,
  };
}

const CONSUMER_EXT = new Set([
  '.edmx', // the cached $metadata itself: evidence, not use
  '.mmap', // message mapping: references the EntityType by XPath
  '.xsl',
  '.groovy',
  '.iflw',
  '.xsd', // the generated schema is NAMED after the alias
  '.wsdl',
  '.json', // manifest.json
  '.xml', // annotation.xml Target=, metadata.xml
]);

/**
 * Files whose CONTENT must never be read.
 *
 * Integration `.sample` payloads can carry personal data. They are excluded by extension
 * here, and the journal's field allowlist is the second door -- neither alone would be enough.
 */
const NEVER_READ = /\.(sample|properties|p12|pfx|key|pem)$/i;

/**
 * Files that are neither evidence nor use: build metadata whose vocabulary collides
 * with ours by accident. `package-lock.json` contains the word `Logs`, and that is not
 * a citation of the `Logs` entity set of ZUI_DEMO_RATE.
 */
const NOT_A_CONSUMER = /^(package(-lock)?\.json|tsconfig\.json|ui5(-\w+)?\.yaml)$/i;

/**
 * Is this file a $metadata document rather than something that consumes one?
 *
 * By CONTENT, not only by name. A Fiori app keeps generated mocks under
 * `webapp/localService/` under arbitrary names (`ZUI_DEMOITEMRATING_VAN.xml`), and
 * reading one of those as a consumer turns every EntityType it mirrors into a phantom
 * citation -- the app is not USING those names independently, it is holding a copy of
 * the same document.
 */
const isMetadata = (file, text) =>
  /\.edmx$/i.test(file) ||
  /(^|[\/])metadata\.xml$/i.test(file) ||
  /<(?:edmx:)?Edmx[\s>]/i.test(String(text).slice(0, 4000));

/** Would a file of this name be read as a consumer at all (extension allowed, never-read excluded)? */
export const isConsumerFile = (name) => {
  const base = String(name).split('/').pop();
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.')).toLowerCase() : '';
  return CONSUMER_EXT.has(ext) && !NEVER_READ.test(base) && !NOT_A_CONSUMER.test(base);
};

/**
 * One file of a consumer (a Fiori app as the system's UI5 repository serves it), split into the
 * two roles a file can have: EVIDENCE of a contract ($metadata) or USE of one (everything else).
 * Identifier tokens only -- never the node text, never a value: the question is "does this file
 * NAME the EntityType", and a name is an identifier.
 * @returns {{metadata:object}|{consumer:{file:string, scope:string, tokens:Set<string>}}|null}
 */
export function readConsumerFile(file, text, scope) {
  if (!isConsumerFile(file)) return null;
  if (isMetadata(file, text)) return { metadata: { ...parseEdmx(text, file), scope } };
  return { consumer: { file, scope, repo: scope, tokens: new Set(String(text).match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? []) } };
}

// The name of a package (DEVC), one rule for every request that carries one.
//
// MEASURED 2026-11-12 on the development system (docs/adt-api-reference.md, "Package names"):
// the quick search over DEVC/K answered names made of A-Z, 0-9 and `_ - & . + $ /` -- 928
// packages with a hyphen (namespaced ones among them), `IS-A&D-MPN-SUCHHILFE`, `IS_E&C_AHK`,
// `WO+G`, `/PM0/ALB_RELEASE4.5`, `$TMP`-style local packages and `$/1BEA/BBEA` (a local package
// in a namespace). No name used `# ! % ( ) = @ : ' , ; ~`, a space or a lower-case letter. SAP's
// documentation states the rest: at most 30 characters with the namespace included, and a
// namespace of 5 to 10 characters slashes included.
//
// Every character admitted here leaves this server encoded for where it goes: percent-encoded
// in a URL (`&` and `+` are separators there), escaped in XML (`&`).

/** A whole package name: optional `$`, optional namespace, then the name; 30 characters at most. */
export const PACKAGE_NAME = /^(?=.{1,30}$)\$?(?:\/[A-Z0-9_]{3,8}\/)?[A-Z0-9_$&.+-]+$/;

/** The name as the system writes it (upper case), or null when it is not a package name. */
export function packageNameOf(raw) {
  const name = String(raw ?? '').trim().toUpperCase();
  return PACKAGE_NAME.test(name) ? name : null;
}

/** The name as one URL path segment the ADT writes: lower case, every reserved character encoded. */
export function packageSegmentOf(raw) {
  const name = packageNameOf(raw);
  return name ? encodeURIComponent(name.toLowerCase()).replace(/%[0-9A-F]{2}/g, (h) => h.toLowerCase()) : null;
}

/** The name as XML text. */
export const packageXml = (name) => String(name).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

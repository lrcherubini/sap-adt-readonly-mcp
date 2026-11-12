// The name of a repository object, one rule for every request this server builds from one.
//
// MEASURED 2026-11-12 on the development system (docs/adt-api-reference.md, "Object names"): the
// quick search answered names of the families this server reads made of A-Z, 0-9, `_`, a
// namespace and `- & $ % . + #` -- function groups with a hyphen (`FTBP-CUST`), includes with
// `&` and `$` (`BILA&I00`, `RPC4$QQ0`), programs with `%` (`%H_ARCH_`), message classes with
// `-`, `+` and `#`. The ADT itself writes such a name in a URL percent-encoded (`%26`, `%24`,
// `%25`), lower case. A name the families read here never carried a blank, a quote or `( ) , ;`.
// Packages have their own rule (lib/package-name.mjs).

/** A whole object name: an optional namespace, then the name; 40 characters at most. */
export const OBJECT_NAME = /^(?=.{1,40}$)(?:\/[A-Z0-9_]{1,10}\/)?[A-Z0-9_&$%.+#-]+$/;

/** The name as the system writes it (upper case), or null when it is not an object name. */
export function objectNameOf(raw) {
  const name = String(raw ?? '').trim().toUpperCase();
  return OBJECT_NAME.test(name) && name !== '.' && name !== '..' ? name : null;
}

/**
 * The name as one URL path segment the ADT writes: lower case, the namespace slashes and every
 * reserved character percent-encoded with lower-case hex. Null when it is not an object name.
 */
export function objectSegmentOf(raw) {
  const name = objectNameOf(raw);
  return name ? encodeURIComponent(name.toLowerCase()).replace(/%[0-9A-F]{2}/g, (h) => h.toLowerCase()) : null;
}

/**
 * What `objectSegmentOf` can produce, for a route table: the namespace as `%2f`, then the name's
 * characters as they are or as the five escapes of `# $ % & +`. One segment: no slash, no `..`.
 */
export const OBJECT_SEGMENT = /^(?!\.{1,2}$)(?:%2f[a-z0-9_]{1,10}%2f)?(?:[a-z0-9_.-]|%2[3-6]|%2b){1,90}$/;

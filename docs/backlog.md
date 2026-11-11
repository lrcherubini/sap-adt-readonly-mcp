# Backlog: open decisions and measurements

Points for future analysis. Nothing here is estimated, prioritised or approved; the point is not to
lose a finding between one task and the next.

**Format:** what is missing · where it bit · what would have to be measured or decided. An item
that becomes work leaves this file and becomes a commit; an item that proves unnecessary just
leaves. **A measured fact does not live here**: it goes to [`adt-api-reference.md`](adt-api-reference.md).
A decision taken goes to [`security.md`](security.md). A live defect of the ADT that this client
cannot repair becomes a rule in the code that avoids it, plus a section of the reference.

Last reviewed: 2026-11-10, after a comparison with other ADT MCP servers (read and run only).

---

## 1. Remove `abap-adt-api`: no third-party code between this server and the system

**What is missing.** The owner's rule: no new capability uses third-party code, and the library
leaves. It still carries the Basic logon, the CSRF token, the cookies and the stateless session,
and the 22 allowlisted members of `lib/guard.mjs` (search, object structure, source, where-used,
node contents, DDIC, discovery, enhancements). Every newer read already goes through
`lib/adt-get.mjs` or a fixed POST of our own.

**Where it bit.** Three measured defects of the library are already worked around in the
reference (`userTransports`, the quick-search facet, `revisions`), and the guard exists because
the library hands out unguarded objects.

**What to measure and decide.** The raw reply of each of the 22 members, transcribed before its
route replaces it; the order of the migration, one member per cycle; the logon and CSRF exchange
measured on the wire; and what `lib/guard.mjs` becomes once no client is left to wrap.

---

## 2. Candidates from the comparison that were not taken

Each needs a measurement on the system and a dated decision before it is built.

- **The syntax check of the remaining text objects.** Classes, programs, behaviour definitions,
  CDS views and metadata extensions are checked (`adt_syntax_check`). Still to read: one
  `abapCheckRun` body for a service definition, an interface and a function module (Ctrl+F2 in
  each, the request body from the log).
- **Quickfix proposals, never applied.** Measured 2026-11-10 (`adt-api-reference.md`, *Backlog
  reads*): the body is a constant empty element, the object, position and marker go in the query,
  and the server evaluates its stored source. Build: a POST of its own, its dated decision, a
  mode that lists proposals and never follows their apply URI. Measure first: the IDE sent
  `start=l,c;end=l,c` with the end of the token, and a check message carries the start only.
  Capture Ctrl+1 at a caret with no selection on a marked line, to see whether `end` equal to
  `start` is answered.

---

An accepted limit is not an item: it is a decision, and it lives where the behaviour is (the
per-target gap that cannot retire itself is explained in `lib/report.mjs`, `classifyStaleness`).
What was closed is in the git history, not here.

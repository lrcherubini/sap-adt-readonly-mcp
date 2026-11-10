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

- **Existing ABAP traces, read only.** `GET /sap/bc/adt/runtime/traces/abaptraces` and the
  hit list, DB accesses and statements of one trace. Creating or configuring a trace is a write
  and stays out. Measure: the shapes, and whether reading changes the trace state.
- **Quickfix proposals, never applied.** `POST /sap/bc/adt/quickfixes/evaluation` with a
  position. Today an ATC finding says only that a quickfix exists. Decide: it sends source to the
  server, so the body is the stored source just read, never text from the caller.
- **Go to definition.** `POST /sap/bc/adt/navigation/target`. Same body question as quickfixes.
- **Grouped dumps.** `adt_runtime_errors` grouping a page by program, line and error. Local
  post-processing only, no new call. Decide the grouping key on real pages.
- **SARIF / JUnit output of an ATC run**, for a CI gate per transport (`adt_transport` objects into
  `adt_atc_run`). Decide whether it is a format option or a separate tool.
- **Refuse an unexpected system.** An installation value naming the system and client the server
  must find after logon, so a configuration pointed at the wrong system stops before any read.
- **Conditional reads by ETag.** The IDE log shows 304 answers; a source read again within the
  session could ask with `If-None-Match`. Measure which resources send an ETag.

ABAP Unit is not a candidate: it stays with the IDE (`docs/security.md`).

---

An accepted limit is not an item: it is a decision, and it lives where the behaviour is (the
per-target gap that cannot retire itself is explained in `lib/report.mjs`, `classifyStaleness`).
What was closed is in the git history, not here.

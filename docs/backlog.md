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
- **The syntax check of every text object, not only classes and programs.** Quickfixes, and the
  check run behind them, exist for any source-based object: CDS (DDLS, DDLX, DCLS), RAP behaviour
  definitions, service definitions, interfaces, function modules, includes. `adt_syntax_check`
  and its body builder admit the two families measured. Measure, per type: the object URI the
  check run takes, its reply (the quickfix marker `atom:link rel=.../categories/quickfixes` is
  already parsed for any message), and whether `inactive` checks an empty source when there is
  no inactive version, as it does for a program.
- **Quickfix proposals, never applied.** `POST /sap/bc/adt/quickfixes/evaluation` with a
  position. A check message and an ATC finding say only that a quickfix exists (the check run
  names it, e.g. `art.syntax:GTU`). Decide: it sends source to the server, so the body is the
  stored source just read, never text from the caller.
- **Go to definition.** `POST /sap/bc/adt/navigation/target`. Same body question as quickfixes.
- **SARIF / JUnit output of an ATC run**, for a CI gate per transport (`adt_transport` objects into
  `adt_atc_run`). Decide whether it is a format option or a separate tool.
- **Refuse an unexpected system.** An installation value naming the system and client the server
  must find after logon, so a configuration pointed at the wrong system stops before any read.
- **Conditional reads by ETag.** The IDE log shows 304 answers; a source read again within the
  session could ask with `If-None-Match`. Measure which resources send an ETag.
- **Package boundary violations.** A customer object that uses an object of another customer
  package outside that package's declared interface (`PINF`): the dependency side of Clean Core,
  next to what `adt_clean_core_scan` says about consumed SAP objects. Measure: how the ADT
  exposes a package interface and its members, and whether `adt_where_used` and
  `adt_package_tree` together see every use, or only enough to report `complete: false`.
- **The context an object consumes.** For one object, the public signature of each object it
  uses, with its API release state (`apiRelease`), instead of their full sources: what an agent
  needs to judge the object's Clean Core level. A composition of existing reads, no new route.
  Measure: the reads it costs on a real class against the read budget, and decide the depth.
- **Package health report.** One summary per package of the Clean Core level, the ATC and
  syntax check results and what could not be read, from the gaps already filed. Decide whether
  it is a mode of `npm run report` (local, no new call) or a tool.

ABAP Unit is not a candidate: it stays with the IDE (`docs/security.md`).

---

## 3. Reads seen in the IDE's communication log and not built

Read on 2026-11-10 while the IDE compared versions, checked syntax and released requests. The
write requests of that log (lock, source PUT, activation, transport checks and release, the
background run that releases) are out by design and are not listed.

- **The requests a saved search configuration lists.** The IDE lists transport requests with
  `GET /sap/bc/adt/cts/transportrequests?targets=true&configUri=<configuration>` (about 830 KB):
  modifiable requests too, not only the released ones of the last two weeks that `recent` gets.
  The configuration is one the IDE saved for the user. Measure: the reply with a configuration
  this server did not create, and what a missing configuration answers; decide whether reading a
  user's saved search is admissible.
- **The logs of one request.** `GET /sap/bc/adt/cts/transportrequests/<number>/actionlogs` and
  `/transportlogs` (2-4 KB each): what happened to a request and its import. Measure the shapes.
- **The open requests that hold an object.**
  `/repository/informationsystem/objectproperties/transports?uri=<object>` answered an empty
  `tpr:transportProperties` for two classes in released requests only. Measure an object that
  sits in an open request before deciding anything.

---

An accepted limit is not an item: it is a decision, and it lives where the behaviour is (the
per-target gap that cannot retire itself is explained in `lib/report.mjs`, `classifyStaleness`).
What was closed is in the git history, not here.

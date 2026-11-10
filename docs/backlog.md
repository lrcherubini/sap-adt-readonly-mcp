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
- **Conditional reads by ETag.** Measured 2026-11-10 (`adt-api-reference.md`, *Backlog reads*):
  class documents and sources, CDS sources and package documents send `ETag` and
  `Last-Modified`; logs, search hits and the request tree do not. Decide: whether a session cache
  of bodies is worth the state it adds; then measure whether `If-None-Match` answers `304`.
- **Package boundary violations.** A customer object that uses an object of another customer
  package outside that package's declared interface (`PINF`): the dependency side of Clean Core,
  next to what `adt_clean_core_scan` says about consumed SAP objects. Measured 2026-11-10: the
  package document names its interfaces, but only by their SAP GUI URI, so their members were
  not read. Measure next: `checkuseaccess` (`/sap/bc/adt/packages/{package}/useaccesses/{interface}`),
  and whether any ADT resource lists an interface's members.
- **The context an object consumes.** For one object, the public signature of each object it
  uses, with its API release state (`apiRelease`), instead of their full sources: what an agent
  needs to judge the object's Clean Core level. A composition of existing reads, no new route.
  Measure: the reads it costs on a real class against the read budget, and decide the depth.
  Discovery (2026-11-10): for CDS the `graphdata` route already answers; for a class the
  candidates are `/sap/bc/adt/objectrelations` (a POST body) and `objectsets/references/{id}`,
  to be captured from the IDE's Relation Explorer.
- **ATC on a package, for `adt_package_health`.** The tool runs the Clean Core scan and the
  syntax check; ATC stays out because `adt_atc_run` checks one object. Measure, from the IDE's
  communication log: an ATC run on a package (the object set the run takes, the worklist it
  leaves, its size and duration), and whether it differs from one run per object.

ABAP Unit is not a candidate: it stays with the IDE (`docs/security.md`).

---

## 3. Reads seen in the IDE's communication log and not built

Read on 2026-11-10 while the IDE compared versions, checked syntax and released requests. The
write requests of that log (lock, source PUT, activation, transport checks and release, the
background run that releases) are out by design and are not listed.

- **The requests a saved search configuration lists.** Admitted read-only by the owner
  (2026-11-10); measured the same day (`adt-api-reference.md`, *Backlog reads*): the list is the
  logged-on user's requests, modifiable and released, with every object inline (874 KB for 858
  objects). Decide: what the answer keeps of it, since the size is the trap.
- **The logs of one request.** Measured 2026-11-10: `actionlogs` flat, `transportlogs` a tree of
  systems and steps. Build: a request mode of `adt_transport`, with its dated decision.
- **The open requests that hold an object.** Measured 2026-11-10: for an object in a modifiable
  request `objectproperties/transports` names it (number, owner, status `D`, counts). Build: part
  of the `object` mode of `adt_transport`, with its dated decision.

---

An accepted limit is not an item: it is a decision, and it lives where the behaviour is (the
per-target gap that cannot retire itself is explained in `lib/report.mjs`, `classifyStaleness`).
What was closed is in the git history, not here.

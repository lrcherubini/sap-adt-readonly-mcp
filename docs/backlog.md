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

- **The syntax check of every text object, not only classes and programs.** Measured 2026-11-10
  from the IDE: a behaviour definition takes the same body (`bo/behaviordefinitions/<name>`) and a
  second reporter, `bdefImplementationCheck`, both answered in the measured shape (behaviour
  definitions are ready to build). A CDS view takes the same body (`ddic/ddl/sources/<name>`)
  and `abapCheckRun` alone, and so does a DDLX (`ddic/ddlx/sources/<name>`, a namespace
  percent-encoded): both ready to build. Still to read: one `abapCheckRun` body for a service
  definition, an interface and a function module (Ctrl+F2 in each, the request body from the log).
- **Quickfix proposals, never applied.** Measured 2026-11-10 (`adt-api-reference.md`, *Backlog
  reads*): the body is a constant empty element, the object, position and marker go in the query,
  and the server evaluates its stored source. Build: the fifth POST, its dated decision, a tool
  or a mode that lists proposals and never follows their apply URI.
- **Go to definition.** Measured 2026-11-10 from the IDE: `POST /sap/bc/adt/navigation/target?uri=<source
  URI#start=l,c>&filter=definition`, the body the whole source as `text/plain`, the reply one object
  reference with the target position. Build (decision D7, confirmed by the owner): the body is the
  stored active source the server has just read, never text from the caller.
- **Package boundary violations.** A customer object that uses an object of another customer
  package outside that package's declared interface (`PINF`): the dependency side of Clean Core,
  next to what `adt_clean_core_scan` says about consumed SAP objects. Measured 2026-11-10: the
  package document names its interfaces, but only by their SAP GUI URI, so their members were
  not read. The Relation Explorer's network (above) gives the package path of every object an
  object uses, so a use that crosses packages is visible; whether it goes through the other
  package's interface still needs the interface's members. Measured since: the package document
  lists the use accesses a package declares (interface, owning package, severity) and whether it
  is encapsulated; `checkuseaccess` is a validation, not a read; the interface's members are not
  reachable from ADT (the IDE opens the interface in SAP GUI). What is buildable: a use that
  crosses into another package, with whether the user package declares a use access to an
  interface of that package, and never "violation" (the members decide). The package check run
  (the package URI, no `reporters`) gave no message for a package built to violate, so it cannot
  stand in for the members: the measured system has the package check switched off
  (`PAKPARAM` `GLOBAL_SWITCH` = `OFF`), as customer systems often do.
- **The context an object consumes.** For one object, the public signature of each object it
  uses, with its API release state (`apiRelease`), instead of their full sources: what an agent
  needs to judge the object's Clean Core level. A composition of existing reads, no new route.
  Measure: the reads it costs on a real class against the read budget, and decide the depth.
  Measured 2026-11-10 from the IDE: `POST /sap/bc/adt/objectrelations/network` with a body
  naming the object answers, in context `ENV` ("Used Objects"), every object it uses with type,
  package and package path; for CDS the `graphdata` route already answers. Build: that POST
  (a dated decision: the body names one object, no source), then the composition.
- **ATC on a package, for `adt_package_health`.** Measured 2026-11-10 from the IDE: one object
  reference, `virtualfolders?selection=package:<pkg>`, answered `201`; the worklist read with the
  LAST_RUN set holds the package's objects. Build: the object set into the ATC run body, its dated
  decision, and the part of `adt_package_health` that runs it.
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

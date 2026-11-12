# Backlog: open decisions and measurements

Points for future analysis. Nothing here is estimated, prioritised or approved; the point is not to
lose a finding between one task and the next.

**Format:** what is missing · where it bit · what would have to be measured or decided. An item
that becomes work leaves this file and becomes a commit; an item that proves unnecessary just
leaves. **A measured fact does not live here**: it goes to [`adt-api-reference.md`](adt-api-reference.md).
A decision taken goes to [`security.md`](security.md). A live defect of the ADT that this client
cannot repair becomes a rule in the code that avoids it, plus a section of the reference.

Last reviewed: 2026-11-12, after the completeness contract and the name alphabets.

---

## 1. Candidates from the comparison that were not taken

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

## 2. Found while validating the completeness contract

Each answer already says what it could not read; these are the measurements that would let it
read more.

- **The dump feed's category labels follow the logon language.** On a German logon the entries
  carry `label="ABAP-Laufzeitfehler"` and `label="Beendetes ABAP-Programm"`; the parser knows the
  measured English labels, so `runtimeError` and `program` come back `null` and the list answers
  `PARSE_FAILED` (drift). Measure: the same entries with an English and a Portuguese logon, and
  whether `atom:category` carries a language-independent attribute (`scheme`, `term` shape) that
  identifies the two categories.
- **The FDM routes and `__next`.** `adt_launchpad` reports a `__next` link and does not follow it,
  because no FDM reply measured so far carried one. Measure: the spaces and role catalogs lists
  with the largest result on the system, to see whether the server pages them.
- **The ATC run over a namespaced or local package.** The run body percent-encodes the package
  into `selection=package%3a<PKG>`; only a plain package was measured from the IDE's log. Measure:
  one run with `atc: true` on a `$` package and on a namespaced one, compared with the IDE's log.

## 3. Hosting the server for a team

The code is in place (`docs/deployment.md`); these are what only the system or the owner can
settle.

- **The first unattended logon.** The password file, the refusal held against an unchanged
  file, and `/readyz` are tested offline only. Measure: one start with a wrong password in the
  file on a development system with a test user, then a second start, and the trail between them.
- **The minimal role of the service user.** Display activities only is the intent; which
  authorisation objects the tools need was never traced. Measure: the authorisation trace (STAUTHTRACE)
  while each tool is called once, then a role that holds exactly that.
- **The System user type.** Whether ADT accepts a logon of a *System* (type B) user over Basic
  authentication on `compatibility/graph`, as it does for a dialog user. Measure: one logon.
- **A ceiling on the size of one answer.** Considered and not built, 2026-11-12. Cutting the
  text would break the completeness contract (invalid JSON, a cut with no way past it), and
  refusing a large answer whole would fail calls that work today, while the client already caps
  what it shows the model. Every list is paged already; the largest answer known is
  `adt_package_tree` at depth 3 without `compact`. Reopen with a measured answer size that a
  client mishandled.
- **`readOnlyHint` of `adt_atc_run`.** Every tool says `readOnlyHint: true`; the ATC run leaves a
  result worklist under the user. Decide whether that is "modifies its environment" in the
  specification's sense (then `false`, which some clients answer with a confirmation per call) or
  bookkeeping of the run (then it stays, as the IDE treats it).

---

An accepted limit is not an item: it is a decision, and it lives where the behaviour is (the
per-target gap that cannot retire itself is explained in `lib/report.mjs`, `classifyStaleness`).
What was closed is in the git history, not here.

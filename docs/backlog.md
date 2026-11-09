# Backlog: open decisions and measurements

Points for future analysis. Nothing here is estimated, prioritised or approved; the point is not to
lose a finding between one task and the next.

**Format:** what is missing · where it bit · what would have to be measured or decided. An item
that becomes work leaves this file and becomes a commit; an item that proves unnecessary just
leaves. **A measured fact does not live here**: it goes to [`adt-api-reference.md`](adt-api-reference.md).
A decision taken goes to [`security.md`](security.md). A live defect of the ADT that this client
cannot repair becomes a rule in the code that avoids it, plus a section of the reference.

Last reviewed: 2026-11-09, against the self-contained server (every source read from the system).

---

## 1. Switch Framework: what is switched off is invisible, in the DDIC and in code

**What is missing.** Nothing in this server knows whether an object sits behind a switch that is
off. The effect is measured and the cause is not: `propose:table` marks `NOT IN THE ACTIVE TABLE`
when no field of an append appears in the active field list, and stops there on purpose.

**Where it bit.**
- **DDIC.** On `KNA1`, `enhancement/elements` named 11 appends while `ddicElement` had 7 blocks; the
  four without a block were industry-solution appends whose fields are not in the table. Without a
  route to the cause, "this field does not exist here" and "this field exists and is switched off"
  look the same, and the second changes the decision (switching on a business function is a
  project option).
- **Code.** An `ENHO` carries `@switchSupported`, so an enhancement implementation is
  switch-dependent by design. A where-used or an enhancement listing that ignores the switch
  overstates what runs.

**What remains** (discovery publishes no switch or business-function collection, only feature
toggles; see the reference, *Discovery has no switch or business-function collection*):
1. The answer lives only in table rows (`SFW_SWITCH`, `SFW_BF` and the switch → package /
   object assignments). That hits the boundary this server defends: `runQuery`/`tableContents` are
   denied and the customizing list is closed. The options are proposing the `SFW_*` tables through
   `npm run propose:table`, with the evidence the process requires, or accepting that the cause
   lives in the IDE. **The owner's decision.**
2. What `SFW_BROWSER` shows that the tables do not: one manual pass before building anything.

Until measured, nothing may **assert** a switch as the cause. Reports state absence and point to
`SE11`/`SFW_BROWSER`.

---

## 2. Namespaced subjects on the enhancement routes: admitted by the alphabet, never measured

**What is missing.** One read of `/sap/bc/adt/ddic/structures/%2f<ns>%2f<name>/enhancement/elements`.
The two `enhancement/elements` routes accept the `%2f` form because they reuse the alphabet the
function-group route proved, but for a **function group**, not this resource.

**Where it bit.** Not yet. Namespaced appends show up in responses and read normally as objects;
the case where the namespaced object is the one being asked about is missing.

**What to measure.** A `propose:table` over a namespaced structure that has an append. On 404/422
the report must say *not asked* rather than let the node look enumerated. Today it would fall into
`refusedAsk` ("node(s) not enumerated"), which is right, but that is a reading of the code, not a
measurement.

---

## 3. Two gap codes contradict their own records

**What is missing.** Correct two codes in `lib/journal-codes.mjs`. Not cosmetic: the journal is the
mechanism that makes silence visible, and a code that misstates its own finding spends the
credibility of the others.

- **`BATCH_ITEM_NOT_READ`** says *one failed item is never evidence of absence*, but its `detail`
  can read `Object '<name>' of type TABL/DS not found in the system`. That **is** evidence of
  absence. Two cases, "could not resolve the name" and "the object does not exist", are collapsed
  into one code.
- **`DDIC_FIELDS_NOT_READ`** is `medium` and says *no statement can be made about the fields*. It
  fires for every structure, but `ddicElement` returns an empty tree for **every** `TABL/DS`: a
  measured property of the type (in the reference), not a failure. A `medium` that fires on a
  structural property hides what broke among what simply is so.

**What to decide.** Either a sub-code for "does not exist" (with `impact` depending on it), or texts
that stop asserting absence either way. For the second code, whether a `TABL/DS` should file a gap
at all: it is predictable, and the useful advice ("use the source, not ddicElement") is already in
`fallback`.

---

## 5. Success traces in the failure stream: `FOUND_BY_FACET`, `FOUND_BY_URI`

**What is missing.** Decide whether a successful-resolution trace belongs in the gap stream.

**Where it bit.** In both cases **the object was found and read**; the record only says by which
route, because the primary one did not answer. The information produced two measurements in the
reference, but it lands in the list of "where this server did not reach", and it did reach.

**What to decide.** Move both to a diagnostic stream (which does not exist today), or let the gap
stream carry two kinds of row and have `report` separate them. The prior question: does anyone read
these rows after the measurement that produced them? If not, stop writing them daily.

---

## 6. `EXPOSURE_INCONCLUSIVE`: a code that says it is not a defect can flood the stream

**Status changed 2026-11-08.** The flood came from the removed offline `scan:contract`: one row per
consumer file in a local checkout whose service had no `.srvd` on disk (it was 99.7% of the
stream). `adt_contract_check` now reads the service definition from the system, and consumers are
not read yet, so today the code fires only when a service definition really cannot be read.

**Why it stays.** When the Fiori consumers arrive (UI5 repository route, pending a measurement), one
call may again cover many apps. Decide **before** that lands: one row per app, or one summary row
("N apps whose service could not be read"). Same question as item 5: does anyone act on each row?

---

## 7. A refused logon leaves no trace, and the risk it carries is locking the SAP user

**What is missing.** Decide whether the trail records a failed logon attempt. `recordStart` runs
**after** the logon (`server.mjs`), so a 401 writes nothing: not in the audit, not in the journal.

**Where it bit.** A run of server restarts with two 401s followed by two successful logons shows up
in `npm run report -- --runs` as successful runs only; the refused ones are invisible. Aborting at
the password prompt or a busy port are not risks: neither talks to SAP.

**Why it matters.** `lib/session.mjs` refuses a second attempt in the same process because repeated
failures lock the SAP user, and the IDE, abapGit and transports with it. That guard holds per
process and cannot hold across processes: whoever restarts starts from zero. Only the trail could
say "three refusals on this machine today", and it does not.

**What to decide.** An `event: 'logon-refused'` with `run`, `pid`, `user` and the status (never the
password, never the server's reason verbatim) is cheap and keeps the *no payload, ever* promise,
but it **changes what the trail covers**: from what an authenticated server did to also what never
became one. A `docs/security.md` decision. The question: does the trail exist to audit use, or also
to protect the account?

---

## 8. IDE endpoints, now measured: which become routes

**What is missing.** A route decision for each family measured from an Eclipse communication log:
Service Bindings and their `odatav4` detail, ATC check variants, release states and virtual
folders. The shapes are in the reference (the sections dated 2026-11-09).

**What to decide** (each one needs a `docs/security.md` entry before it can be built):
- **Bindings: measure the missing combinations first.** The broad probe of 2026-11-09 read one
  published binding (V2 UI, with navigations). Still unread:
  - a published V4 binding, UI and Web API;
  - a published V2 Web API;
  - a published binding without navigations;
  - a binding holding several versions;
  - an SRVD whose source type is not `S`.
  Until those are read, nothing about the detail's content may be generalised. Only `created`
  and `published` in the row are trusted, because a wrong version also answers 200.
- **Bindings.** The best fit, because `adt_object_info` / `adt_contract_check` could state a
  `SRVB`'s kind, contract and published state. Read the kind from `srvb:binding`: the `odatav2`/`odatav4`
  detail answers 200 for either kind.
- **Check variants.** The variant itself is small; the 300 KB form template is the check
  catalogue and is probably not worth a route.
- **Release states.** A 20-row SAP-standard list: a candidate for `data/defaults/` rather than a
  route. A capped reply reports the capped count as `totalItemCount`.
- **Virtual folders.** The only POST. Decide whether a POST that reads may enter the guard at all.

---

## Accepted limit (not work): a per-target gap cannot retire itself

Recorded so it does not come back as a defect.

`report` retires a row when a later **census** did not file it again: a sweeping tool
(`adt_clean_core_scan`, `adt_annotation_scan`) on the same package, unnarrowed and complete. That
covers what is a census by nature. It cannot cover gaps filed **per target**
(`ENHANCEMENTS_NOT_READ`, `BATCH_ITEM_NOT_READ`, `SHAPE_DRIFT`, `EXPOSURE_INCONCLUSIVE`): no sequence
of calls proves one of them went away. Those rows stay `unknown`, and `unknown` counts as open:
**nobody looked is not the same as resolved.** To close one: re-read that target, or
`npm run logs:prune -- --code <CODE> --apply`, an explicit act with its own command.

---

## Closed in the 2026-11-09 review

- **Append fields in `propose:table`.** Done: the script reads the three views and prints, per
  append, the fields its own source declares, with a membership test against the active DDIC list.
  What remains is product choice (one read per append, capped at 25; put it behind a flag if the
  cost bothers).
- **`INCLUDE_NOT_READ`, `VOFM_CARRIER_NOT_READ`.** They described the state of a local catalogue of
  include dumps, not a limit of this server. The catalogue sweeps and their codes were removed with
  the move to a self-contained server.

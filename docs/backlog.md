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

## Accepted limit (not work): a per-target gap cannot retire itself

Recorded so it does not come back as a defect.

`report` retires a row when a later **census** did not file it again: a sweeping tool
(`adt_clean_core_scan`, `adt_annotation_scan`) on the same package, unnarrowed and complete. That
covers what is a census by nature. It cannot cover gaps filed **per target**
(`ENHANCEMENTS_NOT_READ`, `BATCH_ITEM_NOT_READ`, `SHAPE_DRIFT`, `UI5_APP_NOT_READ`): no sequence
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

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

**What remains.** The tables of the chain package → `SFW_PACKAGE` → `SFW_SW_BF` →
`SFW_ACTIVE_BFUNC` are admitted (`docs/security.md`, *Switch Framework tables*, 2026-11-09).
`VERSION` is A/I/P (active, inactive, pending after import) and `SWITCHTYPE` is A/E (activation,
standby), both read from their domains. Still to do:
1. **Measure the chain on the known case**, through `adt_customizing`. The four `OI*_KNA1` appends
   missing from the active `KNA1` all sit in package `OI0_COMMON_2`. Read its `SFW_PACKAGE` rows,
   then the business functions of each switch, then whether those are in `SFW_ACTIVE_BFUNC`, and
   what `X_OFF` means there. If the chain explains the four and leaves the seven present ones
   alone, it is evidence; if it does not, it is not built.
2. **Then** `propose:table` prints, for each append `NOT IN THE ACTIVE TABLE`, the switch and the
   business function its package hangs on, and whether that function is active. That is evidence
   next to the absence, never the stated cause.
3. The code half (`ENHO` behind a switch) is not started.

Until measured, nothing may **assert** a switch as the cause. Reports state absence and point to
`SE11`/`SFW_BROWSER`.

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

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

## 1. Switch Framework: whether a switch is ON is not read

**What is missing.** The real state of a switch. The ADT lists enhancement implementations
whatever their switch says (reference, *The enhancement listing ignores the Switch Framework*),
and the business-function chain cannot stand in for the state. On this S/4HANA system no classic
business function is active, yet objects behind those switches are in use. So "this ENHO is bound"
cannot be followed by "and it runs", or "it does not", and the DDIC chain printed by
`propose:table` is weaker evidence than it looks.

**Where it bit.**
- `SAPMV45A` lists four implementations, all behind switches with no active business function.
- `KNA1`: three appends of a switch with no business function are active, and one append of a
  switch whose business functions are inactive is not.

**Decided** (2026-11-09, `docs/security.md`): `SFW_SWITCH_STATE` is admitted by exception, with
`STATE` (`T` on, `S` stand-by, `F` off) readable and `USERNAME` filter-only.

**Measure.** The state of `OI0_COMMON_2` (expected on: its appends are active),
`OI0_COMMON_DS` (expected off: `OILKNA1` is absent), and the switches of the four
`SAPMV45A` implementations. If the table reproduces both known `KNA1` facts, it replaces the
business-function step in `lib/switch-chain.mjs`, and the enhancement footer can say per
implementation whether its switch is on.

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

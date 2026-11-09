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

## 1. Switch states `F`, `S` and "no row": read, never checked against a field truth

**What is missing.** `SFW_SWITCH_STATE` is read, and it agreed with the active field list on all
ten `KNA1` appends of SAP packages (reference, *The switch state*). But only `T` has been seen
against a field truth more than once. "No row" agreed with an absence once (`OILKNA1`), and `F`
and `S` never, because no append behind such a switch turned up in the sweep. So the tools print
the state as read, and print a missing row as such, never as "off".

**What to measure.** One append, or an implementation with an observable effect, behind an `F` and
behind an `S` switch: `SFW_PACKAGE` of a package that holds `TABL` objects, joined to switches
stored `F`/`S`, then the membership test of `propose:table` on the extended table. If "no row"
and `F` agree again, the printed line may say "off" for both. Until then it does not.

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

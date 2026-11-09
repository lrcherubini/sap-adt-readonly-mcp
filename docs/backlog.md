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

## 1. Switch Framework in code: an enhancement behind a switch that is off

**What is missing.** An `ENHO` carries `@switchSupported`, so an enhancement implementation is
switch-dependent by design. `adt_read_source` with `enhancements: true` and the enhancement
listings report every implementation they find, whether or not its switch is on, so they overstate
what runs.

**What exists.** The DDIC half is built: `propose:table` prints the switch chain beside an append
`NOT IN THE ACTIVE TABLE` (`lib/switch-chain.mjs`). The chain goes package → `SFW_PACKAGE` →
`SFW_SW_BF` → `SFW_ACTIVE_BFUNC`, all admitted tables, and is measured on `KNA1` (reference,
*The switch chain*).

**What to measure.** Whether an enhancement implementation is switched through its package, like
the appends, or through its own name: `SFW_PACKAGE` and `SFW_SW_BF` both carry `ENHNAME`, empty
on every row read so far. One `ENHO` known to sit behind a switch is needed, with its
`SFW_PACKAGE`/`SFW_SW_BF` rows read through `adt_customizing`. Until then nothing may **assert**
that an enhancement does not run.

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

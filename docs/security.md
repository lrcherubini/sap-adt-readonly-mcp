# Security notes

This server holds a live credential to a SAP development system and reads source code out of
it. The notes below are the decisions behind that, so a reviewer can disagree with a specific
one instead of with the whole thing.

## The SAP credential

- **Typed once per server start, kept in memory, never written anywhere.** No `.env`, no
  keyring, no OS credential manager, no fallback to an environment variable. If the prompt
  cannot run (no TTY), the server refuses to start rather than looking elsewhere for a
  password.
- The prompt does not echo, and the password is not passed as a process argument, so it does
  not appear in the process list or in shell history.
- It is **never** an MCP tool parameter. Anything that reaches a tool call reaches the model
  context; the credential deliberately lives on the other side of that line.
- After logon, only the ADT session cookies are used. Basic auth is sent on the first request
  and not again.
- On `SIGINT`/`SIGTERM` the session is dropped (`dropSession` + `logout`) before the process
  exits.

### One attempt, no retry

On `401` the server prints why and exits. It does not prompt again, does not retry, does not
back off and try later. Repeated failed logons lock the SAP user; a locked user takes the
IDE, abapGit and transports with it. The correct recovery is a human checking the password
in the IDE or SU01 and starting the server again.

## Read-only: how it is enforced

Not by reviewing each call site — by removing the capability.

`lib/guard.mjs` wraps the ADT client in a `Proxy` driven by an **allowlist**. Of the 161
members `ADTClient` declares in its 8.4.3 `.d.ts`, **22 are reachable**; every other access throws
`ReadOnlyViolation` **before a request is issued**.

Seven of those 22 read DDIC metadata, the service document or the enhancements of an
object, and each was added on the strength of a measurement, not a preference.

`ddicElement`, `annotationDefinitions` and `ddicRepositoryAccess` came first. In a CDS
projection a field inherits its type without restating it (`key Plant,` and nothing
more); `objectStructureElements` returns `[]` for a CDS view; and a data element has no
source at all (a GET on its URI is a 404). So "which data element is behind this field"
is **not derivable from source text**. Measured against this system, `ddicElement` with
the plain entity name as its `path` answers it: `ZC_DemoItemRating` returns 583
fields, each with `ddicDataElement`, `ddicDataType`, `ddicLength` and `ddicIsKey`.

`getDataElementProperties` and `getDomainProperties` followed, and they correct a
decision this file used to record. It previously said `getDataElementProperties` stayed
blocked because "`ddicElement` already covers what the tool needs". That was untested
and wrong: `ddicElement` returns no domain, and the domain is exactly what a Z append
field matches on — its data element is a Z name that matches no standard concept, while
the domain it inherits from the standard does. The documented types name the missing
values (`DataElementProperties.typeName` and `searchHelp`,
`DomainProperties.valueInformation.valueTableRef` and `fixValues`); a domain with fixed
values needs no value help at all, which is a conclusion rather than a gap.

`adtDiscovery` reads `/sap/bc/adt/discovery`: the collections this system exposes and
their URI templates. SAP publishes no endpoint reference for ADT and points at the
service document instead, so this is how a parameter name gets verified rather than
guessed — which is the difference between the first and the second attempt at
`ddicElement` above.

`objectEnhancements` reads the enhancement implementations active on a source object:
a GET on `/source/main/enhancements`, `Accept: …enhancements.v3+xml`. It was opened
because it closes a gap an include-exit inventory has **declared open**, not to round out the set.
Such an inventory lists the include exits and states plainly that their
sibling — enhancement spot and implicit enhancement — has the same invisibility problem
and has not been inventoried because it was not known how to extract it from the system.
This is how. Customer code living inside an enhancement never shows up in a Z-namespace
sweep of the working tree, and no abapGit repository serialises it against the standard
object it modifies; the reply names the ENHO, the enhancement-point path, whether the
implementation **replaces** that point, and the line of the base object it sits at. The
source of each implementation is returned only when it is asked for.

All seven are plain GETs, none needs a lock, and none returns an unguarded object. The
write neighbours (`setDataElementProperties`, `setDomainProperties`) stay blocked, and
so does every read no tool needs — less surface is better even when a call is harmless.
`objectEnhancements` has no write neighbour reachable here: creating or changing an
enhancement goes through `createObject`/`setObjectSource`, and both stay denied.

> **Why an allowlist, and not the denylist this started as.** A denylist that blocked `lock`,
> `activate`, transports and ~50 more was the first design, and it protected nothing, because
> four members hand back an object the proxy does not wrap: `httpClient` (an `AdtHTTP` with a
> generic `request(url, config)` — exactly the `adt_http` tool this design vetoed),
> `statelessClone` (a fresh, unwrapped `ADTClient`, so `.lock()` works), `createHttp`, and
> `password` (the plaintext SAP password). The last two are `private` in TypeScript, which is
> a compile-time fiction: at runtime they sit on the prototype like any other member. A
> denylist also grows holes silently whenever the library adds a method. The allowlist fails
> closed instead. Regression tests cover all four, plus a simulated new library method.

The intent behind the block is still catalogued in `DENIED`, used only for error messages
and for whoever reads a future pull request:

| Group | Examples |
|---|---|
| Repository modification | `lock`, `unLock`, `setObjectSource`, `createObject`, `deleteObject`, `activate`, refactorings |
| Transport | `createTransport`, `transportRelease`, `transportAddUser` |
| abapGit | `gitPullRepo`, `pushRepo`, `unlinkRepo` |
| Out of scope by decision | `unitTestRun`, `rapGen*` |
| **ATC** (2026-09-08 decision **reversed for one run resource**, 2026-09-14, below) | `atcCustomizing`, `atcCheckVariant`, `createAtcRun`, `atcWorklists` stay denied as library methods -- the run is two fixed POSTs + one named GET route of its own; `atcExemptProposal`, `atcRequestExemption`, `atcChangeContact` are governance writes and stay denied by every path |
| Out of scope in this phase | debugger, traces |
| **Closed decision** (2026-09-08), **reopened for a closed list of customizing tables** (2026-09-12, below) | `runQuery`, `tableContents` stay denied; the one data-preview POST is a route of its own, not a library method |

Two structural points matter more than the list:

1. **Writing through ADT requires taking a lock first.** Denying `lock` is the brake; the rest
   is defence in depth.
2. **The session is forced stateless.** A stateful ADT session is what holds locks and
   enqueues. Assigning `stateful` through the proxy is refused at runtime.

### Business data: `runQuery` / `tableContents` stay blocked — closed, not pending

Both were listed as "out of scope in this phase", which reads like a queue. It is a decision,
taken on 2026-09-08 and recorded here so it stops being reopened: this server answers questions
about the **repository** — what an object is, what it consumes, who calls it — and never about
the **contents of a table**. The question that pushed on it (a value held in an application's own configuration table) goes
to the IDE or to the official SAP ADT MCP server, both of which already have the capability and the authorisation model for it.

Reading business data would also change what the audit trail has to promise. Today it can say
"no payload, ever"; a table read makes that untrue by construction.

#### The two frontiers are not the same frontier

This document has been mixing them, and the mixture is what made the customizing question
below look harder than it is:

| | the frontier of the **request** | the frontier of the **report** |
|---|---|---|
| the sentence | *answers about the repository, never about the contents of a table* | *no payload, ever* |
| enforced by | the guard allowlist and the closed route table | `lib/audit.mjs` and the `FIELDS` allowlist of `lib/journal.mjs` |
| what it protects | what this server is **able to ask the system** | what leaves a trace **on this disk** |

A capability can be admitted at the first frontier and still be barred at the second -- which
is exactly what happens with a transport description. It is in the answer, because *why* those
objects moved together is the question; it is in neither the audit log nor the journal.

### Customizing tables: the decision of 2026-09-08 is reversed for a closed list -- 2026-09-12

**What changed, and who changed it.** The repository owner reopened the question above for one
purpose: a catalogue of VOFM routines knows *which* routines exist, whether they
are active and their text, and cannot say *where they are used* -- that lives in `T683S`
(`KOBED`/`KOFRM`/`KOFRA` are routine numbers) and in the copy-control tables
`TVCPA`/`TVCPF`/`TVCPL`. The concrete consumer is a pricing-usage report of the kind most
installations have, which reads `T683S`, `T683U`/`T683T`, `T685`/`T685A`/`T685T`,
`T682I`/`T681`/`TMC1T` with direct `SELECT`s. The reversal is a
decision of 2026-09-12, recorded here dated, and it is **narrower than the question it
reopens**.

**What it admits.** One route, **the only POST this server will ever send**:
`/sap/bc/adt/datapreview/freestyle`, body a `SELECT` **generated** from a closed grammar
(`lib/data-preview.mjs`: one table, allow-listed fields, `WHERE` from `=`/`<>`/`IN` on identifiers, a row cap of 200), for a table in the closed list `CUSTOMIZING_TABLES` -- the tables
such a report reads plus `TVCPA`/`TVCPF`/`TVCPL`/`TFRM`/`TFRMT` and, for the launchpad
(2026-10-02, fields read with `propose:table`), `/UI2/SEMOBJC`/`/UI2/SEMOBJCT`/`/UI2/SEMOBJ` and, for package deletion (2026-10-13, fields read with
`adt_object_info`: object key, package, flags, dates, `AUTHOR` as a user id), `TADIR`, and since then, each admitted the same way -- a named consumer, the fields read with `propose:table`, the delivery class and appends checked, no person data: CDS header annotations (`DDHEADANNO`), payment terms and STVARV parameters (`T052`/`T052U`/`TVARVC` -- `TVARVC` holds free text, query it by `NAME`), partner determination (`TPAER`), the material master screen map (`T133A`/`T133B`/`T133C`, `D020S`/`D020T`/`D021T`, `DDFTX`, `TSDIR`, `DYNPSOURCE`, `TSTC`/`TSTCP`, `T130M`/`T133K`/`T133S`/`T133T`), MRP areas and their parameters (`MDLV`/`MDLG`, `T460A`/`T460T`, `T438A`/`T438T`, `T439A`; `MDMA`, material master per MRP area, was **refused** -- class A), material status (`T141`/`T141T`, `TVMS`/`TVMST`), the factory calendar (`TFACD`/`TFACT`/`TFAIN`/`TFACS`/`THOC`/`THOCI`/`THOL`/`THOLT`, `FHC_CONFIG`/`FHC_C_FCAL`) and the organizational units (`T001`/`T001K`/`T001L`/`T001W`/`T001B`/`T001Z`; `T001S`, accounting clerks with names and contact, was left out on purpose). The standard list lives in `data/defaults/customizing-tables.json`; an installation adds its OWN tables (customer `Z*`/`Y*`) with `npm run config -- table add`, validated by the same grammar and the same checks -- see *The list has two layers* below. A table outside the list is refused
by the client before any socket opens; free SQL never reaches the route. The tool is
`adt_customizing`, and it is **built only after** the resource is measured live (measurement,
step 6: status, shape, lock/`SM12` before and after, timing) -- the route rule of this
repository does not bend for it.

**What does not change.** `runQuery` and `tableContents` stay on the denied side of the
allowlist (22 methods, unchanged); the guard test that proves thirteen write paths throw still
proves it. The *report* frontier does not move: the audit line carries the table name and the
row count, never a row; the journal carries a gap code (`TABLE_NOT_READ`), never a value. The
*request* frontier moves exactly one closed list wide, and the question that originally pushed
on it (an application's own configuration values) is **not** in that list -- it stays with the IDE.

Customizing is configuration, not business data: a row of `T683S` says which routine a pricing
procedure step calls, not what any document is worth. That is the line the 2026-09-08 sentence
drew ("never about the contents of a table"), redrawn one table-list wide, and the list is
closed in code so it cannot grow by convenience.

**Measured, 2026-09-12 (measurement; the dossier has the shape).** One POST per call,
`rowNumber` as the only cap, 480–560 ms, `Accept` exactly
`application/vnd.sap.adt.datapreview.table.v1+xml`. `SM12` showed no lock before or after; the
server echoes the statement it ran (`executedQueryString`), which the tool returns so the
reader can see there was nothing but a `SELECT … UP TO n ROWS`. The server answered `VBAK`
too -- authorisation is the server's only fence, which is why the client's fence is tested
and not assumed (`tests/guard.test.mjs`, "the one POST is the data preview").

#### The delivery-class rule: measured and refused -- 2026-09-22

The list above was proposed for replacement by a **rule** -- admit any table of delivery class
`C`, any table of a customer area, and any `Z*`/`Y*` -- so that adding a customizing table would
stop costing a commit. The rule was measured before it was argued, and it is refused. Both
readings are recorded because the second one is the durable trap.

**It does not describe the list it would replace.** Delivery classes read live on the development system
(`adt_read_source` on a `TABL/DT` returns `@AbapCatalog.deliveryClass` in the DDIC header):

| table | delivery class | |
|---|---|---|
| `T683S` | `C` | customizing table, maintenance only by customer |
| `TFRM` | `G` | customizing table, protected against SAP upd. |
| `TVCPA` | `G` | customizing table, protected against SAP upd. |
| `T682I` | `E` | control table, SAP and customer have separate key areas |
| `T681` | `W` | **system table**, contents transportable via own TR objects |

Four different classes among them, and a `C`-only rule drops three of the tables the
VOFM consumer needs. Widened to cover them
(`C+E+G+W`) it admits everything except `A`, `L` and `S` -- nearly the whole dictionary.

**Delivery class does not mean what the reversal above relies on.** The 2026-09-12 decision rests
on *"customizing is configuration, not business data"*, and that sentence is true **of the
tables that were chosen**, not of the class. A customer table of delivery class `C` can just as
well be a recruitment record carrying first and last name, date of birth, gender, nationality,
e-mail and ethnicity -- personal data, some of it *sensitive* under any data-protection law -- or
an integration log carrying supplier, invoice and purchase order. The `Z*`/`Y*` half is wider
still: a sync table can carry a personal tax id in its key.

**And the name proves nothing, in either direction** -- which is why no verdict in this repository
classifies content by a name heuristic: a table named after an HR infotype can hold harmless
constants, and a table with an innocent name can hold sensitive personal data.

**The structural objection, which outlives the two above.** Today the fence is a literal that
appears in a diff: it grows by commit, under review, with a test. As a rule it becomes a predicate
whose input comes from **the system being fenced** -- anyone creating a `Z` table on the system, or
setting its `CONTFLAG` to `C`, would widen what this server may read with no commit, no review and
no test. That is precisely what *"the list is closed in code so it cannot grow by convenience"*
exists to prevent, and no amount of narrowing the class set repairs it.

**What was kept from the measurement.** The delivery class *is* readable, so it became evidence
for a review instead of a gate: `npm run propose:table -- <TABLE>` (`scripts/propose-customizing-table.mjs`,
`lib/table-meta.mjs`) prints the package, the class, the maintenance flag and the field list
**with its includes followed to the end** (they nest: `KNA1` -> `SI_KNA1` -> `KNA1BRAZIL`),
refuses classes `A` and `L` outright, and emits the line to paste into `CUSTOMIZING_TABLES`.
It also states, for every table, what a table source does NOT contain -- **append structures and
fields added from outside it**. Measured: an append (`ZDEMO_APKOMKCV` on `KOMKCV`) appears
nowhere in the base table source, not even by name, and a field added through the Custom Fields
app is invisible there too -- the table's `include incl_eew_kna1` does not lead to it, that
include ends at a data element.

⚠️ The **creation path**, not the name, decides where such a field is visible, and this file says
so because the first draft of it got that backwards. `ZZ1_DEMODELIVERY` reads as `CFDF/FLD` under
`/sap/bc/adt/customfields/objects/` **because it was created with the Custom Fields app**; the
same field added as an append in SE11 has no `CFDF` object at all. The reference cases are on this
system and were measured the same day:

| append | on | its fields | note |
|---|---|---|---|
| `ZDEMO_MM_FIELDS` (`TABL/DS`, pkg `ZDEMO_MM`) | `MEREP_OUTTAB_PURCHDOC` | `ZZ1_DEMOFLAG_PDH`, `ZZ1_DEMODISC_PDH`, ... | `ZZ1_` names, **no `CFDF` object** |
| `ZDEMO_APKOMKCV` | `KOMKCV` | **`FKART`** | customer field, no `Z` at all |
| `ZDEMO_STR_EXIT` | `WBRF` | **`DT_COMP`**, **`ST_COMP`** | idem |
| `ZDEMO_ST_003` | `J_1BPRNFLI` | **`BASE`** | idem |

The base source of `MEREP_OUTTAB_PURCHDOC` names neither the append nor any of its fields. So
neither the object type, nor the append name, nor the **field** name enumerates customer fields --
nothing forces a developer into `ZZ*`, and plenty here did not. The sentence the tool prints names
the two mechanisms instead, and claims no namespace.

**Nesting has no fixed depth, and the two mechanisms mix.** An include can hold includes, and an
include can itself carry an append -- so the gap is frequently NOT at the table. The measured
chain: `KOMG` includes `KOMPAZ`; `KOMPAZ`'s source holds one field (`PDUMMY`); and it is `KOMPAZ`,
not `KOMG`, that carries the append `ZDEMO_KOMPAZ` with `ZZDEMOFLD`. `KNA1` bottoms out at depth 2
(`KNA1` -> `SI_KNA1` -> `TWTAX_S_KNA1` / `KNA1BRAZIL` / `PHI_KNA1_I`), but nothing fixes that
number. `expandIncludes` therefore follows every level -- termination comes from the cycle guard,
not from the depth cap, and a cap that is hit is REPORTED with the pending names.

**So completeness is stated per node, and it can be proved.** `@AbapCatalog.enhancement.category`
carries it: the ABAP Keyword Documentation (7.58, `ABENDDICDDL_DEFINE_STRUCT_PROPS`; the system kernel
is 7.58) defines `#NOT_EXTENSIBLE` as **cannot be enhanced**, so such a node cannot carry an append
and its source IS its whole field list. ⚠️ `#NOT_CLASSIFIED` is a *different* value meaning **not
classified** -- it excludes nothing, and folding the two would turn "unknown" into "clean". The
tool prints which nodes are provably closed, which can carry an append, and which were not
classified; it claims a complete field list only when every node is closed and every include
resolved. Twelve base structures of the appends above were checked for a counter-example
(a `#NOT_EXTENSIBLE` node carrying one) and none was found, which is consistent with the
documentation and is not offered as a second proof. Resolving them needs a resource this server does not have -- the base table
publishes an `enhancement/elements` link that plausibly covers both, unmeasured and therefore
unbuilt. Saying all of this is what keeps a field list that is missing exactly the customer fields
from reading as complete. It adds nothing itself; it makes the commit cheap. The fence did not move
and `lib/guard.mjs` is untouched. `tests/table-meta.test.mjs` holds the counter-example in place:
if `TFRM` ever reads as class `C`, that test is the one that says so.

#### The list has two layers: standard in the repository, the installation's own in the store

No value of a particular landscape is written in the code. That holds for the fences too, so
every closed list this server checks before a socket opens has two layers, and both stay closed:

| | where | how it grows | reviewed by |
|---|---|---|---|
| **SAP-standard** entries (tables, OData roots, the `DEFAULT` ATC variant) | `data/defaults/*.json`, versioned | commit | a diff, like any code |
| **the installation's** entries (its customer tables, its governance variant) | the environment store, `%LOCALAPPDATA%\sap-adt\sap-adt.db`, outside any git tree | `npm run config -- table add` / `atc add` | the operator who owns the installation |

What keeps the second layer from being the *rule* the section above refused:

- **Same validation, both ways.** An entry passes `validateCustomizingTable` / `validateAtcVariant`
  when the CLI writes it and again when the server reads the store at start.
  A row edited into the SQLite file by hand is caught at the next start; the server refuses to run on
  a fence it cannot vouch for.
- **No input from the fenced system.** The list still grows by a person's act, never by a predicate
  over what the SAP system reports. A `Z` table created on the system widens nothing.
- **A standard entry cannot be redefined** by the installation, and a standard table leaves the list
  only by commit (`table remove` refuses it).
- **The *report* frontier does not move**: the audit line still carries the table name and a row
  count, never a row.

The person who adds a customer table owns the judgement the section above describes -- run
`npm run propose:table -- <TABLE>` first and read the fields.

### ATC: the decision of 2026-09-08 is reversed for one run resource -- 2026-09-14

**What changed, and who changed it.** The ATC was "out of scope by decision: owned by the
official SAP ADT MCP server". The repository owner reopened it on 2026-09-14 because that
server answers an ATC request with "error" and nothing else, and the question it was meant to
answer -- *does this object pass the Clean Core governance variant, and if not, which finding,
which check, which line?* -- is the question a Clean Core review asks of every delivery. The reversal is
**narrower than the capability it reopens**: one run, on one object, with a variant from a
closed set, and its findings read back.

**What it admits.** The **second POST this server sends** -- and the first that creates
something on the server. Two fixed paths in `lib/atc.mjs`: `POST
/sap/bc/adt/atc/worklists?checkVariant=<v>` (answers a 32-hex-character worklist id) and
`POST /sap/bc/adt/atc/runs?worklistId=<id>` with a body **generated** from one validated
object URI (the same rule as the `objectProperties` route: absolute under `/sap/bc/adt`, no
query, no fragment) and a `maximumVerdicts` from 1 to 100; then the named GET route
`atcWorklist` reads the findings under `Accept: application/atc.worklist.v1+xml`. The variant
is the fence that matters: **the server hands a worklist id to any name** (measured: a
made-up variant got an id like the real one), so `ATC_VARIANTS` is a closed set -- SAP's `DEFAULT`
(`data/defaults/atc-variants.json`) plus the variants the installation lists, typically the
system's own `systemCheckVariant` read from `atc/customizing` (`npm run config -- atc add`) --
and nothing else reaches the socket. The body
is branded when built, so a hand-written body, even one carrying a valid URI, is refused
(`tests/guard.test.mjs`, "the ATC run is the second POST"). The tool is `adt_atc_run`, built
after the resource was measured live (measurement, steps 4-5: status, shape, timing, what stays
on the server).

**What stays on the server, measured.** A run leaves an ATC result worklist -- the thing the
ATC Result Browser lists -- and nothing else: no lock, no transport, no repository object
touched, no entry in the ATC verdicts feed (the feed is for stored central runs; 244-byte
envelope before and after). The worklist is check results about an object, written by the
ATC itself; this server writes nothing into it. The `SM12`/transport check after the runs is
the owner's, and recorded below when reported.

**What does not change.** The allowlist does not move (22 methods): `atcCustomizing`,
`atcCheckVariant`, `createAtcRun` and `atcWorklists` stay denied as library methods (the
guard test proves they throw); the POST goes through the raw transport like the data preview,
with every argument re-validated inside `lib/atc.mjs`. **Exemptions are governance writes**
(`atcExemptProposal`, `atcRequestExemption`, `atcChangeContact`) and are admitted by no path.
ABAP Unit stays with the IDE. The *report* frontier holds: the audit carries `variant +
object`, the worklist id and the byte counts -- never a finding text, never a check message;
the journal carries `ATC_NOT_RUN` (no run is not a clean object) and `ATC_RESULT_NOT_READ`
(a run whose findings were not read is not zero findings), never a finding. The findings
themselves are the tool's answer, as the ST22 entries are `adt_runtime_errors`'s.

**Measured, 2026-09-14 (measurement; the dossier has the shape).** Worklist POST
~350 ms; run POST 3.7-5.1 s on a 1-2 KLOC object, 515-byte reply with `FINDING_STATS`
"p1,p2,p3"; worklist GET 8-20 KB, the 406 names only `application/atc.worklist.v1+xml`.
Three objects, three variants' worth of counts (12, 8 and 6 findings) -- the counts in the run
reply and in the worklist agreed every time.

### Transport requests: both halves admitted, 2026-09-09 -- and the reason is measured

Alongside the closed decision above, and reached the opposite way. The question was whether
reading **customizing** requests crosses the "never the contents of a table" line, since a
customizing entry is by definition about table content.

It was not settled by reasoning. It was **measured** on 2026-09-09, on six requests of both
halves, and the hypothesis was falsified for the two resources this tool reads: a customizing
entry names a **table, view or view cluster and nothing finer**. `tm:obj_info` is the
description of the object TYPE ("Table contents", "View maintenance: data"), never a
value. The payloads are recorded in
[`adt-api-reference.md`](adt-api-reference.md#sapbcadtctstransportrequests--the-transport-organizer-measured-2026-09-09).
**That is why `adt_transport` ships**, and it is unchanged by what follows.

### `objectkeys`: measured, refused, overruled, built -- 2026-09-09

🔴 **The wider claim behind the decision above was wrong, and the correction is written here
rather than edited away.** It was stated as "the `E071K` key rows are not exposed by this
resource at all", and then repeated as though it were about the CTS. Eight independent
avenues had been closed to reach it -- media-type enumeration by 406 on both resources, a full
element and attribute census with no allowlist, zero text-carrying elements, a needle hunt for
`E071K`/`tabkey`/`as4pos`/`viewname`, and the absence of `E071K` from both Clean Core
catalogues. All eight readings were correct. **All eight measured the wrong resource.**

The CTS publishes a third one, and it publishes the path to it itself: the `tm:dummy_uri` in
every `tm:abap_object`, repaired with the `tr_number` its handler needs, returns a link named
`objectkeys`. Called with the one media type it accepts, it returns the key rows in full --
`tk:value` is `E071K-TABKEY`, `tk:position` is `AS4POS`, plus a `tk:keyField` block giving the
offsets that **decompose the packed key into its fields**. Verified field for field against an
export of `E071K` itself. The payload is in
[`adt-api-reference.md`](adt-api-reference.md#transportrequestsnumberobjectkeys--the-keys-are-exposed-measured-2026-09-09).

**That refusal was made, and then overridden the same day by the repository owner.** Both
halves belong on the record, because the second is a decision and not a discovery.

*The refusal, as argued:* a key row of a customizing entry is a row of a configuration table
-- `001BUPAGS_KNA1 … ZZ1_DEMODELIVERY_CUS … 0600` names a field configuration, not a table --
so serving it would cross the frontier at the top of this document by the same argument that
keeps `tableContents` and `runQuery` denied.

*The override, and why it is sound:* the requirement is to be able to read a transport in
full, with the concatenated key decoded against the DDIC definition of the view or table.
`E071K` is a table of the **CTS**, not of the business: a key row is the transport's own
record of WHICH rows moved, which is the question `adt_transport` exists to answer, and it is
not a `SELECT` against `AGR_TIMEB` or `TBZ3R`. The frontier that stays is the one that always
mattered -- this server still cannot read the CONTENTS of those rows, only their identity in
the transport. `tableContents` and `runQuery` remain denied and that is unaffected.

**State of play:**

- The resource is **fully measured** -- addressing, the template-versus-transported-key
  distinction, the complete vocabulary and a 164-key decode -- and the census is in
  [`adt-api-reference.md`](adt-api-reference.md#the-full-census-measured-2026-09-09-round-5-151-gets-over-6-requests-and-their-tasks).
- **The two questions that were held open have closed**, both by measurement, and neither
  needed a line of `lib/guard.mjs` to change: the non-character key types `I` and `b` exist
  on exactly two fields in the whole population and reach **no** transported key; and the
  DDIC cross-check ran through the client's own allowlisted DDIC readers and found the CTS
  layout to BE the DDIC's -- same fields, same order, same lengths, offsets cumulative,
  grounded a second time on the data elements.
- **The route is built**, and narrow by construction: `transportObjectKeys` in
  `lib/adt-get.mjs` takes one number-shaped path segment plus a `suffix` that is a literal
  of the route table, so the sub-resource name can never come from a caller; both query
  parameters are required. The decoder is `lib/object-keys.mjs`; the caller is
  `adt_transport({number, keys: true})`, which is **opt-in, detail-mode only, and budgeted**
  -- one ADT call per object, 25 by default, every object it did not reach reported by
  count. The audit trail gets **one line per ADT call**, naming the carrier and the object
  and never a decoded value.
- **A `400` is never reported as "this object has no keys."** The same status means "wrong
  carrier", and the resource does not distinguish them. The tool says *not resolvable for
  the carriers tried*, and the tests hold that sentence in place.
- **`objectkeys/checkruns` stays unprobed and unbuilt** regardless: a "checkrun" plausibly
  creates server state, and a GET that does that is a write.

### `enhancement/elements`: the route table widened by two, on request -- 2026-09-22

The closed table in `lib/adt-get.mjs` says in its own header that widening it is a security
decision and not a refactor. This is the record of one, made by the repository owner after the
measurement was in hand.

**The question it buys.** WHICH append structure extends an object. There is no other route to it:
an append is invisible in the base source by design, and `ddicElement` -- the only read that sees
append FIELDS -- marks them with anonymous `.append` separators and answers an empty tree for every
`TABL/DS`. So for a STRUCTURE nothing answered at all. That gap is not academic:
`KOMG` includes `KOMPAZ`, whose source carries one field (`PDUMMY`) and whose real content is the
customer append `ZDEMO_KOMPAZ` (`ZZDEMOFLD`). A field list that misses it is a field list that says a
customer field does not exist.

**Why it passes the header's own two rules.**

- *GET with no side effect.* It creates no run, no worklist and no lock; it enumerates objects that
  already exist. Contrast the ATC route, which had to be argued precisely because its GET creates a
  worklist.
- *The path is not invented.* The server publishes it itself, as an `atom:link` with
  `rel="http://www.sap.com/adt/relations/enhancements"` on the object's own `objectStructure` --
  the same provenance that `objectkeys` established as acceptable when a resource is absent from
  the discovery document.

**Why two routes and not one.** `/sap/bc/adt/ddic/tables` and `/sap/bc/adt/ddic/structures` are
different resources. One route with a caller-chosen collection would be a caller assembling a path,
which is the single thing this table exists to refuse. Two templates cost two entries and keep the
property.

**What did NOT change.** `httpClient` stays in the guard's DENIED list; the allowlist stays at 22
methods; the routes declare `params: []`, so they take a subject and no question. The segment
alphabet is the one the function-group route already proved (`%2f` admitted only as the namespace
wrapper), so `..`, a bare `/` and a second segment are refused before a socket opens --
`tests/adt-get.test.mjs` asserts each of those refusals.

**What is still not known, and is written into the caller rather than assumed.** Absence of the
published link does not prove absence of an append. Both negative controls answered that way and
both are `#NOT_EXTENSIBLE`, so the two conditions are confounded; an extensible object with zero
appends was never probed. The tool therefore reports *nothing to enumerate*, never *there is no
append*.

### `ddl/dependencies/graphdata`: the route table widened by one, on request -- 2026-10-14

Made by the repository owner, with the measurement in hand: an Eclipse ADT 3.60 communication log of
`GET /sap/bc/adt/ddic/ddl/dependencies/graphdata?ddlsourceName=ZC_DEMOSTOCK&addMetrics=true`, 200,
`application/vnd.sap.adt.ddl.SQLDependencyModel.v3+xml`, 8.8 s (6.9 s server).

**The question it buys.** Which tables a CDS view reads, as the SYSTEM resolves it -- the independent
reference the source parser of `scan:odp-gap` (`lib/cds-lineage.mjs`) is checked against, and the only
answer for a view whose lineage the parser cannot follow (a table function on the path).

**Why it passes the header's two rules.** GET with no side effect (the Dependency Analyzer of ADT reads
the activated runtime; nothing is created or locked), and the path is not invented: it is in this
system's own discovery document (`docs/adt-api-reference.md:56`). The route declares two query
parameters (`ddlsourceName`, `addMetrics`) and no segment.

**What it costs, and the limit written into the caller.** Seconds of server time per call. It is never
swept over the census: `scan:odp-gap` asks it only for the top candidates of each table and the views
the parser could not follow, at concurrency 2, capped by `--graph-max`, and caches every answer.

**What did NOT change.** `httpClient` stays denied; the allowlist of client methods does not grow; no
MCP tool exposes the route -- only the script uses it.

**Removed, 2026-11-08.** The catalogue scripts left the repository (they are not part of the MCP
server), and with them this route and the `functionGroupStructure` route they alone used, the `>=`/`<`
operators of the data-preview grammar and its 5,000-row cap for scripts. The route table is narrower
than anything recorded above; this section stays as the record of why the route once existed.

### The version feed: a link the server published, read under its object -- 2026-09-12

The third mode of `adt_transport`, `object: {name, type}`, answers the reverse question --
which requests carried this object -- from the object's **version feed**, measured on
2026-09-10 and recorded in
[`adt-api-reference.md`](adt-api-reference.md#object-version-history--the-reverse-lookup--measured-2026-09-10).
Version history is written when a request is **released**; reading it creates nothing.
Three boundaries are held, each by construction and each with a test:

- **The path is never assembled.** The feed's location depends on the object type (a class
  publishes five, a program one, a domain another one), so the href is taken from the
  `atom:link rel=…/relations/versions` that `objectStructure` itself returned. That makes it
  the first route whose URL is not a literal of the route table -- and the reason the seam
  gained a second, narrower kind of GET, `derivedGet` in `lib/adt-get.mjs`: it accepts only
  a link that resolves **under the object URI already resolved through the guarded client**,
  ends in the literal `/versions`, carries no query, fragment, `..`, `//` or encoded slash,
  and is sent as GET with the one `Accept` the resource takes. `TEMPLATES` did not grow, and
  the library's `revisions()` -- which labels the transport as the version and never reads
  the copies flag -- is **not** in the allowlist.
- **The content of an old version is not read.** Every entry carries
  `atom:content/@src`, the URI of *that version's source*. It is a real capability and a
  different question; `derivedGet` refuses any href past `/versions`, so this server reports
  the version **header** (number, timestamp, author, transport, the server's own
  `isTestTransport`) and stops.
- **The feed names third parties, and the audit trail does not.** `atom:author` is whoever
  wrote each version and `atom:title` is the transport's free-text description; both are
  carried in the answer, because they are the answer. The audit trail gets **one line per
  feed**, naming the object and the href, never a title.

Two lessons are worth keeping, because both cost a full round to learn. **Closing eight
avenues is not a proof when a ninth is unenumerated** -- the count of falsified hypotheses says
nothing about the size of the space. And **two different error messages to the same malformed
call are a signal**: `objectkeys` answers `400 I::000` to an unknown parameterisation while a
genuinely absent path answers *"Resource controller does not support method GET"*, and reading
the first as a dead end is what delayed this by two rounds.

### The monitoring feeds: ST22 dumps and the gateway log, read as the Feed Reader reads them -- 2026-09-12

`adt_runtime_errors` reads what the Eclipse *Feed Reader* shows: the catalogue
`/sap/bc/adt/feeds`, the runtime-error feed `/sap/bc/adt/runtime/dumps` and the gateway error
log `/sap/bc/adt/gw/errorlog` -- measured and recorded in
[`adt-api-reference.md`](adt-api-reference.md#sapbcadtfeeds--the-self-describing-catalogue-of-the-feed-reader--measured-2026-09-12).
Three named GET routes, allowlist unchanged (the library's `feeds()`/`dumps()` are **not**
admitted: `dumps()` takes the `$query` as free text). What holds:

- **The hrefs are the catalogue's, the `$query` is generated.** The two feed routes carry the
  hrefs the catalogue publishes -- neither is a discovery collection, so this is the only
  place they are named. A filter is `{attribute, op, value}`: the attribute must be one of the
  ids the catalogue declares for that feed, the operator one of its one-operand operators,
  the value drawn from a closed alphabet; `lib/runtime-feeds.mjs` writes the prefix form the
  catalogue's own variants use (`and ( equals ( user , X ) )`), and the route regex in
  `lib/adt-get.mjs` refuses anything else -- the OData-looking infix form is 400 on the
  server and refused here before the socket. Paging is `$top`/`$skip` (measured; `maxResults`
  is ignored by the server and refused by the route). **At most two clauses, in the comma
  form.** A probe sent two clauses side by side inside the `and` and the server
  **dumped** (`ASSERTION_FAILED` in `CL_ADT_FQL_QUERY`) -- a dump this client
  caused, on a development system, with a GET. It is recorded in the dossier as the measurement it
  is, and it is why the generator writes only the form the catalogue itself publishes,
  `and ( c1 , c2 )`, and the route regexes admit nothing else: a read-only client can still
  make the other side fail, and the grammar of a query is measured one form at a time, with
  the ST22 checked afterwards. The one-clause form filtered on 7 of 7 attributes; the comma
  form was proved to filter on 2026-09-14 (33 entries with one clause, 9 with a `notContains`
  added, 6 with a `datetime` bound, no dump) and `MAX_CLAUSES` became 2 that day. Three is
  unmeasured and refused.
- **The detail resource is followed, and only it.** The entry's links are `adt://` URIs; the
  `self` one has an HTTP twin, `/sap/bc/adt/runtime/dump/<key>` (measured in measurement), read
  through two `derivedGet` kinds: `runtimeDump` (the URI itself, the dump.v1+xml with links and
  the chapter index) and `runtimeDumpText` (`<key>/formatted`, the whole ST22 report as text --
  the only place the **chosen variables** are readable, and read only on `full: true`). The
  `unformatted`, `summary` and `http` links the resource publishes are not followed. Variable
  values reach the answer and nothing else: the audit line for a detail is the reduced key plus
  `resource` or `formatted`.
- **The ATC verdicts feed is a third feed** (`atc`), read the same way, envelope measured and
  entries not (the feed answered none). It is the read half of the open ATC decision: no run is
  started, no worklist created; `atc/worklists` and `atc/runs` stay outside the routes.
- **The feed names third parties, and the audit trail does not.** A dump entry names the user
  who caused it (`user`, `userFullName`) and the object responsible; the report carries the
  source extract and the call stack. All of that is the answer, and the answer is where it
  stays: the audit line carries the feed, the page (`dumps top=50 skip=0 filtered`) and, for a
  detail, the dump key **without the user in it** (timestamp+host and sequence,
  `auditKeyOf`); a `DUMP_NOT_READ` gap carries the same reduced key. A filter value is not
  written to the audit either -- it is, typically, a user id.
- **The gateway log is measured as an envelope only.** It was empty for the reading user on
  2026-09-12; its entries are returned generic (every element listed) and flagged
  `entriesMeasured: false`, so a caller can see the shape has not been measured rather than
  trust a parser that never saw one.

`FEED_NOT_READ` is filed when a feed cannot be read (a failed read is **not** an empty log),
`SHAPE_DRIFT` when the measured shape has aged; a `RouteViolation` files nothing, because it
never reached the network.

The same day `derivedGet` gained a second **kind**, closed in `DERIVED_KINDS`: `enhoxhb`
reads a BAdI implementation's own URI -- the one the quick search resolved -- with the one
Accept the resource answers, because its spot, BAdI definition and implementing class are in
the body and nowhere in `objectStructure` (measured). The rule for that kind is the whole
rule: the href must **be** the object URI, the URI must be of that resource
(`/sap/bc/adt/enhancements/enhoxhb/<one segment>`), nothing appended, nothing relative. A
class URI, an `enhoxh` URI, a query string or a `/versions` suffix are refused before the
transport; the test enumerates them. The package ancestry `adt_object_info` answers for a
`DEVC/K` is one allow-listed call (`findObjectPath`), no new route.

The reply shape of every route in that table was **measured on the system on 2026-09-09** and is
recorded in `docs/adt-api-reference.md`, so `adt_annotation_chain` and `adt_transport` parse
rather than guess. The refusal machinery
stays wired underneath: an unmeasured route, or a reply that does not match the measured shape,
returns the payload verbatim with a warning and files a `SHAPE_UNOBSERVED` gap rather than
reporting "no annotations" — because a shape this parser cannot read and an element that
carries nothing must never render the same.

The fifth route, `quickSearch` (2026-09-12), is the one GET the library already makes -- the
repository quick search -- asked once more with the facet the library strips. It adds no
resource the client did not already reach; what it adds is a `fixed` parameter
(`operation=quickSearch`, part of the route's identity, refused if a caller names it) and a
`validate` map: the facet must be `<major>/<sub>` in uppercase, the cap one to three digits,
the query a name with at most a trailing wildcard. A leading wildcard is refused on purpose:
the route resolves a name the library could not, it does not enumerate. Its reply carries no
description (measured), and the audit line names the object and the facet, as every route does.

The sixth route, `objectProperties` (2026-09-14), reads the repository properties of **one
object by its URI** -- `/sap/bc/adt/repository/informationsystem/objectproperties/values?uri=…`
with the single Accept the 406 named. It exists for one type: a class / interface enhancement
(`ENHO/XH`), whose own resource dumps the server and whose structure this client therefore never
asks. The `uri` is validated as an absolute ADT object URI and nothing else (no query, no
fragment, no dot-segment, no empty segment; `%2f` inside a segment stays allowed for namespaced
names), so the route cannot be pointed at another resource. The reply carries the object's
**owner** -- it is part of the answer, as the transport's authors are, and it never reaches the
audit line (which names the object and `#properties`) or the journal.

`npm test` proves this offline (569 tests on 2026-09-14; `npm run test:guard` is the 52 of them that cover the guard and the named routes, and runs in a fraction of the time): thirteen write paths throw, no blocked call
reaches the client, the four escape hatches throw, a method invented at test time is unreachable
by default, and the proxy still survives `await`, `util.inspect` and `delete`. No SAP system and
no credentials are needed to run it.

### A 500 costs one more read: the dump that explains it -- 2026-09-14

On every measurement so far a 500 from the ADT was a runtime error on the system, and the
library's sentence for it (*Request failed with status code 500*) is useless to the person
and to the improvement backlog alike. So the journal wrapper reads, after a 500, the newest
ST22 entry of **the session's own user** through the measured dump feed -- one clause, the
fewest the grammar takes -- and attaches the runtime error, the program and the
ST22 key to the error and to a `SERVER_DUMPED` line. What this does NOT change: the read is
the same named GET route as `adt_runtime_errors` (no new route, no new allowlist entry); the
audit line is `dump after 500` with the byte count; the journal gets the key with the user
stripped, never the title, never a variable; a dump older than the failed call is not
attached, because it is someone else's; and the original error stands whatever the feed
answers. Module: `lib/dump-after-500.mjs`, test `tests/dump-after-500.test.mjs`.

### The Fiori launchpad -- 2026-10-02

The repository owner asked for the Fiori launchpad content of the system (catalogs, tiles, target
mappings, groups, spaces, pages, semantic objects). It has no ADT collection, so this is the one
place the route table leaves `/sap/bc/adt` -- for **SAP-standard** services only (the /UI2 OData
services of the launchpad). The header of `lib/adt-get.mjs` says why that needed a decision: the
authority of a path was, until then, the discovery document alone.

**This server calls no customer (Z) service** -- with one later exception, its `$metadata` only
(see *The $metadata of a service a Fiori app consumes -- 2026-11-09* below). An earlier version also read PFCG roles and classic
screen element lists through custom HTTP services; both were removed with the services. What remains
about roles is `roleCatalogs` -- the catalogs FDM resolves for one role, a SAP-standard entity set.

**Two authorities, each enforced at import.** `routeAuthority()` classifies a path, and
`assertRouteTable()` -- called when the module loads -- refuses any route under neither, a gateway
route that does not fix `$format=json`, and an OData key on a route that is not gateway.

| Authority | What qualifies | Where it is listed |
|---|---|---|
| `adt` | a collection of `/sap/bc/adt/discovery` | the discovery document (every route before this date) |
| `gateway` | ONE entity set, or ONE key of it, of an OData V2 service registered in the Gateway catalogue (`/IWFND/CATALOGSERVICE`) | `ODATA_ROOTS`, four roots measured 200 on the development system |

**`ODATA_ROOTS`, and why each neighbour is out.** Admitted: `UI2/PAGE_BUILDER_CONF` (cross-client
catalogs), `UI2/PAGE_BUILDER_CUST` (client catalogs and groups), `UI2/FDM_PAGE_REPOSITORY_CUST_SRV`
and `UI2/FDM_SPACE_REPOSITORY_CUST_SRV` (pages and spaces). Refused, each for its own reason:

- `UI2/PAGE_BUILDER_PERS` -- it holds the personalization of each user. A person's data, not
  content.
- `UI2/FDM_SPACE_REPOSITORY_SRV` -- not registered on this system (403); a route to it would be a
  path nobody measured.
- `$batch`, `$metadata`, the service document and every function import -- `$batch` carries many
  requests, of any verb, inside one POST-shaped envelope; the route table names resources, not
  envelopes. A path with more than one segment after the root is under no authority.
- Every route fixes its own `$select`, `$expand` and `$filter`; the caller sets only the key and,
  on `fdmPages`, `$top` (1..50) and `$skip`. No `$select` names `createdBy`, `modifiedBy` or a
  `*Fullname` field -- FDM carries all three, and `tests/adt-get.test.mjs` asserts their absence.
- `fdmPages` reads 50 at a time because the whole list answers a `sap-message` header of about
  63 KB, past the 16 KB header limit of Node -- a read that fails by size, not by permission.

**The 24 entries in the gateway error log, and the rule that comes from them.** The exploratory
probe read every entity set the FDM service documents list. Four of them
(`spaceActionSet`, `displayOptionSet`, `vizOptionSet`, `vizReferenceHierarchySet`) answered 501 and
left entries in `/IWFND/ERROR_LOG` (a frontend and often a backend entry per call); the other two
are a `$select` naming a property that does not exist (`layoutId`: 404, *Resource not found for the
segment*) and the unregistered `FDM_SPACE_REPOSITORY_SRV` -- all on a development system, from GETs,
read back with `adt_runtime_errors`. The acceptance run of the routes as built added none. Same
lesson as the FQL dump above: a read-only client can still make the other side record a failure. Rule:
**never a generic GET over the entity sets of a service.** A set enters the table by name, after a
single measured read, and a set that answered 501 does not enter at all.

**The closed list of what never leaves SAP through this server:** every PFCG table (no route reads
`AGR_*`); the person fields of FDM (`createdBy`, `modifiedBy`, `*Fullname`, stripped from every body
by `lib/launchpad.mjs`); everything under `PAGE_BUILDER_PERS`.

**What did NOT change.** `httpClient` stays in the guard's DENIED list; every route is still a named
GET with a frozen request; the MCP still writes no repository (see *What is written to disk*).

### The $metadata of a service a Fiori app consumes -- 2026-11-09

The repository owner asked `adt_contract_check` to read the Fiori consumers of a service. That
means checking whether a deployed app still addresses names its service publishes. Two routes
were measured, and one exception to the rule above was granted on purpose.

**The UI5 repository is ADT (authority `adt`).** `ui5Folder` and `ui5File` read
`/sap/bc/adt/filestore/ui5-bsp/objects/<APP>[%2F<path>]/content`, a collection of the discovery
document. The path inside the app is **one** segment, with its slashes encoded. The alphabet is
upper-case BSP name plus `[A-Za-z0-9_.@-]` parts, at most eight levels deep, with no `..` and no
empty part. The literal-slash form is a bare 404 and is never built. Neither route reads the
whole app list (2,863 apps, 1.4 MB, and every filter parameter is ignored). The caller names the
apps, at most ten per call.

**The exception: the `$metadata` of a customer (Z) service (authority `metadata`).** Until now
this server called no customer service. The owner's reasoning, recorded here:

- The `$metadata` an app keeps in its repository (`localService/`) is a scaffold copy. Nothing
  refreshes it and the app never loads it, so it is not a source.
- The live document is the only one that says whether the app's controllers, annotations and
  bindings still hold. It is equally useful for checking code written on the backend side.

What is admitted, and nothing more:

| Route | Path | Measured |
|---|---|---|
| `odataMetadata` | `/sap/opu/odata/sap/<SERVICE>/$metadata` (V2) | yes, 2026-11-09: 200, 92 KB, `application/xml` |
| `odataMetadataV4` | `/sap/opu/odata4/sap/<binding>/<srvd group>/sap/<srvd>/<nnnn>/$metadata` (V4), the group `srvd` or `srvd_a2x` | yes, 2026-11-09: 200 on three apps, 14-211 KB, `application/xml` |

`assertRouteTable()` enforces the shape at import. A route under `metadata` must declare the service
as its segment and the literal `/$metadata` as its suffix, with no query parameter and no fixed
parameter. `routeAuthority()` admits the bare V2 and V4 roots and nothing below them, so an entity
set, the service document, `$batch` or a function import of a customer service is under **no**
authority. A V4 segment is several real path segments (`pathParts`), each from a closed alphabet
and in a fixed count, so it cannot add a part.

What `$metadata` carries: entity sets, types, property names, operations and their parameters,
annotations. No row and no field value. It is the document every Fiori app downloads on start-up,
for every user it has.

### Self-contained: every source is read from the system -- 2026-11-08

The repository owner asked for a server with **no dependency on anything else on the machine**:
no sibling repository, not even optionally, no IDE file, no local copy of SAP content. What
changed, and why each step holds:

**Package scans read the system, not a checkout.** `adt_clean_core_scan` and
`adt_annotation_scan` used to parse the abapGit checkouts next to this repository; they now take
a `package`, list it with `nodeContents` and read each DDLS/DDLX with `getObjectSource` --
both already on the allowlist, so **the guard did not grow** (`lib/package-sources.mjs`). The
cost is real -- one read per object -- so it is capped (default 100, at most 300), counted
against the read budget, reported as progress and stopped by cancellation, and every object not
read is a `SOURCE_NOT_READ` gap (`SCAN_AT_CAP` for the cap): a scan that read less than the
package holds says `complete: false`, because fewer sources always read as cleaner. What was
gained: an upstream **standard** view is now read on demand, so a hide written in it is seen --
no checkout could ever show that. The journal's census rule follows: a row is retired only by a
later **complete, unnarrowed scan of the same package** (`lib/report.mjs`, `censusOf`).

**`adt_value_help` reads its evidence from the system.** Which fields are already bound comes
from the entity's own source (one read); a binding precedent comes, opt-in, from another
consumer found by where-used; exposure is checked against the service definitions the
where-used names (at most three read). The precedent scan of the checkouts and the folder of
exported standard sources are gone.

**The ABAP Keyword Documentation mirror is gone.** It was a per-key fallback behind the
system's DDLA. The DDLA is the system's own, exact for its release (31 of 31 roots, 1,027 keys
measured); a documentation copy describes one release, possibly not this one. When the DDLA
cannot be read, the emitted annotation says NOT VALIDATED -- never "validated" against another
release's documentation. The test fixture is a DDLA text proven equivalent, key by key, to the
mirror rows it replaced.

**The IDE destination file is no longer read.** `host`, `client` and `user` come from the
environment store only; without them the server stops and names the command. One source of
configuration, written by one CLI, validated one way.

**The Clean Core catalogue left the repository.** It was vendored (7 MB) and refreshed from a
sibling clone. It now lives in the state directory, downloaded by `npm run sync:catalog` from
SAP's repository: the commit of `main` is resolved first and both files are fetched **at that
commit** from `raw.githubusercontent.com` (the source the ATC Cloud Readiness check itself
uses), validated (shape, `formatVersion`, rows), and swapped in by rename with the previous
copy kept. `PROVENANCE.json` records release, commit, sha256 of the bytes, rows and date (the
old canonical hash, which hashed only the top level of the document, is gone with it). The
**server never downloads**: the catalogue is release data, and refreshing it is a decision taken
monthly with `sync:catalog`, never a side effect of a question. Querying the catalogue live per
answer was considered and refused -- every answer would then depend on internet access and on
GitHub, and stop being reproducible. SAP's viewer (`sap.github.io/abap-atc-cr-cv-s4hc`) is a
client-side page over the same files; it is linked in answers for people and never queried.
Without a catalogue, the two tools refuse and file `CATALOG_MISSING` -- a missing release gate is
never read as "released". `catalog.release` selects the file (`Latest`, `PCELatest`, a
specific release); the network read is the only one this project makes outside the SAP system,
and it happens only when a person runs the script.

**`adt_contract_check` lost its consumers, for now.** The provider side is read from the
system (the SRVD, one call). The consumer side -- Fiori apps -- will be read from the system's
UI5 repository, through a route that does not exist yet: a route enters the table only after its
reply was read on the system (*Probes* below). Until then the answer says the consumers were
**not read** and never calls an alias unused. CPI integrations live in SAP BTP, another system
with another credential, and are out of this server's scope.

**`adt_atc_run` runs up to three variants.** Each variant is a separate worklist on the
server, created and read exactly as one run was; the set stays closed (`DEFAULT` plus the
variants the installation lists), and a variant that fails is reported as not run, never clean.

**MCP hardening.** `Host` and `Origin` are checked before the token (DNS-rebinding protection,
which the Streamable HTTP transport specification requires of a local server); tool definitions
carry titles and behaviour annotations; input schemas are closed and enforced; answers carry
`structuredContent`; long calls report progress and honour cancellation; `initialize` carries
`instructions`. Pinned by `tests/mcp-protocol.test.mjs`, which drives the server with the SDK's
own client over a real loopback connection.

## What is written to disk

Everything lives in `%LOCALAPPDATA%\sap-adt\`, and the server **refuses to start** if that
path resolves inside a git work tree:

| File | Contents | Sensitivity |
|---|---|---|
| `sap-adt.db` | the environment store (SQLite): host, port, client, user, language, the catalogue release, the installation's customer tables and ATC variants. Written only by `npm run config` | user name only, no password; no SAP data |
| `catalog/` (and `catalog.prev/`) | SAP's Clean Core catalogue -- one release file, `objectClassifications_SAP.json`, `PROVENANCE.json` -- written only by `npm run sync:catalog` | public SAP data (Apache-2.0); no system data |
| `token` | 32 random bytes, hex, mode 0600 | guards the local MCP port; **not** a SAP credential |
| `audit.log` | one JSON line per call: timestamp, run id, tool, target object, result size — plus one `start`/`stop` pair per process (pid, host, client, user, machine, and how it stopped) | no payload, ever |
| `measurements/<topic>-<day>/` | transcripts of the probes and measuring scripts (`scripts/measure-*.mjs`, `scripts/probes/*.mjs`): raw ADT replies, whole bodies, so a truncated terminal never loses a reading | **SAP data** — DDLA definitions, version feeds, transport documents; may name third parties. Never inside a git work tree, by construction (`stateDir()`) |

**There is no response cache, and that is a property rather than an omission.** An earlier
version of this table listed a `cache/` directory — "responses keyed by URI + etag, may contain
SAP source". Nothing in `lib/`, `tools/`, `scripts/` or `server.mjs` has ever written one: a
reply lives in memory for the length of one call and is gone (the annotation-scan index of one
package is kept in memory for ten minutes, never on disk). The entries above are the whole of
what this server writes outside the repository. The `cache/` line in `.gitignore`
stays as a guard against that changing by accident — it describes nothing that exists, and it
is not evidence that it does.

One artefact deliberately lives **inside the repository** instead, git-ignored:

| Path | Contents | Why it may sit here |
|---|---|---|
| `logs/{calls,findings,gaps}/<day>.jsonl` | analysis metadata: tool name, object names, registered codes, counters, timings | a different class of artefact — no credential, no SAP source, no payload. That is enforced by a **field allowlist** in `lib/journal.mjs` (anything not listed is dropped, nested maps hold primitives only, content-named keys are refused whatever they hold), not by promise, and `tests/journal.test.mjs` asserts both the allowlist and the `.gitignore` entry |

The two are not interchangeable. `audit.log` is the security trail this document promises and
stays outside any git work tree; `logs/` is the analytical journal that makes quality measurable
(`npm run report`). `npm run logs:prune` bounds both — deleting whole journal days, and
rewriting `audit.log` line by line, keeping every line it cannot date.

### The trail says the server ran, not what it read — 2026-09-23

Two additions, and the line between them and *payload* is where the reasoning is.

**A run id on every line.** The journal already carried one; the trail carried nothing
equivalent, so a line could not be attributed to an execution. It answered *what* and *when*
and not *in which run* — which is the question somebody investigating actually asks, and the
one that cannot be answered by reading harder. The id is random, memoised per process
(`runId()` in `lib/config.mjs`), and says exactly one thing: two lines came from the same
process. Not who, not where, not what.

**A `start`/`stop` pair per process.** That the server ran, and how it stopped, is *evidence*;
what it read is what would be *content*, and none of that is in these lines. Before them, a
restart could only be inferred from the read counter falling back to 1 — an inference that is
wrong whenever two processes append to the same file (measured: a server and a `propose:table`
run interleaving), and blind to a process that started and read nothing. `stop` carries
`reason` (the signal, or `uncaughtException`) and `clean`, which says whether the system logout
answered. **`clean: false` is not an incident**: the ADT session is stateless, so what stays
behind is an idle session SAP expires by itself, never a lock.

`npm run report -- --runs` reads these back. It is **opt-in** because it crosses from analysis
into evidence, and the crossing is one module (`lib/audit-runs.mjs`) that reads the run lines
and counts reads — it never looks at what a call line targeted.

**The shutdown that made the pair worth having.** `Ctrl+C` used to await a logout with no
deadline and then `httpServer.close()`, which waits for keep-alive connections an MCP client
has no reason to release. With the system unreachable, neither ever returned: the terminal looked
hung, and the way out — closing the window — leaked the very session the shutdown was trying to
drop. It now closes the listener first, drains what is in flight, says goodbye within
`shutdownMs` (5 s), then cuts the remaining sockets. What the deadline leaves behind is stated
above and printed to the operator, so that "logout not confirmed" does not send anyone looking
for a lock.

One decision recorded so it is not reopened: **`budget.reads` is a notice and stays one.**
`lib/audit.mjs` counts a read *after* it returns — it is a ledger, not a gate, and cannot
refuse a call that already went out. A `budget.enforce` flag was drafted and dropped for that
reason: it would have been the same overstatement in a new place. A real cap belongs before the
route and would change what this server promises, which makes it a decision for this document
rather than a setting in the environment store.

A journal that cannot write is itself a security-relevant failure, because from that moment an
empty report is indistinguishable from a clean one. `lib/journal.mjs` therefore warns once per
process on stderr and counts what it dropped, and the package scans report the objects they could
not read (`SOURCE_NOT_READ`) instead of skipping them — a skipped path always biases a count
towards *cleaner*. `tests/no-silent-errors.test.mjs` holds both properties structurally: every
registered code must have an emitter, and every error-discarding `catch` must be on a short list
with a reason.

The audit log records *that* a class was read, never *what* it said. Source that is read lives
in memory for one call (see above: there is no cache), and `adt_read_source` output is never
committed automatically anywhere.

### Probes: measured on the system, transcribed, deleted

A route is built only after the reply it depends on has been read on this system, and that
reading is done by a **temporary probe** — a script that logs on, issues a handful of GETs
through the same guard and transport seam as the server, writes the whole reply to
`measurements/` and prints a verdict. The probe is never the record: its findings are
transcribed into [`adt-api-reference.md`](adt-api-reference.md) with the date, and the file is
deleted.

Since 2026-09-11 every probe is born in **`scripts/probes/`**, which is git-ignored
(`/scripts/probes/` in `.gitignore`, asserted by `tests/journal.test.mjs` the same way `logs/`
is). The rule used to depend on remembering to delete the file before committing; one probe
was once committed by accident (and removed the next commit), and a folder the tree refuses
to track is the version of the rule that does not need remembering. Two things stay outside
the folder on purpose: `scripts/probe.mjs`, the permanent phase-0 probe that needs **no
credential** (`npm run probe`), and `scripts/measure-*.mjs`, which are repeatable
measurements with a fixed output and their own tests. A probe carries no secret — the
password is prompted by `loadConfig`/`connect` like everywhere else — but it is still
measurement, not code, and does not belong in the history.

## The MCP port

`127.0.0.1:2237` only. Every request must name this endpoint in `Host` (`127.0.0.1`,
`localhost` or `[::1]`, on this port) and, when a browser sends `Origin`, a loopback origin --
the DNS-rebinding protection the MCP transport specification requires; anything else is a
`403` before the token is looked at (`lib/mcp-server.mjs`, `hostFailure`). Then every request
must carry `Authorization: Bearer <token>`, compared with `crypto.timingSafeEqual` in
`lib/auth.mjs`.

A 401 from this server **never** carries `WWW-Authenticate: Bearer`. Under the MCP spec that
header declares OAuth 2.0 support, so a client answers it by running authorization-server
discovery and Dynamic Client Registration, and the operator sees
`Dynamic Client Registration rejected (HTTP 404)` — an OAuth error for what is really a
static-token problem. This server implements no OAuth and must not claim otherwise. The 401
instead states the reason (`no Authorization header`, `token does not match`, `the shell did
not expand the token`), which is also logged on the server console; the expected token is
never included in either. Pinned by `tests/auth.test.mjs`. The token guards a local port against other processes on the
machine; it grants read access to SAP through an already-authenticated session, so it is
worth protecting, but it is not itself a SAP secret and rotating it costs one file deletion
and one `claude mcp add`.

This server never reads or writes the tokens or ports of SAP's own ADT MCP servers
(`2234` Eclipse, `2236` VS Code).

Each request gets a fresh `Server` + `StreamableHTTPServerTransport`. That is a
correctness requirement, not style: a transport accepts exactly one `initialize`, so a
shared instance serves the first client and then answers every reconnect with HTTP 500 and
an empty body. The ADT session and the tools are shared; only the protocol plumbing is
per-request. Pinned by `tests/transport.test.mjs`.

## TLS

`allowUnauthorizedTls` defaults to `false`: the certificate of the SAP system is verified. An
installation whose system presents a certificate that does not chain to the local trust store (an
internal CA) has two ways out, in order of preference:

1. **Trust the CA**: `NODE_EXTRA_CA_CERTS=<ca.pem>` in the environment of the server. Verification
   stays on.
2. **Opt out**: `npm run config -- set allowUnauthorizedTls true`. This disables certificate
   verification and therefore accepts a man-in-the-middle on that connection. It is tolerable only
   for a fixed host inside a trusted network, taken from the ADT project the IDE already created,
   over a link that already carries the same credential from the IDE itself -- never for an
   arbitrary host.

## Third-party code

Two runtime dependencies, both pinned to exact versions with a committed lockfile, installed
with `npm ci --ignore-scripts` so no lifecycle script from the dependency tree executes:

- `abap-adt-api` (MIT) — session, CSRF, URI resolution and XML parsing. It is confined behind
  the guard proxy: the rest of the code cannot reach a method the guard denies.
- `@modelcontextprotocol/sdk` — MCP transport and tool registration.

There is no CI in this repository, by decision: third-party code is not run unattended in a
hosted runner. `npm run test:guard` is meant to
be run locally before use.

### CVE triage, 2026-09-04 — `qs` (CVE-2026-82417, CVE-2026-82562)

A scanner in the IDE flagged both CVEs on the `@modelcontextprotocol/sdk` card. **Neither is a
vulnerability in the SDK.** Both are in `qs`, reached transitively:

```
@modelcontextprotocol/sdk@1.30.0 -> express@5.2.1 -> qs   (also via body-parser@2.3.0)
```

| | CVE-2026-82417 | CVE-2026-82562 |
|---|---|---|
| Component | `ljharb/qs` | `ljharb/qs` |
| Affected | 2.2.5 – 6.15.3 | 6.14.2 – 6.15.3 |
| Fixed in | **6.16.0** | **6.16.0** |
| CVSS v4.0 | 6.3 medium | 6.3 medium |
| Impact | DoS: `TypeError` in `stringify` on a truthy non-callable `isBuffer` | `arrayLimit` bypass with `comma: true` + `throwOnLimitExceeded: true` |

**Resolved version installed here: `qs@6.16.0`** — the fixed one, in `package-lock.json` and on
disk. `npm audit` reports 0 vulnerabilities across 123 packages, and 1.30.0 is the newest SDK
published, so there is nothing to upgrade to.

The alert is a false positive of range analysis: `express` declares `qs: ^6.14.0`, a range that
*permits* the vulnerable 6.14.2–6.15.3, and the scanner reads the declared range rather than the
resolved lockfile. **The lockfile is the control** — which is why the install command is
`npm ci --ignore-scripts` (honours the lockfile) and not `npm install`.

Belt and braces: `package.json` carries `"overrides": { "qs": ">=6.16.0" }`. npm does not write it
into the lockfile because it changes no resolution today, but it is applied on any future
resolution. Verified after a clean `rm -rf node_modules && npm ci --ignore-scripts`: `qs 6.16.0`,
guard tests 5/5 — that being the size of the guard suite **on 2026-09-04**, not today's. The
number is left as measured rather than refreshed, because the line records one dated
verification, not a running total.

Sources: [NVD CVE-2026-82417](https://nvd.nist.gov/vuln/detail/CVE-2026-82417) ·
[NVD CVE-2026-82562](https://nvd.nist.gov/vuln/detail/CVE-2026-82562).

## Scope limits that are also safety limits

- The tools read the **object catalogue** — repository objects and DDIC metadata — not
  business data. Reading metadata and reading data are different things: a data element,
  a CDS annotation or a field list is not personal data, and the data-protection bar does
  not apply to them. There is still no SQL tool, and adding one would be a separate
  decision, because a query result must never be written inside a git repository.
  (An earlier version of this file argued the SQL point by claiming that "in a Private
  Cloud landscape the development system is often a copy of production". That is not true
  everywhere, and it was never measured here — removed rather than kept as a convenient
  argument.)
- **This server is meant for a development system.** It reads what a developer reads; pointing
  it at a quality or production system is outside its design, and nothing in it is tuned for
  the load or the data of one.
- `adt_where_used` refuses SAP standard objects unless `allowStandard: true` is passed — that
  search is the most expensive call this server can make against the SAP system.
- A read budget (200 calls per session by default) warns when crossed.

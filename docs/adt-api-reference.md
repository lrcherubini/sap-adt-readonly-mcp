# The ADT REST API, as this system documents it

SAP publishes no endpoint reference for ADT. Asked directly, the answer is to read the
service document the system itself serves at **`/sap/bc/adt/discovery`** — and community
threads say the same: the full list of endpoints, parameters and response shapes is not
documented publicly. So this file exists to stop the same thing being guessed twice.

It records, in this order of authority:

1. **The service document of this system** (a development system on S/4HANA 2023, kernel 7.58)
   — collections and their URI templates, with parameter names. Machine-readable, and
   correct for this release by construction.
2. **The typings and JSDoc of `abap-adt-api@8.4.3`** — what the *client* sends and the
   shape it parses back. It is a **subset** of the API, which matters below.
3. **Measurement**, recorded with the value observed and the date.
4. Community and blog material — used to learn that a parameter exists, never to
   conclude what it does.

Measured. Reproduce the collection listing with `adtDiscovery()`; the readings
below came from the temporary probe described at the end.

## The trap this file was written for

`ddicElement(path)` builds `GET /sap/bc/adt/ddic/ddl/elementinfo?…&path=<path>`. Passing
an **ADT object URI** as `path` returns HTTP 200 with a well-formed **empty** body:

```json
{ "properties": { "elementProps": false, "annotations": [] }, "children": [] }
```

No error, no hint. `path` is a **DDIC path**, and for a CDS entity that is the **plain
entity name**, case-insensitive. Measured: `I_PlantStdVH`, `i_plantstdvh` and
`I_PLANTSTDVH` return the same tree; `/I_PlantStdVH`, `I_PlantStdVH/Plant` and every URI
form return the empty body. (`I_PlantStdVH-Plant` also works, because everything after
the entity name is ignored — do not read that as field addressing.)

`ddicRepositoryAccess` is the documented producer of that path, but only in its **array**
form: `['I_PlantStdVH']` → `path: "I_PlantStdVH"`; the string form returns `path: ""`.
The client sends `requestScope=all&path=…` for an array and `datasource=…` for a string.

## Collections that matter for CDS metadata

Verbatim templates from this system's service document (`{&x*}` is an exploded,
repeatable parameter):

| Collection | Template |
|---|---|
| DDL element info | `/sap/bc/adt/ddic/ddl/elementinfo{?getTargetForAssociation,getFullTypeFieldInformation,getLabelTextsOfDataElementForFields,getExtensionViews,getSecondaryObjects,dataType,cdsFunction,path*}` |
| DDL repository access | `/sap/bc/adt/ddic/ddl/ddicrepositoryaccess{?column,datasource,datasourcetype*,requestScope*,path*,targetUriRequired,unlimitedResultSizeForElements,uriRequired,exactMatch,role,dsfd,cdsTypeAndDataElement,drtyPath}` |
| Generic DDIC element info | `/sap/bc/adt/ddic/elementinfo{?path,uri}{&context}{&type*}` |
| **CDS annotation chain** | `/sap/bc/adt/ddic/ddlx/annotation/chain{?entity,element,variant}` |
| CDS annotation element info | `/sap/bc/adt/ddic/cds/annotation/elementinfo{?path,enumValue}` |
| CDS annotation definitions | `/sap/bc/adt/ddic/cds/annotation/definitions` |
| Mass element info | `/sap/bc/adt/ddic/ddl/elementinfos` |
| Related objects of an entity | `/sap/bc/adt/ddic/ddl/relatedObjects/entity/{name}` |
| DDL dependency graph | `/sap/bc/adt/ddic/ddl/dependencies/graphdata{?ddlsourceName*,addMetrics*}` |
| Data element properties | `/sap/bc/adt/ddic/dataelements/{object_name}{?corrNr,lockHandle,version,accessMode,_action}` |
| Domain properties | `/sap/bc/adt/ddic/domains/{object_name}{?corrNr,lockHandle,version,accessMode,_action}` |
| SRVD element info | `/sap/bc/adt/ddic/srvd/elementinfo{?path}` |
| DDIC data preview | `/sap/bc/adt/datapreview/ddic{?rowNumber,ddicEntityName,dataAging}` |

The data preview collection is listed only so nobody has to hunt for it: it returns
**business data**, which is out of scope for this server by decision, not by absence.

## Where the client is narrower than the API

Two gaps, worth knowing before concluding that something is impossible.

**Parameters the endpoint accepts and `abap-adt-api` never sends.** For
`ddl/elementinfo` the client sends only `getTargetForAssociation`, `getExtensionViews`,
`getSecondaryObjects` and `path`. Unsent, and plausibly relevant:
`getFullTypeFieldInformation`, `getLabelTextsOfDataElementForFields`, `dataType`,
`cdsFunction`. For `ddicrepositoryaccess` the client reaches 2 of the 14 documented
parameters — `exactMatch`, `column`, `cdsTypeAndDataElement` and `uriRequired` are
unreachable through it.

**Collections with no client wrapper at all** — the annotation chain, the annotation
element info, the mass element info, related objects, the dependency graph. The
annotation chain (`?entity,element,variant`) is the resource that answers "which
annotation reached this element, and from where", which is exactly the question behind
the propagated-annotation conflicts that keep surfacing in Fiori elements apps.

Reaching either would need an HTTP call the guard deliberately cannot make: `httpClient`
is blocked precisely because it is a generic `request(url, config)`. Widening that is a
security decision, not a refactor — see [security.md](security.md).

## Measured shapes

### `ddicElement(entity)` — the field list source text cannot give

```
DDLS/STOB I_PlantStdVH
├─ STOB/DOF Plant       { ddicIsKey: true,  ddicDataElement: "werks_d",    ddicDataType: "char", ddicLength: 4 }
├─ STOB/DOF PlantName   { ddicIsKey: false, ddicDataElement: "werks_name", ddicDataType: "char", ddicLength: 30 }
├─ DEVC/K   MM_IM_VDM_MD          <- the package arrives as a child node
└─ STOB/DOS SEARCH                <- secondary object; pairs with the
                                     .../secondaryObjectAnnotation link in objectStructure
```

- Works on a **projection**: `ZC_DemoItemRating` returns **583** children, and each
  field resolves its data element (`Product`→`productnumber`,
  `ProductName`→`zdemo_prod_name`, `ProductExternalID`→`matnr_external`) even though the
  source only says `key Product,`.
- `elementProps` is `false` on nodes that are not fields (root, package, secondary
  object) — filter on its presence, not on `type`.
- `ddicDataElement` comes back **lower case**.
- **`annotations` is empty** on every node, at every path shape, with the flags the client
  sends. Annotations are not available from this endpoint as called: parse them from
  source, or use the annotation-chain collection above once it is reachable.
- **No domain.** That is what the next two calls are for.

#### On a TABLE the answer is FLAT and includes the appends — MEASURED 2026-09-22

The question that forced this reading was whether a field list can ever be complete: a table
source names its includes but **never** its appends (`ZDEMO_STR_EXIT` on `WBRF`,
`ZDEMO_MM_FIELDS` on `MEREP_OUTTAB_PURCHDOC`, `ZDEMO_KOMPAZ` on `KOMPAZ` — none appears in the base
source, not even by name). `ddicElement` on the table NAME answers it:

| read | answer |
|---|---|
| `ddicElement('AGR_TIMEB')` | 12 `TABL/DTF` children + one `DEVC/K` (the package) |
| `ddicElement('WBRF')` | its own fields, **plus four `TABL/DS` nodes named `.append` and one named `.include`**, each followed by the fields that block contributes — `DT_COMP` and `ST_COMP` among them, which are the fields of the customer append `ZDEMO_STR_EXIT` |
| `ddicElement('KOMPAZ')` (a `TABL/DS`) | `{children: []}` — **empty, and not an error** |

So for a **table** this is the complete, DDIC-active field list: includes expanded and appends
included, which no source read can give. Three things to hold on to:

- **The `.append` / `.include` nodes are MARKERS, not names.** They carry `elementProps: false`,
  empty `children`, and the literal name `.append`; the block's fields follow them as siblings.
  The reply says *that* an append contributed and *where* it starts, never WHICH append. The source
  read (`lib/table-meta.mjs`) names the **includes** but cannot name an append either — for the
  name, see `enhancement/elements` in the next section, which pairs with these markers.
- **It does not work on a structure**, and that is not the URI defect. Asked by NAME, after the
  fix, `KOMPAZ`, `KOMPCV`, `INCL_EEW_KNA1` and `MEREP_OUTTAB_PURCHDOC` — all `TABL/DS` — answer
  `{children: []}`, the same empty tree a wrong path gives. `TABL/DT` answers full. The split is
  by object type, so for a structure the source read plus `enhancement/elements` are the only
  routes.
- **An empty tree is never an empty object.** It is what this resource returns for a path it does
  not resolve, so `tools/index.mjs` files `DDIC_FIELDS_NOT_READ` instead of reporting no fields.

⚠️ And the reason this was found at all: the call passed `adtcore:uri` until 2026-09-22, i.e. the
URL form this file already recorded as answering empty. Every DDIC object had been reporting
`ok: true` with no fields — including `AGR_TIMEB`, the example two sections above, and
`ZC_DEMOITEMRATING`, which `docs/security.md` cites as returning 583 fields. **A measurement
written here is not a test**: the double in `tests/tools.test.mjs` stubbed `ddicElement`, so
nothing compared the argument against this page for two weeks.

#### `enhancement/elements` — the resource that NAMES the appends — MEASURED 2026-09-22

The missing half of the previous section. On the object's `objectStructure` reply, an
`atom:link` is published with
`rel="http://www.sap.com/adt/relations/enhancements"`,
`type="application/vnd.sap.adt.elementinfo+xml"` and a **relative** href
(`./wbrf/enhancement/elements`) — resolve it against the objectStructure URL, never assemble it.

- **The `type` on the link is the only accepted media type, and the server will not tell you
  which.** A wrong `Accept` gets `406` with the body `The message content is not acceptable` —
  this resource does **not** enumerate the acceptable types, unlike the ADT resources elsewhere
  on this page that answer 406 with a list. Read the type off the published link.
- Cost: one GET, a few hundred milliseconds to about a second.

**Shape.** The **root** `abapsource:elementInfo` is the object asked about, and its `adtcore:uri`
is the object (`…/ddic/structures/incl_eew_kna1`). Each **child** `abapsource:elementInfo` is one
append, and its `adtcore:uri` ends in `/source/main` — that suffix is what separates a child from
the root, beyond nesting. Each carries `adtcore:type`, `adtcore:name`, lower case and with the
namespace as **plain slashes** (`/accgo/append_com_period`) — it is the `adtcore:uri` that carries
the `%2f` wrapper form (`…/ddic/structures/%2faccgo%2fappend_com_period/source/main`), so the two
attributes do not agree on spelling and a caller must pick the one its next call needs and usually an `abapsource:documentation` shorttext —
**usually**: the key-user append `zz1_demo7x2kq9mbt4wpl3rncy8hfa` has none, so a parser that keys
on the shorttext loses exactly the Custom Fields case. It names the appends and stops there —
there is **no field list**, so a part's fields still cost one source read of that part.

| object | type | appends named |
|---|---|---|
| `WBRF` | `TABL/DT` | `wbrf_addon_di`, `wbrf_addon_gt`, `wbrf_append_ehp6`, **`zdemo_str_exit`** |
| `KOMPAZ` | `TABL/DS` | **`zdemo_kompaz`** + 5 SAP/partner |
| `KOMPCV` | `TABL/DS` | **`zdemo_app_kompcv1`**, **`zdemo_app_kompcv2`** + 3 — listed **separately**, never flattened |
| `INCL_EEW_KNA1` | `TABL/DS` | `crms4_bp_kna1`, **`zz1_demo7x2kq9mbt4wpl3rncy8hfa`** — the key-user (Custom Fields app) append |
| `MEREP_OUTTAB_PURCHDOC` | `TABL/DS` | **`zdemo_mm_fields`** + 5 SAP/partner |

**It works on a structure**, which is exactly where `ddicElement` goes empty — so the two
resources are complementary by object type, not redundant.

**The markers pair with the names, positionally, and the pairing reconciled 4 of 4 on `WBRF`:**
each `.append` marker in the `ddicElement` list is followed by the fields that append contributes,
in the same order the names arrive here.

| `ddicElement` marker | name from here | fields between this marker and the next |
|---|---|---|
| `.append` | `wbrf_addon_di` | `corr_document` |
| `.append` | `wbrf_addon_gt` | *none* — its source is `include wb2b_cond_key`, which is the `.include` marker that follows, carrying `knumh/kopos/coco_num` |
| `.append` | `wbrf_append_ehp6` | `settlement_date`, `settl_date_seq_id` |
| `.append` | `zdemo_str_exit` | `dt_comp`, `st_comp` |

The zero-field append is the load-bearing row: it is not noise, it is an append whose whole body
is an include, and the marker sequence reproduces that nesting. A merger must therefore consume
`.include` markers too and must not assume marker *n* owns fields; it owns the fields **until the
next marker**, possibly none. Note also that `dt_comp`/`st_comp` are customer fields with **no
`Z` in the field name** — the append is `Z`, the fields are not.

⚠️ **"Until the next marker" is a position, not an owner — measured against append sources
2026-09-22.** `WBRF` reconciles only because each of its appends is either all fields or all
include. `AKNA1_FMFG` (an append of `KNA1`) breaks it: its source declares `alc`, `pmt_office`,
then `include si_fmfg_vp2`, then `duns`, `duns4`, `sam_ue_id`, `sam_eft_ind`. The flat list puts
the last four **after** the `.include` marker, so the block rule hands them to the include and the
append's block under-reports it by four fields. The marker sequence is a pre-order walk of the
nesting and nothing more; **the append's own source is the only authority on what it declares**,
and that source is one read away now that the names can be enumerated.

⚠️ **The last child of a `ddicElement` reply is the package** (`type: "DEVC/K"`, e.g. `WZRE` on
`WBRF`, and the 13th child on `AGR_TIMEB`'s 12 fields). Filter children by `type`/`elementProps`
before counting fields.

**The resource answers whether or not the link is published — measured the same day, on 8 tables.**
The first reading left a confound: the only objects that listed nothing (`KNA1BRAZIL`, `AGR_TIMEB`)
were also `#NOT_EXTENSIBLE`, so "no link" and "no append" could not be told apart, and the probe
never called the URL for them. A run over `ZDEMO_STAGE_KNA1` and seven other Z tables separated the two:
the GET answered for **every** node asked, including extensible tables that carry no append and
including `KNA1BRAZIL`, which is `#NOT_EXTENSIBLE` and publishes no enhancements link at all.

So an empty list is an **observation**, not a silence, and the published link is a hint about the
object, not a precondition of the resource. What an empty list still does not say is *forever*: an
extensible table is one transport away from an append, so the finding is "none today".

**A nested include's appends appear in the TABLE's flat list.** `ZDEMO_STAGE_KNA1` (11 nodes, depth 2)
answers `ddicElement` with two `.append` blocks whose fields are `RULE_EXCLUSION` and
`ZZ1_DEMODELIVERY_CUS` — and the appends that carry them, `CRMS4_BP_KNA1` and
`ZZ1_DEMO7X2KQ9MBT4WPL3RNCY8HFA`, are appends of `INCL_EEW_KNA1`, an include two levels down, not
of the table. Their order matched the marker order, 2 of 2, so the marker ORDER pairs with the name order on two
independent objects (`WBRF` 4/4 at depth 0, `ZDEMO_STAGE_KNA1` 2/2 at depth 2). That is the order only —
see the warning above for why a block's CONTENTS are not the append's contents.

**An append can carry an include, and several do.** `WBRF_ADDON_GT`, `/VSO/R_KNA1_A` and
`J_3GKNA1A` each have a body that is nothing but `include <structure>`; `AKNA1_FMFG` mixes fields
and an include. So an append is not a flat list of fields, and a tool that prints "no fields" for
one of these says the opposite of the truth — it brings a whole structure.

**A namespaced name reads fine as an object.** `adt_read_source('/VSO/R_KNA1_A')` answers. Only the
`enhancement/elements` route has a segment alphabet that stops at the slash, and conflating the two
made an earlier version of the report claim a source could not be read when it could.

⚠️ **NAMING AN APPEND IS NOT SAYING IT IS IN THE TABLE — measured on `KNA1` 2026-09-22.** The
resource names **11** appends; `ddicElement` carries **7** `.append` blocks. The four with no block
belong to an industry solution (`OI*_KNA1`), and not one of their fields is in the active list.

**What is measured:** the append is named by the resource, and none of the fields its own source
declares is in the table. Nothing here reads WHY. The Switch Framework is the obvious suspect —
the count reconciles exactly and all four are from one component — but this reading was **not
verified**: no switch table was queried, and an append can also be missing from the active list
because it never activated, activated with an error, or targets another object. A tool must
therefore report the absence, never the cause.

So the two resources answer different questions and neither subsumes the other:

| | `enhancement/elements` | `ddicElement` |
|---|---|---|
| lists | appends that EXIST for the object | fields that are ACTIVE in the table |
| includes switched-off appends | yes | no |
| works on a structure | yes | no |

The consequence for any tool built on this: an append's field list must be checked for **membership**
in the active list before it is presented as available. `propose:table` marks the failures
`NOT IN THE ACTIVE TABLE`, and it tests membership rather than position precisely because the
positional pairing is the thing that does not hold.

#### A DDIC name is unique only WITHIN a type — MEASURED 2026-09-22

`adt_read_source('PRODH')` does not answer. The name belongs to three unrelated objects (`AUTH`,
`DOMA/DD`, `TABL/DS`), the resolver refuses to rank them, and it asks for `objectType`. Same for
`INCO_L` (`DOMA/DD` and `TABL/DS`). With `objectType: 'TABL/DS'` both read on the first try.

This is not an edge case, it is how the DDIC namespace works: a structure and a domain sharing a
name is ordinary. **Any code that resolves an include by bare name loses every include whose name
collides**, and it loses them as a failed read rather than as a missing object, so the two are
indistinguishable in the output. `KOMG` expanded 47 nodes and reported six unresolved; two were
this, and `PRODH` is a whole subtree (`include prodhs; include produhf;`), so the field list was
short by all of it and said only "short by an unknown amount". Passing the type closed it the same
day: 497 fields over 46 includes became **504 over 50** — `INCO_L` (3), `PRODHS` (3), `PRODUHF` (1)
— which is the size of what a bare-name read had been dropping on one structure.

The other four (`CI_KOMK_CM`, `CI_KOMP_CM`, `CI_KOMPFIC`, `CI_PRS_CPILS_2`) genuinely **do not
exist** — an unimplemented customer include is not an object. That is the opposite finding and it
must not print as a gap: an include that does not exist contributes no field, so the list is not
short. A warning that fires on nearly every large standard structure is one nobody reads.

| answer to a bare name | what it means | what it costs the field list |
|---|---|---|
| `names N unrelated objects` | the include EXISTS; the name is ambiguous | the subtree, silently |
| `not found in the system` | the include does not exist | nothing — it has no fields |

#### The source of an append is `extend type`, and an include alias may be quoted

Two DDL forms that a `define`-only parser drops in silence, both found on live objects 2026-09-22:

| form | where it appears | what silence looks like |
|---|---|---|
| `extend type <target> with <name> { … }` | every append source (`CRMS4_BP_KNA1`, `ZDEMO_STR_EXIT`, `ZZ1_DEMO7X2KQ…`) | the append resolves, its source comes back, its field list parses EMPTY — so a report prints a named append with nothing under it, which reads as *it adds no field* |
| `"%admin" : include sych_bdl_draft_admin_inc;` | RAP draft tables — `ZDEMO_INVMAP_D` writes the alias quoted, `ZDEMO_CTR_MAN_D` writes the same include bare | the six draft fields are absent from the source list, so the DDIC diff reports them as arriving **from an append** — the wrong mechanism, which sends the reader to SE11 › Append structures to find something that was never there |

The second is the sharper lesson: an unparsed line does not announce itself, it comes back as a
finding somewhere else.

### `getDataElementProperties` / `getDomainProperties` — the domain and the value table

`werks_d`, verbatim: `typeName: "WERKS"`, `dataType: "CHAR"`, `dataTypeLength: 4`,
`searchHelp: "H_T001W_C"`, `searchHelpParameter: "WERKS"`, `setGetParameter: "WRK"`,
**`defaultComponentName: "PLANT"`**, `fieldLabels.{short,medium,long,heading}` all "Werk"
(login language PT, master DE). Domain `WERKS`: `valueInformation.valueTableRef: "T001W"`,
`appendExists: false`, no fixed values.

**`MEINS`, measured — the `UNIT` value, not just the shape.** The pending
question was whether a unit-typed field actually reports `UNIT` on this system or falls
back to `CHAR`. It reports **UNIT**: `adt_value_help --dataElement MEINS` resolved
`domain: MEINS`, `valueTable: T006` and derived the concept from
`"DDIC type UNIT (the domain) -- unit key of a quantity field"`, then recommended
`I_UNITOFMEASURESTDVH` (released, tier B, 5 signals). So the semantic signal is as strong
as designed, and `readAnnotations` remains unnecessary for a field that has a data element.

⚠️ **`ddicElement` on a bare data element answers nothing.** `MEINS` as `DTEL/DE` returns
`properties.elementProps: false`, `annotations: []`, `children: []`. The UNIT signal came
from the **domain**, through `getDataElementProperties`/`getDomainProperties` — not from
`ddicElement`. That resource is for the field list of an entity, and asking it about a
data element on its own is a dead end rather than an error. So `adt_object_info` on a
`DTEL/DE` or `DOMA/DD` never asks `ddicElement`: it answers `dataElement` / `domain` from the
two property calls, `fixValueList` included (the list as `getDomainProperties` sends it), and a
failed domain read files `DOMAIN_NOT_READ` — never "no fixed values". `adt_read_source` refuses
both types (a `DTEL/DE` source read answered 404, 2026-10-01).

### Type contract — what `ddicElement` and the source read answer, per type — MEASURED 2026-10-01

One object per type, `adt_object_info` (field list on) and `adt_read_source`, the development system. **The field
list was being asked of every type**, and every type without fields answered an empty tree that
filed a false `DDIC_FIELDS_NOT_READ` (the journal already held it for two packages and a service
binding):

| type | sample | `ddicElement` by name | source read |
|---|---|---|---|
| `TABL/DT` | `ZDEMO_TRK_OC` | 25 fields | reads |
| `TABL/DS` | `EXTCMDEXEX` | **0 children** — a real gap, kept | reads |
| `DDLS/DF` | `ZI_DemoChannel` | 11 fields (`DDLS/STOB` → `STOB/DOF`) | reads |
| `BDEF/BDO` | `ZR_DEMOOCCGROUPTP` | ⚠️ the fields of the **DDLS of the same name** | reads |
| `DDLX/EX` | `ZC_DEMOOCCCODETP` | ⚠️ the fields of the **DDLS of the same name** | reads |
| `APLO/TYP` | `ZDEMO_FREIGHT` | empty | reads — the source is **JSON** |
| `CLAS/OC` | `ZCL_DEMO_BUPA_CHANGE` | empty (members are in `elements`) | reads |
| `INTF/OI` | `IF_HTTP_CLIENT` | empty (members are in `elements`) | reads |
| `DEVC/K` | `ZDEMO_DEV` | empty | ⚠️ answers the **`pak:package` XML** as if it were source |
| `SRVB/SVB` | `ZUI_DEMOOCCGROUP_O4` | empty | 404 |
| `TTYP/DA` | `BAPIRET2_T` | empty | 404 |
| `SHLP/DH` | `H_T001W_C` | empty | 404 (the structure carries no links) |
| `DTEL/DE` | `BTCXPGSTAT` | empty | 404 |
| `DOMA/DD` | `CHAR1` | not asked | not asked (refused by analogy) |

The structure's own `abapsource:sourceUri` predicted the source column on every type that has it
(present on `TABL`, `DDLS`, `BDEF`, `DDLX`, `APLO`, `INTF`; absent on `DTEL`, `DOMA`, `DEVC`,
`SRVB`, `TTYP`, `SHLP`); a class has no `sourceUri` and reads through its includes. The decisions
live in `lib/type-contract.mjs` — field list only where it is the object's own, a refusal that
names the answering call where there is no source — and `tests/type-contract.test.mjs` fails the
build when the code names a type the contract never decided. A type met at runtime outside it
files `TYPE_NOT_IN_CONTRACT`; an HTTP failure no code explains files `UNCLASSIFIED_ADT_ERROR`
(tool × type), so a recurring dead end becomes a counted row of `npm run report`.

Two findings that change design:

- **`defaultComponentName` is the canonical VDM element name, stated by the system.**
  `WERKS_D` → `PLANT`; `ZDEMO_DE_MVGR1` → `PRC_GROUP1`. That is a signal, not a naming
  habit.
- **`valueTableRef` is a strong concept key** (`WERKS`→`T001W`, `MVGR1`→`TVM1`), and a
  domain carrying `fixValues` instead means **no value help is wanted at all** — DDIC
  fixed values already render as a dropdown.

The decisive case, a **Z append data element**:

```
ZDEMO_DE_MVGR1    package ZDEMO_PLM, responsible DEVUSER1, masterSystem DEV
  typeName             -> MVGR1        (domain, SAP, package VZ)
  defaultComponentName -> PRC_GROUP1
  domain valueTableRef -> TVM1
```

The data element is ours and matches no standard concept; the domain it inherits does.
Without these two calls, that whole class of field has nothing to match on.

### `/sap/bc/adt/ddic/ddlx/annotation/chain` — MEASURED 2026-09-09

The collection `ddicElement` could not answer. First call ever made against it on this
system, through the named GET route in `lib/adt-get.mjs` (there is still no generic HTTP
tool). Two calls, both `200`:

| request | bytes | content-type |
|---|---:|---|
| `?entity=ZC_DemoRosterMonitor&element=Stcd2` | 46,807 | `application/vnd.sap.adt.ddlx.annotation.chain.v2+xml; charset=utf-8` |
| `?entity=ZC_DemoInvMapTP&element=BaseUnit` | 9,137 | same |

The second is complete and small enough to keep whole. It is stored as
`tests/fixtures/annotation-chain-measured.xml`, reproduced to the byte (9,137), and every
assertion in `tests/annotation-chain.test.mjs` runs against it.

Shape — a flat list, not a tree. The root `elementInfo` carries an **empty**
`<abapsource:properties/>`; each child is one **contribution** to one annotation key:

```xml
<abapsource:elementInfo adtcore:type="ANNO" adtcore:name="UI.LINEITEM$1$.POSITION">
  <abapsource:properties>
    <abapsource:entry abapsource:key="SOURCE_NAME">ZC_DEMOINVMAPTP</abapsource:entry>
    <abapsource:entry abapsource:key="SOURCE_TYPE">DDLX/EX</abapsource:entry>
    <abapsource:entry abapsource:key="LAYER">5500 </abapsource:entry>
    <abapsource:entry abapsource:key="LAYER_NAME">CUSTOMER</abapsource:entry>
    ...
    <abapsource:entry abapsource:key="IS_ACTIVE">X</abapsource:entry>
```

**The property set depends on the source kind, and this is the finding that would have
been guessed wrong.** Both kinds appeared in the same 9 KB reply:

| key | `DDLX/EX` (metadata extension) | `DDLS/DF` (the view's own source) |
|---|---|---|
| `SOURCE_NAME`, `SOURCE_TYPE`, `SOURCE_URI` | ✔ | ✔ |
| `ENTITY`, `ELEMENT`, `ELEMENT_TYPE` | ✔ | ✔ |
| `ANNOTATION_VALUE`, `IS_ACTIVE` | ✔ | ✔ |
| `LAYER`, `LAYER_NAME` | ✔ (`5500 ` / `CUSTOMER`) | **absent** |
| `SWITCH_ID`, `SWITCH_DISABLED` | ✔ (both empty here) | **absent** |
| `TRANSLATED_ANNOTATION_VALUE` + `_LANGUAGE` + `_LANGUAGE_KEY` | ✔ | **absent** |
| `STATEMENT_TYPE` | **absent** | ✔ (`P`) |

Reading `LAYER` as always-present would make every annotation written in the view itself
look like a layer-less anomaly. The keys also arrive in **different order** between the
two kinds, so a parser must read by key and never by position.

Other measured details:

- `LAYER` is **space-padded** by the kernel: `"5500 "`, not `"5500"`.
- Array subscripts are encoded in the name: `UI.FACET$1$.ID`, `UI.FIELDGROUP$1$.QUALIFIER`.
- `ANNOTATION_VALUE` keeps **ABAP quoting**: `'I_UnitOfMeasureStdVH'` with the quotes,
  `#LOW` for an enum, `60` bare for a number. The quoting is what distinguishes a string
  from an enum, so it is carried through unmodified.
- A translated text arrives **alongside** the source literal, not instead of it:
  `ANNOTATION_VALUE = 'Unit'` with `TRANSLATED_ANNOTATION_VALUE = Unit`,
  `_LANGUAGE = <logon language>`, `_LANGUAGE_KEY = <its one-letter key>`.
- `IS_ACTIVE` is the kernel's own verdict on which contribution wins. **Do not re-derive
  the winner from `LAYER`** — a switched-off contribution can sit on the higher layer and
  still lose, and the reply carries `SWITCH_ID`/`SWITCH_DISABLED` precisely because of it.
- `SOURCE_URI` is a deep link back to the exact annotation in the source
  (`…/source/main#name=…;element=…;annotation=ui.lineitem%241%24.position`).

**The overriding case is OBSERVED** (corrected 2026-09-09, later the same day — the first
two calls had shown none, and this file said so). `ZC_DemoRosterMonitor/Stcd2`, 46,807 bytes,
37 contributions to 35 annotation keys from **5 sources**, with two keys written more than
once:

| key | winner | also written by |
|---|---|---|
| `ENDUSERTEXT.LABEL` | `ZC_DEMOROSTERMONITOR` (`DDLS/DF`), `CPF` | `ZI_DEMOROSTERMONITOR`, `ZI_DEMOROSTERSTATUS` — same value, benign |
| `UI.HIDDEN` | **nobody** | `ZI_DEMOROSTERSTATUS` (`DDLX/EX`, CUSTOMER), `true` |

The second row is the shape that matters, and it validates the `silenced` case: a
contribution exists in the chain, carries `true`, and **no contribution is active**. The
reply models "written but reaching nothing" as a first-class state rather than as absence,
which is why the parser reports `winner: null` instead of dropping the key.

Two structural facts this second measurement added:

- A source can contribute through **both** kinds at once: `ZI_DEMOROSTERSTATUS` appears twice
  in `sources`, once as `DDLX/EX` and once as `DDLS/DF`, which is why the source rollup is
  keyed on `name|type` and not on `name`.
- A source with `contributions: 1, active: 0` is a source whose entire contribution lost.
  Three of the five sources here are in that state.

Cross-check that came free: for `ZC_DemoInvMapTP.BaseUnit` the chain reports
`consumption.valuehelpdefinition[1].entity.name = 'I_UnitOfMeasureStdVH'`, which is the
same fact `adt_value_help` derives from the entity's source and the catalogue — two independent
routes, one answer.

#### `entity` and `element` are DISJOINT scopes — measured

Calling the route **without** `element` does not return a superset. `ZC_DemoRosterMonitor`
with no element → 20 annotations from 2 sources, all of them entity-level
(`accessControl`, `headerInfo`, `presentationVariant`, `objectModel.semanticKey`,
`search.searchable`). The same entity **with** `element=Stcd2` → 37 contributions from 5
sources, none of them the entity-level keys.

Consequence for anyone sweeping: an element-level defect **cannot** be found by asking
about the entity, so a sweep costs one ADT call per *element*, not per entity. The cheap
filter has to come first: `adt_annotation_scan` reads the sources once and ranks which elements
deserve the call.

#### An `association` does NOT propagate element annotations — measured

A source-based triage that walked `from`/`join`/`association to`/`composition of` transitively
proposed `ZC_DemoEmployee/Stcd2` as hit by the `@UI.hidden` in seven upstream DDLX files.
The measurement refuted all seven: 78 annotations, 2 sources, **0 conflicts, no
`UI.HIDDEN` at all**. The seven `ZI_DEMOBP*` views reach `ZC_DemoEmployee` through
`association`, which puts no element in the select list and therefore contributes no
element annotation.

Propagation follows the element's **select-list lineage** — `from`, `join`,
`as projection on`. Restricting the triage to those edges dropped it from 84 candidate
pairs to 49, removed every false positive, and still reproduced the one known case.

#### The contradiction that produces ZERO conflicts — measured, twice

| entity/element | bytes | contributions | sources | conflicts |
|---|---:|---:|---:|---:|
| `ZC_DemoShelfStock/Plant` | 8,298 | 6 | 2 | **0** |
| `ZC_DemoShelfStockDEMO/Plant` | 8,378 | 6 | 2 | **0** |

Both chains carry, **all active**:

```
ui.hidden               = true   ←  ZI_DEMOSTORAGELOCATION (DDLX/EX, CUSTOMER)
ui.lineitem[1].position = 30     ←  ZC_DEMOSHELFSTOCK[DEMO]    (DDLX/EX, CUSTOMER)
ui.selectionfield[1].position = 30
ui.fieldgroup[1].qualifier = 'DadosGerais'
```

`conflicts` is **empty** because `ui.hidden` and `ui.lineitem[1].position` are different
keys — nothing contests anything. A same-key check reports a clean chain about a field
that does not render. A hidden element with a display role is a defect in its own right, and it is
the reason `hiddenWithUiRole()` exists alongside the conflict list.

Corroborated through a second, independent route: the `$metadata` the service emits, as
downloaded into `fiori-outlets-stock/webapp/localService/mainService/metadata.xml`,
carries `SAP__UI.Hidden` on `SAP__self.DemoShelfStockType/Plant` while listing `Plant` in
both `UI.LineItem` and `UI.SelectionFields`. Filed as `ANNOTATION_HIDDEN_WITH_ROLE`
(fingerprints `946c8e595f29`, `4d1f38bf88a4`).

⚠️ The fixture `tests/fixtures/annotation-chain-hidden-role.xml` is **not** byte-exact,
unlike `annotation-chain-measured.xml`: only the parsed answer of that call was captured,
so the XML is rebuilt from the measured facts in the structure of the byte-exact fixture.
It reproduces the live parse exactly (6 contributions, 2 sources, 0 conflicts) but makes
no claim about matching 8,298 bytes.

### `/sap/bc/adt/ddic/ddl/dependencies/graphdata` — MEASURED 2026-10-14

**Wire** (Eclipse ADT 3.60 communication log, the development system): `GET …/graphdata?ddlsourceName=<DDLS>&addMetrics=true`,
`Accept: application/vnd.sap.adt.elementinfo+xml, …SQLDependencyModel.v1/v2/v3+xml`; the system answers
`application/vnd.sap.adt.ddl.SQLDependencyModel.v3+xml`. ZC_DemoStock: 200 in 8.8 s, 6.9 s of it server time.

**Shape.** A TREE of `abapsource:elementInfo`. Each node has `adtcore:uri`/`type`/`name` attributes
(`DDLS/DF` for a view, `TABL/DT` for a table; none for a structural node) and an `abapsource:properties`
block BEFORE its children, with `TYPE` (`CDS_VIEW`, `CDS_VIEW_ENTITY`, `TABLE`, `RESULT`, `SELECT`,
`UNION_ALL`), `RELATION` (`FROM`, `INNER_JOIN`, `LEFT_OUTER_JOIN`, `UNION_ALL`; empty on the root),
`ENTITY_NAME` (camel case; empty for a table), `NODE_NAME` (the SQL view name for a DDIC-based view:
`IPRDSTORLOCBASIC`), `DB_EXISTS`, `AC_STATE` and, with `addMetrics`, `NUMTABS`, `NUMVIEWS`, `NUMJOINS`,
`NUMUNIONS`, `NUMCASE`, `NUMEXPLCITCASTS`, `NUMFUNCTIONCALLS`, `NUMTABLEFUNCTIONS`,
`NUMVIEWSWITHPARAMETER` (numbers with a trailing blank). Structural nodes (`RESULT` of a join, `SELECT`
and `UNION ALL` branches) sit where the SQL puts them -- a `RESULT` is a child of the view whose join it
is, not of the root. A view reached twice is repeated in full under each parent.

**Not in it:** associations (only what the SQL reads) and anything at element level. Kept as a
measurement: this server no longer has a route to it (the script that read it was removed on
2026-11-08, docs/security.md).

### `annotationDefinitions()` — the DDLA of this system

Returns a **string of 182,092 characters**: the annotation definitions of this release,
carrying `@Scope:[#VIEW, #TABLE_FUNCTION, …]`, `@API.state: [#RELEASED_FOR_KEY_USER_APPS,
#RELEASED_FOR_SAP_CLOUD_PLATFORM]`, `@CompatibilityContract` and the closed enums:

```
@Scope:[#VIEW, #TABLE_FUNCTION, #HIERARCHY]
annotation AccessControl {
  @API.state: [#RELEASED_FOR_KEY_USER_APPS, #RELEASED_FOR_SAP_CLOUD_PLATFORM]
  authorizationCheck : String(20) enum { NOT_REQUIRED; NOT_ALLOWED; MANDATORY; CHECK; PRIVILEGED_ONLY; } default #NOT_REQUIRED;
```

This is the **primary** source for validating an annotation before emitting it — scope,
API state and enum values, from this system at this release -- and, since 2026-11-08, the only
one: when it cannot be read the emission degrades to "not validated", never to silence and never
to another release's documentation.

#### Why the full payload is NOT in this repository

The raw payload of this call could have been pasted here, the way the annotation-chain
payload was. It is not, and it will not be: **DDLA is SAP standard
source**, and this repository's own `.gitignore` says "Never in this repo: credentials,
session state, cached SAP source, the audit trail." The chain payload could be pasted
because it described a Z object of ours; 182 KB of SAP's annotation definitions is the
thing that rule exists to keep out. What belongs here is the length, the structure and an
excerpt long enough to show the shape — all three above.

#### What was actually missing, and how to measure it

Not the bytes: whether `fromDdla()` reads all of them. A parser that silently understands
half the DDLA and one that understands all of it look identical from inside
`adt_value_help` — both just answer, and the incomplete one answers "not a known
annotation" for keys it never parsed. That is the failure this repository refuses
everywhere else, so it should not be tolerated here.

```bash
npm run measure:ddla            # prompts for the SAP password, like `npm run adt`
```

`scripts/measure-annotation-defs.mjs` makes one read through the **already-allowlisted**
`annotationDefinitions` method — no new GET route, because widening the named-GET table to
reach something already reachable buys nothing and costs security surface — then counts
`define annotation` roots in the raw text, compares them against what `fromDdla()`
returned, and names any root the parser did not produce. The text is written under
`%LOCALAPPDATA%\sap-adt\measurements\`, outside any git work tree by construction, for
the same reason the audit log lives there.

#### What the measurement found on the first run (2026-09-09)

```
bytes                 : 182116          (= the 182,092 characters above; the 24-byte
lines                 : 3597             difference is UTF-8 multibyte, not drift)
roots declared        : 31
fromDdla() returned   : 27 roots
! DefaultAggregation, Feature, MappingRole, Scope
```

A real gap in our own parser, found on the first run — which is the argument for the
script. All four are declared **without a `{}` body**:

| Root | Line | Form as measured |
|---|---|---|
| `Feature` | 2098 | `define annotation Feature : String(1024);` |
| `MappingRole` | 2191 | `annotation MappingRole` / `: Boolean default true` / `;` — the `:` on the NEXT line |
| `DefaultAggregation` | 1199 | `annotation DefaultAggregation : String(30) enum { NONE; SUM; … };` — scalar **and** enumerated |
| `Scope` | 3222 | `annotation Scope : array of String(20) enum { … }` — every member carrying a `//` comment |

`fromDdla()` did `if (src[i] !== '{') continue;`, so a root with no brace was dropped
whole, taking its `@Scope` and `@API.state` with it. The consequence was not a missing
entry in a table: `defs.has('Feature')` answered **false** about an annotation this system
defines, and `adt_value_help` would have refused it as "not a known annotation" — the
silent wrong answer this server exists to refuse. Fixed by reading the declaration up to
its `;` at brace depth 0 and registering it as a leaf; `Scope` also forced stripping `//`
comments before tokenising an enum body, since otherwise `in`, `front`, `of` and `DEFINE`
would have registered as permitted values and the validator would have been **more**
permissive than the system.

Two counting traps worth keeping, because both produced a misleading number first:

- **`define` is optional.** Only 11 of the 31 roots use it. The script's first regex
  required it and reported "11 roots in the raw text" against the parser's 27 — which
  reads as the parser inventing 16 annotations, when the truth was the exact opposite.
- **Roots are not keys.** The text declares 31 roots; `fromDdla()` returns 1,027 dotted
  keys under them. Comparing the two numbers directly means nothing.

After the fix: **31 declared, 31 parsed, none missing.** Regression tests in
`tests/annotation-defs.test.mjs` use the four excerpts verbatim, with their line numbers.

### `searchObject(query, objectType, max)` — the `type:ddls` pre-filter, and its cap

The type filter of the Eclipse ADT search is this parameter, and it is the difference
between a 3 KB answer and a 3.4 MB one. Measured on the system looking for the value help of
`BaseUnit`:

| Query (`objectType: DDLS/DF`) | Rows | Bytes | Finds `I_UnitOfMeasureStdVH`? |
|---|---|---|---|
| `*UNITOFMEASURE*`, `max` 60 | 60 | 15 KB | **no** |
| `I_UNITOFMEASURE*` | 13 | 3.2 KB | yes |
| `*MEINS*` (the domain), `max` 40 | 1, unrelated | 366 B | no |
| `usageReferences` on `T006` (the alternative) | 15,963 | 3.4 MB | only after filtering |

⚠️ **The cap truncates alphabetically, and says nothing.** The 60 rows of
`*UNITOFMEASURE*` stop at `I_PRODUNITOFMEASURETEXTBASIC`; `I_UNITOFMEASURESTDVH` sorts
after that and was simply not there, with no marker in the reply to say the list was cut.
A leading-wildcard query is therefore never trustworthy at the cap — anchor it
(`I_<CONCEPT>*`) and report `rows.length >= max` as truncation. `lib/concept-search.mjs`
does both.

The prefix search also returns names no generator invents: `I_UnitOfMeasureTimeVH`,
`I_UnitOfMeasureIsoCode`. That is the argument for asking the system instead of
enumerating name shapes offline — but the catalogue still decides, because the search
knows nothing about release state.

### Quick search facets — which `objectType` filters, and why — MEASURED 2026-09-12

`/sap/bc/adt/repository/informationsystem/search?operation=quickSearch&query=<name>&maxResults=20
&objectType=<facet>`. Fourteen facets, one object each known to be of that facet, four
readings per row: (1) unfiltered — the control, does the index return this object *as this
facet* at all; (2) through the client library with the facet; (3) raw GET with the **full**
facet URL-encoded; (4) raw GET with the major type only. All 56 answered 200.

Half of the mechanism is in the library and is read in its source (`abap-adt-api`,
`build/api/search.js`): `searchObject` sends `objectType = objType.replace(/\/.*$/, '')` —
**the facet is stripped before the request leaves**, so (2) and (4) are the same request.
The other half is the ADT's, and it was the unmeasured one: **the ADT accepts the full facet**.

| facet | object | (1) in index | (2) library | (3) full facet | (4) major | verdict |
|---|---|---|---|---|---|---|
| `FUGR/I` | `LV05CFZZ`, `L0KBLFZ1` | yes, as FUGR/I | **0** | **0** | **0** | 🔴 unsearchable — the index does not filter this facet |
| `FUGR/FF` | `BAPI_SALESORDER_CREATEFROMDAT2` | yes, as FUGR/FF | **0** | **1** | 0 | 🔴 unsearchable **through the library**; the ADT answers the full facet |
| `PROG/I` | `MV45AFZZ` | yes | 1 | 1 | 1 | filters |
| `FUGR/F` | `V05C` | yes | 1 | 1 | 1 | filters |
| `CLAS/OC` | `CL_FDP_EF_PURCHASE_ORD_DPC_EXT` | yes | 1 | 1 | 1 | filters |
| `PROG/P` | `SAPMV45A` | yes | 1 | 1 | 1 | filters |
| `DDLS/DF` | `I_PLANTVH` | yes | 1 | 1 | 1 | filters |
| `TABL/DT` | `VBBE` | yes | 1 | 1 | 1 | filters |
| `DTEL/DE` | `ZDEMO_DE_BASE` | yes | 1 | 1 | 1 | filters |
| `DEVC/K` | `ZDEMO_FIN` | yes | 1 | 1 | 1 | filters |
| `STOB/DO` | `I_PLANTVH` | yes | 1 | 1 | 1 | filters |
| `CDBO` | `I_COMPANYCODEVH` | yes | 1 | 1 | 1 | filters |
| `CLAS/OM` | `CL_ABAP_TYPEDESCR` | **no** — the index holds no methods | 1 as CLAS/OC | 1 as CLAS/OC | 1 as CLAS/OC | control failed: a sub-object facet is answered with its carrier |

Three things follow, and the first was a wrong hypothesis on record:

- **"Unsearchable = a facet whose major type is a different object" is false.** `FUGR/I` is
  not returned with the full facet either, while `FUGR/FF` — the same shape, a sub-object of
  a function group — is. The index filters some facets and not others, and the rule is not
  predictable from the facet's shape: **object by object, never by family** stays the rule.
- **The library's stripping loses information the ADT would use — and the full facet has a
  price.** For `FUGR/FF` the full facet answers present against absent. But a reply filtered
  by a facet (an `objectType` containing `/`) **carries no `adtcore:description`**: the same
  one hit is 285 bytes as `PROG/P` against 341 as `PROG`, 251 as `FUGR/F` against 340 as
  `FUGR`, and the difference is exactly the description attribute (re-read of the transcript,
  same day). So the whole-facet request is a **second ask** after the library's, never a
  replacement for it: the route `quickSearch` in `lib/adt-get.mjs` sends the facet whole,
  `lib/resolve.mjs` asks it only when the library's search answered nothing and a facet was
  given, and the hit comes back with `description: null` and `foundBy: "facet"`, filing
  `FOUND_BY_FACET`.
- `lib/resolve.mjs` keeps refusing `FUGR/I` with the measured reason (`UNSEARCHABLE_TYPES`),
  asks `FUGR/FF` straight through the route (`FACET_ONLY_TYPES`, the library is not called for
  it), and `SEARCHABLE_TYPES_MEASURED` locks the ten that filter so neither list can grow by
  symmetry.

### `usageReferences(url)` — no type filter, by construction

The client posts a fixed body with an empty `<usagereferences:affectedObjects/>` and no
filter in the query string, so the type restriction the ADT UI offers is **not reachable
through it**: the whole list comes back and is filtered here. That is why the where-used
route is the last resort and the anchored search runs first.

Its one irreplaceable use: **which released CDS entity models the concept behind a value
table**. `T006` → 15,963 callers → 57 `DDLS/DF` → exactly **one** released,
`I_UnitOfMeasure`. That is the only route from the field `BaseUnit` (data element `MEINS`,
whose `defaultComponentName` is **`BASEUOM`**, not `UNIT_OF_MEASURE`) to the answer.

### `/sap/bc/adt/cts/transportrequests` — the Transport Organizer, MEASURED 2026-09-09

The admission gate of [`security.md`](security.md) is **open**: this system's service
document publishes the CTS collections, so the first rule is satisfied before anything
else is asked.

```
/sap/bc/adt/cts/transportrequests            accept application/vnd.sap.adt.transportorganizer.v1+xml
                                             template {?targets}
/sap/bc/adt/cts/transportrequests/facets
/sap/bc/adt/cts/transportrequests/reference  {?obj_name,obj_wbtype,pgmid}
/sap/bc/adt/cts/transportrequests/searchconfiguration/configurations
/sap/bc/adt/cts/transportrequests/searchconfiguration/metadata
/sap/bc/adt/cts/transportchecks
/sap/bc/adt/cts/transports
/sap/bc/adt/cts/valuehelp/{attribute,target,ctsproject,object/{field}}
```

⚠️ Everything in that block that looks like guidance is **wrong**, and only measurement
says so. The `accept` the collection advertises is **rejected by the collection itself**.
The template declares `{?targets}` and **no `user` parameter** — yet `userTransports`
sends `?user=&targets=`. And the declared parameter is worse than useless: **sending
`?targets=` at all empties the answer**, silently. The collection answers on the bare URL
and nowhere else.

#### The list resource: six requests, and only one of them answers

Two variables, crossed. The header the collection advertises against the one the resource
names, and the query string against no query string at all:

| # | request | answer |
|---|---|---|
| A1 | `?user=DEVUSER1&targets=true` · `…transportorganizer.v1+xml` | **406** — "Accepted content types: `application/vnd.sap.adt.transportorganizertree.v1+xml`" |
| A2 | `?user=DEVUSER1&targets=true` · **no `Accept`** (what the client sends) | 200, **297 bytes** — `<tm:root adtcore:name="DEVUSER1" …/>`, self-closed, **zero requests** |
| B1 | `?targets=true` · `…transportorganizer.v1+xml` | **406**, identical message |
| B2 | bare URL · `…transportorganizer.v1+xml` | **406**, identical message |
| E1 | `?user=DEVUSER1&targets=true` · `…transportorganizer**tree**.v1+xml` | 200, **297 bytes** — the same empty root |
| E2 | `?targets=true` · `…transportorganizer**tree**.v1+xml` | 200, **297 bytes** — the same empty root |
| **E3** | **bare URL** · `…transportorganizer**tree**.v1+xml` | **200, 270 138 bytes — 6 requests, 14 tasks, 672 objects** |

⚠️ **The only request that answers is the bare URL with the tree media type.** Both
variables have to be right at once, and getting either one wrong fails in a *different*
way: the wrong `Accept` is loud (406), while **any query string at all is silent** — E1
and E2 return HTTP 200 with a well-formed empty document, byte-identical to the no-header
case. The header was never the whole story; adding `?user=` or `?targets=` silences the
resource on its own.

This is the correction the A/B control of round 2 could not make on its own: it was
designed to decide between "the request was wrong" and "the endpoint is a no-op", and the
answer turned out to be that the request was wrong in **two** independent ways, only one
of which the server complains about.

⚠️ **`userTransports` is defective against this release in three ways, all measured.**

1. It sends **no `Accept`** (`transports.js:128`) — branch A2.
2. It always sends **`?user=&targets=`** — and a query string is exactly what empties the
   answer, so even with the right header (E1) it would still get 297 bytes.
3. Its parser navigates `tm:root > tm:workbench > **tm:target**` (`parseTargets`,
   `transports.js:116-120`) — and **there is no `tm:target` element** in the real answer
   (see the tree below). So even handed a correct 270 KB body it would return
   `{workbench: [], customizing: []}`.

Three independent faults, each of which alone produces **an empty list and no error**. The
method stays out of the allowlist: the defect is in the client, not in the system, and
admitting it would import a silent wrong answer. The route is reachable — but only as a
declared URL with a declared `Accept` and **no query**, which is what the closed route
table of [`../lib/adt-get.mjs`](../lib/adt-get.mjs) is for.

#### What drives the list on this release

`searchconfiguration/metadata` (200, 1 114 bytes) returns the query model verbatim, as
`configuration:property` elements carrying **text** — the only place in the whole CTS
surface where a value is not an attribute:

| key | mandatory | value on this system |
|---|---|---|
| `WorkbenchRequests`, `CustomizingRequests`, `TransportOfCopies` | yes | `true` |
| `Modifiable`, `Released` | yes | `true` |
| `User` | yes | `DEVUSER1` — the server fills in the caller |
| `DateFilter` | yes | `1` |
| `FromDate`, `ToDate` | no | *(empty)* |
| `com.sap.adt.tm.facets.order` | yes | `request_type,target,cts_project,request_status` |

`facets` (719 bytes) declares those same four ids in domain `sap.adt.tm.core`.
`searchconfiguration/configurations` (131 bytes) is **empty** — no saved configuration
exists on this system, which is consistent with a list resource that wants a different
representation rather than a `?user=` query.

#### The detail resource: works, and this is its exact tree

`GET /sap/bc/adt/cts/transportrequests/<number>` with
`Accept: application/vnd.sap.adt.transportorganizer.v1+xml` answered **HTTP 200 on all six**
requests read. Note that the *detail* resource accepts the type the *list* resource
rejects: one `accept` on a collection does not describe its members.

```
tm:root            adtcore:name=<number> adtcore:type=RQRQ tm:object_type=R
                   adtcore:changedAt changedBy createdBy
  atom:link*
  tm:request       tm:number parent owner desc type status status_text target
                   target_desc cts_project cts_project_desc source_client
                   lastchanged_timestamp uri                    (14 attributes)
    tm:long_desc
    atom:link*
    tm:attributes*      tm:attribute tm:description tm:value tm:position
    tm:abap_object*     <-- the request's OWN list
    tm:all_objects
      tm:abap_object*   <-- the UNION (see below)
    tm:task*       same 14 attributes as tm:request
      tm:long_desc
      atom:link*
      tm:abap_object*   <-- that task's own list
```

`tm:abap_object` carries `tm:pgmid tm:type tm:name tm:position tm:dummy_uri tm:obj_info
tm:lock_status tm:img_activity`, plus `tm:wbtype` and `tm:obj_desc` where the object type
has them, plus `tm:obj_func`. **Nothing in the document carries text content** — every
value is an attribute, and the only child element below `tm:abap_object` is `atom:link`.

⚠️ `tm:obj_func` is **not** a customizing marker, though six documents made it look like
one. Reading a seventh (the list, below) shows it on `TABU/K`, `CDAT/K`, `VDAT/K`,
`TDAT/K` **and** on `METH/D`, `DOMA/D`, `FUGR/D`, `TOBJ/D`, `TRAN/D`. Two values, `K` and
`D`, across both halves. What they mean was closed on 2026-09-10 by reading the domain —
`K` = *has rows in the key list*, `D` = *object was deleted* — see *The domain `OBJFUNC`
and its six values*, below. It is recorded here so the next reader does not repeat the
inference that six samples invited.

#### ⚠️ The task rule, and the node that already implements it

A task's content is moved up into the request **only when the task is released**. Reading
`tm:request`'s own `tm:abap_object` children therefore under-reports an open request — and
in one measured case reports **nothing at all**:

| request | `tm:type` | status | own | `tm:all_objects` | tasks — status:objects | bytes |
|---|---|---|---|---|---|---|
| `DEVK900113` | K | D | 14 | **15** | `DEVK900116`/D:2 · `DEVK900114`/R:13 | 44 454 |
| `DEVK900110` | K | R | 78 | 75 | `DEVK900112`/R:0 · `DEVK900109`/R:38 · `DEVK900111`/R:37 | 102 328 |
| `DEVK900117` | W | D | **0** | **4** | `DEVK900118`/D:4 | 19 377 |
| `DEVK900107` | W | R | 7 | 6 | `DEVK900108`/R:3 | 26 234 |
| `DEVK900101` | T | L | 29 | 28 | *(none)* | 66 402 |
| `DEVK900119` | T | R | 3 | 2 | *(none)* | 20 942 |

`DEVK900117` is the case that settles it: **a customizing request with four objects whose
own list is empty**, because its only task is still modifiable. A reader that skips
`tm:task` answers "this request is empty" about a request that is not.

The invariant, and it holds on **all six**:

> `tm:all_objects` = (the request's own objects **minus** the `CORR` pseudo-entries)
> ∪ (every task's objects), deduplicated.

Checked where the two sides actually differ: `DEVK900113` is 13 ∪ 2 = 15; `DEVK900117` is
0 ∪ 4 = 4. The `CORR` entries — `CORR/RELE` ("comment entry: release completed", in the logon language),
`CORR/MERG` ("…object list transferred") — are **release and merge comments, not
objects**, and `tm:all_objects` already drops them.

⚠️ **The client does not read `tm:all_objects` at all.** `parseTask`
(`transports.js:99-108`) takes `xmlArray(t, "tm:abap_object")`, which is the **direct**
children only, and `parseRequest` (`:109-114`) adds `tasks`. So `transportDetails` hands
back the request's own list plus a per-task list and **silently omits the union node**.
That is recoverable — the union is recomputable by the rule above, and per-task
attribution is worth more than a flat node when the point is documenting *who changed what
together* — but it has to be recomputed deliberately. It is never handed over.

#### The central question: does a customizing entry carry table KEYS? **No.**

No public source answers this, and the hypothesis was that `tm:obj_info` would hold the key
of a `TABU`/`CDAT` entry. **Falsified.** In both customizing requests, every entry names a
**table, view or view cluster** and nothing finer:

```xml
<tm:abap_object tm:pgmid="R3TR" tm:type="CDAT" tm:name="BUPAFLDMOD" tm:obj_func="K"
  tm:dummy_uri="/sap/bc/adt/cts/transportrequests/reference?obj_name=BUPAFLDMOD&amp;obj_wbtype=CDAT&amp;pgmid=R3TR"
  tm:obj_info="View cluster maintenance: data" tm:position="000001"
  tm:lock_status="" tm:img_activity=""/>
```

`tm:obj_info` is the **description of the object type** — "Table contents",
"View maintenance: data", "Data definition language source" (logon-language texts, translated here) — never a value.
The `E071K` key rows behind a `TABU` entry are **not exposed by this resource**, as an
attribute or in any other form. Measured on `DEVK900117` (`CDAT`, `VDAT`) and `DEVK900107`
(`TABU` on `AGR_TIMEB`, `USR10`, `USR11`, `UST12`; `TDAT` on `WDY_CONF_USER`).

Consequence for [`security.md`](security.md): admitting the customizing half does **not**
move the "the repository, never the contents of a table" frontier. It says which tables
were parameterised; it cannot say which row.

#### Attribute traps, all measured

1. ⚠️ **`tm:type` is a code on `tm:request` and a localised text on `tm:task`.** Same
   attribute name, sibling elements: `K`/`W`/`T` against `"Development/Correction"`,
   `"Repair"`, `"Customizing Task"`. Code that reads `tm:type` uniformly is wrong on one of
   the two.
2. ⚠️ **`K` is workbench and `W` is customizing.** `W` does not mean workbench — confirmed
   against requests their owner had classified by hand before the reading.
3. ⚠️ **`tm:status` has a third value: `L`, "Protected"** (`DEVK900101`), besides `D`
   "Modifiable" and `R` "Released" (status texts translated from the logon language). The client's `{modifiable, released}` two-bucket model
   (`parseTargets`, `transports.js:116-120`) has no place for it.
4. **`tm:status_text` is translated** into the logon language. Display only — branch on
   `tm:status`.
5. **A workbench request contains customizing-shaped entries and vice versa.**
   `DEVK900113` (`K`) carries `TABU MASSFLDLST` with `tm:obj_func="K"`. The two halves are
   a property of the **request**, never of its objects.
6. **`tm:position` is per list, not per request** — the same object shows a different
   position in the task and in the request, and positions repeat across the two nodes.

#### Where the bytes go

`tm:attributes` is stamped at **export** and it is bulk: **97 `SAPCOMPONENT` rows** (the
software-component vector, `<component>,<release>,<support package>`) in each of the released requests
and **zero** in the modifiable ones. Also present: `EXPORT_TIMESTAMP`, `EXPTIMESTAMP`,
`CALM_CDM_FEATURE_ID` (a feature GUID, when a project tool stamps one), `SAP_ATO_TRANSPORT_TYPE`,
`SAP_CUS_TRANSPORT_CATEGORY`. None of it answers *which objects moved together*.

`atom:link` is the other bulk: 3 per `tm:abap_object`, up to **195 in one document**
(`DEVK900101`).

Envelope for the caps: **19 377 – 102 328 bytes** per request, **5 – 228** `tm:abap_object`
nodes counting all three lists, **0 – 3** tasks.

Requests read: `DEVK900113`, `DEVK900110` (workbench, modifiable and released);
`DEVK900117`, `DEVK900107` (customizing, modifiable and released); `DEVK900101`,
`DEVK900119` (transports of copies — the negative control, a different `tm:type`, and the
one that produced the `L` status). Descriptions and long texts are deliberately not
reproduced here.

#### The list answer (E3), and how much of it is not a list

`GET /sap/bc/adt/cts/transportrequests`, `Accept:
application/vnd.sap.adt.transportorganizertree.v1+xml`, **no query string** — 270 138
bytes:

```
tm:root              adtcore:name=<user> changedAt createdAt changedBy createdBy
  tm:workbench       tm:category="Workbench"
    tm:released      tm:status="Released (From Last 2 Weeks)"
      tm:request     12 attributes -- NOT the same 12 of 14 the detail returns
        tm:long_desc
        tm:abap_object*
        tm:task*
          tm:long_desc
          tm:abap_object*
  tm:customizing     tm:category="Customizing"
    tm:released      tm:status="Released (From Last 2 Weeks)"
      …same shape
```

⚠️ **There is no `tm:target` element** — the node `parseTargets` navigates through. The
buckets are `tm:workbench` / `tm:customizing`, each carrying a `tm:category`, and below
them a status node directly.

⚠️ **There is no `tm:modifiable` node in this answer, and no open request in it.** The
default view is **released only, and only the last two weeks** — the scope is written into
the data, in the `tm:status` attribute, as a mixed-language string (its first word in the
logon language, translated here) `"Released (From Last 2 Weeks)"`. Both requests measured as
modifiable earlier the same day (`DEVK900113`, `DEVK900117`) are **absent**.
Anything built on this route must state that scope; the
route cannot be asked to widen it, because the `?targets=` and `?user=` parameters that
would are the ones that empty the answer, and the date filter lives in a search
configuration whose creation is a **POST** and stays denied.

⚠️ **The list is not scoped to the caller's own requests.** Measured owners in one
answer: `DEVUSER1`, `DEVUSER2`, `DEVUSER3`. Two requests are owned by another developer and
appear because the caller holds a **task** inside them; one task inside a request the
caller owns belongs to a third person. So the route **names other people**, together with
their task descriptions. That is a smaller enumeration than `systemUsers` — it is the
people who worked alongside the caller, not the system's user list — but it is an
enumeration, and it is declared here rather than discovered later.

⚠️ **There is no `tm:all_objects` in the list answer.** The detail resource offers the
union node; the list does not. So the task rule above is not optional here — a reader of
the list that does not descend into `tm:task` under-reports every request. Measured
distribution in one answer:

| bucket | request | owner | own | tasks — owner/status:objects |
|---|---|---|---|---|
| workbench | `DEVK900110` | DEVUSER1 | 78 | 3 tasks, 0 + 38 + 37 |
| workbench | `DEVK900102` | DEVUSER1 | **0** | 1 task (DEVUSER3), 0 |
| workbench | `DEVK900106` | DEVUSER1 | 3 | 1 task, 2 |
| workbench | `DEVK900104` | **DEVUSER2** | 228 | 6 tasks, 7 + 1 + 121 + 32 + 13 + 98 |
| customizing | `DEVK900107` | DEVUSER1 | 7 | 1 task, 3 |
| customizing | `DEVK900105` | **DEVUSER2** | 3 | 2 tasks, 0 + 1 |

**And the "list" is a full dump.** 6 requests carry **672 `tm:abap_object` nodes**;
`DEVK900104` alone accounts for 500 of them. There is no summary form of this route and no
server-side paging parameter — the parameters that exist empty the answer. Any cap is
therefore **local, applied after the bytes have arrived**, and must say so rather than
look like a filter. `tm:attributes` is absent here, so the 97 `SAPCOMPONENT` rows per
released request do **not** appear in the list; that noise is a detail-resource cost only.

#### What the code does with all of this

Everything above is now wired, so the document and the behaviour can drift apart — read
these three together, and change all three when a re-measurement disagrees:

| where | what it holds |
|---|---|
| [`lib/adt-get.mjs`](../lib/adt-get.mjs) | the two routes. `transportList` declares **no parameters at all**, which is how "any query string empties the reply, silently" becomes a mistake nobody can express; `transportDetail` declares the one path segment and the alphabet it must be drawn from |
| [`lib/transport-requests.mjs`](../lib/transport-requests.mjs) | the task rule, the attribute projection, and the three traps. It also re-checks the recomputed union against the `tm:all_objects` the system sent, and files `SHAPE_DRIFT` when they disagree — the invariant above is asserted at runtime, not just written down here |
| [`tools/transport.mjs`](../tools/transport.mjs) | `adt_transport`: two modes and no default, the scope returned as data, and the local caps |

The fixtures in `tests/fixtures/transport-*.xml` are **rebuilt** from the facts above in the
structure of the real payloads — same discipline as `annotation-chain-measured.xml`. The
descriptions and object names in them are invented; the structure, the attribute sets and the
arithmetic are not.

#### Cross-check against a development system, 2026-09-09

`adt_transport` was run against all seven readings above. The counts below are the tool's;
they differ from the tables earlier in this section by exactly the `CORR` pseudo-entries,
which the tool reports as `comments` rather than as objects.

| request | half / status | own | in tasks | union | `tm:all_objects` | agree |
|---|---|---|---|---|---|---|
| `DEVK900113` | workbench / modifiable | 13 | 2 + 13 | **15** | 15 | ✅ |
| `DEVK900110` | workbench / released | 75 | 0 + 38 + 37 | 75 | 75 | ✅ |
| `DEVK900117` | customizing / modifiable | **0** | 4 | **4** | 4 | ✅ |
| `DEVK900107` | customizing / released | 6 | 3 | 6 | 6 | ✅ |
| `DEVK900101` | copies / **protected** | 28 | — | 28 | 28 | ✅ |
| `DEVK900119` | copies / released | 2 | — | 2 | 2 | ✅ |

**The projection loses nothing.** `DEVK900110` and `DEVK900107` appear in both modes, and
the two answers agree digit for digit — 75 / 75 / 75 and 6 / 3 / 6 — which is the only check
that can catch a projection quietly eating a node.

**The task rule, live.** In `DEVK900113` the two objects of the still-modifiable task
`DEVK900116` (`FUGR ZDEMO_FG_SCHAGR`, `TABU MASSFLDLST`) come back attributed to that task
alone: they are **not** in the request's own list. In `DEVK900117` all four objects are.

**The customizing frontier holds in THIS resource.** `DEVK900107` names `AGR_TIMEB`,
`USR10`, `USR11`, `UST12` and `WDY_CONF_USER` — five tables, and not one row of any of them.
The tool built on this section therefore reports table names and never table contents.

### `…/transportrequests/{number}/objectkeys` — the keys ARE exposed, MEASURED 2026-09-09

⚠️ **This section corrects a claim this file made twice.** Earlier rounds concluded that the
`E071K` key rows behind a `TABU` entry are "not exposed by this resource at all", on eight
closed avenues: the detail resource accepts exactly one media type (enumerated from a 406),
the list accepts only the tree type, `/cts/transports` accepts only POST payloads, the element
census found eight elements and no undeclared one, zero elements carry text, `tm:abap_object`
has exactly nine attributes and none is key-shaped, no needle (`E071K`, `tabkey`, `obj_key`,
`as4pos`, `viewname`) appears in either document, and `E071K` is absent from both Clean Core
catalogues. **Every one of those eight is true, and the conclusion drawn from them was
wrong**: they all measured the two organizer resources, and the keys live on a third.

The path to it is one the server publishes itself. The `tm:dummy_uri` written into every
`tm:abap_object` is missing the `tr_number` its own handler requires; supplied, that reference
resource returns 200 and a link named `objectkeys`. That resource speaks exactly one media
type — `application/vnd.sap.adt.transportorganizer.objectkeys.v1+xml`, enumerated from its own
406 — and answers:

```xml
<tk:objectKeys tk:objName="AGR_TIMEB" tk:objType="TABU" tk:objPgmId="R3TR"
               tk:objDesc="Time stamp for role (profile generation)">
  <tk:tableKeys tk:isReadOnly="true">
    <tk:tableKey tk:tableName="AGR_TIMEB" tk:position="000001"
                 tk:value="001ZDEMO_ROLE_SAMPLE_001         GENERATE"/>
  </tk:tableKeys>
  <tk:tables>
    <tk:table tk:isStringTable="false" tk:name="AGR_TIMEB">
      <tk:keyField tk:name="MANDT"    tk:type="C" tk:postion="0001" tk:length="000003" tk:offset="000000"/>
      <tk:keyField tk:name="AGR_NAME" tk:type="C" tk:postion="0002" tk:length="000030" tk:offset="000003"/>
      <tk:keyField tk:name="AGR_TYPE" tk:type="C" tk:postion="0003" tk:length="000010" tk:offset="000033"/>
    </tk:table>
  </tk:tables>
</tk:objectKeys>
```

**It is `E071K`, field for field.** Cross-checked against an export of the table itself:
`tk:value` is `TABKEY`, `tk:position` is `AS4POS`, `tk:tableName` is `OBJNAME`, `tk:objPgmId`
is `PGMID`. The `tk:keyField` block is the part that makes the claim unarguable — it is not a
label, it is the **layout to decompose the packed key**, and the declared offsets (0 / 3 / 33)
are exactly the field widths that reconstitute `MANDT` + `AGR_NAME` + `AGR_TYPE` from the flat
`TABKEY`. `tk:postion` is spelled that way in the payload; it is not a transcription slip here.

`pgmid` in the query string is **ignored** — the reply is byte-identical with and without it,
1475 bytes both times.

**Two refusals, and they mean different things.** A wrong `Accept` gives **406** with the one
acceptable type. An unknown parameterisation gives **400** with a six-byte body, `I::000` — and
that is what an earlier round mistook for "dead end" while three genuinely absent paths
answered *"Resource controller does not support method GET"*. The difference between those two
messages was the whole signal.

⚠️ **`I::000` does not mean "this object has no keys".** Measured against the exported
`E071K`: the customizing request `DEVK900117` answers `I::000` for `CDAT BUPAFLDMOD`, and the
table shows why — the request owns **no key rows at all**; its nine rows are registered under
its open task `DEVK900118`, and they are keyed by the **physical table** (`OBJNAME` = `TBZ3R`,
`TBZ3H`, `TBZ1C`…) with `MASTERTYPE`/`MASTERNAME` pointing back to the customizing object
(`CDAT BUPAFLDMOD`) and `VIEWNAME` to the maintenance view (`V_TBZ3R`). So the task rule
recorded above governs the keys as well, and the identifier that addresses them is not the one
the object list shows. **What those key rows contain is business configuration** — one of them
reads `001BUPAGS_KNA1 … ZZ1_DEMODELIVERY_CUS … 0600`, which names a customer field
configuration, not a table name.

#### The full census, MEASURED (151 GETs over 6 requests and their tasks)

Everything below is cross-checked against an export of `E070` / `E071` / `E071K` from the
same system, kept out of the repository (the state directory's `measurements\` folder).

**1. Addressing is per CARRIER, and by the identifier the object list shows.** This is the
rule the tool has to obey, and getting it wrong looks exactly like "this object has no keys":

| asked | answer |
|---|---|
| task `DEVK900116` + `TABU MASSFLDLST` | **200**, one key |
| request `DEVK900113` + `TABU MASSFLDLST` (same object, via the task) | **400 `I::000`** |
| task `DEVK900118` + `CDAT BUPAFLDMOD` | **200**, 4 keys over 3 tables |
| task `DEVK900118` + `TABU TBZ3R` (the physical table `E071K` keys by) | **400 `I::000`** |
| task `DEVK900118` + `VDAT V_TBZ3R` (the `E071K` `VIEWNAME`) | **400 `I::000`** |
| request `DEVK900117` + any of its four objects | **400 `I::000`** |

So: ask the carrier that the object is attributed to, with `objName`/`objType` **verbatim
from `tm:abap_object`** — including embedded spaces, which occur (`ATOW` objects are named
`"CFDF      ZZ1_DEMODELIVERY"` and answer 200 when the value is URL-encoded).

**2. ⚠️ `tk:position` is the discriminator between a transported key and a key TEMPLATE.**
A reply mixes two kinds of `tk:tableKey` and only one of them is an `E071K` row:

- **with `tk:position`** — a real transported key. For `DEVK900107` the resource returned
  exactly the 26 rows the table holds, table by table: `AGR_TIMEB` 1, `USR10` 1, `USR11` 1,
  `UST12` 7, `WDY_CONF_UDEF` 4, `WDY_CONF_USER` 4, `WDY_CONF_USERT` 4, `WDY_CONF_USERT2` 4.
- **without `tk:position`** — the object's key template. The `ACGR` role object returns 28 of
  these (`AGR_1016`, `AGR_1250`, `AGR_TCODES`, …) and **`E071K` contains zero `ACGR` rows**. A
  parser that treated every `tk:tableKey` as a transported key would invent 28 entries per role.

Counted over the sweep: **58 positioned, 106 template** out of 164.

⚠️ **The wildcard is NOT the discriminator, and an earlier draft of this section said it was.**
Measured over a second sample: **23 positioned keys contain `*`** and **6 template keys do
not**. A generic key range is ordinary `E071K` semantics — the seven transported `UST12` rows
each carry `FIELD="*" VON="" BIS=""`, and they are in the exported table. So `*` says the key
is generic, `tk:position` says the key was transported, and only the second one separates the
two kinds. `tk:viewName`, measured on **8 positioned and 0 template** keys, points the same way
as `tk:position`.

**3. The declared layout decodes every key.** 164 keys, 508 `tk:keyField` elements, **0
decode failures and 0 non-blank leftovers**. Worked examples, all reproducing `E071K-TABKEY`:

```
TABU AGR_TIMEB    [1] AGR_TIMEB  MANDT=001 AGR_NAME=ZDEMO_ROLE_SAMPLE_001 AGR_TYPE=GENERATE
TABU UST12        [7] UST12      MANDT=001 OBJCT=ZDEMO_AUTH AUTH=T-S478040900 AKTPS=A FIELD=*
CDAT BUPAFLDMOD   [1] TBZ3R      CLIENT=001 OBJAP=BUPA TABNM=GS_KNA1 FLDNM=ZZ1_DEMODELIVERY_CUS FLDGR=0600
CDAT BUPAFLDMOD   [2] TBZ3R      CLIENT=001 OBJAP=BUPA TABNM=KNA1    FLDNM=ZZ1_DEMODELIVERY_CUS FLDGR=0600
VDAT V_TBZ1C      [1] TBZ1C      CLIENT=001 OBJAP=BUPA DYNPTABNM=GS_KNA1 DYNPFLDNM=ZZ1_DEMODELIVERY_CUS
TABU MASSFLDLST   [1] MASSFLDLST OBJECT=KNA1 TABNAME=KNA1 FIELDNAME=ZZ1_DEMODELIVERY_CUS
```

Note the last one: `MASSFLDLST` has **no client field**, so a decoder must not assume a
leading `MANDT`. The layout is the authority, never a convention.

**4. Complete vocabulary — seven elements, no text anywhere.** Censused with no allowlist
over 21 replies:

| element | attributes |
|---|---|
| `tk:objectKeys` | `tk:objName`, `tk:objType`, `tk:objPgmId`, `tk:objDesc` (missing on 2 of 21), `xmlns:tk` |
| `tk:tableKeys` | `tk:isReadOnly` — **both `true` and `false` occur** |
| `tk:tableKey` | `tk:tableName`, `tk:value`, `tk:position` (58/164), `tk:viewName` (13/164) |
| `tk:tables` | — |
| `tk:table` | `tk:name`, `tk:isStringTable` (only `false` seen) |
| `tk:keyField` | `tk:name`, `tk:type`, `tk:length`, `tk:offset`, `tk:postion` *(sic)*, `tk:label` (always empty) |
| `atom:link` | `href`, `rel`, `title`, `type` — `adturi`, `objectkeys`, `objectkeys/checkruns` |

**`elements carrying TEXT: 0`** — everything is in attributes.

**5. `tk:viewName` is `E071K-VIEWNAME`**, and it is what says a key was maintained through a
maintenance view rather than on the table directly (`V_TBZ3R`, `V_TBZ3W`, `V_TBZ3E`, `V_TBZ3S`).
Present on 13 of 164 keys, so it is optional and must not be required.

**6. Most workbench objects have no keys, and say so with the same `400 I::000`.** 109 of the
sweep's objects answered that way: `DDLS`, `DEVC`, `DOMA`, `DTEL`, `FUGR`, `TABL`, `CINC`,
`CLSD`, `CPRI`, `CPRO`, `CPUB`. Since the SAME status also means "wrong carrier" (row 2 of the
table above), `400` alone can never be reported as "this object has no keys".

**7. Two things this census did NOT settle, and they are open, not absent.**

- ✅ **`tk:type` `I` and `b` — measured, and they never reach a transported key.** The whole
  population contains exactly two non-character key fields: `AGR_HIER_BOR.UNIQUE_NR` (`I`,
  declared length 2) and `CFD_W_REP_SCN_SP.SEQUENCE_NUMBER` (`b`, length 1). **Zero positioned
  keys belong to either table** — both appear only in key templates. So character-offset
  slicing is only ever applied to `C`/`N` fields. This clears the population measured, not the
  type system: a decoder must still REPORT a non-character field rather than slice it silently,
  because the day one appears in a transported key the slice would be wrong with no leftover to
  give it away.
- ✅ **The DDIC cross-check ran, and the CTS layout IS the DDIC's.** The easy road was
  closed first: `/sap/bc/adt/ddic/tables/<t>` answers `406` whose body enumerates **nothing**
  (unlike every CTS resource), and six guessed media types all earned `406`. The road that
  works is the client's own DDIC readers, already in the guard's allowlist — so **no line of
  `lib/guard.mjs` changed in order to measure**, the same rule that governed every earlier
  round. `ddicElement('AGR_TIMEB')` returns each field with `ddicIsKey`, `ddicDataElement`,
  `ddicDataType` and `ddicLength`. Three tables, chosen to break an assumption rather than
  confirm one:

  | table | DDIC key fields, in order | CTS declares | offsets |
  |---|---|---|---|
  | `AGR_TIMEB` | `mandt` clnt 3 · `agr_name` char 30 · `agr_type` char 10 | `MANDT(C,3)` `AGR_NAME(C,30)` `AGR_TYPE(C,10)` | 0 / 3 / 33 |
  | `TBZ3R` | `client` · `objap` · `tabnm` · `fldnm` · `fldgr` (type `N`) | same names, same order | 0 / 3 / 7 / 37 / 67 |
  | `MASSFLDLST` | `object` · `tabname` · `fieldname` — **no client field** | same names, same order | 0 / 10 / 40 |

  Same fields, same order, same lengths, and in all three the offsets are exactly cumulative.
  Grounded once more outside the payload: data element `AGR_NAME` reports `dataTypeLength: 30`
  and `MANDT` reports `3`. **The CTS is repeating the DDIC, not inventing a layout.**

  Two gotchas worth keeping, both measured here:
  - **`tk:type` is the ABAP internal type class, NOT the DDIC data type.** `MANDT` is `CLNT`
    in the DDIC and `C` in the CTS payload. Comparing the two strings directly would report a
    mismatch that is not one.
  - **`ddicElement` answers on the NAME, not the URL.** `ddicElement('AGR_TIMEB')` returns the
    full field list; `ddicElement('/sap/bc/adt/ddic/tables/agr_timeb')` returns
    `{type: undefined, name: undefined, children: []}` — an empty answer, not an error. And
    `objectStructureElements(structure)` throws `url.match is not a function`: it wants a URL
    string, not the structure object the neighbouring method returns.

**Status of this route in this server: MEASURED AND BUILT — 2026-09-09.** It was refused
first, on the frontier argument ("the repository, never the contents of a table"), and the
refusal was **overridden the same day by the repository owner**, whose requirement is to
read everything, key decoded included. The reversal and the reason it is sound are recorded
in [`security.md`](security.md). What exists now:

| piece | where |
|---|---|
| route `transportObjectKeys` (segment + literal `suffix`, both params required) | `lib/adt-get.mjs` |
| parser, offset decoder, drift census | `lib/object-keys.mjs` |
| carrier-aware, budgeted sweep | `collectObjectKeys` in the same module |
| `adt_transport({number, keys: true})` | `tools/transport.mjs` |
| rebuilt fixtures (values recomputed from the declared lengths, never pasted) | `tests/fixtures/objectkeys-*.xml` |

Four measured facts are enforced by a test rather than a comment: the carrier is the task
(not its parent request); `tk:position` alone separates a transported row from a key
template; a non-character field is reported and never sliced; and `400` is reported as
*unresolved for the carriers tried*, never as "this object has no keys".

⚠️ **`objectkeys/checkruns` was deliberately not probed.** A CTS "checkrun" plausibly CREATES
a run on the server, and a GET that creates server state is a write with a GET verb. Its
absence from every measurement here is a decision, not an oversight.

### `…/transportrequests/reference` — a FORWARD resolver, not a reverse lookup — MEASURED 2026-09-09

The question was: **can this server list the transports that carry a given object/table/view?**
The discovery template made it look like yes —
`/sap/bc/adt/cts/transportrequests/reference{?obj_name,obj_wbtype,pgmid}`, three parameters
that name an object and no transport — and the server writes that URL, already assembled,
into **every** `tm:abap_object` as `tm:dummy_uri`. **The answer is no**, and now it is measured
instead of asserted.

⚠️ **Read that as an answer about THIS resource, not about the system.** The reverse lookup
does exist — it is the object's **version history**, measured and recorded below.
What is settled here is that the CTS collection does not offer one.

⚠️ **Every bare call answers `400 ExceptionParameterNotFound`: "Parameter tr_number could not
be found."** — including the `tm:dummy_uri` **verbatim, exactly as the server wrote it**, which
was tried first for that reason. Four `Accept` values were tried (bogus, none, organizer,
tree) and the parameter check happens **before** content negotiation, so the 406 trick cannot
even reach this resource. Measured over 680 `tm:dummy_uri` occurrences, three of them called
unmodified, plus twelve reconstructed calls across three deliberately different classes of
object.

So `tm:dummy_uri` is **a structurally incomplete template**, not a link: the IDE repairs it
with the transport it is currently displaying. The resource resolves *(transport, object) →
link*, never *object → transports*.

That also disposes of four hypotheses stated before the reading — "the request that contains
it now" / "the last one" / "the one that locks it" / "all of them". **None of them is
testable on this resource**, because it never answers without a transport number. The three
classes built to separate them (object in one released request; object in several; object
locked by an open task) all behaved identically: `400` bare, `200` with `tr_number`.

**What the 200 reply is worth, and it is not nothing.** The body is ~300–360 bytes,
`tm:root` with **one** `atom:link` and no other element, and ⚠️ **the `rel` depends on the
object type** — which makes it a per-object statement of *which kind of thing this is*:

| `rel` | objects measured | `href` |
|---|---|---|
| `…/cts/relations/objecturi` | `LIMU CINC/CLSD/CPRI/CPRO`, `R3TR DEVC/DOMA/FUGR/PROG` | the object's own ADT URI |
| `…/cts/relations/objectkeys` | `R3TR CDAT` ×3, `R3TR VDAT` | `…/transportrequests/<carrier>/objectkeys?objName=…&objType=…` |

Two consequences worth keeping:

- **The TADIR → ADT URI mapping does not have to be invented** — the server performs it:
  `DEVC ZDEMO_EXPENSES` → `/sap/bc/adt/packages/zdemo_expenses`, `DOMA ZDEMO_PROFILE` →
  `/sap/bc/adt/ddic/domains/zdemo_profile`, `FUGR ZDEMO_V_0088` →
  `/sap/bc/adt/functions/groups/zdemo_v_0088`, `PROG …` → `/sap/bc/adt/programs/programs/…`,
  `CINC …CCAU` → `…/oo/classes/<c>/includes/testclasses`.
  ⚠️ `CPRI` and `CPRO` both resolve to the **same** `…/source/main`: a LIMU sub-object maps to
  its containing source, so the mapping is not injective.
- **The server itself says which objects have table keys**, per object and per carrier,
  instead of the type census `lib/object-keys.mjs` uses. It costs one call either way, so it
  is not cheaper — but it is authoritative where the type list is only measured.

**🔎 The reverse lookup exists somewhere else, and this round found the lead by accident.**
`objectStructure` on a class returns, among its `links`:

```
href:  /sap/bc/adt/oo/classes/<name>/transports
rel:   http://www.sap.com/adt/relations/transport
type:  application/vnd.sap.as+xml;charset=utf-8;dataname=com.sap.adt.lock.result2
title: Related Transport Requests
```

A **per-object** sub-resource, published on the object rather than on the CTS collection.
⚠️ It is **not measured**, and it is not to be assumed benign: `dataname=com.sap.adt.lock.result2`
is the vocabulary of the lock/transport-check flow, and `transportInfo` was refused in this
repository precisely because a "read" whose semantics is *I am about to modify this object*
is a write. Whether a plain GET on this href checks a lock, creates one, or merely lists —
**unmeasured**. It gets its own round, or it stays out.

### `/sap/bc/adt/cts/valuehelp/*` — five forms tried, all 404 — MEASURED 2026-09-09

Discovery publishes `/sap/bc/adt/cts/valuehelp/{attribute,target,ctsproject,object/{field}}`.
All four literal forms plus `object/name` answered **404**, and — unlike a genuinely absent
ADT path, which answers *"Resource controller does not support method GET"* — this 404 carried
no ADT exception at all (`Request failed with status code 404`, no `type`). So the template is
**not literal**, and what it wants is unknown. Recorded as measured-and-unresolved: nothing is
built on it, and "it does not exist" is **not** what was measured.

### `E071` field list, and a trap in `ddicElement` children — MEASURED 2026-09-09

`ddicElement('E071')` returns the transport object-entry table:
`trkorr` (key, `trkorr`, char 20) · `as4pos` (key, `ddposition`, numc 6) · `pgmid` (`pgmid`,
char 4) · `object` (`trobjtype`, char 4) · `obj_name` (`trobj_name`, char 120) · `objfunc`
(`objfunc`, char 1) · `lockflag` (`lockflag`, char 1) · `gennum` (`trgennum`, char 3) ·
`lang` (`spras`, lang 1) · `activity` (`tractivity`, char 20).

⚠️ **Two traps, both of which bit on the way to that list.**

1. `children` is **not** a field list. The last child of `E071` is
   `{type: 'DEVC/K', name: 'SCTS_REQ'}` — the **package**, not a column. Anything counting
   `children.length` as a field count is off by one, per table. Filter on `type === 'TABL/DTF'`.
2. The properties are **nested**: `child.properties.elementProps.ddicDataElement`, not
   `child.ddicDataElement`. Reading them off the child yields `undefined` for every field with
   no error — which is exactly what happened in this round and cost the `tm:obj_func`
   question. (The DDIC agreement recorded above for `AGR_TIMEB`/`TBZ3R`/`MASSFLDLST` is
   unaffected: those values were read off the printed raw structure, not through an accessor.)

**`tm:obj_func` stayed OPEN for two rounds for the same reason**, one level further out.
`getDataElementProperties` is nested the same way: the reply is `{metaData, properties}`,
and a sweep over its **top-level** string values finds none, so the domain call was never
made. ⚠️ **Two rounds lost to one shape.** The name was in the reply all along, at
`properties.typeName`.

### The domain `OBJFUNC` and its six values — MEASURED 2026-09-10

Closed by a recursive sweep of the two replies (transcript in
`measurements/objfunc-2026-09-10/`). Three allowlisted reads, nothing written:

- `E071-OBJFUNC` → data element `objfunc`, `CHAR(1)`, package `SCTS_REQ`
  (*CTS: Request Editing*), master language DE, labels all `Funktion` /
  `Objektfunktion`. No `searchHelp`, no `setGetParameter`.
- `properties.typeName = 'OBJFUNC'` names the domain, and
  `getDomainProperties('objfunc')` → `properties.valueInformation.fixValues` is the list.
  The system carries **no translation** — `adtcore:language="PT"` on the reply, text in DE:

| code | domain text (the system carries it in German only; translated) |
|---|---|
| *(blank)* | Normal case: transport to the target system (see also F1 help) |
| `D` | Object was deleted (only possible with deleted objects) |
| `M` | Delete and re-create on the database |
| `K` | **Object key according to entries in the key list** |
| `A` | Key was archived via SARA |
| `C` | User-defined conversion |

So the attribute is **not** a customizing marker and never was: `K` says *this entry has
rows in the key list* (`E071K`), and that is a property an entry of any type can have. It
is the predicate `lib/object-keys.mjs` was approximating with a hand-kept type census.

**Cross-checked offline** against an `E071` × `E071K` export of the same system
(**8** requests, 150 entries, kept out of the repository): blank → **no** `E071K` row,
**136/136**; `K` → `E071K` rows present, **14/14** — 10 keyed under the entry's own name,
and 4 (`CDAT BUPAFLDMOD`, `CDAT BUPA_TBZ3E`, `CDAT BUPA_TBZ3C`, `VDAT V_TBZ1C`, all in
`DEVK900118`) keyed under the **physical table** (`TABU TBZ3R`, `TBZ3E`, …) with
`MASTERTYPE`/`MASTERNAME` pointing back at the `CDAT`/`VDAT` entry — the same indirection
the `objectkeys` route already resolves through `tk:tableName`/`tk:viewName` (see
*`tk:tableKey`*, above). Zero counter-examples in either direction.

Two reservations, stated so the reading is not overread: `D` was seen only in the ADT
transport document (`METH/D`, `DOMA/D`, `FUGR/D`, `TOBJ/D`, `TRAN/D` — deleted objects,
which the CSV export does not contain), `M`/`A`/`C` were **never observed in use** on this
system, and the offline sample is 8 requests. Two facts of shape: the raw
domain document is `application/vnd.sap.adt.domains.v2+xml` (200, 3 167 bytes — the type
the **version feed declared** for domains), and `…/domains/objfunc/source/main` answers
**404**: a domain is not a source-bearing object in ADT.

### Object version history — THE reverse lookup — MEASURED 2026-09-10

The CTS collection has no reverse lookup (see the `reference` section above). The object
does. **This is the resource that answers "which transports carry this object", and it is
a plain read**: version history is written when a transport is *released*, so reading it
creates nothing. It was found by following two pointers that were already in hand — the
`rel = http://www.sap.com/adt/relations/versions` link that `objectStructure` publishes,
and the fact that the client library's own `extractVersion` hunts inside each version
entry for a link typed `application/vnd.sap.adt.transportrequests.v1+xml`.

**The falsifiable test was stated before the reading.** `ZCL_DEMO_EXPENSE_SYNC` had been
measured in the previous round as carried by `DEVK900110` and `DEVK900104`. Its version
feed names both. The reverse lookup is proven against an independent fact, not by the
resource agreeing with itself.

#### The path is published, never constructed — and its shape depends on the object type

| object | what `objectStructure` publishes with `rel …/relations/versions` | reply |
|---|---|---|
| `CLAS` | **five** links, `includes/{definitions,implementations,macros,testclasses,main}/versions`, and **none on the object itself** | 200, 37 812 – 41 797 bytes each |
| `PROG` | `source/main/versions` | 200, 11 410 bytes |
| `DOMA` | `versions` | 200, 6 869 bytes |

Three different shapes for three object types. ⚠️ **A URL assembled from a convention will
be wrong for two of these three.** Take the `href` from `objectStructure` and resolve it
against the object URI, the way `followUrl` does.

`Accept: application/atom+xml;type=feed`, and that is not a preference — a bogus `Accept`
on the same URL answers `406 ExceptionResourceNotAcceptable`:
`Accepted content types: application/atom+xml;type=feed`. One type, no negotiation.

#### The entry, element by element

The census was taken with no allowlist. On `…/includes/main/versions`: `atom:feed` 1,
`atom:entry` 46, `atom:title` 47, `atom:updated` 47, `atom:author` 46, `atom:name` **45**,
`atom:content` 46, `atom:id` 46, `atom:link` 92. Attributes: `atom:content/@type`,
`atom:content/@src`, `atom:link/@adtcore:name`, `@href`, `@rel`, `@type`, `@title`, and
`atom:entry/@adtcore:isTestTransport` (42 of 46).

| node | what it carries |
|---|---|
| `atom:id` | **the version number** — `00012`, `00007`, … and `00000` |
| `atom:content/@src` | the URI of *that version's content* (`…/versions/<stamp>/<id>/content`) |
| `atom:content/@type` | `text/plain` for source, `application/vnd.sap.adt.domains.v2+xml` for a domain |
| `atom:author/atom:name` | the user who wrote the version (`DEVUSER1`, `DEVUSER2`) |
| `atom:updated` | when |
| `atom:title` | ⚠️ **the transport's description**, not a version title |
| `atom:link` ×2 | both `rel="http://www.sap.com/adt/relations/transport/request"` |

The two links differ only by `type`: one is `application/vnd.sap.sapgui` with an
`/sap/bc/adt/vit/wb/…` href (the GUI jump), the other is
`application/vnd.sap.adt.transportrequests.v1+xml` with
`href="/sap/bc/adt/cts/transportrequests/<number>"` — **the CTS URI, pre-assembled**, which
is the same courtesy the `reference` resource does. **`adtcore:name` is the transport
number** on both.

#### ⚠️ Three ways this resource will lie to a reader that does not know better

Each one produces a wrong answer with **no error at all**. They are the reason a route over
this resource is not a one-liner.

**1. A class keeps FIVE independent histories, and asking one is a silent undercount.**
Real (non-copy) requests seen per include of `ZCL_DEMO_EXPENSE_SYNC`:

```
definitions      42 entries   1 request    DEVK900104
implementations  42 entries   1 request    DEVK900104
macros           42 entries   1 request    DEVK900104
testclasses      46 entries   2 requests   DEVK900104, DEVK900110
main             46 entries   3 requests   DEVK900104, DEVK900110, DEVK900115
```

Three of the five includes answer `1/2` on the cross-check and look perfectly healthy doing
it. Over all five, the union of transport-shaped strings is 45 and the intersection is 41.
`main` happened to be a superset of every other include here — **that is one class, not a
rule**, and the safe operation is the union.

**2. The feed is dominated by transports of copies.** 45 distinct numbers in the class
feed; **3** are real requests. The discriminator is the server's own
`adtcore:isTestTransport="true"` on the `atom:entry` — **not** the `"CP - "` prefix that
happens to start those titles, which is one developer's habit. Counts:

```
CLAS …/main      46 entries   3 real   42 copies   0 without a link
PROG ZDEMO_RPT_…      13 entries   2 real    9 copies   1 without a link
DOMA ZDEMO_DOM_…     8 entries   2 real    4 copies   1 without a link
```

A reader that ignores the attribute reports 45 transports for this class, 93 % of it noise.

**3. Version `00000` is the ACTIVE version, and its link is the "who holds it now" answer.**
It carries a transport link only while the object sits in an **open** request; otherwise the
entry comes back with `atom:title` absent and **no `atom:link` at all** (the `noLink=1` above,
and the `atom:name` count of 45 against 46 entries — one entry has no author either).

#### ⚠️ The library's own projection must not be used

`node_modules/abap-adt-api/build/api/revisions.js`, `extractVersion`, finds the
transport-typed link and returns its `@_adtcore:name` — the **transport number** — and
`revisions()` stores it in `Revision.version`. The interface is
`{uri, date, author, version, versionTitle}`: there is **no transport field**, and the real
version number (`atom:id`) has nowhere to go. So the library labels the transport as the
version and drops the version entirely. `adtcore:isTestTransport` is not read at all.

Same defect class as `userTransports`: the bytes are correct, the projection eats them.
`revisions` is **not** in this server's allowlist and does not need to be — this resource is
read as raw XML through `transportFor()`, like every other measurement here. In delivered
code that read is `derivedGet` (`lib/adt-get.mjs`): a link the server published, accepted
only when it resolves under the object's own URI and ends in `/versions`; the parser and the
three rules above live in `lib/object-versions.mjs`, and the caller is
`adt_transport({object: {name, type}})`.

#### A boundary this resource opens, and which is not crossed

`atom:content/@src` returns **the source of an old version** of a Z object. That is a real
capability and it is a different question from "which transports carry this object". Nothing
in this repository follows that link; a reader built on this feed reports the version
*header* — number, timestamp, author, transport, `isTestTransport` — and stops there.

### `…/<object>/transports` — a read after all, and much narrower — MEASURED 2026-09-10

`objectStructure` also publishes `href …/<object>/transports`, `rel
…/adt/relations/transport`, title "Related Transport Requests", declared type
`application/vnd.sap.as+xml;charset=utf-8;dataname=com.sap.adt.lock.result2`. The
`dataname` is lock vocabulary, and this repository refused `transportInfo` for exactly that
reason, so the call was **fenced**: the `tm:lock_status` of every `ZCL_DEMO_EXPENSE_SYNC`
entry in `DEVK900110` was read from `transportDetail` before and after and compared.

```
GET /sap/bc/adt/oo/classes/zcl_demo_expense_sync/transports
->  200  application/vnd.sap.as+xml; charset=utf-8; dataname=com.sap.adt.lock.Result2  391 bytes

<asx:abap version="1.0"><asx:values><DATA>
  <LOCK_HANDLE/><CORRNR>DEVK900115</CORRNR><CORRUSER>DEVUSER1</CORRUSER>
  <CORRTEXT>…</CORRTEXT><IS_LOCAL/><IS_LINK_UP/><MODIFICATION_SUPPORT/>
  <LINK_UP_MODE/><CORR_LOCKS/><CORR_CONTENTS/><SCOPE_MESSAGES/>
</DATA></asx:values></asx:abap>

⚖️  LOCK STATE UNCHANGED: true      (26 objects, lock=3 before and after)
```

**`LOCK_HANDLE` comes back empty and nothing moved: it is a read.** (Note the reply's
`dataname` capitalises `Result2` where the published link says `result2`.)

But it answers a much smaller question than the version feed: **one** number, the open
request holding the object right now — which the version feed's `00000` entry already
gives, alongside the whole history. Measured, benign, and superseded.

### `/repository/nodestructure` — descriptions shifted by one row, POST-only — MEASURED 2026-09-12

`nodeContents('DEVC/K', 'YDEMO_ROOT')` returns **11** `SEU_ADT_REPOSITORY_OBJ_NODE`: one folder
node (`OBJECT_NAME` empty, `NODE_ID` 2, the "Subpacotes" folder the tree draws) and ten
packages. Every node carries the same 22 keys (`OBJECT_TYPE`, `OBJECT_NAME`, `TECH_NAME`,
`OBJECT_URI`, `OBJECT_VIT_URI`, `EXPANDABLE`, `IS_*` ×9, `VISIBILITY`, `NODE_ID`,
`PARENT_NAME`, `DESCRIPTION`, `DESCRIPTION_TYPE`, `VERSION`, `INACTIVE_TYPE`). And the
`DESCRIPTION` on each row is the **next** row's:

```
(folder)  ->  "Basis/Cross/ABAP Development"   (YDEMO_BASIS's)
YDEMO_BASIS       ->  YDEMO_CO's
YDEMO_CO       ->  YDEMO_DUMMY's
…
YDEMO_SD       ->  YDEMO_TM's
YDEMO_TM       ->  ""
```

10 of 10 differ from the search's description of the same name; 9 of the 10 carry exactly
the next package's. The library's parser is **one object per XML element**
(`xmlArray(root, 'TREE_CONTENT', 'SEU_ADT_REPOSITORY_OBJ_NODE')`, then `node.DESCRIPTION ||
""`): nothing on the client can move a child element across siblings, so **the server pairs
them that way**. The raw bytes could not be read to prove it a second way: the resource is
**POST-only** — a GET answers `405 ExceptionMethodNotSupported: Resource controller does not
support method GET`, with and without `Accept` — and the GET-only seam is not widened for a
diagnosis. `adt_search(name, 'DEVC/K')` answers the same names with the correct text, so the
tool carries the tree's text as `treeDescription` and offers `describe: true` (one search per
sub-package). Realigning by one is *not* done: one package with one folder is not a rule for
a package with five type folders. Proving the shift on the raw bytes would need a POST read;
**decided 2026-09-14: not needed** — the search already answers the right text, and the
GET-only seam stays. This is the rule, not an open item.

### `/enhancements/enhoxh/<name>` — HTTP 500 is the resource dumping — MEASURED 2026-09-12

All **3 of 3** class enhancements (`ENHO/XH`) on the system: `ZCL_DEMO_UTILITIES`,
`ZENH_DEMO_XML_DOWN`, `ZDEMO_BP_INTEGRATION_INT`, all in `ZDEMO_PKG`, all returned normally
by the search with URI `/sap/bc/adt/enhancements/enhoxh/<name>`. Per object, seven reads:

| read | answer |
|---|---|
| `objectStructure(uri)` — the library, `Accept: */*` | **500** |
| raw GET, `Accept: */*` | **500** |
| raw GET, `application/vnd.sap.adt.enh.v1+xml` | 406 |
| raw GET, `application/vnd.sap.adt.enh.enhoxh.v1+xml` | 406 |
| raw GET, `application/vnd.sap.adt.enhancements.v1+xml` | 406 |
| raw GET, `application/xml` | 406 |
| raw GET `…/source/main`, `text/plain` | 404 |

The 406 bodies say only *"The message content is not acceptable"* — they do **not** enumerate
the accepted types, unlike the version feed's 406. So the one `Accept` that passes negotiation
(`*/*`) is the one that reaches the resource, and the resource **dumps**. The ST22 record of
the `*/*` call (12.09.2026 14:35:52, caller port 44300, URI
`/sap/bc/adt/enhancements/enhoxh/zdemo_bp_integration_int`): `OBJECTS_OBJREF_NOT_ASSIGNED_NO`
/ `CX_SY_REF_IS_INITIAL` in `CL_ENH_ADT_ENHO_OBJ_PERSIST->GET_DATA_FROM_TOOL`, include
`CL_ENH_ADT_ENHO_OBJ_PERSIST===CM00F` line 30, component `BC-DWB-AIE-SRC` — *"Access using a
'ZERO' object reference is not possible"*.

**The cause is in the source, read live through this server the same day**
(`adt_read_source('CL_ENH_ADT_ENHO_OBJ_PERSIST')`, package `SEEF_ADT_IMPL_COMMON`).
`get_data_from_tool` creates its result object in a `CASE` over the enhancement's tool type
with exactly **two** branches — `cl_enh_tool_badi_impl=>tooltype` (`BADI_IMPL`) and
`cl_enh_tool_hook_impl=>tooltype` (`HOOK_IMPL`) — and **no `WHEN OTHERS`**; the next
statement is `r_object_data->if_wb_object_data_model~set_object_name( … )`. A class
enhancement's tool is `CL_ENH_TOOL_CLASS`, `tooltype = 'CLASENH'` (read live, constant at
the top of the class): neither branch matches, `r_object_data` stays initial, and line 30
dereferences it. The `WHEN OTHERS` that would answer *"tool type not supported"*
(`e017(seef_adt_common)`) sits in a second `CASE` further down, after the dump. The
`calculate_etag` and `set_data_to_tool` methods have the same two branches.

So this is **not API misuse and has no `Accept`, no `?version=`, no parameter that cures it**:
the persistence behind `/enhancements/enhoxh/*` supports BAdI implementations and source-code
hooks only; the `enhoxh` URI the search publishes for a class enhancement leads to code that
cannot represent it. The IDE does not read it through this resource either — Eclipse opens a
class enhancement in the embedded SAP GUI (SE19). A fourth `ENHO/XH`, created clean, would
dump the same way; the three pre-existing objects are not the variable.

⚠️ **A failed read is not an absent enhancement.** `adt_object_info` on an `ENHO/*` says
*exists but could not be read*, names this cause, and files `ENHANCEMENTS_NOT_READ`; the
three stay *unanswered*, never *empty*. What a class enhancement implants (pre/post/overwrite
exits, added methods and attributes) was then looked for from the enhanced class's side — its
enhancement includes, the enhanced object's implementations, the search index — and **none of
those routes represents the type** (section *`ENHO/XH` has no model in the ADT*, 2026-09-14):
the tools read `objectproperties` instead and never ask the structure.

### Source text comes decoded — bytes are not the unit — DECIDED 2026-09-12

`adt_read_source` returns text (UTF-8, LF), never the bytes the system would export. A consumer
that needs a dump matching a SAP GUI export **byte for byte** (cp1252, CRLF) has to re-encode
on its side; this server will not. The one such consumer, an include-exit inventory, was
born as a SAP GUI export with a trailing `Texts` block (text elements — a different ADT
resource, `/textelements`, not read here), and the attempt to keep that wrapping and swap only
the ABAP was not stable: the blank lines before `Texts` grew by two on every run (measured
2026-09-12). It was dropped by decision, and the three catalogues (`include-exits`,
`enhancements`, `vofm`) now write the read as it comes. Re-encoding, if ever needed, belongs to
the consumer.

### VOFM routines: the carrier include is the source of the text — MEASURED 2026-09-12

A VOFM routine (`RV64A953`, `RV61A952`, …) is a `PROG/I` whose name follows the rule in
`SAPMV80H` (`xd0200_include_namen_setzen`). Its **text** (`TFRMT`) is not a property of the
include: the VOFM transaction writes it as a comment beside the `INCLUDE` statement in the
**carrier** program (`RV64ANNN`, `RV61ANNN`, …), and that is where it can be read — 23 of 23
on this system. Whether the routine is **active** is the same read: the routine is active when
the carrier includes it. Where the routine is **used** (`T683S`, `TVCPA`/`TVCPF`/`TVCPL`) is
table content and is not a repository question — it is read through the data preview (next
section; `docs/security.md`, the reversal of 2026-09-12).

### `POST /sap/bc/adt/datapreview/freestyle` — the one POST, table content by SELECT — MEASURED 2026-09-12

Round 14, step 6, eight requests. This is the resource behind the Eclipse **Data Preview** (and
`runQuery` in `abap-adt-api`, which this client keeps **denied**: the read goes through
`lib/data-preview.mjs`, not through the library method — see `docs/security.md`, the reversal
of 2026-09-12).

**Wire.** `POST /sap/bc/adt/datapreview/freestyle?rowNumber=N`, body `text/plain` holding a bare
`SELECT … FROM <table> [WHERE …]`. The server appends the rest of the statement itself and echoes
the result in `executedQueryString`:

```
SELECT * FROM T683S   INTO     TABLE @DATA(LT_RESULT)   UP TO 5  ROWS   .
```

so `UP TO n ROWS` comes from the query parameter, never from the body. `rowNumber` is the only
cap; `totalRows` in the reply is the count **without** it (`T683S`: 9784 rows, 5 returned).
Timing 480–560 ms per call across the eight, independent of the table.

**Accept.** The 406 body lists exactly one type: `application/vnd.sap.adt.datapreview.table.v1+xml`.
`application/*` is answered with it; `application/xml` is refused (406). Send the exact type.

**Shape** (`xmlns:dataPreview="http://www.sap.com/adt/dataPreview"`), **column-major**:

```
tableData
  totalRows                 integer, uncapped
  isHanaAnalyticalView      false
  executedQueryString       the statement the server ran (above)
  queryExecutionTime        seconds, 7 decimals
  columns*                  one per column, in SELECT order
    metadata                @name @type @description @keyAttribute @colType @isKeyFigure
    dataSet                 data* — one per ROW; <dataSet/> when zero rows
```

`@type` is the ABAP type letter (`C`, `N`, `D`, `T`, `X`, …); `@description` is the field
label in the logon language. Every column's `dataSet` has the same number of `data` children
(the row count); the parser treats a disagreement as `SHAPE_DRIFT` and keeps the shortest.
Sizes: `T683S` 5 rows × 23 columns 10.5 KB; `TVCPA` 5 × 52 columns 22.9 KB; `TFRM` 2 KB.

**The fence is the client, not the server.** `SELECT * FROM VBAK` answered 200 (942 bytes,
5 rows) — the server enforces the user's authorisation, nothing narrower. Everything this
repository refuses (table outside `CUSTOMIZING_TABLES`, a field or value the grammar cannot
say, more than 200 rows) is refused **before the request exists**, and that refusal is tested
(`tests/guard.test.mjs`).

**No lock, no transport.** `SM12` before and after step 6 showed nothing for the user (the
owner's reading, 2026-09-12). Nothing is enqueued, nothing is recorded: the read is
read-only by semantics and POST only by wire.

**NUMC widths, because they bite.** Routine numbers compare at the column's full width:
`T683S.KOBED/KOFRM/KOFRA` are 7 digits (`0000953`), `TVCPA/TVCPF/TVCPL.GRBED/GRU*` are 3
(`953`). `TFRM` columns are `GRPZE GRPNO AKTIV KAPPL GNDAT GNZEI`; `GRPZE = 'A' AND GRPNO >=
'900'` answered 0 rows, so `TFRM` is not where the customer routines register — the carrier
include is (section above).

**⚠️ Each line of the body keeps its first 255 characters; the rest of the line is dropped in
silence — MEASURED 2026-10-01** (three one-line reads of `T683S` through `adt_customizing`,
the development system). How the reply looks depends only on where character 255 falls:

| statement | char 255 falls | answer |
|---|---|---|
| 257 chars — the 16 `PFRM` routines in `KOFRM IN (…)` (2026-09-30) | inside the last literal | **400** `The text literal "'0000996   INTO     TABLE @DAT" is longer than 255 characters` |
| 267 chars, 10 fields + 15 routines | after a literal, inside the `IN` list | **400** `"INTO" is invalid here (due to grammar)` |
| 271 chars, `… IN (…16…) AND KSCHL <> 'QQQ' AND KVEWE = 'X'` | right after `'QQQ'` | **200**, `totalRows` 36, every row `KVEWE = 'A'` — `executedQueryString` ends at `'QQQ'`: **`AND KVEWE = 'X'` never ran** |

The third row is the one that matters: **a wrong answer with status 200**, provable only from the
echo.

**The limit is per line, and Eclipse never meets it because it never sends one line.** Two
requests of the Eclipse Data Preview, captured by the owner in the *ABAP Communication Log* the
same day (ADT 3.60.3): the body is the statement **broken into lines** — one field per line
(`SELECT` / `T683S~MANDT,` / … / `FROM` / `T683S`: 371 characters, longest line 35), and even
`SELECT *` goes as `SELECT *` / ` FROM ` / `  T683S`. Both echoes come back whole, the lines
**joined by one blank with their own leading blanks kept** (`SELECT *  FROM   T683S   INTO …`).
Eclipse also sends `&dataAging=true` and `Accept: application/xml,
application/vnd.sap.adt.datapreview.table.v1+xml`; neither touches the limit, and this client does
not copy them. `runQuery` in `abap-adt-api` sends the caller's text as is, so it meets the cut too.

So `buildSelect` lays the statement out between tokens — never inside a literal or an
identifier — into lines of at most 255 (`MAX_LINE`), continuation lines indented (a `*` or `"` at
column 1 is an ABAP comment); a statement that fits one line is one line, unchanged. And every
answer is checked: rows whose `executedQueryString` does not start with the statement sent are
refused (`assertRanAsSent`, `QueryAltered`). **LF works, measured the same day:** the 16 `PFRM`
routines (the 257-character statement of 2026-09-30) went out as two lines of 246 and 12, and
answered 200, `totalRows` 36, the echo whole (`… '0000989',   '0000996')   INTO …`). Whether Eclipse
itself breaks with LF or CRLF the log does not show, and it no longer matters.

**Grammar this client generates** (`buildSelect`): identifiers `^[A-Z0-9_/]{1,30}$`; values
`^[A-Za-z0-9_ /.:*+\-']{0,60}$` with quotes doubled; operators `=`, `<>`, `IN (…)`; `AND` only;
no join, subquery, `;`, comment, `ORDER BY`. Not measured: `LIKE`, `OR`, joins, `ORDER BY` — the
grammar does not offer them, so their behaviour on the wire is unknown by design.

### `/sap/bc/adt/feeds` — the self-describing catalogue of the Feed Reader — MEASURED 2026-09-12

Round 14, steps 1–2. Discovery lists `/sap/bc/adt/feeds` ("Feed Repository") and
`/sap/bc/adt/feeds/variants` with **no** accept and no template; `runtime/dumps` and
`gw/errorlog` are **not** discovery collections at all — the catalogue is the only place that
names them, which is why the client reads the catalogue and never assembles a feed URL.

**Wire.** `GET /sap/bc/adt/feeds`, `Accept: application/atom+xml;type=feed` → 200, 23.6 KB,
one `atom:entry` per feed (7 on this system). Per entry: `atom:title`, `atom:id` (= the href),
`atom:content/@src` and `atom:link[@rel='alternate']/@href` (the feed's URL, `@type
application/atom+xml`), `atom:summary`, `atom:published`/`updated` (the feed's own release date,
2011 for dumps), and `feed:extendedData` (`xmlns:feed="http://www.sap.com/adt/feeds"`):

```
feed:extendedData
  feed:refresh/feed:interval      @value @unit (dumps: 5 minutes; gateway: 60)
  feed:paging                     @size [@max]   (dumps: size=50 max=100; gateway: size=5)
  feed:notification               @isEnabled
  feed:operators/feed:operator*   @id @numberOfOperands @kind=RELATIONAL, feed:label (logon language)
  feed:dataTypes/feed:dataType*   @id (string | dateTime | number), feed:operators
  feed:attributes/feed:attribute* @id, feed:dataType/@id, feed:label, feed:operators
  feed:queryIsObligatory          true | false
  feed:queryDepth                 1 | 2
  feed:queryVariants/feed:queryVariant*  @queryString @title @isDefault
```

**The seven feeds**, with their filter attributes (`@id`, the only thing a `$query` may name):

| Feed | href | attributes | obligatory |
|---|---|---|---|
| ABAP Runtime Errors | `/sap/bc/adt/runtime/dumps` | `package packageHierarchy packageResponsible objectResponsible responsible objectName component user runtimeError exception datetime` | no |
| SAP Gateway Error Log | `/sap/bc/adt/gw/errorlog` | `username namespace service_name t100_msgid t100_msgno error_component error_package remote_address request_uri request_id opid transaction_id timestamp` | no |
| Enterprise Event Enablement Error Log | `/sap/bc/adt/eee/errorlog` | `username channel` | no |
| URI Creation Errors | `/sap/bc/adt/error/urimapper?user=<self>` | — | — |
| ATC Findings | `/sap/bc/adt/atc/feeds/verdicts` | (see `adt_atc_run`) | **yes** |
| RAP Contract Check Violations | `/sap/bc/adt/bo/feeds/ccviolations` | — | — |
| ABAP System Messages | `/sap/bc/adt/runtime/systemmessages` | — | — |

Operators, all feeds: `equals notEquals contains notContains greater greaterOrEquals less
lessOrEquals between(2) notBetween(2)` — per attribute the subset its data type allows (a string
attribute gets the first four; `datetime` gets the ordering ones too).

**The query grammar is the variant's, prefix form.** The catalogue ships the default query
verbatim — `and ( equals ( user , <SAPUSER> ) )` for dumps, `and ( equals ( username , <SAPUSER> ) )`
for the gateway log — and step 3 measured that the OData-looking infix form
(`$query=user eq 'X'`) is refused with **400 `ExceptionInvalidData`** ("Data is invalid and could
not be converted") on every attribute tried (user, objectName, program, datetime, from/to,
package, responsible). So a `$query` is `<conj> ( <op> ( <attr> , <value> ) [ <op> ( … ) ] )`
with `queryDepth` levels of nesting, and this client **generates** it from structured filters
and never accepts it as text. The prefix form itself was not yet answered on the wire (round
14 asked the infix form only); the first live call of `adt_runtime_errors` with a filter is
the measurement, and a 400 there files `FEED_NOT_READ` with the generated string in `detail`.

### `/sap/bc/adt/runtime/dumps` — the ST22 list, with the detail already in it — MEASURED 2026-09-12

Round 14, steps 3–4. `GET /sap/bc/adt/runtime/dumps`, `Accept: application/atom+xml;type=feed`
→ 200, **620 KB for 35 entries** (~17.7 KB each). The 406 body lists exactly that type;
`application/xml` and `text/html` are refused.

**Paging.** `$top=N` and `$skip=N` work (`$top=2` → 2 entries, 40 KB; `$skip=1&$top=2` → the next
two); `maxResults` is **ignored** (35 entries back); `$inlinecount=allpages` does nothing visible
(no count element; 20 KB for `$top=1`). The catalogue's `paging size=50 max=100` is the reader's
page, not a server cap: with no `$top` the server sent every dump it had (35). The feed's `self`
link carries `?from=<yyyymmddhhmmss>`, i.e. the server's own notion of "since".

**Entry** (`xml:lang` on the entry; 13 element names, 17 attributes in the census):

```
atom:entry
  atom:author        @FullName, atom:name = SAP user of the dump
  atom:category      term=<runtime error name>     label="ABAP runtime error"
  atom:category      term=<terminated program>     label="Terminated ABAP program"
  atom:id            /sap/bc/adt/vit/runtime/dumps/<yyyymmddhhmmss><host>_<SID>_<nr>%20…<USER>%20…<client>%20…<seq>
  atom:link          rel=alternate type=application/vnd.sap.adt.sapgui  href=adt://<SID>/sap/bc/adt/vit/runtime/dumps/<same tail>
  atom:link          rel=self      type=text/plain                     href=adt://<SID>/sap/bc/adt/runtime/dump/<same tail>
  atom:published / atom:updated    ISO instant (UTC)
  atom:summary       type=html — the dump itself (below)
  atom:title         the short text of the error
```

The id's tail is the ST22 key (`SNAP` key: date+time, host, user, client, sequence), with the
blank-padded fields percent-encoded. **Both links are `adt://` URIs** — the IDE's scheme, not
HTTP; sent as `/sap/bc/adt/vit/runtime/dumps/<tail>` over HTTP the id answers **404** with every
accept (`text/html`, `application/xml`, `atom+xml;type=entry`, `*/*`). The HTTP form of the
`self` link (`/sap/bc/adt/runtime/dump/<tail>`, `text/plain`) was not tried in round 14.

**The summary IS the detail.** `atom:summary` (13.8 KB, HTML-escaped) carries the ST22 report
in seven `h4` sections — `Contents`, `Header Information`, `What happened?`, `Error analysis`,
`Information on where terminated`, `Source Code Extract`, `Active Calls/Events` — with:
a header table (`Short Text`, `Runtime Error`, `Exception`, `Program`, `Application Component`,
`Date/Time`, `User`, `Client`, `Host`); the analysis paragraphs verbatim; the source extract as a
two-column table (line numbers with `>>` on the failing line, source with `&nbsp;` indentation);
and the call stack as a table `No. | Event | Program | Include | Line`, each `No.` an `adt://`
link into `…/oo/classes/<class>/source/main#start=<line>` (so the stack names the **class and
method** — `GET_DATA_FROM_TOOL` of `CL_ENH_ADT_ENHO_OBJ_PERSIST`, line 30 of `…CM00F` — with
no second request). Variable values are **not** in the summary (ST22's "Chosen variables" is
not among the seven sections). So the list is the detail: one GET, parse the summary.

### `/sap/bc/adt/gw/errorlog` — the Gateway error log feed — MEASURED 2026-09-12

Round 14, step 5. Same accept (`application/atom+xml;type=feed`, the 406 lists only it) → 200,
**264 bytes, 0 entries**: `atom:feed` with `atom:icon` and `atom:title` only. The entry shape
is therefore **unmeasured** on this system (the log was empty for the user); the parser
declares the feed envelope and files anything under `atom:entry` as `drift` until a non-empty
read is transcribed here. The catalogue's default query is `and ( equals ( username , <self> ) )`.

### Search has no paging, and the information system does not know `RV64A953` — MEASURED 2026-09-12

Round 14, step 7. `quickSearch` with `$skip=2`, `offset=2`, `start=2` each answered the **same
two hits** as without — the parameters are ignored, not refused. `operation=fullSearch` →
**500 "No service found for ID fullSearch"**. So `maxResults` (cap 200) is the only knob, and
`adt_search`'s `truncated: "possible"` at exactly `max` stays the only signal. Closed: there is
no offset to add.

`RV64A952` vs `RV64A953`, exact name, no facet, `maxResults=1`: 1 hit vs **0**. The library's
`searchPattern` parameter (instead of `query`) answers **109 bytes, no hit, for both** — it is
not a synonym. `…/informationsystem/objectproperties/values?uri=…/programs/includes/rv64a952`
→ 406 naming `application/vnd.sap.adt.repository.objproperties.result.v1+xml` (the resource
exists; the accept was wrong); the same for **`rv64a953` → 422 "semantic errors"** before any
accept negotiation. The repository information system does not resolve the include that the
direct URI reads and `SE03` lists — the cause is the index of the information system, and it
is not repairable from this client. Mitigation stands (`foundBy: 'uri'`).

`DDLX/EX` **filters**: `ZC_DEMOROSTERMONITOR` with `objectType=DDLX/EX` → 1 hit; without the
facet → 4 (the DDLS, the DDLX and two more). It joins `SEARCHABLE_TYPES_MEASURED`.

### The parent of a package is exposed twice — MEASURED 2026-09-12

Round 14, step 8. `objectStructure('/sap/bc/adt/packages/zdemo_expenses')` carries **no** parent
(the library keeps the root's attributes and links: `versions`, `abaplanguageversions`, the SAP GUI
`self`, five value helps, `checkruns`). The parent is in two other places: the raw package XML
(`GET /sap/bc/adt/packages/<name>`, `Accept: application/vnd.sap.adt.packages.v1+xml`; `*/*` is
answered with **v2**; 3.8 KB) has `pak:superPackage` with `adtcore:uri/type/name/description`,
next to `pak:attributes` (`packageType`, `isEncapsulated`, …) and `pak:transport/pak:transportLayer`;
and `findObjectPath(uri)` (allow-listed) answers the **whole chain** as `DEVC/K` steps, each
with `adtcore:parentUri`: `YDEMO_ROOT → YDEMO_FI → ZDEMO_EXPENSES`. The second is one allow-listed call
and answers the deeper question (the ancestry), so `adt_object_info` on a `DEVC/K` uses it.

### Text elements live under `/sap/bc/adt/textelements/<kind>/<name>` — MEASURED 2026-09-12

Round 14, step 9 asked `…/programs/programs/<name>/textelements` (and `/includes/…`) — **404
for all three programs**, with every accept: that path does not exist. Discovery (step 1) has the
real collections: `/sap/bc/adt/textelements/programs`, `/functiongroups`, `/classes`, accept
`application/vnd.sap.adt.textelements.v1+xml`; and a class's `objectStructure` publishes the
link `rel="http://www.sap.com/adt/relations/sources/textelements"
href="/sap/bc/adt/textelements/classes/<class>"` (step 10c), which confirms the pattern. The
**body shape is not yet measured** — the route is not built until it is.

### `ENHO/XHB` names its spot, BAdI and implementing class in the body — MEASURED 2026-09-12

Round 14, step 10. `objectStructure` of an XHB carries only three links (versions, language
versions, SAP GUI). The raw object (`GET /sap/bc/adt/enhancements/enhoxhb/<name>`, `*/*` →
`application/vnd.sap.adt.enh.enhoxhb.v4+xml`, 4.3 KB) has everything:

```
enho:objectData  (@adtcore:* of the ENHO; adtcore:packageRef)
  enho:contentCommon  @toolType=BADI_IMPL @adjustmentStatus @upgradeFlag @switchSupported
    enho:usages/enhcore:referencedObject*  @element_usage=USEO|EXTO
      enhcore:objectReference / mainObjectReference  @adtcore:uri @type @name
        → CLAS/OC (the implementing class), ENHS/XSB (the spot, EXTO), INTF/OI (the BAdI interface)
  enho:contentSpecific/enho:badiTechnology/enho:badiImplementations/enho:badiImplementation*
      @name @shortText @example @default @active @customizingLock …
      enho:enhancementSpot   @adtcore:uri @type=ENHS/XSB @name
      enho:badiDefinition    @adtcore:uri (spot uri + #type=enhs/xb;name=…) @type=ENHS/XB @name
      enho:implementingClass @adtcore:uri @type=CLAS/OC @name
```

The interface is also visible from the class side: `objectStructureElements` of the class lists
the BAdI interface as `CLAS/OR` (`/XNFE/IF_BADI_INVOICE_ENHANCE`). Namespaced URIs come
percent-encoded (`%2fxnfe%2f…`) and are kept so. A search for `ENHO/XHB Z*` answered `[]` — the
facet is not searchable, like `FUGR/I`; XHBs are found by the whole-facet route only.

### A class publishes its enhancement implants — the class side of `ENHO/XH` — MEASURED 2026-09-12

Round 14, steps 10c–11. A class's `objectStructure` carries, per include, a link
`rel="http://www.sap.com/adt/relations/enhancementOptions"` (`…/includes/<x>/enhancements/options`,
`application/vnd.sap.adt.enhancementoptions.v2+xml`) and, on the class, **two** links:
`enhancementOptionsOfMainObject` (`…/enhancements/options`) and **`enhancementImplementations`**
(`/sap/bc/adt/oo/classes/<class>/enhancements/implementations`,
`application/vnd.sap.adt.enhancementimplementations.v1+xml`). That last one is the read the
`enhoxh` resource cannot give (its persistence dumps, section above): the implants, asked from
the object they are implanted in. Step 11 could not measure it — `ZCL_DEMO_UTILITIES` is the
**name of the ENHO**, not of a class (404 on every route; `…/enhancements/options` → 400
"reading source of ZCL_DEMO_UTILITIES=============CP", which is the server trying to read a class
that does not exist). Which class each of the three `ENHO/XH` enhances is exactly what nobody
can read; the ENHO names suggest candidates
(`ZCL_DEMO_UTILITIES` → `CL_COS_UTILITIES`), and round 15 asks the link on them. The link's body
shape is unmeasured until then.

### `$query` on the wire: one clause filters, two clauses dump the server — MEASURED 2026-09-12

Round 15, step 1, on `/sap/bc/adt/runtime/dumps` with the prefix form this client generates.
**One clause works on every attribute tried** (7 of 7): `and ( equals ( user , <self> ) )` → 26
of 35; `notEquals` → the other 9; `contains ( objectName , CL_ENH )`, `equals ( runtimeError , … )`,
`equals ( package , SEEF_ADT_IMPL_COMMON )` → 21 each; `greaterOrEquals ( datetime ,
2026-09-05T23:56:48 )` → 26. The counts differ from the unfiltered list, so the filter is applied,
not ignored.

⚠️ **Two clauses side by side — `and ( equals ( user , X ) equals ( runtimeError , Y ) )` — answered
500, and the 500 is a dump this client caused**: `ASSERTION_FAILED` in `CL_ADT_FQL_QUERY`
(terminated program `CL_ADT_FQL_QUERY==============CP`, 20:57:00 local, visible in the very feed
being measured). The catalogue's `queryDepth` is 2 for this feed, so a two-clause form exists —
it is not this one, and it is **unmeasured**. Until it is, `MAX_CLAUSES = 1` in
`lib/runtime-feeds.mjs` and `{1}` in the route regexes: a caller with two conditions asks twice.
The rule this measurement adds to the ones above: **a parser on the other side can dump on a
grammar guess; a filter that has not been read back with a count is not a filter.**

### `/sap/bc/adt/runtime/dump/<key>` — the dump resource, the HTTP twin of the `self` link — MEASURED 2026-09-12

Round 15, step 2. The entry's `rel=self` link is `adt://<SID>/sap/bc/adt/runtime/dump/<key>`; the
same path over HTTP (scheme and system dropped, the key kept percent-encoded — its blanks are part
of the ST22 key `SNAP`: date+time, host, user, client, sequence) **answers**:

| Accept | Status | Content |
|---|---|---|
| `text/plain`, `application/xml` | 406 | — |
| `text/html` | 200 | 20 KB, the same report page the summary carries (`h1`/`h4`, tables) |
| `*/*` | 200 | **`application/vnd.sap.adt.runtime.dump.v1+xml`**, 4.9 KB |

The xml is a `dump:dump` (`xmlns:dump="http://www.sap.com/adt/categories/dump"`) with the header
as attributes — `title`, `error`, `author`, `exception`, `terminatedProgram`, `serverInstance`,
`datetime` (UTC), `systemDate`/`systemTime` (local), `language` — then `dump:links/dump:link`
(`@relation @uri @contentType`) and `dump:chapters/dump:chapter` (`@name @title @category @line
@chapterOrder @categoryOrder`). The seven links:

```
contents                              <key>/formatted     text/plain        the whole ST22 report, formatted
…/runtime/dump/unformatted            <key>/unformatted   text/plain
self                                  <key>               …runtime.dump.v1+xml
alternate                             /vit/runtime/dumps/<key>   …sapgui      (the adt:// twin of the list)
…/runtime/dump/summary                <key>/summary       text/html         (= the entry's atom:summary)
…/runtime/dump/termination            adt://…/oo/classes/<x>/includes/implementations#start=N
…/runtime/dump/http                   https://<host>:44300/sap/bc/adt/runtime/dump/<key>   text/html
```

The **chapters** are the ST22 sections (`kap0` short text … `kap19` control blocks) with the
**line where each starts in the formatted text** — `kap10` *Chosen Variables* at line 321,
`kap11` *Active Calls/Events* at 281, `kap8` *Source Code Extract* at 193 — in three
categories (`User View`, `ABAP Developer View`, `BASIS Developer View`); titles come in the
session's logon language (translated here). **The set is per dump, not fixed** (20 on that dump; 21 on another
`OBJECTS_OBJREF_NOT_ASSIGNED_NO` read live through the tool on 2026-09-14, with `kap28` *Chain of
Exception Objects* between `kap6a` and `kap7`, and `kap10` at line 348) — the parser
declares only the node names, never the chapter names, so a new chapter is not drift. So the resource is the index, and `<key>/formatted` is the one place
the **chosen variables** are readable — the list's summary does not carry them. Both are read as
`derivedGet` kinds (`runtimeDump`, `runtimeDumpText`), on the path of the entry's own link.

### `/sap/bc/adt/textelements/<kind>/<name>` — a container of three sub-resources — MEASURED 2026-09-12

Round 15, step 3. `Accept: application/vnd.sap.adt.textelements.v1+xml` → 200 for a program
(`SAPMV45A`, `adtcore:type="PROG/PX"`, 2.6 KB), a function group (`V05C`) and a class
(`CL_ENH_ADT_ENHO_OBJ_PERSIST`); **404 for an include** (`MV45AFZZ`: text elements belong to the
main program, an include has none of its own). `?language=PT`/`EN` change nothing in this body.
The body is `rept:textElement` (adtcore header + `packageRef` + SAP GUI link) with three
`rept:subobject` — `symbols`, `selections`, `headings` — each publishing `atom:link href=
"source/<name>"` twice (`type="application/vnd.sap.adt.textelements.<name>.v1"` and `text/html`,
both with an `etag`) plus `source/<name>/versions`. **The texts themselves are one GET further**
(`…/textelements/programs/sapmv45a/source/symbols`), whose body is not yet measured; the etag
`DA39A3EE…` on `selections`/`headings` of `SAPMV45A` is the SHA-1 of the empty string — those two
are empty, `symbols` is not.

### The class side of `ENHO/XH`: the resource answers, the candidate was wrong — MEASURED 2026-09-12

Round 15, step 4. `objectStructure('/oo/classes/cl_cos_utilities')` carries the link
`enhancementImplementations` → `GET …/cl_cos_utilities/enhancements/implementations`,
`application/vnd.sap.adt.enhancementimplementations.v1+xml` → **200, 136 bytes, an empty
`enho:enhancementImplementation`** (`xmlns:enho="http://www.sap.com/adt/enhancements/implementations"`).
So the resource is live and this class has **no** implant: `ZCL_DEMO_UTILITIES` (the only
`ENHO/XH` under `Z*` — the search with `objectType=ENHO/XH` through the library answers every
`ENHO/*`, the facet is stripped) enhances some other class. `CL_IM_COS_UTILITIES` and
`CL_COS_UTILITY` do not exist (404). The non-empty body is unmeasured; which class to ask is a
question for SE19, not for a name guess.

### `/sap/bc/adt/atc/feeds/verdicts` and what GET reaches under `/atc` — MEASURED 2026-09-12

Round 15, step 5. The ATC Findings feed with **no `$query`** → 200, 244 bytes, `atom:feed` with
`atom:icon` + `atom:title` "ATC messages" and **zero entries** — although the catalogue says
`queryIsObligatory: true`, the server does not refuse. With `$query` on an attribute the feed does
**not** list (`user`, `responsible` — its attributes are `priority`, `applicationComponent`,
`objectName`, `package`, `contactPerson`; `queryDepth` 4) → **400 `ExceptionInvalidData`** "Data
is invalid and could not be converted". So an unknown attribute is refused by the server too, and
a filtered read on a real attribute is still to be done: the entry shape is unmeasured. Also
under `/atc` by GET: `/sap/bc/adt/atc/worklists` → 400 "Parameter worklistId could not be found"
(a worklist is read by id, and ids come from a run); `/sap/bc/adt/atc/customizing` → 200,
`application/vnd.sap.atc.customizing-v1+xml`, 2.3 KB: `systemCheckVariant =
ZDEMO_CLEAN_CORE`, `ciCheckFlavour = true`, four exemption reasons (`FPOS`, `OTHR`, and two
customer-defined `Z*` reasons), three validities (`U`, `S`, `D`). That read names the check
variant the governance runs -- which is what `atc.defaultVariant` should be set to.

### `ENHO/XH` has no model in the ADT — the enhanced object does not list it, `objectproperties` is the one read — MEASURED 2026-09-14

Measured on the three `ENHO/XH` of a development system, with the targets confirmed in SE19
(two standard classes and one standard function group). These are not
BAdI or source-code plug-ins: the abapGit XML names the tool — **`CLASENH`** (class
enhancement: new methods and attributes on a standard class) and **`FUGRENH`** (function-module
interface enhancement: optional parameters). What the ADT answers about them, 11 readings:

| Read | Answer |
|---|---|
| `…/oo/classes/<class>/enhancements/implementations` (v1 accept) | 200, **136 bytes, empty** for both classes — the `CLASENH` is not an implant |
| `…/functions/groups/hcm_addon_int/enhancements/implementations`, and the same on `…/programs/programs/saplhcm_addon_int` | 200, 630 bytes, **one** implementation — the `XHH` hook (`ZDEMO_BP_INTEGRATION`, self link under `enhoxhh`); the `FUGRENH` is not listed |
| `…/enhancements/options` (v2 accept) | 200, 10-27 KB: the implicit options only (`\PR:…CP\IC:…CCDEF\SE:END\EI`, every method's `BEGIN`/`END`) — nothing about the enhancement |
| `objectstructure?version=active&withShortDescriptions=true` of `CL_COS_UTILITIES` | 200, 23.9 KB, **no** `ZDEMO_INACTIVATE`/`ZDEMO_REACTIVATE` among the elements (`source/main` neither) |
| `…/oo/classes/<class>/includes` | 400 `uriMappingError` (not a resource); `…/functions/groups/<g>/includes` → 400 "Parameter fugrincludename could not be found"; `…/fmodules/<fm>/objectstructure` → 404 |
| `…/programs/includes/<ENHO padded to 30 with '='>E/source/main` (the enhancement include the abapGit XML names) | **500 `ExceptionResourceReadFailure`** "Resource PROGRAM … could not be successfully read" — 3 of 3, same for the metadata URI, **and no dump**: the ST22 feed read before and after is unchanged |
| quick search `<ENHO>*` | the ENHO itself (`ENHO/XH`, package `ZDEMO_PKG`); with `PROG/I` → empty |
| quick search of an added method (`ZDEMO_INACTIVATE`, `ZDEMO_GET_DESTINATION`, …), no type and `CLAS/OM` | **empty**, 8 of 8 — the index does not know them |
| `/sap/bc/adt/repository/informationsystem/objectproperties/values?uri=/sap/bc/adt/enhancements/enhoxh/<x>` | with `Accept: application/vnd.sap.adt.objectproperties.v1+xml` → **406** naming exactly one type; with that one — **`application/vnd.sap.adt.repository.objproperties.result.v1+xml`** — or no Accept → **200, ~2.8 KB**, 3 of 3, and **no dump** |

The `objectproperties` body: one `<opr:object text name package type="ENHO/XH">` with two
`atom:link` (the `enhoxh` URI and a `vit/wb` SAP GUI link), then a flat list of
`<opr:property facet name displayName [text]>`: `SOURCETYPE` ×2 (`UNDEFINED`), `APPL` (`-`),
**`PACKAGE` once per ancestor, root first** (`YDEMO_ROOT`, `YDEMO_BASIS`, `ZDEMO_PKG`, each with a packages
link), `GROUP` (`ENHANCEMENTS`), `TYPE` (`ENHO`), `OWNER`, `API` (`NOT_RELEASED`), `LANGUAGE`
(`PT`), `SYSTEM`, `VERSION` (`ACTIVE`), `DOCU` (`NONE`), `CREATED` (year), `MONTH`, `DATE`
(`YYYYMMDD`), `COMP` (`HOME`). 18 properties on each of the three. It is the **only** resource
that answers for the type without touching the `enhoxh` persistence.

The rule this closes: **a `CLASENH`/`FUGRENH` has no representation in the ADT object model.**
Its own resource dumps the server (section above), the enhanced object does not list it, its
enhancement include is unreadable as a program, and the search index does not know the members
it adds. The methods, attributes and parameters exist only in SE19 (SE24/SE37 on the enhanced
object) and in abapGit (`<enho>.enho.xml` — `TOOL`, target, member headers — plus one
`<enho>.enho.em_<method>.abap` per new method). So `adt_object_info` on an `ENHO/XH` reads
`objectproperties` through the named route `objectProperties` and never the structure;
`adt_read_source` answers empty with that sentence; `adt_transport {object}` reads nothing and
points at the caller of the added members (the request that created each of the three also
carries its caller, read through `ZCL_DEMO_HCM18` and `ZDEMO_XML_DOWNLOAD`). Journal code
`CLASENH_NOT_IN_ADT`.

One distinction round 17 added (step 3b): *the enhanced object does not list it* was measured
on a **class** through `enhancements/implementations`; the **function group's own
`objectstructure`** (next sections) does list its `ENHO/XH` -- both the hook and the FUGRENH,
typed the same -- as elements. A listing in the structure is not a readable resource: the
FUGRENH's href is the `enhoxh/.../source/main` that dumps, and it is never followed.

### `$query` with two clauses, the comma form: accepted, no dump, filtering unproven — MEASURED 2026-09-14

Round 16, step 2, on `/sap/bc/adt/runtime/dumps`, the one form the catalogue itself publishes
(the ATC default variant separates clauses with a comma). `and ( equals ( user , <self> ) ,
contains ( objectName , CL_ENH ) )&$top=3` → **200, 60,191 bytes, 3 entries** — and the ST22
feed read before and after names the same newest dump: **the comma form does not dump** (round
15's form without the comma did). What it does not prove: the control `and ( equals ( user ,
<self> ) )&$top=3` answered the same 3 entries (60,077 bytes; the difference is the echoed
query in the `self` link), because this user's three newest dumps all terminated in
`CL_ENH_ADT_ENHO_OBJ_PERSIST===CP` — a second clause that excludes nothing cannot be told from
one that is ignored. `MAX_CLAUSES = 1` stayed until a two-clause read was compared against a
one-clause count it had to differ from -- **done 2026-09-14, next section but two:
the comma form filters, `MAX_CLAUSES = 2`.**

### `/sap/bc/adt/textelements/<kind>/<name>/source/symbols` — the text symbols, as text — MEASURED 2026-09-14

Round 16, step 3. `Accept: application/vnd.sap.adt.textelements.symbols.v1` → **200, plain text**
(`charset=UTF-8`, 7,439 bytes for `SAPMV45A`): blocks of `@MaxLength:<n>` followed by
`<NNN>=<text>` and a blank line — 173 symbols. Every other Accept is refused: `…symbols.v1+xml`,
`text/plain`, `text/html` → **406**; **no Accept → 200 `text/html`, 153 KB** — an HTML page
(the SAP GUI-in-browser rendering), not the texts. `source/selections` with
`…selections.v1` → 200, **0 bytes** (`SAPMV45A` has no selection texts, as the empty-string etag
of round 15 said); `source/headings` with `…headings.v1` → 200, 81 bytes: `listHeader=` and
`columnHeader_1..4=`, all empty. A Z program (`ZDEMO_XML_DOWNLOAD`, whose abapGit TPOOL has
IDs `R` and `S` only) and a class (`CL_ENH_ADT_ENHO_OBJ_PERSIST`) → 200, **0 bytes** — the
resource answers for classes too. So a text-elements read is `GET …/textelements/<programs|
classes|functiongroups>/<name>/source/<symbols|selections|headings>` with the sub-resource's own
`.v1` type, and 0 bytes is "none", not a failure. Not wired to a tool: no consumer asked for
text symbols yet; the route is one `TEMPLATES` entry away when one does.

### `/sap/bc/adt/atc/feeds/verdicts` filtered: every filter answers the empty envelope — MEASURED 2026-09-14

Round 16, step 4. Six reads, each **200, 244 bytes, zero entries**: `equals ( package , ZDEMO_SD )`,
`equals ( package , ZDEMO_PKG )`, `contains ( objectName , ZCL_ )`, `greaterOrEquals ( priority , 1 )`,
`equals ( contactPerson , <self> )`, and the catalogue's default variant verbatim (comma form,
two clauses — no dump here either). The feed only carries findings of ATC runs whose results
were **stored** for the Feed Reader (a central check run with "save results", or a run the
user subscribed to); reading the feed answers nothing about the governance's check variant or
about what an ATC run on a package would find. The entry shape stays unmeasured, `atcVerdicts`
stays `shapeObserved: false`, and the ATC question is answered by `adt_atc_run`, not by this
feed.

### `$query` with two clauses filters -- the comma form, proved — MEASURED 2026-09-14

Round 17, step 1, on `/sap/bc/adt/runtime/dumps` with `$top=100`, four reads whose counts had
to differ if the second clause did anything: `and ( equals ( user , <self> ) )` → **33
entries**; `and ( equals ( user , <self> ) , notContains ( objectName , CL_ENH ) )` → **9**
(and `CL_ENH_ADT` occurs 0 times in that body, against dozens in the first); `and ( equals (
user , <self> ) , greaterOrEquals ( datetime , <today>000000 ) )` → **6**; the control
`and ( notContains ( objectName , CL_ENH ) )` alone → **16**. The newest dump of the feed was
the same before and after (`$top=1`, 26,436 bytes both times): **no dump**. So the comma form
`and ( c1 , c2 )` is the two-clause form the server evaluates, and the clauses are ANDed
(9 ≤ 16 and 9 ≤ 33). Consequence in code: `MAX_CLAUSES = 2` in `lib/runtime-feeds.mjs`, the
generator joins with ` , `, and the route regexes of `runtimeDumps`, `gatewayErrors` and
`atcVerdicts` admit exactly `and ( clause(?: , clause)? )` -- the side-by-side form that
dumped the server on 2026-09-12 cannot be produced and is refused at the route. Three clauses
are unmeasured (the catalogue's `queryDepth` is 2) and refused.

### A function module publishes its own implants: `…/fmodules/<fm>/source/main/enhancements/elements` — MEASURED 2026-09-14

Round 17, step 2, on the one FUGR whose hook is anchored in a function module
(`\FU:HCM_P_BP_INTEGRATION\SE:BEGIN\EI`, from the abapGit of the ENHO). What answers:

| Read | Answer |
|---|---|
| `GET …/functions/groups/<g>/fmodules/<fm>/source/main` (`text/plain`) | 200, the FM's source (453 bytes) |
| `GET …/fmodules/<fm>/source/main/enhancements` (Accept `enhancements.v3+xml`) | **404** |
| `GET …/fmodules/<fm>/source/main/enhancements/elements` (same Accept) | **200, 2,448 bytes**: `enh:enhancements` > `enh:enhancementImplementations` (`adtcore:name`, `adtcore:type="ENHO/XHH"`, `adtcore:version`) > `enh:elements` > `enh:sourceCodePlugin` (`enh:uri`, `enh:id`, `enh:full_name`, base64 `enh:source`, `enh:option/enh:sourceCodePluginOption` with `enh:full_name` and `enh:position adtcore:uri="…/fmodules/<fm>/source/main#start=<line>,0"`) -- one element per anchor (`SE:BEGIN` at line 1, `SE:END` at line 17); then `enh:enhancedObject` naming the group (`FUGR/F`) |
| `GET …/fmodules/<fm>` (no Accept or the fmodules Accept) | 200, `application/vnd.sap.adt.functions.fmodules.v3+xml`, 2,836 bytes -- the FM's metadata |
| `GET …/functions/groups/<g>/source/main/enhancements` (what the extractor read until then) | **404** -- the library falls back to `/elements`, which is why the group read never failed, it just listed nothing for an FM-anchored hook |
| `GET …/functions/groups/<g>/includes/<SAPL>/source/main/enhancements`; the same on a second group (`J1BF`) | 404, 404 |

So the implant of an FM is listed **under the FM's `source/main` and nowhere else**: the
`SAPL<group>` read is the right read for an implant anchored in an include and the wrong one
for an implant anchored in a function module -- the 34 of 45 FUGR dumps of 2026-09-12 that
ended in "0 implementation(s)" are that, not absence. `objectEnhancements(<fm source/main>)`
of the library does `/enhancements` then `/elements` on 404, so it reads this today.

### A function group's `objectstructure` lists its FMs, includes and `ENHO/XH` — MEASURED 2026-09-14

Round 17, step 3. The library's `objectStructure()` on a FUGR answers metadata and links only
(no elements, measured on the parsed object: 0 FM URIs). The raw read
`GET …/functions/groups/<g>/objectstructure?version=active&withShortDescriptions=true` with
`Accept: application/vnd.sap.adt.objectstructure.v2+xml` → **200, 9,522 bytes**: one root
`abapsource:objectStructureElement` (`adtcore:type="FUGR/F"`, `xml:base` = the group's
`source/main`) holding one element per **`FUGR/FF`** (15; each with `atom:link
rel="…/source/definitionIdentifier" href="…/fmodules/<fm>/source/main"` and a `description`),
per **`FUGR/I`** (10, `…/includes/<inc>/source/main`), one **`FUGR/PX`** (the text symbols)
and **two `ENHO/XH`**: the hook (href `…/enhancements/enhoxhh/<x>`) and the FUGRENH (href
`…/enhancements/enhoxh/<x>/source/main` -- the resource that dumps; the href is the only thing
that tells the two apart, the type does not). `…/groups/<g>/includes` → 400
`ExceptionParameterNotFound`; `…/groups/<g>/fmodules` → 400 `uriMappingError` (with or
without the fmodules Accept): there is no list resource, the structure is the list. A
**namespaced** group goes in the path exactly as the ADT writes it, `%2fscwm%2fprinting`:
encoding it once more (`%252fscwm%252fprinting`) answers **422 "Function group  not found"**
with an empty name -- every namespaced group measured so on the first live run of the
extractor; the route keeps `%2f` literal and admits it only as the namespace
wrapper. Kept as a measurement: the route that read it was removed with the catalogue scripts on
2026-11-08 (docs/security.md).

**Re-measured 2026-11-09 on a large SAP group (`V45A`, SD copy functions).** The same read
answered **200, 872,408 bytes**, with 20 element types. The counts, read with
`adtcore:type="…"`:

| Type | Count | Type | Count | Type | Count |
|---|---|---|---|---|---|
| `FUGR/PD` | 1956 | `PROG/I` | 40 | `FUGR/PO` | 4 |
| `FUGR/PT` | 235 | `ENHO/XH` | 22 | `FUGR/PLM` | 3 |
| `FUGR/FF` | 80 | `FUGR/I` | 17 | `FUGR/PS` | 2 |
| `FUGR/PU` | 47 | `TYPE/DG` | 11 | `FUGR/F`, `FUGR/PL`, `FUGR/PZ`, `FUGR/PX` | 1 each |
| `FUGR/PY` | 42 | `FUGR/PC` | 9 | `ENHS/XS`, `DIAL/A` | 1 each |
| | | `FUGR/PK` | 5 | | |

Two smaller groups held only `FUGR/F`, `FUGR/FF`, `FUGR/I`, `FUGR/PX` and `PROG/I`.

Compared with the element types the removed extractor did not declare:
- `FUGR/PLA`, `FUGR/PN`, `PROG/PNA` and `PROG/PNM` did not appear in this group;
- `FUGR/PC`, `FUGR/PS`, `FUGR/PZ` and `DIAL/A` were never on that list.

The set therefore grows with the group: no list measured on one group is complete. The reply also
grows with the group. A tool that reads this resource again caps what it lists, and it reports
any type outside its declared set as unclassified, never as absent.

### The ATC run: two POSTs, one worklist, the findings in the body — MEASURED 2026-09-14

Round 17, steps 4-5, three runs on two Z objects (a report and a class), two variants.

| Step | Read | Answer |
|---|---|---|
| 4a | `GET /sap/bc/adt/atc/customizing` (Accept `…atc.customizing-v1+xml`) | 200, 2,313 bytes: `systemCheckVariant = ZDEMO_CLEAN_CORE`, `ciCheckFlavour`, `isCCSTunnelEnabled`, exemption reasons `FPOS`/`OTHR`/`ZDEMO_LEG`/`ZDEMO_NAP`, validities `U`/`S`/`D`, `scaAttributes` -- as on 2026-09-12 |
| 4b | `POST /sap/bc/adt/atc/worklists?checkVariant=ZDEMO_CLEAN_CORE` (Accept `text/plain`, empty body) | 200, **32 hex characters** (the worklist id), 350-380 ms |
| 5b | the same POST with `checkVariant=ZZZ_NOPE_17` (does not exist) | **200, an id like the others** -- the server validates the variant name nowhere in this call; the client's closed set is the fence |
| 4c | `POST /sap/bc/adt/atc/runs?worklistId=<id>`, body `<atc:run maximumVerdicts="100"><objectSets><objectSet kind="inclusive"><adtcore:objectReferences><adtcore:objectReference adtcore:uri="<object uri>"/>…` (Accept `application/xml`) | 200, **515 bytes in 3.7-5.1 s**: `atcworklist:worklistRun` > `worklistId`, `worklistTimestamp`, `infos/atcinfo:info` with `type = FINDING_STATS` and `description = "p1,p2,p3"` (counts per priority: `0,6,6`, `1,1,6`, `0,3,3`) |
| 4d | `GET /sap/bc/adt/atc/worklists/<id>` (Accept `application/atc.worklist.v1+xml`) | 200, **8-20 KB**: `atcworklist:worklist` (`id`, `usedObjectSet`, `objectSetIsComplete`) > `objectSets/objectSet` (`name` = a 32-digit id, `title`, `kind` `ALL`/`LAST_RUN`) > `objects/atcobject:object` (`adtcore:uri` = `/sap/bc/adt/atc/objects/R3TR/<type>/<name>`, `type`, `name`, `packageName`, `atcobject:author`) > `atcobject:findings/atcfinding:finding` with attributes `adtcore:uri`, `location` (`<source uri>?context=<object uri>#start=<line>,<col>`), `processor`, `lastChangedBy`, `priority`, `checkId`, `checkTitle`, `checkClass`, `messageId`, `messageTitle`, `exemptionApproval`, `exemptionKind`, `checksum`, `quickfixInfo`; children `atom:link rel="…/relations/documentation"`, `atcfinding:quickfixes` (`manual`/`automatic`/`pseudo`), `atcfinding:tags/tag` (`APPLICATION_COMPONENT`, `REF_OBJ_NAME`, `REF_OBJ_TYPE`, `REF_PACKAGE`, `REF_SOFTWARE_COMPONENT`). 12 findings on the report (checks `CLSSIC`, `INTRNL`, `SELECT`, `0002`), 8 on the class (`NOAPI`, `INTRNL`, `TC_CLA`) -- the counts per priority equal to the run reply's every time |
| 4e | the same GET with `includeExemptedFindings=true` | 200, same body (no exemption on these objects) |
| 4f | the same GET with Accept `application/xml`; with no Accept | **406** naming only `application/atc.worklist.v1+xml`; 200, the same body |
| 4i-j | `/sap/bc/adt/atc/feeds/verdicts`, filtered on `contactPerson` and unfiltered, **after** the runs | 200, 244 bytes, **zero entries** both -- an ad-hoc run does not feed the verdicts feed (round 16's question, closed: the feed is for stored central runs) |
| 5a | the run repeated with `checkVariant=DEFAULT` on the report | worklist id, run 5.1 s, 6 findings (`0,3,3`) against 12 with the governance variant |

What a run leaves on the server: the result worklist (the ATC Result Browser lists it by id and
timestamp) and nothing this client can see elsewhere -- no lock, no transport, no object
changed (the owner's `SM12`/transport check is recorded in `docs/security.md` when reported).
Consumer: `adt_atc_run` (`lib/atc.mjs`: closed variant set, branded body, `parseWorklist` with
a declared element/attribute set and `drift`; route `atcWorklist`; route `atcCustomizing` for
the variant of the system).

### The ATC worklist re-measured: the cap is the client's, `noExemption` is new — MEASURED 2026-11-09

A probe on a second system (S/4HANA, logon language German): four Z objects (a class, two reports,
a CDS view) × two variants (`DEFAULT` and the installation's governance variant), each worklist
read twice (plain and `includeExemptedFindings=true`), plus one capped run.

| Read | Answer |
|---|---|
| `GET /sap/bc/adt/atc/customizing` | 200, 2,155 bytes: `ciCheckFlavour`, `systemCheckVariant`, `isCCSTunnelEnabled = false`, **`isTransportableExemptionTypeUsed = false`** (new property), validities `U`/`S`/`D`, `scaAttributes`, **no exemption reasons**. `systemCheckVariant` named a variant **other** than the one the installation had configured as "the system check variant": the store can be stale against the system |
| worklist + run, both variants | 200, ids as before; run 2.9-6.3 s, 515-516 bytes, `FINDING_STATS` equal to the worklist count every time (0 to 49) |
| run with `maximumVerdicts="5"` on the object with 49 findings | **`FINDING_STATS 0,0,49` and 49 findings in the worklist, 56,706 bytes** -- the same as with `100`. **The server ignores `maximumVerdicts`.** The client caps what it lists, most severe first, and `truncated` is a boolean (shown < findings held, or < the run stats) |
| `GET /sap/bc/adt/atc/worklists/<id>` | 200, 698 bytes to 56 KB. Head as measured (`usedObjectSet` = 32 nines, the `LAST_RUN` set; `objectSetIsComplete = true`); `objectSet` titles in the logon language. Every finding carries **`atcfinding:noExemption="true"`** (53 of 53, `exemptionKind` and `exemptionApproval` empty). **`atcfinding:checkClass` is absent** and **no `atcfinding:tags` element exists** on any finding: both are optional |
| the same GET with `includeExemptedFindings=true` | 200, same findings and attributes; the body differs at most in `atcworklist:timestamp` (one second) |
| a zero-finding run | two shapes: `atcworklist:objects` empty (`DEFAULT` on the CDS view), or one `atcobject:object` with an empty `atcobject:findings` (the governance variant on all four objects) |

What `noExemption` means on an exempted finding is not measured: no finding here had an
exemption. The parser passes it through as read (`noExemption: true|false|null`).

### An unknown check variant runs `DEFAULT`, silently — MEASURED 2026-11-09

Same system, two Z objects (a report with 49 `DEFAULT` findings, a class with 1), four variant
names each: `DEFAULT`, the installation's governance variant, the `systemCheckVariant` read from
`/sap/bc/adt/atc/customizing` at that moment, and `ZZZ_NOPE_17`, which does not exist. The worklists
were compared byte for byte after removing ids, timestamps and finding indexes.

| Read | Answer |
|---|---|
| worklist POST with `checkVariant=ZZZ_NOPE_17` | 200, a 32-hex id (as in 2026-09-14) |
| its run and its worklist | 200, **`FINDING_STATS` and worklist identical to `DEFAULT`'s** on both objects (49 and 1 findings, same check ids). No info, no message, no status says the variant is unknown |
| the governance variant and the `systemCheckVariant` | 0 findings on both objects, worklists **identical to each other** and different from `DEFAULT`'s: both names exist and ran |
| `GET /sap/bc/adt/atc/variants` (published in discovery as `{?maxItemCount,data}`), with no query and with `maxItemCount=50&data=*` | 200, `application/vnd.sap.adt.nameditems.v1+xml`, 194 bytes, `totalItemCount = 0`: it does not list variants for these parameters |
| `GET /sap/bc/adt/atc/checkvariants` | 400 (no resource at the collection itself); `…/checkvariants/validation` 405 for GET |

So **a zero is a verdict of a real variant, and a wrong name is not a zero: it is `DEFAULT`'s
verdict under another label.** Nothing in the reply tells the two apart. The client's closed set
of variant names is what keeps a typo from reaching the server; a name in that set that no longer
exists on the system would still be answered with `DEFAULT`'s findings.

### A 500 is a dump: what the client does with it — 2026-09-14

Every HTTP 500 the ADT has answered this client so far was an ABAP runtime error on the
DEV: `enhoxh` persistence (`OBJECTS_OBJREF_NOT_ASSIGNED_NO` in
`CL_ENH_ADT_ENHO_OBJ_PERSIST`, rounds 14-16, also through the library's own
`findObjectPath`/search path used by `adt_transport {object}` on an `ENHO/XH`), a two-clause
feed `$query` (`ASSERTION_FAILED` in `CL_ADT_FQL_QUERY`). One exception:
`…/programs/includes/<name with '='>/source/main` answers 500 `ExceptionResourceReadFailure`
**without** a dump — so the client says *probably a dump* and reads the feed, it does not
assume. The library reports all of them as *Request failed with status code 500*. So every tool, through the journal wrapper
(`tools/index.mjs`), spends **one more call** after a 500: the newest dump of the session's
user (`/sap/bc/adt/runtime/dumps?$query=and ( equals ( user , <self> ) )&$top=1`, one clause),
and if it was published no earlier than the call started (15 s of skew allowed) the error
message gains ` -- the system dumped: <runtime error> in <program> (ST22 <key>; adt_runtime_errors
detail {id, full: true})` and the journal a `SERVER_DUMPED` line (runtime error, program, key
with the user stripped, timestamp). An older dump is reported as *none of this user since the
call started* — never attached. The feed failing files `DUMP_NOT_READ`; the original error is
never replaced. Module: `lib/dump-after-500.mjs`.

### How this client reports a failure — MEASURED 2026-09-09

⚠️ **The `AdtHTTP` throws on 4xx; it does not return the response.** Every `status >= 400`
branch written against `res.status` in this repository was therefore dead code against the
real system, and the journal recorded `HTTP ?` on every `ADT_ERROR` — a gap entry that
cannot say whether the resource was absent, the parameters wrong or the session expired.

The status is present, under a name that does not suggest it. `AdtException.js` builds the
error as `new AdtErrorException(response.status, properties, type, message, undefined,
namespace, localizedMessage)`, and the constructor assigns that first argument to
**`this.err`**. On that path `.status` and `.response` stay `undefined`; the `.status`
getter belongs to `AdtHttpException`, a different class used for transport-level failures.
Reproducible without a system:

```js
const { AdtErrorException } = require('abap-adt-api');
const e = new AdtErrorException(406, {}, 'ExceptionResourceNotAcceptable', 'msg');
e.err;      // 406
e.status;   // undefined
e.response; // undefined
```

`namedGet` now normalises `err` / `status` / `response.status` in that order and keeps
`type` and `localizedMessage`, and **refuses to report a value below 100 as a status** —
`adtException(message)` defaults that same field to `0`, and `HTTP 0` would read like a
measurement. A failure with nothing readable says *no readable status* instead.

### Fiori launchpad, OData V2 under `/sap/opu/odata/UI2` — MEASURED 2026-10-01/02

Six probe rounds on the development system (`measurements/launchpad*-2026-10-0[12]`). Not ADT: the authority
of these paths is the Gateway catalogue (`/IWFND/CATALOGSERVICE;v=2/ServiceCollection`, 200), and
the route decision is in [`security.md`](security.md), *The Fiori launchpad -- 2026-10-02*.

**Which services answer.** `$metadata` 200 for `PAGE_BUILDER_CONF`, `PAGE_BUILDER_CUST`,
`FDM_PAGE_REPOSITORY_CUST_SRV`, `FDM_PAGE_REPOSITORY_SRV`, `FDM_SPACE_REPOSITORY_CUST_SRV`,
`FDM_PAGE_RUNTIME_SRV`, `FDM_VALUE_HELP_SRV`, `INTEROP`, `FIORI_CATALOGS`, `LAUNCHPAD`; the
root is case-insensitive (`UI2` = `ui2`). `FDM_SPACE_REPOSITORY_SRV` answers **403** (not
registered). The client goes by the session cookie: with and without `sap-client=001`, the same
body. Bodies are `application/json; charset=utf-8` and real UTF-8
(the accented letter of `Café` arrives as `C3 A9`).

**Catalogs** (`<root>/Catalogs`, 13 fields: `id type domainId remoteType title systemAlias
remoteId isReadOnly originalLanguage scope baseUrl chipCount outdated`).

| Service | Rows | Of the customer |
|---|---|---|
| `PAGE_BUILDER_CONF` (cross-client) | thousands | a handful of customer catalogs (a namespaced id such as `/UI2/…` is SAP or an SAP partner, never the customer -- a decision, not a measurement) |
| `PAGE_BUILDER_CUST` (client) | thousands | `scope=CUSTOMIZING`: the customer's Z/Y catalogs, some with no Z prefix at all, plus the SAP catalogs changed in the client |

- The catalog id is `X-SAP-UI2-CATALOGPAGE:<domainId>`. An id can carry an accent
  (`X-SAP-UI2-CATALOGPAGE:Café`, title `ZDEMO_TCODE`), a namespace (`/UI2/…`) and a
  zero-width space (U+200B) at the end; never a quote, a blank or a parenthesis.
- The changed SAP catalogs have `scope=CUSTOMIZING` on the catalog. The instances read
  (`SAP_PRC_BC_PRC_OVP`) were not; what changed in them is not established. They are in the
  CONF list too (their delivered version), so a client filter that drops the CONF ids drops them.
- **A client catalog is mostly references.** An instance of a business catalog carries
  `referencePageId` (`X-SAP-UI2-ADCAT:SAP_TC_EAM_BE_APPS:S4EAM`: the replicated technical
  catalog and its system alias) and `referenceChipInstanceId` (`<chip>_TM`; the instance id is
  `<chip>_TM_COPY`), with the referenced mapping already expanded in `configuration`. This is
  SAP's recommended set-up: technical catalogs in the configuration scope, business catalogs
  in the customizing scope that reference them, per tile/target mapping and never per
  catalog. Source: the guide *SAP Fiori Launchpad* (ABAP Platform), "Scopes for Adapting
  Launchpad Content" and "Best Practices for Managing Catalogs".
- **One intent, several targets.** SAP's own technical catalog can deliver several
  (`SAP_TC_EAM_BE_APPS`: `IW32` and a Web Dynpro for `MaintenanceOrder-change`). A
  business catalog that references both hands one user two targets. The launchpad does not
  fail; it picks one. The order comes from ushell 1.120
  `_ClientSideTargetResolution/Search.js`, function `sortMatchingResultsDeterministic`:
  `sap-priority`, then the sort string `AIDM CURCP g/x TECM MTCH MREQ NFIL NDEF POT RFRE
  TECP`, where `A_TECHNOLOGY_PRIORITY` is `[undefined, GUI, WDA, UI5]`, then the serialized
  result. That is shipped code, not prose documentation, and the UI5 version of the system was
  not read.

**A catalog page with its tiles** (`PAGE_BUILDER_CUST/Pages('<id>')?$expand=PageChipInstances/Chip,…`,
`ZDEMO_CAT`: 200, 12,554 bytes).

- **Page:** `id title catalogId layout originalLanguage isCatalogPage chipInstanceCount
  isPersLocked isReadOnly scope updated outdated`.
- **Instance:** `pageId instanceId chipId title configuration layoutData remoteCatalogId
  referencePageId referenceChipInstanceId isReadOnly scope updated outdated`.
- **Chip:** `id title description configuration url baseChipId catalogId
  catalogPageChipInstanceId referenceChipId isReadOnly`.
- **Two chip types:** `X-SAP-UI2-CHIP:/UI2/ACTION` = target mapping, and
  `X-SAP-UI2-CHIP:/UI2/STATIC_APPLAUNCHER` = tile.
- **Content:** it is a JSON **inside a JSON string inside a JSON string**:
  `configuration` → `{"tileConfiguration":"<json>"}`.
  - Target mapping: `semantic_object`, `semantic_action`, `navigation_provider` (`TR`, …),
    `transaction.code`, `ui5_component`, `url`, `web_dynpro.application`, `signature.parameters`
    (with `rename_to`, `defaultValue`), `mapping_signature`, `form_factors`, `target_system_alias`.
  - Tile: `display_title_text`, `display_subtitle_text`, `navigation_semantic_object`,
    `navigation_semantic_action`, `navigation_semantic_parameters`, `navigation_target_url`,
    `display_search_keywords`, `service_url`.
- **No field of the page, the instance or the chip names a person.** `updated` is a timestamp.

**Groups.** A group is a `Pages` row with `catalogId = '/UI2/FLPD_CATALOG'`.

- The filter answers 200 with thousands of rows, under a megabyte (`$select=id,title,catalogId`;
  `scope` selected in a later measurement).
- **A `$select` naming a property that does not exist answers 404, not 400.** An early probe selected
  `layoutId` with the same filter and got 404. The same read without `layoutId` answered 200.
  So a 404 on a gateway route can mean "your field list is wrong", and not "the set is
  absent".
- **Scopes:** customer groups are `CUSTOMIZING`; SAP's are `CONFIGURATION`; a few non-Z groups are `CUSTOMIZING` too.
- **A tile in a group** is an instance whose `chipId` is
  `X-SAP-UI2-PAGE:X-SAP-UI2-CATALOGPAGE:<catalog>:<catalog instance id>`, with the
  `reference*` fields empty. Measured on `ZDEMO_STOCK`: 5 instances.

**FDM (spaces and pages).**

- `spacesMasterSet` 263 rows. `pagesMasterSet` 408 rows, of which **0** are Z/Y. No space is
  Z/Y either. Fields of a master row: `id modifiedOn title description`.
- **The whole page list fails in the client, not on the server:** *Parse Error: Header
  overflow*. Each page that has no space adds a warning to the `sap-message` header (code
  `/UI2/PAGE/028`), and the full list builds a header of about 63 KB against the 16 KB
  default of Node. Read in pages of 50, the header measured at most 11,539 bytes.
- **A space** (`spaceSet('<id>')?$expand=pages`) has `id title description sortPriority
  numberOfPages numberOfRoles masterLanguage pages{id pageIndex title description visibility}`.
- **A page** (`pageSet('<id>')?$expand=sections/viz,roles,spaces`) has `id title description
  devclass masterLanguage transportId sections{id title sectionIndex viz} roles{id title}
  spaces{id title description sortPriority}`.
- `roleSet('<role>')/catalogs` answers the catalogs of a role
  (`ZS:DEMO.ROLE_C`: 3).
- `createdBySet` and `modifiedBySet` exist (`username`, `fullname`) and **are not read**.
- **Answer 501:** `vizReferenceHierarchySet` (both FDM page services), `spaceActionSet`,
  `displayOptionSet`, `vizOptionSet`. The gateway log holds 24 entries from round 1: 22 from
  these sets, 1 from the `layoutId` select and 1 from `FDM_SPACE_REPOSITORY_SRV`. Rule in
  [`security.md`](security.md).

**Semantic objects** (data preview, `/UI2/SEMOBJ*`, package `/UI2/SEMANTIC_OBJECT`):

- `/UI2/SEMOBJC` (cross-client, class C, only `SEM_OBJ`) holds the customer semantic objects.
  Several have no Z prefix (a product or partner name, a generated `S_AHR_…` id).
- `/UI2/SEMOBJCT` holds their texts.
- `/UI2/SEMOBJ` (SAP, class S, `SEM_OBJ AKH_COMP STATUS`) holds SAP's, a few thousand rows.
  `SalesOrder` is in it; a customer's unprefixed object is not.

**The launchpad in the PFCG menu** (data preview on `AGR_HIER`/`AGR_BUFFI`, exploratory, before
the decision that the MCP issues no `SELECT` on `AGR_*`):

- Most customer roles have a menu, and most of those a launchpad node. No derived role has one.
- **Node kinds**, most to least frequent: `OT/SERVICE`, `TR`, `FOLDER/CAT_PROVIDER`,
  `GROUP_PROVIDER`, `FOLDER`, `URL`, `SPACE_PROVIDER`, `WDY_APPLICATION`, `BW_GENERIC_TYPE`,
  `BSP_APPLICATION`.
- **`AGR_BUFFI.URL` by provider:**

  | Provider | Form | Frequency |
  |---|---|---|
  | `CAT_PROVIDER` | `X-SAP-UI2-CATALOGPAGE:<id>?DEST_FES=…&ROLE_ORIGIN=…` | almost all |
  | `CAT_PROVIDER` | `X-SAP-UI2-HANA:hana?remoteId=HANA_CATALOG` | rare |
  | `CAT_PROVIDER` | `X-SAP-UI2-PAGECHIP?pageId=<id>` | rare |
  | `GROUP_PROVIDER` | `sap-ui2-group:<id>` | common |
  | `SPACE_PROVIDER` | the bare id | some |

### The launchpad and role routes, as built — ACCEPTED 2026-10-02

`scripts/probes/probe-launchpad-routes.mjs`: each of the 12 launchpad routes through
the real `namedGet`, 16 GETs, no POST. Evidence is in `measurements/launchpad-routes-2026-10-02`.

- **16 of 16 answered 200**, in 0.36–0.93 s each.
  - The two catalog lists: 1.5 MB and 2.2 MB.
  - `flpGroups`: 0.9 MB.
  - Everything else: under 20 KB.
- **Keys:**
  - `X-SAP-UI2-CATALOGPAGE:Café` reaches the entity with the accent percent-encoded
    (2 instances).
  - `X-SAP-UI2-CATALOGPAGE:/UI2/ZDEMO_TEST` reaches it with `/` as `%2F` inside the quotes. The
    Gateway and the ICM do not refuse the encoded slash. The entity is `scope=CONFIGURATION`,
    0 instances.
  - `ZDEMO_TC_CO_APPS`, the one Z catalog that exists only cross-client, answers through
    `PAGE_BUILDER_CUST` as well.
- **No key of any body names a person.** No value matches a user name of the system as
  a whole word; a 5-character one matches only inside ids such as `SAP_BASIS_*`. **The gateway
  log gained no entry.**
- **Shapes that the parser must read:**
  - The page `$expand` brings `Chip` and `ChipInstanceBags.results[].ChipInstanceProperties.results[]`
    (`name value translatable bagId`). It also brings `__deferred` links for `Bags`, `Catalog`,
    `allCatalogs`, `RemoteCatalog`, `ReferenceChip` and `ReferenceChipInstance`.
  - The group `ZDEMO_STOCK` has no bag in any instance.
  - `fdmPages` answers `__count` without `$inlinecount`.
  - `fdmPage` of `SAP_BASIS_PG_UI_FLP` has a section with **no viz**. The shape of a viz is
    therefore still unmeasured (no Z page exists), and the parser has to treat it as unknown.
  - The role service answers `{system, client, service_version, count, roles|nodes}`.
    - `roles[]`: `{name, type, parent, title_pt, title_en, launchpad}`.
    - `nodes[]`: `{role, object_id, kind (catalog|group|space), url}`.

Fixtures are in `tests/fixtures/launchpad/`, cut from these bodies by
`make_fixtures.py` (scratchpad, not versioned):

- the lists are reduced to representative rows;
- the host is `vhdemohost.example`;
- the role file is kept byte for byte, CRLF, as `-text` in `.gitattributes`.

### The UI5 repository over the ADT, and the live `$metadata` of a Fiori app's service — MEASURED 2026-11-09

Three probes on the development system, 79 GETs in all. The app was a Fiori elements List Report
(V2) with a controller extension. The route decision is in [`security.md`](security.md),
*The $metadata of a service a Fiori app consumes -- 2026-11-09*.

**Discovery.** Three filestore collections:
- `/sap/bc/adt/filestore/ui5-bsp/objects` (*SAPUI5 Filestore based on BSP*)
- `…/ui5-rt-version` (*SAPUI5 Runtime Version*): `text/plain`, 7 bytes, the UI5 version
- `…/deploy-storage` (*Filestore Marker for Deploy storage support*): the same body as the
  object list

**The list.** `GET …/objects` returns 1.4 MB of `application/atom+xml;type=feed` covering
2,863 apps. `?name=`, `?query=` and `?maxResults=` are each ignored, and the body is the same
byte for byte. That is why apps are named, never searched.

**One app.**
- `GET …/objects/<APP>` returns one `atom:entry`, `atom:summary` = the BSP description,
  plus a link `rel="appindex"`. GET on that link answers **405**.
- `GET …/objects/<APP>/content` returns a feed with one entry per child:
  - `atom:category term="file|folder"`;
  - `atom:id` = the path with `%2f` for each slash;
  - on a file: `afr:etag` (a timestamp, `20261030132214`) and a `rel="execute"` link to the BSP
    URL (host, port and `sap-client`, so never followed).

**A file or a folder.** The whole path is **one** segment:

| Request | Result |
|---|---|
| `…/objects/<APP>%2Fmanifest.json/content` | 200, `application/json` |
| `…/objects/<APP>/manifest.json/content` | 404 with **no** ADT message (the route does not exist) |
| encoded path to a file that does not exist | 404, "Resource <APP>/… does not exist" (in the logon language) (the message truncates long paths) |

- Folders: `…/<APP>%2Fext%2Ffragment/content` returns the same feed shape.
- Files: the content type follows the file: `application/json`, `text/xml`,
  `application/x-javascript` (minified `.js`), `application/octet-stream` (`-dbg.js`, `.properties`).
- A deployed app carries each module twice, `X.js` (minified) and `X-dbg.js`, plus `.js.map` and
  `Component-preload.js` (all modules again). The `-dbg` source is read once and the rest is skipped.

**What the measured app does NOT carry.** It has no `localService/` folder: the
`localUri` of its manifest points at nothing deployed. Its local `annotations/annotation.xml`
references the live service `$metadata` and holds an empty schema.

**The service, live.** `GET /sap/opu/odata/sap/<SERVICE>/$metadata` returns 200, 92 KB,
`application/xml`, `edmx Version="1.0"`. Details:
- **Namespace:** `cds_<srvd>`. The manifest names the **binding** (`…_2`); the namespace names
  the **service definition**. This is how an app is attributed to an SRVD.
- **Content:** 26 entity sets (12 `SAP__*`) and 2 function imports
  (`m:HttpMethod="POST"`, `sap:action-for`), each with its `Parameter`s.
- **Annotations (VAN):** the VAN data source answered 200, 51 KB, from
  `/sap/opu/odata/IWFND/CATALOGSERVICE;v=2/Annotations(TechnicalName='<VAN>',Version='0001')/$value/`.
  It is not routed: it is generated from the CDS, so it cannot disagree with the service.

**What the app's code addresses (the extractor's measured cases).**
- `callFunction("/<Import>", {method: "POST", urlParameters: {<Param>: …}})`
- `oODataModel.read("/<Set>", {urlParameters: {"\$filter": "<Prop> eq '" + x + "'", …}})`, with
  the **escaped** `"\$filter"` key and a `success` callback holding a regex literal (`/'/g`)
- `.create("/<Set>", payload, …)`
- `getModel("<json model>").getProperty("/…")`, which names no service

**OData V4, live.** A third probe, 30 GETs. It read the manifests of the Z/Y apps in the list
one by one until three of them named a V4 data source (22 manifests).
- **The URI forms met** (`odataVersion`, then `uri`):

  | Count | Form |
  |---|---|
  | 19 | `2.0` `/sap/opu/odata/sap/<SERVICE>/` |
  | 2 | `4.0` `/sap/opu/odata4/sap/<binding>/srvd_a2x/sap/<srvd>/0001/` |
  | 1 | `4.0` `/sap/opu/odata4/sap/<binding>/srvd/sap/<srvd>/0001/` |

  No `;v=`, no `;o=` and no `srvd_f4` appeared. One app in the list had no `manifest.json`
  (the "does not exist" 404 above).
- `GET <uri>$metadata`, with the uri exactly as the manifest writes it (lower case), returned
  200 on all three: 14 to 211 KB, `application/xml`.
- **The shape.** `edmx:Edmx Version="4.0"`, three `edmx:Reference`s (vocabularies), then **one**
  `Schema` with `Namespace="com.sap.gateway.<srvd|srvd_a2x>.<srvd>.v0001"` and
  `Alias="SAP__self"`, holding `EntityContainer Name="Container"`. In both groups the namespace
  names the service definition, so an app is attributed to its SRVD as in V2.
- **Operations** are `Action` and `Function`. A bound action is overloaded, one per entity type
  under the same name: 43 `Action` elements came down to 8 names. No `ActionImport` or
  `FunctionImport` was met. Annotations are inline, 21 to 360 `<Annotations>` per document.
- **Case.** The same URL with binding, group and service definition upper-cased returned the same
  bytes on all three, so the path is case-insensitive. The route builds the lower-case form.

## How to reproduce

The readings above used a **temporary** probe: `lib/ddic-probe.mjs` plus a four-line
escape hatch in `tools/index.mjs` that routed `objectName: "probe:…"` on `adt_object_info`
to it (`probe:<Entity>`, `probe:dtel:<name>`, `probe:disc[:<filter>]`). The probe rode on an
existing tool because a new tool name is invisible to an MCP client that pinned its tool
list at session start.

Both are **gone** now that the measuring is done and `adt_value_help` reaches the same
calls through a supported path: the probe was never committed, and the hatch was removed
in the commit that registered the sixth tool. To measure something new, write the probe
again — three `await api.<method>(…)` calls behind the same hatch — rather than leaving
an undocumented entry point in a tool that ships.

**The CTS section used a second shape of the same idea, and it is the one to copy when the
methods are not in the allowlist yet.** `scripts/probe-cts.mjs` never touched the guarded
client: it went through `transportFor()` (`lib/adt-get.mjs`), the GET-only seam that hands
back `({url, headers}) => …` and never lets the `AdtHTTP` escape its closure. So **no line
of `lib/guard.mjs` changed in order to measure** — which matters, because widening the
guard to find out whether the guard should be widened is circular. It also read the **raw
XML** rather than the client's parsed object, and that is what caught `tm:all_objects`
being dropped by `parseTask`: a parser cannot show you what it discards. It was never
committed and is gone, in three rounds — round 1 read the discovery the six
requests the one reading round 2 had left open. Each round was written only after
the previous one had been read, which is why round 3 asked a question round 1 could not
have phrased: the server named the media type itself, in a 406.

## Sources

- [Looking for Documentation on ADT API Endpoints — SAP Community Q&A](https://community.sap.com/t5/technology-q-a/looking-for-documentation-on-adt-abap-development-tools-api-endpoints/qaq-p/14217047)
  — confirms there is no public endpoint reference, and points at the service document.
- [ADT configuration guide, AS ABAP 7.57 (help.sap.com, PDF)](https://help.sap.com/doc/2e65ad9a26c84878b1413009f8ac07c3/202210.000/en-US/config_guide_system_backend_abap_development_tools.pdf)
  — `/sap/bc/adt` activation, the DDIC subservice from 7.40 SP02, Basic auth over HTTPS.
- [End-to-End SAP Automation with ADT REST Services](https://medium.com/@onuryz.itu/end-to-end-sap-automation-with-adt-rest-services-and-ai-a-modern-alternative-to-gui-scripting-343ea86064ea)
  — where the `/sap/bc/adt/ddic/elementinfo?path=…&type=ddicAnnotationValue` form and the
  `Accept: application/vnd.sap.adt.elementinfo+xml` header came from.
- `node_modules/abap-adt-api/build/api/{cds,objectcontents,discovery}.{js,d.ts}` — the
  client's own contract: `DdicProperties`, `DataElementProperties`, `DomainProperties`
  (`valueInformation.valueTableRef`, `fixValues`), `AdtDiscoveryResult`, and the JSDoc
  that gives the `/sap/bc/adt/ddic/{dataelements,domains}/<name>` URL shapes.
- This system's `/sap/bc/adt/discovery`: 115 workspaces, 117 collections matching `ddic`.

### For the CTS / Transport Organizer section

Rank 4 material — *used to learn that a parameter exists, never to conclude what it does*.
Each entry below says what it was actually used for, and every claim it suggested was then
either measured on this system or left out.

- [Transport API returns 406 — Wrong Accept header for CTS endpoints (`oisee/vibing-steampunk` issue #9)](https://github.com/oisee/vibing-steampunk/issues/9)
  — the only public report that describes **both** of the symptoms seen here: a 406, and
  *"empty responses: returning no results despite transports existing in the database"*,
  blamed on a client sending a generic `Accept`. It is what made the A1/A2 control worth
  running. ⚠️ It did **not** predict the answer: this system names
  `…transportorganizertree.v1+xml`, which the report does not mention. Used as a
  hypothesis generator, and then falsified in part by the measurement above.
- [ADT Transport list empty — SAP Community](https://community.sap.com/t5/application-development-and-automation-discussions/adt-transport-list-empty/m-p/465100)
  — same visible symptom from a different cause (SAP Note 2185682). Recorded to be
  **discarded**: that note long predates S/4HANA 2023 FPS00, so it is almost certainly
  already in this system. It is here so the next reader does not spend the search again.
- [Transport Management — `mcp-abap-abap-adt-api` (DeepWiki)](https://deepwiki.com/mario-andreschak/mcp-abap-abap-adt-api/3.3-transport-management)
  — another MCP server over the same client library, useful only as confirmation that its
  transport surface is `abap-adt-api`'s and inherits the same `userTransports` behaviour.
- [`CL_CTS_ADT_TM_REST_RES_CONT` — sapdatasheet.org](https://www.sapdatasheet.org/abap/clas/cl_cts_adt_tm_rest_res_cont.html)
  — names the backend handler class and package `SCTS_ADT` behind these collections.
  Useful for a Where-Used in the system; nothing was concluded from it.
- **No public source documents the XML of `tm:abap_object` for a customizing entry.**
  Searched and not found — which is why the `tm:obj_info` question could only be settled
  by reading the bytes, and why the negative answer above is recorded so explicitly.
- `node_modules/abap-adt-api/build/api/transports.{js,d.ts}` — the client's contract:
  `parseTask`/`parseRequest`/`parseTargets` (`:99-120`), `transportDetails` (`:121-127`),
  `userTransports` (`:128-137`), and `TransportObject`/`TransportTask`/`TransportsOfUser`
  in the typings. ⚠️ The typings are **not** a runtime limit: `xmlNodeAttr`
  (`build/utilities.js:136-142`) returns every non-`xmlns` attribute, so the five fields
  `TransportObject` declares are what the client *documents*, not what it hands back.

### Service Bindings: `/businessservices/bindings` and the `odatav4`/`odatav2` detail — MEASURED 2026-11-09

These probes ran on the development system with three bindings: one OData V4 UI binding, one SQL
binding, and one name that does not exist. They used GET only. No route has been decided yet.

**Discovery.** 42 collections under `/sap/bc/adt/businessservices`.

**The binding.** `GET …/businessservices/bindings/<srvb lower case>`
- returns **200** `application/vnd.sap.adt.businessservices.servicebinding.v2+xml`, about 2.9 KB;
- returns the same body under `*/*` and under the Accept that discovery advertises.

The root `srvb:serviceBinding` carries:
- `srvb:contract` (`C1` on the V4 binding, `C2` on the SQL one), `srvb:releaseSupported`,
  `srvb:published`, `srvb:bindingCreated`;
- the usual `adtcore:*` header, with responsible, `changedBy` and so on;
- `adtcore:packageRef`;
- `srvb:services srvb:name=…`, holding one `srvb:content` with `srvb:version` (`0001`), the
  minor, patch and build versions, and `srvb:releaseState` (`NOT_RELEASED`);
- inside that, `srvb:serviceDefinition` with the uri, type `SRVD/SRV` and name of the SRVD;
- `srvb:binding`, which says what kind of binding it is:
  - `srvb:type="ODATA" srvb:version="V4" srvb:category="0"` (UI) on the V4 binding;
  - `srvb:type="SQL" srvb:category="1"` with **no** `version` on the SQL binding;
- links, among them `rel=…/categories/odatav4` → `/businessservices/odatav4/<SERVICE>`.

A name that does not exist answers **404** with an ADT message in the logon language.

**The detail.** `GET …/businessservices/odatav4/<SERVICE>?servicename=&serviceversion=&srvdname=`
- returns 200 `application/vnd.sap.adt.businessservices.odatav4.v1+xml`, about 1 KB;
- `odatav4:serviceGroup` carries `odatav4:published` and `odatav4:serviceUrlPrefix`
  (`/sap/opu/odata4/sap/<group>/srvd/`, the root that `odataMetadataV4` reads);
- one `odatav4:services` row carries `serviceId`, `serviceVersion`, `repositoryId="SRVD"` and
  `created`;
- links to `odatav4/publishjobs` and `unpublishjobs`. Those are **write** actions and are never
  followed.

⚠️ **The detail is not a validator.** The other kind's path on the same service
(`odatav2/<V4 service>`) also answers **200**, as a plausible `odatav2:serviceList` with
`created="true"`. For the SQL binding, `odatav2/<name>` answers 200 with `created="false"` and
`repositoryId=""`. The kind of a binding is read from `srvb:binding` in the binding document,
never from which detail path answers.

### Service bindings and definitions, broad probe: nine bindings, eight SRVDs — MEASURED 2026-11-09

GET only, on nine bindings:
- three customer bindings: OData V4 UI, OData V2 UI and SQL;
- three namespaced SAP demo bindings: `/DMO/UI_AGENCY_O4` (V4 UI), `/DMO/UI_FLIGHT_R_V2` (V2 UI,
  the **only published one**) and `/DMO/API_TRAVEL_U_V2` (V2 Web API);
- three SAP-standard bindings: `UI_ACCRUALS_MANAGE`, `UI_APJ_JOB_USER_O2` and `API_ABOPRUN`
  (V4 Web API).

Coverage: this round read one published binding. The coverage round below read 376 bindings;
where the two differ, the coverage round is the measurement.

**Discovery templates.** The server publishes these templates itself:
- the detail is `…/odatav4|odatav2/{objectname}{?servicename,serviceversion,srvdname}`, where
  `objectname` is the **binding** (as the IDE sends it). The probe sent the service name in that
  position and the server still answered 200. ⚠️ That 200 was the not-found row: the path **is**
  read, in upper case (see *The detail path is read, and its case matters*);
- `…/odatav2/publishjobs|unpublishjobs{?servicename,serviceversion}`: actions, never followed;
- `…/bindings/validation`, `uiconfig/{bindtype}` and `schema/{bindtype}`;
- `…/businessservices/release{?objectname,bindtype,bindtypeversion,repositoryid,servicename,serviceversion}`
  (*Service Binding Classification*);
- for SRVD, only the object and `source/main`, plus `ddic/srvd/elementinfo{?path}`.

**The binding document.**
- Every one of the nine answered **200** `…servicebinding.v2+xml`, 2.8-2.9 KB.
  `…servicebinding.v1+xml` answers **406** on all nine, so v2 is the only representation.
- `srvb:binding` names the kind. Measured: `ODATA V4` and `ODATA V2`, each with category `0` (UI)
  or `1` (Web API), and `SQL` with no version and category `1`.
- Contract measured: `C1` on every UI binding, `C2` on the Web API and SQL ones.
- Each of the nine held **one** `srvb:services` with **one** `srvb:content` (version `0001`).
  A binding with several versions was not among them.
- **The service name is not the binding name.**
  - On a V4 binding it is the SRVD name (`/DMO/UI_AGENCY_O4` → service `/DMO/UI_AGENCY`).
  - It can be mixed case (`API_ABOPRUN` → service `ABOPRun`).
  - A V2 and a V4 binding can share one SRVD.
  - The name, version and SRVD for the detail are therefore read from the document, never
    derived from the binding name.
- `…/bindings/<b>/objectstructure` answers **404** on all nine; it does not exist.
- `…/bindings/<b>/versions` answers 200 `application/atom+xml;type=feed`, 0.5-1.1 KB:
  - one entry per version, with an author, `atom:content src=…/versions/<stamp>/<id>/content`
    (`application/json`), and links to the transport request;
  - the feed title is in a logon-dependent language.

**The detail of the declared kind** (one read per binding, with the IDE's Accept list
`…odatavN.v1+xml, v2, v3`; the server answers `odatav2.v2` and `odatav4.v1`):
- On the one **published** V2 binding, the `odatav2:services` row carries:
  - `published="true"` and `created="true"`;
  - `serviceUrl` (`/sap/opu/odata/<ns>/<service>`, the root that `odataMetadata` reads);
  - `annotationUrl` (the catalogue service's `Annotations(TechnicalName='…_VAN',Version='0001')/$value/`);
  - a filled `serviceInfo:serviceInformation` with one `serviceInfo:collection` per entity set
    (`name`, `isLeading`, `isRoot`) and `serviceInfo:navigation` (`name`, `target`).
  On that one binding, this was the binding-side list of entity sets, read without calling the
  service. Whether a published V4 binding fills `serviceInformation` the same way has not been
  measured.
- On every **unpublished** binding, `published="false"`, `serviceUrl=""`, `annotationUrl=""` and
  an **empty** `serviceInformation`. ⚠️ The `created="false"` rows of this round came from reads
  whose path named the service instead of the binding: they are the not-found row, not "not
  generated" (see *The detail path is read, and its case matters*).
- A V4 `serviceUrlPrefix` was filled (`/sap/opu/odata4/sap/<binding>/srvd/`) on the read whose
  path named the binding, and `""` on the reads whose path did not.
- ⚠️ A version the binding does not hold (`serviceversion=0099`) answers **200** on every
  binding. The reply echoes `0099` with `created="false"` and `published="false"`. A 200 proves
  nothing; only `created`/`published` in the row do.

**The Gateway error log was not written by these nine reads** (eight unpublished, one
published V2). The probe read the logged-on user's
`/sap/bc/adt/gw/errorlog` before the run, after each binding and after the edges. The feed held
one entry from before the run (a "No service found" client error) and gained **none**. That
includes the very triple (V2 service name with a shared V4 SRVD) that the earlier row named. That
row came from another action in the IDE, not from the detail read.

The error-log entry shape, which was unmeasured until now (`entriesMeasured: false`):
- `atom:author/atom:name` holds the user and full name;
- `atom:id` is `ClientError/<32 hex>`;
- `atom:updated` is UTC;
- `atom:summary type="html"` holds the whole ST22-style page (header, service information, error
  context, source extract, call stack) as escaped HTML;
- there is no `atom:category` and no structured fields, so a parser has to read the HTML table
  rows.

**The service definition.**
- `GET …/ddic/srvd/sources/<srvd>` (namespaced as `%2fdmo%2f…`) answers 200
  `application/vnd.sap.adt.ddic.srvd.v1+xml`, about 2 KB.
- The root is `srvd:srvdSource`, with `srvd:srvdSourceType` (`S`, "Definition", on all eight),
  `srvd:sourceOrigin` (`0`, "ABAP Development Tools"), `abapsource:sourceUri`, the `adtcore:*`
  header and four links (versions, language versions, source).
- `/source/main` answers `text/plain`.
- `/objectstructure` answers **404** on all eight.
- An SRVD of another source type (A2X) was not among the cases.

**Absent names.** `bindings/<absent>` and `srvd/sources/<absent>` both answer **404** with an ADT
message in the logon language.

### Service bindings, coverage round: 376 bindings — MEASURED 2026-11-09

Two runs of a coverage probe, GET only. The candidates came from the server's own quick search
(`API_*`, `UI_*`, `C_*`, `/DMO/*`, `Z*`, `Y*`, then `*_O4`, `*_O2` and `*_API`), mostly
SAP-standard. 376 distinct bindings were read, each followed by the detail of its declared kind
and the metadata of its SRVD.

| Kind | Category | Published | Bindings |
|---|---|---|---|
| OData V2 | 0 (UI) | true | 137 |
| OData V2 | 0 (UI) | false | 66 |
| OData V2 | 1 (Web API) | true | 5 |
| OData V2 | 1 (Web API) | false | 2 |
| OData V4 | 0 (UI) | true | 59 |
| OData V4 | 0 (UI) | false | 27 |
| OData V4 | 1 (Web API) | true | 16 |
| OData V4 | 1 (Web API) | false | 64 |

- **One service and one version in every one of the 376.** The several-version case is measured
  in the next section.
- **`releaseState` values:** `NOT_RELEASED` (356), `RELEASED` (11) and
  `NOT_TO_BE_RELEASED_STABLE` (9).
- **The binding and the detail agree on `published`** in every one of the 371 pairs that could be
  matched (the five others were not paired by file name, not compared):
  - 153 unpublished: `created="true"`, empty `serviceUrl`, empty `serviceInformation`;
  - 217 published: `serviceUrl` filled and `serviceInformation` listing the entity sets;
  - 1 published with `serviceUrl` filled and **no** collection.
  Every unpublished version read with the right path said `created="true"`.
- **Published V4** fills `serviceInformation` the same way V2 does, with collections and, where
  they exist, navigations:
  - 14 or more V4 bindings with navigations and 30 or more without;
  - 20 or more V2 bindings with navigations and 18 or more without.
  - `serviceUrl` is the full V4 service path,
    `/sap/opu/odata4/sap/<binding>/srvd/sap/<srvd>/<nnnn>/`: the form that `odataMetadataV4`
    admits (`V4_SERVICE_PATH`).
  - `annotationUrl` is `""` on V4. On V2 it points to the catalogue service's annotation.
- **SRVD source type:** `S` ("Definition") on all 375 SRVDs read. No other type appeared.
- **SQL bindings:** none among these candidates. The one SQL binding measured is in the broad
  round.
- **The Gateway error log is not written.** The logged-on user's feed held the same single entry
  (from before both runs) on every read: before and after each run, around roughly 750 detail
  reads in all.

### Service bindings with several versions: `published` is per version — MEASURED 2026-11-09

The owner saw version 2 of three customer OData V2 UI bindings in `/IWFND/MAINT_SERVICE`. That
transaction publishes RAP V2 bindings as well as Gateway (SEGW) services. All three were read
with the coverage probe.

- **Nesting.** One `srvb:services` holds one `srvb:content` per version (`0001`, `0002`). Each
  content has its own `releaseState` and its own `srvb:serviceDefinition`. In all three bindings
  the two versions point to **different** SRVDs.
- **`published` is per version, and the root is not.** On one binding, version `0001` is
  unpublished and `0002` is published, while the root `srvb:published` reads `"true"`. The root
  flag is therefore not a statement about every version. The detail of each version is the only
  per-version answer. (The 376 single-version bindings could not show this: on them the root and
  the detail always agreed.)
- **The detail is asked once per version**, with `serviceversion=<nnnn>` and that version's SRVD.
  Each version answers its own row:
  - `serviceUrl` for version 1 is `/sap/opu/odata/sap/<SERVICE>`, and for version 2
    `/sap/opu/odata/sap/<SERVICE>;v=2`, the matrix parameter the Gateway uses for a version;
  - `annotationUrl` carries `Version='0002'`;
  - `serviceInformation` lists that version's entity sets, which can differ from version to
    version.
- No row was written to the Gateway error log.

### The detail path is read, and its case matters — MEASURED 2026-11-09

The first build of the binding route sent the binding name in **lower case** in the detail path
(`…/odatav2/<binding lower>?…`), the way the binding document is addressed. A metadata probe
read ten versions of seven bindings that way and, side by side, with the name in **upper case**,
as the IDE sends it:

- **Lower case:** every version answered **200** with the not-found row: `published="false"`,
  `created="false"`, an empty `serviceUrl` and an empty `serviceInformation`. That included nine
  versions that are published.
- **Upper case:** the true state: nine versions published with their URLs, one (`0001` of a
  two-version binding) unpublished with `created="true"`.

Conclusions:
- The path is read and is case-sensitive. The parameters alone do not decide the answer. A
  namespace travels as `%2F` (`encodeURIComponent` of `/NS/NAME`, the form measured on the `/DMO/`
  bindings).
- **`created="false"` is the not-found row.** It answered:
  - a wrong path;
  - a version the binding does not hold;
  - a non-OData binding asked for an OData detail.
  It was never the state of a real version: every correctly read unpublished version said
  `created="true"`. A reader treats the row as "not read", never as "unpublished".
- A 200 from this resource proves nothing by itself. Only a row with `created="true"` for the
  version that was asked describes that version.

### The `$metadata` of the service URLs a binding publishes — MEASURED 2026-11-09

A GET was sent once to `<serviceUrl>/$metadata` for every published version whose URL the first
two `$metadata` routes did not admit. The URLs were the ones the binding detail names, read with
the corrected (upper-case) path:

| Form | Example (anonymised) | Reads | Reply |
|---|---|---|---|
| V2, version above 1 | `/sap/opu/odata/sap/<S>;v=2/$metadata` | 3 | 200 `application/xml`, 37-42 KB, edmx 1.0 |
| V2, another namespace | `/sap/opu/odata/DMO/<S>/$metadata` | 2 | 200 `application/xml`, 58-189 KB, edmx 1.0 |
| V4, another namespace | `/sap/opu/odata4/dmo/<binding>/srvd/dmo/<srvd>/0001/$metadata` | 1 | 200 `application/xml`, 159 KB, edmx 4.0 |

- **`;v=2` travels literally**, as the serviceUrl writes it. A V2 namespace is upper case
  (`DMO`). A V4 namespace replaces `sap` in **both** places (`odata4/dmo/…/srvd/dmo/…`).
- **The binding's entity list is a subset of the `$metadata`, never the other way round.**
  Every set the detail listed was in the document (none missing in six reads). The document adds:
  - on V2, the same twelve framework sets every time: `SAP__Currencies`,
    `SAP__UnitsOfMeasure`, `SAP__MyDocumentDescriptions`, `SAP__FormatSet`,
    `SAP__PDFStandardSet`, `SAP__TableColumnsSet`, `SAP__CoverPageSet`, `SAP__SignatureSet`,
    `SAP__HierarchySet`, `SAP__PDFHeaderSet`, `SAP__PDFFooterSet` and `SAP__ValueHelpSet`;
  - on a draft-enabled service, `I_DraftAdministrativeData` (and on V2 also
    `I_DraftAdministrativeUserVH`).
  So the binding lists the entities the service definition exposes, and the `$metadata` is the
  full contract.
- No row was written to the logged-on user's Gateway error log.

### ATC check variants: `/atc/checkvariants` — MEASURED 2026-11-09

One customer variant, GET only.
- `GET …/atc/checkvariants/<name>` returns **200** `application/vnd.sap.adt.chkvv4+xml`, about
  13.6 KB. The name is case-insensitive: lower and upper case give the same body.
  - Root `chkv:checkvariant`: the `adtcore:*` header and `adtcore:packageRef`.
  - `chkv:content` holds `chkv:name`, `chkv:remoteEnabled` and `chkv:referencedVariant`, then one
    `chkvcheck:check` per check. Each check is a `chko:checkObject adtcore:name=<CHKO>` plus
    `chkvcheck:parameterValueXml`, whose text is **JSON**.
- `…/schema` returns 200 `application/vnd.sap.adt.chkvcheck.v1+json`: the JSON Schema of one
  check entry (`checkName` typed `CHKO`, and `parameters[]` with `name`, `type`, `value`,
  `valueList` and `valueRangeList` of sign/option/low/high).
- `…/formtemplate?chkvName=<name>&version=active` returns 200 `application/xml`, **306,621
  bytes**. It contains 26 `availableCheckCategory` entries, each with a `chkc:checkCategoryObject`.
  `version=inactive` returns the same body byte for byte, so this is the catalogue of available
  checks, not the variant. Whether it differs between variants has not been measured.
- A name that does not exist answers **404** with an ADT message in the logon language.

### Release states: `/informationsystem/releasestates` — MEASURED 2026-11-09

- `GET …/repository/informationsystem/releasestates?maxItemCount=999&name=*` returns **200**
  `application/vnd.sap.adt.nameditems.v1+xml`, about 12 KB. With no parameters the body is the
  same.
- `nameditem:totalItemCount` is 20, with one `nameditem:namedItem` per state:
  - `name`, for example `RELEASED`, `DEPRECATED`, `USE_IN_CLOUD_DEVELOPMENT`,
    `USE_IN_KEY_USER_APPS`, `EXTEND_IN_KEY_USER_APPS`, `USE_AS_REMOTE_API`, `USE_IN_AMDP`, the
    `DEPRECATED_FOR_*` family and the `HAS_*_SUCCESSOR` pair;
  - an empty `description`;
  - `data`, a string of the form `type=CHAR8B@@##@@longtext=<English text that names the
    contract C0/C1/…>`.
- `name=DEPRECATED*` is filtered **on the server** and returns 9 items.
- `maxItemCount=2` returns 2 items **and `totalItemCount` 2**: the count is the count after the
  cap, not the total. A capped reply cannot tell you that it was capped.

### Virtual folders: `POST /informationsystem/virtualfolders/contents` — MEASURED 2026-11-09

This is the IDE's project tree. It is a POST that reads. Discovery publishes three collections:
- `…/virtualfolders`, with Accept `…virtualfolders.result.v1+xml`;
- `…/virtualfolders/contents`, with the same Accept;
- `…/virtualfolders/facets`, with no Accept.

Request: `Content-Type: application/vnd.sap.adt.repository.virtualfolders.request.v1+xml`. The
body is `vfs:virtualFoldersRequest` (namespace `http://www.sap.com/adt/ris/virtualFolders`) with
`objectSearchPattern="*"`, `vfs:preselection facet=… / vfs:value` and a `vfs:facetorder`. A body
written by hand in that form was accepted. With a package preselected, the reply is **200**,
about 3 KB:
- `vfs:virtualFoldersResult objectCount=<n>` and `vfs:preselectionInfo facet="PACKAGE"`;
- one `vfs:virtualFolder` per child, with `facet`, `name`, `displayName`, `text` (the
  description), `counter` (objects below it), `uri` and `hasChildrenOfSameFacet`;
- the package's own objects come back as a folder named `..<PACKAGE>`;
- each folder has a `…/virtualfolders?selection=<facet>%3a<value>` link.

`Accept: */*` returns the same body. Adding a `type` preselection (`CLAS`) narrows the reply.

### Discovery has no switch or business-function collection — MEASURED 2026-11-09

The full discovery document has 676 collections. The only ones that match
`switch|sfw|business function` are the eight under `/sap/bc/adt/sfw/featuretoggles`
(*Switch-Based Feature Toggle*, with its formatter, `$schema`, `$configuration`, attribute value
helps, togglable object types and name validation). Those are feature toggles, not Switch
Framework switches or business functions. Nothing over the ADT says whether an `SFW_SWITCH` is on.

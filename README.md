# sap-adt-readonly-mcp

**Read-only MCP server over the SAP ADT REST API.** Gives an AI coding agent the answers that
otherwise require leaving the editor: *does this object exist? what is its real source? who
calls it? what is in this package? does it pass the ATC? does it consume anything that is not
released?* Everything is read from the SAP system itself — no local checkout, no copy of SAP
sources, no IDE file.

---

## Why this exists

SAP ships an official ADT MCP server inside the IDE (Eclipse on `localhost:2234`, VS Code
on `localhost:2236`). It covers the **write** side — activate, unit tests, transports,
generators — and it only runs while the IDE is open. It does **not** search the repository,
read source, or answer where-used; and its ATC answer, measured, is "error" and nothing else.

This server covers the **read** side of that gap, and never the write side:

| | Official SAP ADT MCP | `sap-adt` (this repo) |
|---|---|---|
| Activate, ABAP Unit, create/change objects, release transports | ✅ | ❌ by design |
| ATC on one object, findings legible, several variants | "error" (measured) | ✅ `adt_atc_run` (decision in `docs/security.md`) |
| Syntax check of the stored source, active or inactive | — | ✅ `adt_syntax_check` |
| Search objects, read source and its stored versions, where-used, package tree | ❌ | ✅ |
| Clean Core and annotation scans of a package, value-help recommendation | ❌ | ✅ |
| Transport contents and history, runtime errors (ST22), customizing reads, launchpad content | ❌ | ✅ |
| Works with the IDE closed | ❌ | ✅ |
| Can change the SAP system | yes | **no** |

> The official server covers writing and runs only with the IDE open; this one covers reading
> and runs with the IDE closed. The two coexist: this one **never** touches ports 2234/2236 or
> the IDE token.

## What it does

- **19 MCP tools** for an AI agent (Claude Code or any MCP client that speaks Streamable HTTP),
  every one of them read-only and reading from the SAP system:
  - *objects* — `adt_search`, `adt_read_source`, `adt_object_info`, `adt_where_used`,
    `adt_package_tree`, `adt_find_definition` (where the symbol at a position is defined),
    `adt_used_objects` (what a class uses, with each object's release state);
  - *package scans* — `adt_clean_core_scan` (what the CDS views consume, at which Clean Core
    level), `adt_annotation_scan` (which annotation reaches an element, from which layer),
    `adt_package_health` (the Clean Core scan and the syntax check on one listing, and optionally one ATC run over the package);
  - *CDS and services* — `adt_value_help`, `adt_annotation_chain`, `adt_contract_check`;
  - *change and runtime* — `adt_transport`, `adt_runtime_errors`, `adt_atc_run`,
    `adt_syntax_check`;
  - *configuration and UI* — `adt_customizing` (a closed list of tables), `adt_launchpad`
    (SAP-standard launchpad OData services).
- **A journal and a report**: every call, finding and limit hit is recorded (no payload, ever),
  and read back as a report from the terminal.
- **A configuration CLI** over a local SQLite store, so nothing of your landscape lives in the
  code, and a **catalogue sync** that keeps SAP's Clean Core release catalogue current outside
  the repository.

Every tool is described in [Tools](#tools); every npm script in [Scripts](#scripts); what it
cannot do in [Limitations](#limitations).

## Safety model

1. **Read-only by absence of capability.** The tools reach the system through a proxy
   (`lib/guard.mjs`) built on an **allowlist** of the 13 reads of `lib/adt-reads.mjs`; anything
   else throws before a request is issued — each read justified in
   [`docs/security.md`](docs/security.md). Every GET goes through a closed table of named
   routes (`lib/adt-get.mjs`), every POST through a module with a fixed path and a body built
   from validated values, and no generic HTTP call exists. There is no client library between
   this server and the system: the logon, the cookie and the CSRF token are `lib/adt-http.mjs`,
   on `node:https`. Covered by `npm run test:guard`, which runs offline.
2. **The session is stateless.** A stateful ADT session is what holds locks and enqueues;
   switching it is refused at runtime.
3. **The SAP password is never stored.** It is typed once per server start and lives only in
   memory. There is no `.env`, no keyring, no fallback to an environment variable.
4. **One login attempt per start.** On `401` the server refuses to retry: repeated failed
   logons lock the SAP user, and a locked user takes the IDE, abapGit and transports down
   with it.
5. **Nothing sensitive lands in the repository.** The environment store, the loopback token,
   the catalogue and the audit log live in `%LOCALAPPDATA%\sap-adt\`. The server refuses to
   start if that path resolves inside a git work tree.
6. **The MCP endpoint is loopback-only**: bound to `127.0.0.1`, `Host` and `Origin` checked on
   every request (DNS-rebinding protection, required by the MCP transport specification), and
   a bearer token compared in constant time.
7. **No value of your landscape is hard-coded.** Closed lists of SAP-standard entries ship as
   reviewable JSON (`data/defaults/`); everything your installation chooses lives in the
   environment store and passes the same validation on the way in and on the way out
   (see [Configuration](#configuration)).

## Requirements

- **Node.js ≥ 22.13** (the environment store uses the built-in `node:sqlite`; no extra npm
  dependency). Node prints no warning for it: the one `ExperimentalWarning` is filtered.
- **An ABAP system** (S/4HANA or ABAP Platform, on-premise or private cloud) whose
  `/sap/bc/adt` ICF node is active and reachable over **HTTPS** with **Basic authentication**
  (user + password). SSO-only nodes (SAML, X.509, `MYSAPSSO2`) are not supported.
- **An SAP user** with the authorizations your ADT IDE already uses. The data preview
  (`adt_customizing`, `adt_launchpad` semantic objects), the ATC run and the launchpad OData
  services need the SAP authorizations for those functions too; a missing one comes back as
  the SAP error, never as an empty answer.
- **A terminal (TTY)** for every command that logs on: the password is typed, never read from a
  file or an environment variable.
- **Internet access once a month** (or a manual download) for the Clean Core catalogue — see
  [The Clean Core catalogue](#the-clean-core-catalogue). The server itself never goes online.
- Developed and tested on **Windows**. On Linux/macOS the state directory is
  `~/.local/share/sap-adt`.

## Install and first run

```bash
git clone <this repository> && cd sap-adt-readonly-mcp
npm ci --ignore-scripts     # third-party code, no lifecycle scripts
npm run test:guard          # proves the read-only guard, offline
npm run probe -- --host my-sap-host --port 44300   # reachability + auth scheme, NO credentials
```

1. **Configure the connection** (nothing is read from an IDE or any other file):

   ```bash
   npm run config -- set host my-sap-host.example.com
   npm run config -- set client 001
   npm run config -- set user MYUSER
   npm run config -- set system DEV   # the system id the host must answer as
   ```

   Or copy [`config.example.json`](config.example.json), replace the invented values and load
   it once with `npm run config -- import my-env.json`.
2. **Get the Clean Core catalogue** for the release of your system:

   ```bash
   npm run sync:catalog -- --list                  # the releases SAP publishes
   npm run config -- set catalog.release PCE2023_0 # the one matching your system
   npm run sync:catalog                            # downloads it into the state directory
   npm run config -- doctor                        # what is set, what is missing, what is stale
   ```
3. **Start the server** in a terminal and leave it running:

   ```bash
   npm run adt
   ```

   Before asking for anything it prints the MCP endpoint (`http://127.0.0.1:2237/mcp`), the
   catalogue's age, and the exact `claude mcp add` line for your machine, in PowerShell and bash
   form, with the bearer token read from `%LOCALAPPDATA%\sap-adt\token` by the shell (never
   pasted).
4. **Register it once** in Claude Code, from a **second** terminal, with the printed line, and
   check with `claude mcp list`. Any other MCP client works the same way: Streamable HTTP
   transport, that URL, header `Authorization: Bearer <token>`.
5. **Type the SAP password** in the first terminal. **Nothing is echoed while you type** — no
   asterisks, no cursor movement. That is the terminal, not a hang: type it and press Enter. An
   empty password is refused locally, but a wrong one is a failed SAP logon, and repeated
   failures lock the user. The endpoint starts listening only after the logon succeeds. A
   refused logon is written to the audit trail, and the next start prints how many are on record
   since the last successful one, before it asks for the password.

To see the server the way a client does, the official **MCP Inspector** works against it:
`npx @modelcontextprotocol/inspector`, transport *Streamable HTTP*, URL
`http://127.0.0.1:2237/mcp`, header `Authorization: Bearer <token>`.

What the probe proves is in [`docs/phase0-report.md`](docs/phase0-report.md). What the ADT
API itself accepts, and the measured shape of every read used here, is in
[`docs/adt-api-reference.md`](docs/adt-api-reference.md) — SAP publishes no endpoint
reference, so that file records a service document as measured instead of guesses.

### Tests

`npm test` runs the whole suite offline — no SAP system, no credentials, no network: the ADT
client and GitHub are doubled. It includes a protocol test that drives the server with the
SDK's own MCP client over a real loopback connection (`tests/mcp-protocol.test.mjs`).
`npm run coverage` runs it again with the line, branch and function thresholds set in
`package.json` (tests themselves excluded from the count). Those numbers are a **ratchet, not a target**: they
sit just under what the suite already reaches, so a change that quietly stops exercising a path
fails the run. What the suite is actually for is the two things that cannot be checked by
reading: that no blocked ADT method is reachable, and that a recommendation is never emitted for
an entity the catalogue does not release.

**There is no prettier and no linter here, and formatting is manual — on purpose.** This
server has zero devDependencies: everything it needs to be tested and audited ships with
Node. Style is kept by hand (100 columns, single quotes); `npx prettier` will complain, and
that complaint is not a finding.

## Configuration

Everything an installation chooses lives in **one SQLite file outside any git work tree**,
`%LOCALAPPDATA%\sap-adt\sap-adt.db`, written **only** by `npm run config`. Every value is
validated when it is written and again when the server reads it at start, with the same rules
the runtime fence applies — a value the CLI accepts can never make the server refuse to start,
and a value the fence would refuse can never be stored. Nothing else on the machine is read.

```text
npm run config -- <command> [--json] [--db <file>]

  keys                              every setting, its group, default and meaning
  list                              the settings this installation has
  get <key>                         one setting (or its default)
  set <key> <value>                 validate and store one setting (a list: "a;b;c" or JSON)
  unset <key>                       remove one setting (back to its default)
  table list                        customizing tables: standard + this installation's
  table add <NAME> <why> [--key A,B] [--routine COL=GROUP ...]
  table remove <NAME>
  atc list | atc add <NAME> <why> | atc remove <NAME>
  import <file.json> [--replace]    validate a whole file (config.example.json shape) and store it;
                                    merges by default, --replace drops what the file does not name
  export [--out <file.json>]        the whole environment in that shape
  doctor                            validate the store and say what is missing or stale
```

For example:

```bash
npm run config -- table add ZMY_TABLE "why the data preview needs it" --key FIELD1,FIELD2
npm run config -- atc add ZMY_DEV_PRACTICE "development practices: naming, performance, robustness"
npm run config -- export --out my-env.json     # backup / review; `import` reads it back
```

Every command takes `--json` and answers `{ "ok": true, "data": … }` or
`{ "ok": false, "error": { "code", "message", "key" } }`, exiting 0 / 1 (refused value) /
2 (usage error) — a stable contract for tools that drive the CLI. `--db` points the CLI at
another store file (to prepare or inspect one; the server reads only the default).
[`config.example.json`](config.example.json) shows every block with invented values.

**Switching environments.** `import` merges: it writes what the file names and keeps everything
else. To move to another system without leftovers, back up the current one and replace:

```bash
npm run config -- export --out dev.json
npm run config -- import qas.json --replace     # settings, tables and variants not in the file are dropped
```

An import is validated whole. A refused value writes nothing and says so. A standard table listed
in the file (or in `table add`) is skipped with a warning, since it needs no registration.

| Group | Keys (default) | Used by |
|---|---|---|
| connection | `host`, `port` (44300), `client` (none — always your choice), `user`, `language` (EN), `system` (none — required: the host must answer as this system id, asked without credentials before the password prompt), `allowUnauthorizedTls` (false; prefer `NODE_EXTRA_CA_CERTS` for an internal CA) | the session |
| server | `mcpPort` (2237), `budget.reads` (200, a notice, not a cap), `shutdownMs` (5000) | `server.mjs`, the audit |
| catalogue | `catalog.release` (none — `Latest`, `PCELatest`, `PCE2025_2`, `PCE2023_0`, …) | `adt_clean_core_scan`, `adt_value_help`, `sync:catalog` |
| fences | customizing tables (`table add`), ATC variants (`atc add`, `atc.defaultVariant`) | `adt_customizing`, `adt_atc_run` |
| journal | `paths.logs` (`logs/` in this repository, git-ignored) | the journal, `report`, `logs:prune` |
| value help | `valueHelp.namePattern` (`ZI_{entity}VH`), `valueHelp.labelPrefix` (`Value help - `) | `adt_value_help` |

`npm run config -- keys` prints the meaning of each one. The SAP-standard half of every fence
ships in [`data/defaults/`](data/defaults/) and changes only by commit; the reason the fences
have two layers is recorded in `docs/security.md` (*The list has two layers*).

**ATC variants.** SAP's `DEFAULT` is always available, and so is the system's own check variant:
the server reads `systemCheckVariant` from `atc/customizing` at start, admits it and makes it the
default (the start-up line names it). Nothing to configure. If that read fails, the server starts
without it and the journal says so (`ATC_SYSTEM_VARIANT_NOT_READ`). List further variants with
`atc add`, such as a variant for development practices, and set `atc.defaultVariant` only to
override the system's choice. `adt_atc_run` runs up to three of them on one object in one call,
each with its own worklist and findings, and announces every variant with its purpose to the
client. A name the system does not have is answered with `DEFAULT`'s findings (measured), so
remove a variant from the store when it is deleted on the system.

## The Clean Core catalogue

`adt_clean_core_scan` and `adt_value_help` decide what is released with **SAP's Cloudification
Repository** ([`SAP/abap-atc-cr-cv-s4hc`](https://github.com/SAP/abap-atc-cr-cv-s4hc),
Apache-2.0): one release file (`objectReleaseInfo_<release>.json`) plus
`objectClassifications_SAP.json` (the classic APIs, Level B). These are the files the ATC Cloud
Readiness check itself reads.

- **Outside the repository.** `npm run sync:catalog` resolves the upstream commit, downloads
  both files **at that commit**, validates them, and swaps them into
  `%LOCALAPPDATA%\sap-adt\catalog\` (the previous copy stays as `catalog.prev`).
  `PROVENANCE.json` records release, commit, sha256, rows and date.
- **Refreshed on purpose.** The catalogue changes when SAP publishes, and the answers change
  with it, so the server never downloads anything. **Monthly** is a sensible cadence; the server
  banner, `doctor` and every answer of the two tools state the catalogue's age, and `doctor`
  warns past 35 days. To schedule it on Windows:
  `schtasks /Create /SC MONTHLY /TN sap-adt-catalog /TR "cmd /c cd /d <repo> && npm run sync:catalog"`.
- **No internet, or a proxy?** Download the two files by hand from the repository's `src/`
  folder and run `npm run sync:catalog -- --from <folder>`. Behind a proxy, Node's `fetch` uses
  `HTTPS_PROXY` when `NODE_USE_ENV_PROXY=1` is set.
- **Without a catalogue** the two tools refuse and file `CATALOG_MISSING` — never "released".
- **For people:** SAP's viewer, https://sap.github.io/abap-atc-cr-cv-s4hc/, shows the same data;
  the answers link to it for a manual check.

`npm run sync:catalog -- --check` prints what is installed and how old it is, without network.

## MCP conformance

The server follows the MCP specification (2025-06-18) and the official TypeScript SDK:

- **Transport:** Streamable HTTP, stateless, loopback only, `Host`/`Origin` validated, bearer
  token (no OAuth is advertised: a `401` carries no `WWW-Authenticate`, so clients do not start a
  discovery flow this server does not implement). HTTP rather than stdio because the SAP password
  is typed in the server's terminal, and the specification forbids asking for it through the
  client (elicitation must not request sensitive information).
- **Initialize:** `serverInfo` with name, title and version, and `instructions` that tell the
  model how to use the tools well.
- **Tools:** every definition has a `title`, behaviour `annotations` (`readOnlyHint: true`,
  `destructiveHint: false`, `idempotentHint` — false only for `adt_atc_run`, which leaves a
  worklist — and `openWorldHint: true`), and a closed input schema (`additionalProperties:
  false`) that is **enforced** before the handler runs (type, enum, ranges, items, unknown
  arguments). Answers carry `structuredContent` next to the same JSON as text. No `outputSchema`
  is declared on purpose: the answers are rich and shaped by what the system returned, and a
  client must reject an answer that does not match a declared schema.
- **Errors:** a tool failure is a result with `isError: true` and a readable reason, never a
  protocol error.
- **Long calls:** the package scans and a multi-variant ATC run send progress notifications when
  the client asks for them, and stop between reads when the call is cancelled.

## Tools

| Tool | What it answers | Guard rails |
|---|---|---|
| `adt_search` | Which objects match this name pattern? | `max` 50 by default, up to 999. An answer of exactly `max` hits is `complete: false` with `incomplete: [{code: "SERVER_PAGE_FULL"}]` and `narrowBy` (the arguments that reduce it) — the quick search has no paging, so a full page is not proof of a complete list. Hits of another subtype of the facet asked are left out and counted (`outsideFacet`). ⚠️ An empty answer is not proof of absence either: the search does not see every object that exists (a generated include, measured); the by-name tools fall back to the direct URI for `PROG/P`, `PROG/I`, `CLAS/OC`, `FUGR/F` and say `foundBy: "uri"` when that is how they got there. With a facet given, an empty answer is asked once more through the `quickSearch` route, which sends the facet **whole** (the client library strips it — `FUGR/FF` is only ever found this way); that reply carries no description, and the answer says `foundBy: "facet"`. For an application log object (`APLO`) or a check variant (`CHKV`) the answer also carries `legacy`: the ones created in SLG0 (`BALOBJ` rows without a `TADIR` `R3TR APLO`) or in transaction SCI (`SCICHKV_HD` rows that are not `CHKV`), which the ADT does not publish, read through the data preview with the search pattern as a `LIKE`. Each comes with its text, check variants as `global` or `local` (never with their owner), plus `guidance` on where it lives and how to work with it. `complete: false` with an `incomplete` code (`CAP_REACHED`, `NOT_READ`) when a read was capped or failed (`LEGACY_OBJECTS_NOT_READ`) |
| `adt_read_source` | What is the real source in the system? — and, with `enhancements: true`, what customer code is implanted in it | the source is the text answer; next to it, as structured content, what was asked, read and left out (`complete`, `incomplete`, `enhancements: {asked, read, count}`, `textElements`, `version.exists`, `alternatives`); class includes selectable; enhancement source only when asked for. `objectNames: [...]` (max 25) reads a batch, one JSON item per name, a failed name never stops the others (`BATCH_ITEM_NOT_READ`); a name that resolves to nothing is counted as `notFound`, an answer and not a gap. An ENHO has no source at its own URI (measured): the answer names the **enhanced object** and the call that reads its implants (`ENHO_SOURCE_IS_ELSEWHERE`). On an `ENHO/XH` (class / interface enhancement) it answers empty **without** asking the structure (which dumps the server) and names the abapGit files that carry the methods. On a class or a program, `version` reads a **stored** version — `active`, `inactive`, or a number from the version history — and `compareTo` answers a **unified diff** between two, computed locally. Traps it holds (measured, `docs/adt-api-reference.md`): `?version=inactive` answers the active source when there is no inactive one, so the object document is asked first and the answer says *no inactive version*; a version is read from the link its history entry publishes, never built; `active` facing a number is read as `00000`, because the history regenerates that text. A version it could not read files `VERSION_NOT_READ`. `method` (a class, active or inactive) answers **one method**: `NAME`, `INTF~NAME`, or `LOCAL_CLASS->NAME`, sliced `METHOD … ENDMETHOD` from the include the class outline names, outline and source read in the same version. `textElements: true` adds the text symbols, selection texts and headings of a program or class; a category not read says so (`TEXT_ELEMENTS_NOT_READ`), never "none" |
| `adt_object_info` | Package, owner, dates, API state, structure | a class enhancement or function-module interface enhancement (`ENHO/XH`, tools `CLASENH`/`FUGRENH`) has **no model in the ADT**: its own resource dumps the server (measured, 3 of 3), the enhanced object does not list it and the search index does not know the methods it adds. So the structure is **never asked**; the tool reads the one resource that answers (`objectproperties`, named route `objectProperties`: package chain, owner, API state, creation date), says `clasenh: true` with where the code really is (SE19; abapGit `<enho>.enho.xml` + `<enho>.enho.em_<method>.abap`) and files `CLASENH_NOT_IN_ADT` — never "no enhancement". On any other `ENHO/*` it answers `enhancedObject` (`kind` PROG/FUGR/CLAS/ENHO, name, URI kept percent-encoded); `null` on a BAdI implementation, which implements a spot, not an object — and for an `ENHO/XHB` the spot is read from the object's own body (`badi`: spot, BAdI definition, implementing class, referenced objects; one raw GET at the URI the search resolved, measured). On a package (`DEVC/K`) it answers `packagePath` (root first, via `findObjectPath`) and `parentPackage`; a failed path read says *NOT a root package*. On a service binding (`SRVB/SVB`) it answers `binding`: kind, UI or Web API, contract, and **per version** its release state, SRVD, `published`, service URL and entity sets with navigations, read from the binding and its detail without calling the service; a published version's URL names the `$metadata` route that reads it (V2 or V4, any namespace, V2 `;v=N`). A failed read files `BINDING_NOT_READ`, never "unpublished". For a class, interface, CDS view, table, data element or function module it also answers `apiRelease`, the **API release state the system holds**, per contract (C0–C4): state (`RELEASED`, `NOT_TO_BE_RELEASED`, `DEPRECATED`, …), usable in key-user apps and in cloud development, and the successors SAP names (`MARA` → `I_PRODUCT`, …); one GET on `/sap/bc/adt/apireleases/<uri>`. A read that failed is `read: false` and `API_RELEASE_NOT_READ`, never "not released". `abapLanguageVersion` (`standard`, `cloudDevelopment`, `keyUser`) comes from the object document it already reads |
| `adt_where_used` | Who calls this? | standard objects need `allowStandard: true`. The rows are paged (`max` 100 by default, up to 500; `offset` from `next.offset`), `callers` is the total, and `snippets: true` asks the code of the rows of the page, each snippet tied to its row by `objectIdentifier` |
| `adt_package_tree` | What does this package contain? | `depth` up to 3 — `compact: true` drops the object list (hierarchy + counts only; a large root package at depth 3 is several MB otherwise) and allows up to 5. The sub-packages the depth did not reach are named (`DEPTH_LIMIT`, `subPackagesNotWalked`), and the objects of each package are paged (`max` 500, up to 5000, `next: {packageName, offset}`). The tree resource sends each row's short description **shifted to the next row** (measured, server-side, POST-only so not re-readable raw): it is returned as `treeDescription`, never as the row's description; `describe: true` reads the virtual folders of each package, **one POST that reads** (the IDE's project tree): every sub-package's correct description and `objectsBelow`, the objects under it. If that read fails, it falls back to one search per sub-package and files `PACKAGE_FOLDERS_NOT_READ` |
| `adt_clean_core_scan` | What do the CDS views of this package consume that is not released, and what should replace it? | `package` required; reads the package's DDLS from the system (one call each, `maxObjects` 1..300, default 100, sub-packages by default), extracts every data source and classifies it A/B/C/D against the catalogue, with the successor SAP names; an `entity` filter reads one source. `offset` reads the next page of sources (`scope.next.offset`); the findings are paged by `max` (default 200, at most 1000) and `findingsOffset`. `complete` is false, with each reason in `incomplete`, when an object was not read, a cap was reached, a sub-package was beyond the listing's depth or package cap, or the catalogue is partial; `absent` and `unmapped` list the names no catalogue classifies. Progress and cancellation supported |
| `adt_annotation_scan` | Which annotations reach this element and from **which layer** — and which elements have layers that contradict each other? | `package` required; reads the package's DDLS and DDLX from the system, then follows the upstream views they select from (`upstream`, default 20) — so a hide written in a **standard** view is seen too. Carries every annotation family, from the DDLX **and** from the inline DDLS. Answers what the **source** says; it knows nothing about switches, kernel layers or `IS_ACTIVE`, so every detector hit is a suspicion that `adt_annotation_chain` confirms at one ADT call. The index is kept 10 minutes for follow-up lookups (`refresh: true` rebuilds it; `scope.cached` says whether it was reused). Rows and findings are paged by `max` (default 200, at most 1000) and `rowsOffset`, the package sources by `offset`. A table answering 404 upstream is `notFound`, not a hole; a view not read, the `upstream` budget, the hop cap and an unparsed source each make `complete` false, with an entry in `incomplete` |
| `adt_value_help` | Which **released** value help CDS fits this field, and what do I bind? | candidates are filtered against the Clean Core catalogue **before** any ADT call; the entity's own source (read from the system) says which fields are already bound; every emitted key is validated against **this system's** annotation definitions (its DDLA) — if those cannot be read, the block says NOT VALIDATED; exposure is checked against the service definitions the system says use the entity (where-used, `maxServices` read, default 3, at most 20), and is conclusive only when every one was read; a call ceiling per run (`maxCalls`); the fields are paged by `maxFields` and `fieldsOffset`. A candidate past the budget, not read or not parsed stays `unverified` (never tier C), and each one, like a failed search or a precedent skipped for the budget, is an entry in `incomplete`; a proposed value help of your own is named by `valueHelp.namePattern` |
| `adt_annotation_chain` | Which annotation reached this element, and from where? | one GET on a single named route; reports the value that actually reaches the app per annotation, the source that contributed it, and any key written by more than one source or silenced entirely. Also flags the cross-key contradiction — hidden by one layer while another gives it a display role — which produces **no** conflict and is invisible to reading either source alone. Every active hide is listed (`hiders`), not only the first. A reply that does not parse is `complete: false` with `PARSE_FAILED` and comes back verbatim, paged by `payloadOffset`. ⚠️ `entity` and `element` are disjoint scopes: an element-level defect is not visible in an entity-level call |
| `adt_contract_check` | Which OData expose aliases of this service are frozen contracts? | `service` required; reads the service definition (one call) and lists every alias with the EntitySet / EntityType it generates — the names a consumer addresses by hand and a rename breaks silently — plus an entity exposed under two aliases. With `apps` (at most 10 deployed UI5 apps, by BSP name), each app is read from the system's UI5 repository and every hand-written reference is checked against the **live** `$metadata` of the services its manifest names, V2 or V4, in the `sap` namespace or another one, and a V2 service at a version above 1 (`;v=N`). Checked: controller reads, function calls and their parameters, `$filter`/`$select` properties, absolute bindings, local annotation targets and paths, and manifest pages. A name the service no longer publishes is a `UI5_REFERENCE_BROKEN` finding, and each alias lists the files that cite it. The app's own `localService` copy is never used as a source. Apps are named, never searched, so an alias no named app cites is not claimed unused. Each part of an app not read (`notRead`: kind, name, code, reason) and each reference no service could judge is an entry in `incomplete`. CPI runs in another system |
| `adt_transport` | Which objects moved together, when, and by whom? | one GET on a named route, in one of two modes and never by default: `number` reads one request in full, `recent: true` reads the list the server offers. The answer is the **union of the request's own objects with every task's**, because a task's objects reach the request only when the task is released — with the per-task attribution kept. The list mode is **released only, last two weeks, no paging**: that is the server's scope, not a filter this tool applies, and it is returned as a structured `scope` field. It **names other developers**, because a request you hold a task in is listed under its owner. Local caps of 50 requests / 300 objects, applied after the bytes arrive, and always reported. With `keys: true` (detail mode only) it also answers **which ROWS moved** — the `E071K` table keys of each object, decoded field by field against the key layout the CTS declares, which was measured to be the DDIC's own. That is what turns `CDAT BUPAFLDMOD` from a maintenance-object name into the rows in the tables that actually travelled. One extra ADT call per object, so it is budgeted (25 by default) and every object it did not reach is counted in the answer. Which objects are asked is the **system's own word**: `tm:obj_func` is `E071-OBJFUNC`, and its `K` means *has rows in the key list* (domain read) — every entry carries it decoded (`objFunc: {code, meaning, systemText}`), so a request that **deletes** an object (`D`) no longer reads like one that ships it, and every object in the key sweep says whether it was asked on the attribute, skipped on the attribute, or decided by the measured type census (`askedBy` / `skippedTypes[].by`). The third mode asks the **reverse** question: `object: {name, type}` reads the object's **version history** — every request that ever carried it, released or open, and the one **holding it now** (version `00000`). The feed's path is taken from the link `objectStructure` publishes, never assembled (a class keeps **five** histories, and three of the five undercount — the answer is their union); **transports of copies are set apart on the server's own `isTestTransport` flag**, never on a `"CP - "` title prefix (measured: most numbers in one class feed were copies). With `logs: true` (detail mode only) it also reads the request's **action log** (created, linked, released) and **transport log** (per system and step, each with its return code, and `highestReturnCode`); two more calls, and a log that failed says `read: false`. Beside the history, the object mode names the **open requests holding the object now** (`openRequests`, one more GET; empty means in no open request, never "never transported"). A fourth mode, `saved: true`, reads the list your **saved IDE search** selects (the Transport Organizer view: open and released requests): requests and tasks with an object count each, never the objects. The configuration is read, never created; without one the answer says `read: false`. The content of an old version is read by `adt_read_source` (`version`, `compareTo`), not here. On an `ENHO/XH` the object mode reads **nothing** of the history (its structure dumps the server), still names the open requests, and points at the caller of the added members. Lists are paged: `maxRequests` and `offset` (recent, saved), `maxObjectsPerRequest` and `objectsOffset` (number), `maxKeyLookups` and `keysOffset` (keys); an object whose keys were not read says why from a closed list (`400`, `budget`, `error`) with the carriers actually tried, and each cut, failed part or drift is an entry in `incomplete` |
| `adt_runtime_errors` | What dumped (ST22), where, on which line -- and what the gateway logged | the Eclipse **Feed Reader** over the wire: `feeds: true` reads the catalogue `/sap/bc/adt/feeds` (the feeds the system offers, each with the attributes and operators a filter may use); `list: {feed: "dumps"\|"gateway"\|"atc", filters?, max?, skip?, report?}` reads one page (`$top` 1..100, default 50) of `/sap/bc/adt/runtime/dumps`, `/sap/bc/adt/gw/errorlog` or `/sap/bc/adt/atc/feeds/verdicts`; a dumps page also answers `groups`: its dumps grouped by runtime error and program (and the failing line with `report: true`), with count, first and last time and ids -- this page only, never the whole of ST22; `detail: {id, full?}` returns ONE dump -- header, what happened, error analysis, where terminated, source extract with the failing line marked, call stack with the ADT position of each frame (all parsed from the entry, which **carries its whole report**, about 17 KB), plus the dump **resource** at the HTTP twin of the entry's `self` link (`/sap/bc/adt/runtime/dump/<key>`: links and the 20-chapter index with line numbers) and, with `full: true`, the whole ST22 report as text, chosen variables included. `filters` is up to two `{attribute, op, value}` triples **generated** into the catalogue's own prefix grammar, comma form (`and ( equals ( user , X ) , notContains ( objectName , Y ) )`, measured to filter); free text never reaches `$query`, the route regex is a second fence, and the side-by-side form -- which **dumped the server** when it was probed -- is never produced. The gateway log and the ATC feed answered no entry when measured: their entries come back generic and flagged `entriesMeasured: false`. A full page is `SERVER_PAGE_FULL` with `next.skip` (the server gives no total), the server's own window is `serverWindow.from`, and a dump resource or formatted report not read is an entry in `incomplete`. The answer names whoever dumped (that is the question); the audit line carries the feed, the page and the dump's timestamp+host+sequence, never a user. And **every** tool uses the same feed after an HTTP 500: the newest dump of the session's user since the call is appended to the error (`-- the SAP system dumped: <error> in <program> (ST22 <key>; …)`) and filed as `SERVER_DUMPED`, because on every measurement a 500 from the ADT was a dump |
| `adt_atc_run` | Does this object pass the check variants -- Clean Core governance, development practices, SAP's DEFAULT -- and if not, which finding, which check, which line? | the **second POST** this server sends, and the first that leaves something on the server: an ATC result worklist per variant (what the ATC Result Browser lists), nothing else -- no lock, no transport, no object touched (measured). `variants`: up to **3** from the closed set of SAP's `DEFAULT`, the system check variant (read from `atc/customizing` at start) and the variants your installation lists (`npm run config -- atc add`), run one after the other on the same object; default the system check variant, or `atc.defaultVariant` when set. Per variant: `POST /sap/bc/adt/atc/worklists?checkVariant=<v>`, `POST /sap/bc/adt/atc/runs?worklistId=<id>` with a body **generated** from one validated object URI and `maxFindings` 1..100, then `GET /sap/bc/adt/atc/worklists/<id>`. The set is closed because **the server hands an id to any name** (measured); an `ENHO/XH` is refused (its URI dumps the server). The answer: each finding's priority, check, message, source position, quickfix flags, documentation link; with several variants, one block per variant, and a variant that failed is listed as **not run** -- never clean. After each run the variant itself is read once (`atcCheckVariant`): a variant created in the ADT (`CHKV`) answers `variantChecks`, its checks with their parameter values; a variant created in transaction SCI, which SAP documents the ADT cannot display, answers `variantKind: SCI` with that note. A short list says why (`truncatedBy`: `maxFindings`, or `worklist` when the worklist holds fewer findings than the run counted), run stats that are not three integers are `PARSE_FAILED`, and the exempted findings listed are counted. A few seconds per variant. `ATC_NOT_RUN` / `ATC_RESULT_NOT_READ` / `ATC_SYSTEM_VARIANT_NOT_READ` / `ATC_VARIANT_NOT_READ` in the journal. ABAP Unit stays with the IDE; exemptions are governance writes and are not admitted |
| `adt_customizing` | Which pricing-procedure step calls routine 953? Which copy control carries requirement 653? | the **first POST** this server sends: `/sap/bc/adt/datapreview/freestyle`, body a `SELECT` **generated** from a closed grammar (one table, listed fields, `=`/`<>`/`IN`/`LIKE` joined by `AND`, 1..200 rows; `LIKE` takes a name with `*` wildcards and the module writes the literal and its `ESCAPE`; a table may fix the columns it admits, so a user field is never read) for a table in the closed list `CUSTOMIZING_TABLES` — the SAP-standard tables in [`data/defaults/customizing-tables.json`](data/defaults/customizing-tables.json) (pricing procedures and condition tables, copy control, the VOFM registry, launchpad semantic objects, the object directory, CDS header annotations, payment terms, STVARV parameters, partner determination, the material master screen map, MRP areas, material status, the factory calendar, the organizational units, application log objects, Code Inspector check variants) **plus the tables your installation added** with `npm run config -- table add`, through the same validation. Any other table, field or value the grammar cannot say is refused **before a socket opens**; the server would answer any table (`VBAK` measured 200), so the fence is the client and it is tested. Read-only by semantics (no lock, no transport; `SM12` checked before and after), POST by wire. `totalRows` is the server's count **without** the cap; NUMC columns compare at full width (`0000953` in `T683S`, `953` in `TVCPA`). The audit line carries the table and the row cap, never a row. `runQuery`/`tableContents` of the library stay denied — the decision, dated, is in `docs/security.md` |
| `adt_launchpad` | Which tiles and target mappings does catalog X carry, which groups show them, which catalogs does role Y get, and is the semantic object registered? | one `kind` per call (`catalogs`/`catalog`, `groups`/`group`, `spaces`/`space`, `pages`/`page`, `semobjs`/`semobj`, `roleCatalogs`). The one place the routes leave `/sap/bc/adt`, for **SAP-standard services only**: OData V2 under four `ODATA_ROOTS` (PAGE_BUILDER_CONF/CUST, FDM_*_CUST_SRV; never `PAGE_BUILDER_PERS`, `$batch` or a generic GET over entity sets). No customer (Z) service is called, and every person-like key is stripped from every body. `semobjs`/`semobj` read the `/UI2/SEMOBJ*` tables through the ADT data preview, as `adt_customizing` does. Decision, dated, in `docs/security.md` (*The Fiori launchpad*); shapes in `docs/adt-api-reference.md` |
| `adt_syntax_check` | Does the source the system stores for this class, program, behaviour definition, CDS view or metadata extension compile — the active version, or the inactive one waiting to be activated? | the **fourth POST** this server sends: `/sap/bc/adt/checkruns?reporters=abapCheckRun`, a body built from one object URI (class, program, behaviour definition, CDS view, metadata extension) and the version, **no source sent** — the server checks what it stores. Each message: type, text, include, line, column. Measured: no `Location`, no run id, nothing left on the server, a stateless session (the IDE runs the same check after every save). `version: inactive` first reads the object document, because on an object with **no** inactive version the server checks an empty source and reports an error that is not in the program (measured); the answer then says *no inactive version* and nothing is sent. A report the server did not process is `checked: false`, never clean (`SYNTAX_NOT_CHECKED`); every report of the reply is listed (`reports`), and one not processed makes `complete` false |
| `adt_package_health` | How healthy is this package for Clean Core, in one answer? | a composition, no read of its own: the package is listed **once**, then the Clean Core scan of its CDS views (the same run as `adt_clean_core_scan`: levels and the first `maxFindings` findings, default 20, at most 200) and the syntax check of the stored **active** version of each class and program (the same check run as `adt_syntax_check`, `maxChecks` 1..50, default 20; `checksOffset` checks the next page). `complete` is true only when every part read everything, with each reason in `incomplete`; source types no part checks (interfaces, function groups, includes, behaviour definitions) are counted in `notCovered`: an object not checked, a view not read or a cap reached makes it false, and nothing is summarised about what was not read. Without the catalogue the Clean Core part says it did not run and the syntax part still runs. With `atc: true` it also runs the **ATC once over the whole package** (the default variant; the package as one virtual-folders object reference, as the IDE sends it), leaving a result worklist like `adt_atc_run`, and counting the objects the run checked (`objectsChecked`: a run over no object is incomplete, never a clean package); without it the answer says ATC was not asked |
| `adt_find_definition` | Where is the symbol at this line and column of a class defined? | the IDE's F3: `POST /sap/bc/adt/navigation/target?uri=<source#start=l,c>&filter=definition` with the class's **stored active main source as the body** (read first through the guarded client, never text from the caller). The answer is the target's source URI, object URI, line and column, and whether it is in the same class; "named none" when the server resolves nothing at the position; every reference the reply names is listed (`targetCount`, `targets`). Classes only (the one family measured); an unsaved editor buffer is not seen |
| `adt_used_objects` | What does this class use, and is each of those objects released? | the IDE's Relation Explorer, "Used Objects": `POST /sap/bc/adt/objectrelations/network` with a body naming the class and **nothing else** (no source), one level deep. **Every** used object is listed with type, package, **package path** and whether it is in another package; then the **API release state** of each class, interface, CDS view, table, data element and function module, one GET each, at most 25 (`maxReleaseReads`). An object whose state was not read (past the cap, a family not measured, a failed read, a reply that does not parse, a use listed without a URI) is named in `notRead` with its code and reason and makes `complete` false; the counts cover only what was read, and `releaseOffset` reads the next page of release states. With `boundary: true` it also describes each use into another package by what **both sides declare**: the use accesses of the class's package that relate to it, and whether the used package is encapsulated and which interfaces it publishes (package documents, at most 11). **Never a verdict**: which objects an interface exposes is not readable over ADT, and whether the system enforces the package check is not read. Classes only (the one family measured); for a CDS view, `adt_clean_core_scan` |

`adt_read_source` answers a second question the working tree cannot: **who implanted code
into this standard object.** With `enhancements: true` it lists the enhancement
implementations bound to the source — the ENHO, the enhancement-point path, whether the
implementation *replaces* that point, the line it sits at, and the stored state (on, stand-by,
off) of the Switch Framework switch its package hangs on, because the system lists an
implementation whether or not its switch is on — and with
`enhancementSource: true` the implanted source itself. An implicit enhancement or an
enhancement spot implementation never appears in a Z-namespace sweep, and no abapGit
repository serialises it against the standard object it modifies. When the read fails, the
footer says so — *"enhancements NOT read"* is never rendered as *"there are none"*.

`adt_value_help` is the one tool that is a pipeline rather than a call. For each field of a
CDS view it resolves the data element and the domain in the system (a projection field
inherits its type, so the source text cannot answer this), builds candidates from the released
catalogue, classifies them **A / B / C with the evidence** instead of asserting a rule, refuses
annotation keys that are not released in this release, and checks that the entity is exposed in
the service definition — an omission that makes the F4 come up empty with no activation error
and no `/IWFND/ERROR_LOG` entry.

The strongest signal is not a name at all: a field whose **DDIC type** is `UNIT`, `CUKY` or
`LANG` *is* a unit key, a currency key or a language key, whatever it is called, and that
costs nothing extra because the field list already carries the type. It is also the only
signal of the type that survives a projection, where the field restates neither its type
nor its annotations. The **semantic annotations the system resolves** come with the same field
list, at no extra call, inherited ones included: a quantity's
`@Semantics.quantity.unitOfMeasure` names its unit field even when the projection's source says
nothing. `BaseUnit` is the case the tool was built for: its data element states
`BASEUOM` (measured — not `UNIT_OF_MEASURE`, which is what it looks like), nothing named
`BaseUnit`, `BASEUOM` or `MEINS` is in the catalogue, and its type `UNIT` lands straight on
`I_UnitOfMeasureStdVH`. `readAnnotations: true` additionally reads the entity's own source
for `@Semantics`; what the system resolves wins over what the file writes.

When nothing matches by name or by type it **asks the system** rather than guessing: an
anchored, type-filtered repository search on the concept (one call, ~3 KB), and if that
comes back empty, the domain's value table through where-used — the only route that can
discover that the VDM calls the concept something else entirely (`T006` is what connects
`MEINS` to `UnitOfMeasure`). Everything the search finds still passes the release gate, and
when nothing is confirmed the proposed own view keeps a **placeholder** source instead of
naming an entity that may not exist. Turn it off with `deepSearch: false`.

With `precedent: true` it also asks who else binds the recommended value help, reads one such
consumer from the system and copies its `additionalBinding` — cited, never invented.

The catalogue is **both** files, not just the release info: hundreds of CDS entities exist only
in `objectClassifications_SAP.json` as `classicAPI`, so loading one file would answer "unknown
to the catalogue" for entities that exist and are classified. They are still never recommended —
Level B is not a Level A answer — but they are shown as rejected candidates with their state and,
when the catalogue names one, with their released successor.

## Scripts

Every entry point is an npm script. **Logon** means the script opens one SAP session: it needs a
TTY, asks for the password once per run, never stores it and never retries a failed logon.
None of them commits anything to git.

| Script | Logon | What it does | Writes |
|---|---|---|---|
| `npm run adt` | yes | the MCP server | audit log, journal |
| `npm run probe -- [--host H] [--port P] [--client C] [--strict-tls]` | **no credentials** | is `/sap/bc/adt` reachable, which auth scheme it offers (host, port and client default to the store) | nothing |
| `npm run config -- …` | no | the configuration CLI ([Configuration](#configuration)) | the store |
| `npm run sync:catalog [-- --list \| --check \| --from <folder> \| --release <r>]` | no (GitHub) | downloads or refreshes SAP's Clean Core catalogue ([details](#the-clean-core-catalogue)) | `%LOCALAPPDATA%\sap-adt\catalog\` |
| `npm test` / `npm run test:guard` / `npm run coverage` | no | the offline suite / the read-only guard alone / the suite with thresholds | nothing |
| `npm run report` | no | reads the journal back: cost, findings backlog, the server's own gaps | stdout |
| `npm run logs:prune -- --days N [--apply] [--audit]` | no | trims the journal (and, opt-in, the audit log); a dry run without `--apply` | the journal |
| `npm run propose:table -- T1 T2` | yes | evidence (delivery class, fields) for adding a table to the customizing fence; decides nothing | stdout only |
| `npm run measure:ddla` | yes | checks the annotation-definition parser against what the system serves | state directory |
| `npm run lint:commit -- <file>` | no | checks one commit message against Conventional Commits ([Contributing](#contributing)) | nothing |
| `npm run release [-- --apply]` | no | the next SemVer version and its CHANGELOG entry, from the commits since the latest tag; a dry run without `--apply` ([Versioning](#versioning)) | the version files and `CHANGELOG.md` |

Each script prints its full option list in the header comment of its file under
[`scripts/`](scripts/).

## The journal

Every tool call, every defect a scan found and every limit the server hit is written to `logs/`
— three JSONL streams, one file per day, **git-ignored**. `npm run report` reads them back as
three blocks: how much of the work cost the SAP system nothing (measured from the read budget,
not asserted), a findings backlog grouped by package with *first seen / last seen / how many
times*, and the server's own gaps ranked by how often each one actually bit. The fingerprint is
what makes it a backlog rather than a log: re-running a scan accumulates occurrences instead of
duplicating rows, and a later **complete** scan of the same package (nothing left unread, no cap
reached, no filter) is what retires a row that is no longer filed.

```bash
npm run report              # [--since YYYY-MM-DD] [--json]  -> Markdown by default
npm run logs:prune -- --days 90 [--apply] [--audit]
```

The journal carries **no credential, no SAP source and no payload**, and that is enforced by a
field allowlist rather than promised — see `docs/security.md`. It is a different artefact from
the audit trail, which stays outside the repository.

### No silent errors

A journal is only worth reading if a quiet answer means *nothing was there* rather than *nobody
looked*. Two rules keep that true, and both are enforced by `tests/no-silent-errors.test.mjs`
rather than by review:

- **Every registered code has an emitter.** A code in `lib/journal-codes.mjs` that no module ever
  writes is an intention the server does not keep. The reverse direction is checked too: a code
  emitted but not registered fails the build instead of failing at runtime on whichever path
  happens to run.
- **A `catch` that discards its error must be listed, with a reason.** Everywhere else has to
  report — to the journal, to the answer, or to stderr. The list is the few places where the
  thrown thing genuinely carries nothing a caller could act on (git absent when absence is the
  wanted outcome, a socket already closed, a day file not created yet).

The concrete case this closed: a scan used to skip what it could not read with a bare
`continue`, and a lower count always reads as *cleaner*. Now every object a package scan could
not read, and every package it could not list, is a `SOURCE_NOT_READ` gap, a reached cap is
`SCAN_AT_CAP`, and the answer says `complete: false`. And at the bottom of the stack: if the
journal itself cannot write, it warns once on stderr that an empty report from then on means
**unrecorded, not clean**.

Every call is also written to `%LOCALAPPDATA%\sap-adt\audit.log` — tool, target, result size.
**Never the payload.**

## Limitations

**By design — what it will never do**

- **Write anything to SAP.** No activation, no ABAP Unit, no object change, no lock, no
  transport release, no ATC exemption. It cannot prove that code **activates** or that a test
  passes; that is the official MCP server's job, from the IDE. (ATC it **can** run, on one
  object at a time: `adt_atc_run`; each run leaves an ATC result worklist on the server, as
  the IDE does. And it can say whether the stored source **compiles**: `adt_syntax_check`.)
- **Read business data.** It reads the repository and a **closed list** of configuration
  tables (SAP-standard ones plus those you add with `table add`), through a generated
  `SELECT` that cannot name anything else. `runQuery`/`tableContents` are a **closed
  decision**, not a backlog item (`docs/security.md`): a free table read would make the audit
  trail's "no payload, ever" untrue by construction.
- **Call a customer (Z) HTTP service.** Outside `/sap/bc/adt` it reaches only the SAP-standard
  launchpad OData services under `/sap/opu/odata/UI2/`.
- **Store the password** or retry a failed logon. **Download at run time**: only
  `sync:catalog`, run by you, goes online.

**Scope — what it does not cover**

- It is meant for a **development** system. Pointing it at quality or production is outside its
  design.
- The ADT REST API is the protocol of SAP's own tools, not a published interface. Confirm with
  your SAP contact that this use is admissible before adopting the server (`docs/security.md`,
  *Scope limits that are also safety limits*).
- **One SAP system per installation** (one store, one session). The server always reads the
  store in the state directory; `--db` exists only on the configuration CLI.
- **Basic authentication over HTTPS only.** No SSO, SAML, X.509 or OAuth, so no SAP BTP ABAP
  environment.
- **`adt_contract_check` reads only the Fiori apps you name.** The UI5 repository cannot be
  searched by service (the list ignores every filter). A data source behind a system alias
  (`;o=`) or a destination is reported as not read. Relative bindings, payloads built in variables and
  `Filter` objects are not checked. CPI integrations live in another system (SAP BTP) that this
  server does not reach.
- **PFCG roles are not read.** `adt_launchpad` answers which catalogs FDM resolves for a role
  (`roleCatalogs`), but no SAP-standard service lists roles, so it cannot say which roles open a
  catalog.
- It answers nothing about SM30/SE54 maintenance, the CPI graphical editor, or Fiori deploy.
- **Commands that log on need an interactive terminal**; the server cannot run as a background
  service.
- **Windows first.** The state directory follows Windows conventions; elsewhere it is
  `~/.local/share/sap-adt`.

**Cost and accuracy — what an answer can and cannot prove**

- **A package scan costs one ADT call per object** (capped, default 100, at most 300) and counts
  against the read budget. Scan a sub-package when the root is large.
- An empty `adt_search` is not proof of absence: the quick search does not index every object
  (see the tool row). By-name tools fall back to the direct URI where the name allows it.
- The release catalogue is a snapshot at a recorded upstream commit; refresh it with
  `npm run sync:catalog` (monthly). Its age is in every answer that relies on it.
- `adt_annotation_scan` reads the **source**, so it cannot see a switch, a kernel layer or an
  `IS_ACTIVE` flag. It ranks what deserves an `adt_annotation_chain` call; it never replaces it.
  An upstream view is read for its inline annotations only — its own DDLX is not looked up.
- **`@UI.hidden` and `@Consumption.hidden` are both crossed against display roles**, and the
  finding carries `hiddenKey` to say which one hid the field — they do not have the same remedy.
- ⚠️ **The blind spots that do remain**, both declared by `adt_annotation_scan` in its own
  reply: a hide bound to a field (`@UI.hidden: 'SomeFlag'`) is **skipped as deliberate design**,
  and a hide reached over more than one propagating hop is matched on element **name** — so a row
  with a high `depth` is the weaker claim, and `depth` is reported for exactly that reason.

## Contributing

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):
`type(scope)!: subject`, then a blank line and a body that says what changed and why. The scope
and the `!` are optional, and `!` or a `BREAKING CHANGE:` footer marks a breaking change. The
types and the rules live in `lib/commit-lint.mjs`. The header limit is 100 columns.

```text
fix(guard): refuse a member that is not on the allowlist
```

The hook in `.githooks/commit-msg` rejects a message that does not conform. Enable it once per
clone:

```sh
git config core.hooksPath .githooks
```

### Versioning

The version follows [Semantic Versioning](https://semver.org/). The MCP server reports the version
from `package.json` as its server info, so there is no second copy to keep in step. The public
surface is what an MCP client depends on: the tool names, their input schemas, and the shape of
their results.

| Change | Commit | Bump |
|---|---|---|
| a tool removed or renamed, an input schema narrowed, a result field removed or changed in meaning | `!` or `BREAKING CHANGE:` | major (minor while the major is 0) |
| a new tool, input, result field, route or script | `feat` | minor |
| a bug, performance or revert, with the surface unchanged | `fix`, `perf`, `revert` | patch |
| docs, tests, refactors, chores | `docs`, `test`, `refactor`, `chore`, ... | none on their own |

`npm run release` reads the commits since the latest `v*` tag, prints the next version and its
CHANGELOG entry, and with `--apply` writes `package.json`, `package-lock.json` and `CHANGELOG.md`,
commits those three files as `chore(release): vX.Y.Z` and tags that commit `vX.Y.Z`. It refuses,
before writing anything, when something is already staged, when one of the three files has
changes of its own, or when the tag exists. It never pushes. The first release needs a baseline
tag, `v0.1.0`, on the last commit that belongs to that version.

## Project layout

| Path | What is there |
|---|---|
| `server.mjs` | starts the server: config, SAP logon, loopback HTTP listener, shutdown |
| `lib/mcp-server.mjs` | the MCP plumbing: server info and instructions, tool handlers, the `Host`/`Origin` and token gate |
| `lib/tool-meta.mjs` | titles, behaviour annotations, the input-schema check, `structuredContent`, progress |
| `lib/service-binding.mjs` | a service binding and the detail of each version: parsers, and the read `adt_object_info` runs |
| `lib/virtual-folders.mjs` | the virtual folders of a package: the third POST (fixed path, body built from one package name) and its parser |
| `lib/syntax-check.mjs` | the syntax check: the fourth POST (fixed path, body built from one object URI and a version, no source) and its parser |
| `lib/object-relations.mjs` | the objects a class uses: the Relation Explorer's network POST (fixed path, body naming one class) and its parser |
| `lib/navigation.mjs` | go to definition: the navigation POST (fixed path and filter, the position in the uri, the stored source as body) and its parser |
| `lib/legacy-objects.mjs` | the APLO and CHKV objects the ADT does not publish (SLG0, SCI), read from their tables for `adt_search` |
| `lib/source-versions.mjs`, `lib/line-diff.mjs` | a stored version of a class or program (active, inactive, a history number) and the local unified diff of two |
| `lib/class-components.mjs` | the outline of a class (components and their positions) and the slice of one method |
| `lib/api-release.mjs` | the API release state of one object, per contract, and its parser |
| `lib/system-check.mjs` | the system confirmed before the password prompt: one GET without credentials, the SID and client its 401 names |
| `tools/` | the 19 MCP tools |
| `lib/` | the HTTP client and the logon (`adt-http.mjs`), the reads behind the guard (`adt-reads.mjs`, `repository-posts.mjs`, over the dependency-free `xml.mjs`), the guard (`guard.mjs`), the named GET routes (`adt-get.mjs`), package reads (`package-sources.mjs`), the session, the store and its validation (`store.mjs`, `environment.mjs`), the catalogue and its sync, parsers and the journal |
| `scripts/` | the npm scripts above, each with its usage in its header comment |
| `data/defaults/` | the SAP-standard half of every fence: customizing tables, ATC variant `DEFAULT`, launchpad OData roots |
| `docs/` | `security.md` (every decision, dated), `adt-api-reference.md` (measured endpoint shapes), `phase0-report.md` (checking a system with the probe), `backlog.md` (open decisions and measurements) |
| `tests/` | the offline suite and its synthetic fixtures (`ZDEMO_*`, host `vhdemohost.example`, client `001`) |
| `config.example.json` | an invented environment in the shape `config import` reads |
| `CHANGELOG.md` | one entry per release, generated by `npm run release` |
| `.githooks/`, `.gitattributes` | the `commit-msg` hook ([Contributing](#contributing)), kept at LF line endings so it runs |
| `CLAUDE.md`, `.claude/` | how Claude Code works in this repository (PDCA, invariants) and the Stop hook that keeps `npm test` green |

## License

[MIT](LICENSE). The one runtime dependency, `@modelcontextprotocol/sdk`, is pinned to an exact
version and installed with `--ignore-scripts`.

**Third-party data.** The Clean Core catalogue that `npm run sync:catalog` downloads is SAP's
Cloudification Repository, [`SAP/abap-atc-cr-cv-s4hc`](https://github.com/SAP/abap-atc-cr-cv-s4hc),
© SAP SE or an SAP affiliate company and contributors, Apache-2.0. It is not redistributed with
this repository; each installation downloads it from SAP's repository.

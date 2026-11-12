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

- **20 MCP tools** for an AI agent (Claude Code or any MCP client that speaks Streamable HTTP),
  every one of them read-only and reading from the SAP system:
  - *objects* — `adt_search`, `adt_read_source`, `adt_object_info`, `adt_where_used`,
    `adt_package_tree`, `adt_find_definition` (where the symbol at a position is defined),
    `adt_used_objects` (what a class uses, with each object's release state);
  - *package scans* — `adt_clean_core_scan` (what the CDS views consume, at which Clean Core
    level), `adt_annotation_scan` (which annotation reaches an element, from which layer),
    `adt_package_health` (the Clean Core scan and the syntax check on one listing, and optionally one ATC run over the package);
  - *CDS and services* — `adt_value_help`, `adt_annotation_chain`, `adt_contract_check`;
  - *change and runtime* — `adt_transport`, `adt_transport_routes`, `adt_runtime_errors`, `adt_atc_run`,
    `adt_syntax_check`;
  - *configuration and UI* — `adt_customizing` (a closed list of tables), `adt_launchpad`
    (SAP-standard launchpad OData services).
- **A journal and a report**: every call, finding and limit hit is recorded (no payload, ever),
  and read back as a report from the terminal.
- **A configuration CLI** over a local SQLite store, so nothing of your landscape lives in the
  code, and a **catalogue sync** that keeps SAP's Clean Core release catalogue current outside
  the repository.

Every tool is listed in [Tools](#tools) and described in [`docs/tools.md`](docs/tools.md); every npm script in [Scripts](#scripts); what it
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
3. **The SAP password is never stored by this server.** It is typed once per server start and
   lives only in memory. There is no `.env`, no keyring, no fallback to an environment variable.
   A server without a terminal reads it from one file the operator names (`passwordFile`), and
   never sends twice a password the system refused (`docs/security.md`).
4. **One login attempt per start.** On `401` the server refuses to retry: repeated failed
   logons lock the SAP user, and a locked user takes the IDE, abapGit and transports down
   with it.
5. **Nothing sensitive lands in the repository.** The environment store, the loopback token,
   the catalogue and the audit log live in `%LOCALAPPDATA%\sap-adt\`. The server refuses to
   start if that path resolves inside a git work tree.
6. **The MCP endpoint is loopback-only by default**: bound to `127.0.0.1`, `Host` and `Origin`
   checked on every request (DNS-rebinding protection, required by the MCP transport
   specification), and a bearer token compared in constant time. A hosted installation names
   the address to bind and the host names it answers to (`bindHost`, `publicHosts`); the `Host`
   check then holds against that closed list.
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
- **A terminal (TTY)** for every command that logs on: the password is typed, never read from
  an environment variable. Without a terminal, set `passwordFile` to a file only the service
  account can read (`npm run config -- set passwordFile <absolute path>`).
- **Internet access once a month** (or a manual download) for the Clean Core catalogue — see
  [The Clean Core catalogue](#the-clean-core-catalogue). The server itself never goes online.
- Developed and tested on **Windows**. On Linux/macOS the state directory is
  `~/.local/share/sap-adt`. `SAP_ADT_STATE_DIR=<absolute path>` names another place (a service
  account, a mounted volume); wherever this README writes `%LOCALAPPDATA%\sap-adt\`, read that
  directory.

## Install and first run

This section installs it for one developer. To host one instance for a team, under an SAP
service user, read [`docs/deployment.md`](docs/deployment.md) instead.

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
  token list | token add <name> | token remove <name>
                                    the callers of a hosted server; add prints the token once
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
| connection | `host`, `port` (44300), `client` (none — always your choice), `user`, `passwordFile` (none — the password is typed; set it only for a server without a terminal), `systemRole` (none — DEV, QAS, PRD, ... stated in every answer), `language` (EN), `system` (none — required: the host must answer as this system id, asked without credentials before the password prompt), `allowUnauthorizedTls` (false; prefer `NODE_EXTRA_CA_CERTS` for an internal CA) | the session |
| server | `mcpPort` (2237), `bindHost` (127.0.0.1), `publicHosts` (none; required before `bindHost` leaves loopback), `tools.disabled` (none; tools this installation neither announces nor serves), `limits.adtConcurrency` (8 requests in flight to SAP at once; more wait), `limits.callsPerMinute` (0 = none; tool calls per caller, refused past it), `budget.reads` (200, a notice, not a cap), `shutdownMs` (5000) | `server.mjs`, the audit |
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

- **Transport:** Streamable HTTP, stateless, loopback unless configured, `Host`/`Origin` validated, bearer
  token (no OAuth is advertised: a `401` carries no `WWW-Authenticate`, so clients do not start a
  discovery flow this server does not implement). `POST /mcp` only: `GET` and `DELETE` answer
  `405`, since a stateless server offers no stream to open and no session to end. HTTP rather than stdio because the SAP password
  is typed in the server's terminal, and the specification forbids asking for it through the
  client (elicitation must not request sensitive information).
- **Health, beside the protocol:** `GET /healthz` answers while the process does and
  `GET /readyz` while it holds a SAP session and is not stopping (`503` otherwise). Neither
  needs the token, says anything of the system, or sends a request to it.
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

Twenty read-only tools. What each one guards against, pages and refuses -- the measured traps
included -- is in [`docs/tools.md`](docs/tools.md); read it before trusting an empty or a
short answer.

| Tool | What it answers |
|---|---|
| `adt_search` | Which objects match this name pattern? |
| `adt_read_source` | What is the real source in the system? — and, with `enhancements: true`, what customer code is implanted in it |
| `adt_object_info` | Package, owner, dates, API state, structure |
| `adt_where_used` | Who calls this? |
| `adt_package_tree` | What does this package contain? |
| `adt_clean_core_scan` | What do the CDS views of this package consume that is not released, and what should replace it? |
| `adt_annotation_scan` | Which annotations reach this element and from **which layer** — and which elements have layers that contradict each other? |
| `adt_value_help` | Which **released** value help CDS fits this field, and what do I bind? |
| `adt_annotation_chain` | Which annotation reached this element, and from where? |
| `adt_contract_check` | Which OData expose aliases of this service are frozen contracts? |
| `adt_transport` | Which objects moved together, when, and by whom? |
| `adt_transport_routes` | Where does a request released here go? Which systems has the transport domain, which layer does each develop in, and what is the consolidation and delivery path per layer? |
| `adt_runtime_errors` | What dumped (ST22), where, on which line -- and what the gateway logged |
| `adt_atc_run` | Does this object pass the check variants -- Clean Core governance, development practices, SAP's DEFAULT -- and if not, which finding, which check, which line? |
| `adt_customizing` | Which pricing-procedure step calls routine 953? Which copy control carries requirement 653? |
| `adt_launchpad` | Which tiles and target mappings does catalog X carry, which groups show them, which catalogs does role Y get, and is the semantic object registered? |
| `adt_syntax_check` | Does the source the system stores for this class, program, behaviour definition, CDS view or metadata extension compile — the active version, or the inactive one waiting to be activated? |
| `adt_package_health` | How healthy is this package for Clean Core, in one answer? |
| `adt_find_definition` | Where is the symbol at this line and column of a class defined? |
| `adt_used_objects` | What does this class use, and is each of those objects released? |

## Scripts

Every entry point is an npm script. **Logon** means the script opens one SAP session: it needs a
TTY (or `passwordFile`), asks for the password once per run, never stores it and never retries a
failed logon.
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

### Where an answer was read

Every answer starts with `system`: the system id, the client, the category the system holds for
that client (`T000-CCCATEGORY`: production, test, customizing, ...), and the role you give the
system with `npm run config -- set systemRole DEV`. The category is read once at start; a read
that failed says so in every answer instead of leaving the field out.

### Complete or not, in fields

Every answer says whether it is complete, in fields a client can test. `complete` is `true` only
when `incomplete` is empty; each entry of `incomplete` names the list it is about, a code and
what is known about it:

| Code | Meaning |
|---|---|
| `CAP_REACHED` | this server cut the list; `returned`, `total` and `next` say how far |
| `SERVER_PAGE_FULL` | the system answered a full page and gives no total; `next` or `narrowBy` |
| `NOT_READ` | items or parts that failed, with the reason |
| `PARSE_FAILED` | a reply whose shape was not recognised (drift) |
| `CANCELLED` | the call was cancelled before this part |
| `BUDGET_REACHED` | the call budget ran out (`maxCalls`, `maxKeyLookups`, `upstream`) |
| `DEPTH_LIMIT` | a depth limit left sub-packages or hops unwalked, named |
| `OUT_OF_SCOPE` | types or parts the tool does not cover, counted |

No cut is final: a list cut by a size parameter pages (`offset`, `rowsOffset`, `findingsOffset`,
`fieldsOffset`, `objectsOffset`, `keysOffset`, `releaseOffset`, `checksOffset`, `payloadOffset`, or
the system's own `skip`), and `next` gives the value to pass; where nothing can page, `narrowBy`
names the filters that make the answer smaller. A part not asked for says `asked: false` and
is not incompleteness. An empty list is "none" only when `complete` is `true`.

Every call is also written to `%LOCALAPPDATA%\sap-adt\audit.log` — tool, target, result size,
and the caller when the server knows several (`npm run config -- token add <name>`).
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
- **Commands that log on need an interactive terminal, or a password file.** With `passwordFile`
  set the server runs as a service; its state directory must then be persistent storage, because
  the rule that protects the user from a lock reads the audit trail of earlier starts.
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
| `tools/` | the 20 MCP tools |
| `lib/` | the HTTP client and the logon (`adt-http.mjs`), the reads behind the guard (`adt-reads.mjs`, `repository-posts.mjs`, over the dependency-free `xml.mjs`), the guard (`guard.mjs`), the named GET routes (`adt-get.mjs`), package reads (`package-sources.mjs`), the session, the store and its validation (`store.mjs`, `environment.mjs`), the catalogue and its sync, parsers, the journal, and what belongs to one call while several are in flight (`call-context.mjs`) |
| `scripts/` | the npm scripts above, each with its usage in its header comment |
| `data/defaults/` | the SAP-standard half of every fence: customizing tables, ATC variant `DEFAULT`, launchpad OData roots |
| `docs/` | `security.md` (every decision, dated), `tools.md` (each tool's guard rails), `deployment.md` and `deployment/` (hosting it for a team, one guide per platform), `adt-api-reference.md` (measured endpoint shapes), `phase0-report.md` (checking a system with the probe), `backlog.md` (open decisions and measurements) |
| `tests/` | the offline suite and its synthetic fixtures (`ZDEMO_*`, host `vhdemohost.example`, client `001`) |
| `config.example.json` | an invented environment in the shape `config import` reads |
| `CHANGELOG.md` | one entry per release, generated by `npm run release` |
| `.githooks/`, `.gitattributes` | the `commit-msg` hook ([Contributing](#contributing)), kept at LF line endings so it runs |
| `Dockerfile`, `deploy/` | the container image and example units for a hosted server (Kubernetes, systemd); how to use them is `docs/deployment.md` |
| `.github/workflows/` | the offline suite on every push, Linux and Windows |
| `CLAUDE.md`, `.claude/` | how Claude Code works in this repository (PDCA, invariants) and the Stop hook that keeps `npm test` green |

## License

[MIT](LICENSE). The one runtime dependency, `@modelcontextprotocol/sdk`, is pinned to an exact
version and installed with `--ignore-scripts`.

**Third-party data.** The Clean Core catalogue that `npm run sync:catalog` downloads is SAP's
Cloudification Repository, [`SAP/abap-atc-cr-cv-s4hc`](https://github.com/SAP/abap-atc-cr-cv-s4hc),
© SAP SE or an SAP affiliate company and contributors, Apache-2.0. It is not redistributed with
this repository; each installation downloads it from SAP's repository.

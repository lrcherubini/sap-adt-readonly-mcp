# CLAUDE.md

A read-only MCP server over the SAP ADT REST API. The README covers what it does and how it is
used. This file covers how to change it without breaking what it promises.

## Commands

- Install: `npm ci --ignore-scripts` (third-party code runs no lifecycle scripts).
- Whole suite, offline (no SAP, no network, no credentials): `npm test`.
- One file: `node --test tests/<name>.test.mjs`.
- Read-only guard alone: `npm run test:guard`.
- Coverage with thresholds: `npm run coverage`. The thresholds in `package.json` are a ratchet:
  raise them when the suite grows, never lower them to make a change pass.
- Never run `npm run adt`, `probe`, `propose:table` or `measure:ddla`. They log on to a real SAP
  system, need a TTY and a typed password, and a failed logon can lock the user. Ask the owner to
  run them and paste the result.

## How work is done: PDCA

Every task follows Plan, Do, Check, Act, scaled to its size. A one-line fix is one pass through
the four steps. A new tool or route gets a written plan.

1. **Plan.**
   - State the problem and the check that will prove it solved.
   - Find what already exists before writing anything new: helpers in `lib/`, the route table in
     `lib/adt-get.mjs`, codes in `lib/journal-codes.mjs`, the measured shape in
     `docs/adt-api-reference.md`, the decision in `docs/security.md`.
   - Non-trivial work goes through plan mode, and the plan names its Check.
   - A behaviour of the SAP system that has not been measured is an open question. It is not a
     design input: the plan says "measure first" (see Gotchas).
2. **Do.**
   - The smallest change that meets the plan, with its test in the same change.
   - New code follows the patterns of its neighbours; the README "Project layout" table says
     where things live.
3. **Check.**
   - `npm test` must pass. A Stop hook in `.claude/settings.json` enforces it when files changed.
   - Run `npm run coverage` when logic changed, and `npm run test:guard` when the guard or the
     route table changed.
   - Read the diff as a stranger would: no landscape value, no non-English text, no secret, no
     history (see Invariants).
   - Report what was verified and how. If a check was skipped, say so.
4. **Act.**
   - Standardise what the task taught. A mistake that can recur becomes a test or a hook, not a
     sentence.
   - Update the one document that owns the fact (see "Where knowledge goes").
   - Remove what the change made obsolete: dead code, a resolved `docs/backlog.md` item, a stale
     line here.
   - Close the cycle with a commit, once Check is green, without waiting to be asked:
     - One cycle is one commit. Changes that were already pending when the cycle started get a
       commit of their own first.
     - Stage files by name, never `git add -A`.
     - The message is in English: what changed and why, with no landscape data.
     - Never push, amend or skip hooks unless the owner asks.

## Invariants

Each one has a test that fails the build. Fix the cause, never the test.

- **Read-only by allowlist.** Every ADT call goes through `lib/guard.mjs` (an allowlist of client
  members) and every raw GET through the closed route table in `lib/adt-get.mjs`. Adding a member
  or a route needs three things: a measured shape in `docs/adt-api-reference.md`, a dated
  decision in `docs/security.md`, and a test. Tests: `guard`, `adt-get`.
- **Public repository: no landscape data anywhere.** That covers code, docs, fixtures and commit
  messages: no host, client, SID, user, transport number, customer object name or local path.
  - Installation values belong in the environment store (`npm run config`).
  - SAP-standard lists belong in `data/defaults/`.
  - Test data uses only `ZDEMO_*` names, `Demo*` CDS names, `vhdemohost.example`, client `001`,
    `DEVUSER*` users and `DEVK900nnn` transports.
  - A reply captured from a real system is anonymised before it becomes a fixture.
  - Tests: `no-hardcode`, `public-repo`.
- **English only.** Code, comments, docs, test names and fixtures are in English. Logon-language
  texts in a captured reply are translated before they become a fixture. Test: `public-repo`.
- **No secrets or state in the tree.** The password lives only in memory. The store, the token,
  the catalogue and the audit log live in the state directory, outside any git work tree, and
  `lib/config.mjs` refuses to start otherwise. See `.gitignore` for what must never be committed.
- **No silent errors.**
  - Every journal code is registered in `lib/journal-codes.mjs` and has an emitter.
  - A `catch` that swallows its error must be on the listed exceptions, with a reason.
  - An empty answer must never mean "not looked". Report `complete: false`, or file a gap code.
  - Test: `no-silent-errors`.
- **MCP conformance.** Each tool has:
  - a `title`;
  - behaviour annotations (`readOnlyHint: true`, `destructiveHint: false`, an honest
    `idempotentHint`);
  - a closed input schema (`additionalProperties: false`) enforced before the handler runs;
  - `structuredContent` plus the same JSON as text;
  - `isError: true` with a readable reason on failure, never a protocol error.

  Tool order stays deterministic. Tests: `tools`, `mcp-protocol`.
- **Zero devDependencies.** Everything needed to test and audit ships with Node. Formatting is by
  hand: 100 columns, single quotes, no prettier and no linter.

## Where knowledge goes

Each fact has one home. Do not copy it into a second place.

| Kind of knowledge | Home |
|---|---|
| A measured shape or behaviour of the ADT API | `docs/adt-api-reference.md` |
| A decision about what the server may read, with its reason | `docs/security.md` |
| An open question or measurement still to make | `docs/backlog.md` (leaves when resolved) |
| What a user needs to install, configure and use it | `README.md` |
| What changed and when | git history (commit messages) |
| How to work in this repository | this file |

This file never records history, dates, counts, per-task notes or tool lists. Each of those
grows with time, already has a home above, and goes stale here. Personal notes go in
`CLAUDE.local.md`, which is git-ignored.

## Gotchas

- An empty answer from the ADT is not proof of absence, and an HTTP 500 is usually a server dump.
  Read the relevant section of `docs/adt-api-reference.md` before trusting or adding a route.
- Measuring a new route follows a fixed sequence, run by the owner:
  1. Write a temporary probe in `scripts/probes/`, which is git-ignored.
  2. Transcribe the measured shape into the reference.
  3. Delete the probe.
  4. Build the route.
- `lib/journal.mjs` writes only allowlisted fields. Never add a payload, SAP source or credential
  to the journal or the audit trail.
- On Windows the working copy may hold CRLF. Editing scripts must keep each file's existing line
  endings.

## Keeping this file healthy

- Change it only when a rule changes. If a line keeps being ignored, turn it into a test or a hook
  instead of adding emphasis.
- `tests/public-repo.test.mjs` caps this file's length and rejects dates, counts and log
  sections. Cut lines to make room; never raise the cap.
- Audit it now and then with `/doctor prompt-audit`.

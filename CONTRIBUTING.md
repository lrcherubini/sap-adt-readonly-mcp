# Contributing

Thank you for helping. This server promises to be read-only and to carry no data of anyone's SAP
landscape; every rule below protects one of those promises.

A security flaw is not reported here: see [`SECURITY.md`](SECURITY.md).

## Before you start

- Open an issue first for anything larger than a small fix, so the approach can be agreed.
- A new read or route needs three things: its measured shape in `docs/adt-api-reference.md`, a
  dated decision in `docs/security.md`, and a test. A behaviour of SAP that nobody measured is an
  open question, not a design input.

## Setup

Node.js as given in the README, then:

```sh
npm ci --ignore-scripts
git config core.hooksPath .githooks
npm test
```

The suite runs offline: no SAP system, no network, no credentials. There are no
devDependencies, and there will be none.

## Rules a change must keep

Each one has a test that fails the build. Fix the cause, never the test.

- **No landscape data**, in code, docs, fixtures or commit messages: no host, client, SID, user,
  transport number, customer object name or local path. Test data uses `ZDEMO_*` names, `Demo*`
  CDS names, `vhdemohost.example`, client `001`, `DEVUSER*` users and `DEVK900nnn` transports.
  A reply captured from a real system is anonymised before it becomes a fixture.
- **English only**, including comments, test names and fixtures.
- **No secret or state in the tree.**
- **No silent errors**: a `catch` that swallows its error is a listed exception with a reason.
- **Formatting by hand**: 100 columns, single quotes.

## Pull requests

- One logical change per pull request, with its test in the same change.
- `npm test` passes; run `npm run coverage` when logic changed. Coverage thresholds only go up.
- The branch is rebased on `main`: pull requests are merged by rebase, so each commit lands as
  it is.

## Commit messages

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):
`type(scope)!: subject`, then a blank line and a body that says what changed and why. The scope
and the `!` are optional, and `!` or a `BREAKING CHANGE:` footer marks a breaking change. The
types and the rules live in `lib/commit-lint.mjs`. The header limit is 100 columns.

```text
fix(guard): refuse a member that is not on the allowlist
```

The hook in `.githooks/commit-msg` rejects a message that does not conform, and
`npm run lint:commit -- <file>` checks one message by hand. A change to a tool name, an input
schema or a result shape is breaking and must carry `!` (README, "Versioning").

## License

By contributing you agree that your contribution is licensed under the [LICENSE](LICENSE) of
this repository.

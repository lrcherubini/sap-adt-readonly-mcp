# Security policy

This server holds a live credential to a SAP system and reads source code out of it. A flaw in
it can expose that credential, that code, or the system behind it, so reports are welcome.

## Reporting a vulnerability

Report it privately through GitHub: the **Security** tab of this repository, then **Report a
vulnerability**. Do not open a public issue, pull request or discussion for it.

A useful report says:

- what an attacker can do, and from where (the MCP client, the network, the SAP system);
- the steps to reproduce it, against the offline test suite when possible;
- the version or commit it was found on.

Never include a real host, client, user, password, transport or customer object name. Use the
demo values the tests use (`vhdemohost.example`, client `001`, `DEVUSER1`, `ZDEMO_*`).

The report is acknowledged, assessed, and answered with a fix or a reasoned refusal. A fix is
released as a patch version and credited to the reporter unless they ask otherwise.

## Supported versions

Only the latest release receives fixes.

## In scope

- A way to make the server write to, lock, or change anything on the SAP system: it promises to
  be read-only (README, "Safety model").
- A read or a route that escapes the allowlist in `lib/guard.mjs` or the route table in
  `lib/adt-get.mjs`.
- A leak of the SAP password, the session cookies or the loopback token: into a tool result,
  the journal, the audit log, a file or a process argument.
- A bypass of the `Host`, `Origin` or bearer-token checks of the MCP endpoint.
- Repeated logons that can lock the SAP user.

## Out of scope

- What the SAP system itself returns to a user who is allowed to read it: authorisation is the
  SAP system's job.
- A deployment that disables a documented safeguard, such as binding to a public address
  without a token.

The decisions behind each safeguard, and the reasons for them, are in
[`docs/security.md`](docs/security.md).

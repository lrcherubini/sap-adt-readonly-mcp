# Phase 0 — verify your system before the first logon

Nothing about a specific SAP system may be assumed. Before this server is pointed at a system,
`npm run probe` answers the questions below **without sending a single credential**: it only
reads the response to an unauthenticated request. The examples are from an S/4HANA 2023
development system (SAP_BASIS 758); host and user are shown as `<HOST>` / `<USER>`.

## 1. Is the ADT REST endpoint reachable, and does it offer Basic authentication?

Unauthenticated `GET /sap/bc/adt/discovery?sap-client=<client>`:

```
port 44300: HTTP 401
  sap-system:       <SID>
  www-authenticate: Basic realm="SAP NetWeaver Application Server [<SID>/<client>]"

VERDICT: ADT REST reachable on port 44300, auth mode = basic.
```

What this proves, in order of importance:

1. **`401` with `www-authenticate: Basic`, not a `302` to an identity provider and not
   `text/html`.** So there is no SSO/SAML interposed on this node — the design of this server
   (username + password typed per session) is valid. Had it been SSO, the options would be an
   X.509 client certificate or a pasted `MYSAPSSO2` cookie; this server supports neither.
2. **The `/sap/bc/adt` ICF node is active.** A disabled node answers `403`/`404`, not `401`
   with a realm.
3. The realm names `[<SID>/<client>]`, confirming host **and** client in one string — the probe
   does not have to trust the configuration it read the host from.

Only HTTPS is used. A plain-HTTP port that answers is not a reason to use it.

## 2. Why the HTTP path has to be proven separately

An ADT project the IDE created may connect over **RFC**, not HTTP (its `.destination.properties`
then carries a `systemNumber`). An IDE that logs on fine is therefore **no evidence at all** that
the HTTP ICF path works. Only the probe above shows it.

## 3. TLS

If the server presents a certificate that the local trust store does not chain (an internal CA),
prefer `NODE_EXTRA_CA_CERTS=<ca.pem>`. `allowUnauthorizedTls: true` is a real trade-off,
documented in [`security.md`](security.md#tls) — acceptable only inside a trusted network, to a
host you configured on purpose (`npm run config -- set host`). Pointing the same flag at an
arbitrary host is not.

## 4. What the first authenticated run settles

These need a logon, so phase 0 cannot answer them; [`adt-api-reference.md`](adt-api-reference.md)
records what was measured:

- **Does `objectStructure` return the API State on kernel 7.58? — No.** On a standard class the
  `metaData` block carries `abapsource:sourceObjectStatus: 'SAPStandardProduction'` and
  `adtcore:abapLanguageVersion: 'standard'`, and **no** `apiState`, `releaseState`, `apiRelease`
  or `useAccess` under any key. The Clean Core question ADT answers in Properties → API State
  **cannot** be answered from this resource, which is why `adt_object_info` returns the whole
  metadata block instead of picking a field name — there is no field to pick, and the release
  catalogue (SAP's, downloaded by `npm run sync:catalog`) answers the Clean Core question instead.
- **Shape of `searchObject` / `usageReferences`** — sections *`searchObject(query, objectType,
  max)`* and *`usageReferences(url)`* of the reference. The reading also produced a limit nobody
  had asked for: the search cap **truncates alphabetically and says nothing**, which is why
  `lib/concept-search.mjs` anchors its queries.
- **Which discovery collections the release exposes** — *Collections that matter for CDS
  metadata* in the reference.

**The rule:** a value that has not been observed on *your* system is not reported as fact. Where
the answer is unknown, the tool returns more raw data rather than guessing which field to trust.

## 5. Logon-attempt discipline

Phase 0 incurs zero failed logons by construction — the probe sends no credentials.

For the server itself the rule is stricter than "be careful": **one Basic logon attempt per
process start, and no retry on `401` under any circumstance.** Repeated failed logons lock the
SAP user, and a locked user takes the IDE, abapGit and transports down with it. An API test
collection whose "lock the user" step runs with an empty password is the classic way to lose one.

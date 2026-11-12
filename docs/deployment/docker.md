# Docker on one host

One Linux machine, Docker Engine with the Compose plugin, one container of the server and a TLS
proxy in front of it, from an empty machine to a client that answers. Read
[`../deployment.md`](../deployment.md) first: the SAP user, the four rules and the settings are
explained there and not repeated here.

**Verified on 2026-11-12** with Docker Desktop: the image build, every `config` command below,
the catalogue sync and a start that stops before any password when the SAP host does not answer.
**Not verified**: a logon against SAP, and the Caddy proxy obtaining a certificate.

## What you need

- A Linux host with Docker Engine and the Compose plugin (`docker compose version`).
- A DNS name for the server that points at the host (below: `sap-adt.vhdemohost.example`), and
  ports 80 and 443 open to it. The proxy uses port 80 to obtain its certificate.
- From the host: HTTPS to the SAP host and port (44300 by default), and to GitHub once a month for
  the Clean Core catalogue.
- The SAP service user and its password (`../deployment.md`, *The SAP user*).

## 1. Build the image

```sh
git clone <this repository> sap-adt && cd sap-adt
docker build -t sap-adt-readonly-mcp:local .
```

Use `docker build`, not `docker compose build`: the Compose build goes through Buildx bake, which
may stop to ask for privileges. The image runs as the user `node` (uid 1000), never as root.

## 2. The configuration

The installation's values live in `deploy/sap-adt.config.json`, next to the Compose file.
The repository ignores that file: it never reaches git.

```sh
cp config.example.json deploy/sap-adt.config.json
```

Edit it. What changes against the example:

| Key | Value |
|---|---|
| `host`, `port`, `client`, `user`, `system` | your system; `system` is the SID the host must answer as |
| `systemRole` | `DEV`, `QAS`, ... as you call this system |
| `passwordFile` | `/run/secrets/sap_password` (add it; delete the `$passwordFile` line) |
| `bindHost` | `0.0.0.0`: inside the container, the proxy reaches it over Docker's network |
| `publicHosts` | `["sap-adt.vhdemohost.example"]`, the DNS name, as the proxy forwards it |
| `paths.logs` | `/var/lib/sap-adt/logs`: the image is read-only outside the state volume |
| `limits.callsPerMinute` | a number per caller, such as `120` |
| `catalog.release` | the release of your system (`npm run sync:catalog -- --list` on any machine) |

In `deploy/compose.example.yaml`, replace `sap-adt.vhdemohost.example` in the proxy's command with
your DNS name.

## 3. The password

The secret is a file on the host, read by the container as uid 1000. Write it without echoing it
and without a trace in the shell history:

```sh
mkdir -p deploy/secrets
read -rs SAP_PW && printf '%s' "$SAP_PW" > deploy/secrets/sap-password && unset SAP_PW
sudo chown 1000:1000 deploy/secrets/sap-password
sudo chmod 0400 deploy/secrets/sap-password
```

The server refuses a file every user of the machine can read, so `0400` (or `0440`) is required,
and `chown` lets the container's user read it. `deploy/secrets/` is ignored by git.

## 4. Load the configuration and the catalogue

From the repository root (the state lives in the named volume `sap-adt_state`):

```sh
C="docker compose -f deploy/compose.example.yaml"
$C run --rm config import /etc/sap-adt/config.json
$C run --rm --entrypoint node config scripts/sync-catalog.mjs
$C run --rm config doctor
```

Expected: `imported ... setting(s)`, the catalogue `installed`, and `doctor` answering `all good`.
`import` merges: run it again after any change to the file. To see what is stored:
`$C run --rm config list`.

## 5. The callers

One token per person or agent. Each is printed **once**: hand it over at once.

```sh
$C run --rm config token add alice
$C run --rm config token list
```

## 6. Start

```sh
$C up -d
$C logs -f sap-adt
```

The log, in order: the banner (endpoint `https://<your name>/mcp`, the callers registered),
`system confirmed: <SID> client <client>`, the logon, `environment signature -> <SID>/<client>
(<category>)`, and `Listening on ...`. The container is healthy when `/readyz` answers.

## 7. Check it from outside

```sh
curl -s https://sap-adt.vhdemohost.example/healthz     # ok
curl -s https://sap-adt.vhdemohost.example/readyz      # ok
```

Then, on a developer's machine:

```sh
claude mcp add --scope user --transport http sap-adt https://sap-adt.vhdemohost.example/mcp \
  --header "Authorization: Bearer <alice's token>"
claude mcp list
```

Ask the client for `adt_transport_routes`: the answer starts with `system`, naming the SID, the
client and its category, and lists the routes of the domain.

## Operating it

| Task | Command |
|---|---|
| A caller added or removed | `$C run --rm config token add <name>`, then `$C restart sap-adt` |
| A setting changed | edit `deploy/sap-adt.config.json`, `$C run --rm config import /etc/sap-adt/config.json`, `$C restart sap-adt` |
| The SAP password changed | change it in SAP, rewrite `deploy/secrets/sap-password` (step 3), `$C restart sap-adt` |
| The catalogue, monthly | a cron line: `docker compose -f <repo>/deploy/compose.example.yaml run --rm --entrypoint node config scripts/sync-catalog.mjs` |
| Bounding the logs | `$C run --rm --entrypoint node config scripts/prune-logs.mjs --days 90 --apply --audit` |
| Who read what | `$C run --rm --entrypoint sh config -c 'tail -n 50 /var/lib/sap-adt/audit.log'` |
| Upgrading | `git pull`, `docker build -t sap-adt-readonly-mcp:local .`, `$C up -d` |

Never run two `sap-adt` containers: each is one logon of the same user.

## When it does not start

| The log says | What it means |
|---|---|
| `Could not confirm the system ... (ENOTFOUND)` | the host name does not resolve from the container. Nothing was sent |
| `Unexpected system at ...` | the host answers as another SID or client: fix `host` or `system`. Nothing was sent |
| `passwordFile: ... readable by every user` | `chmod 0400` the file (step 3) |
| `passwordFile: ... cannot be read (EACCES)` | the container's user cannot read it: `chown 1000:1000` (step 3) |
| `NOT logging on: the SAP system refused the password ...` | SAP refused this file's password before. Put the right one in the file; the next start tries once |
| `SAP rejected the credentials (401)` | the password is wrong. Fix the file before the next start: each start with a refused password counts towards the lock until the file changes |
| a client gets `403 ... not this loopback endpoint` | the name the client uses is not in `publicHosts`, or the proxy does not forward `Host` |
| a client gets `401` | the token is not a caller's, or the server was not restarted after `token add` |

# Hosting the server for a team

The README installs the server for one developer: a terminal, a typed password, a loopback port.
This file is the other case: one instance, under an SAP service user, that a team reaches over
the network. Each decision behind it is dated in [`security.md`](security.md); this file says
what to do with them.

**What is and is not verified.** Every behaviour below has a test in the offline suite. The image
has been built and run with a read-only root file system and a named volume: the configuration
import, `token add`, and a start that stops before any password when the host does not answer.
Nothing has been run against an SAP system as a hosted service, and the Kubernetes and systemd
examples have not been applied to a cluster or a machine. Treat the first installation as the
measurement, on a development system, with someone watching (`backlog.md`, *Hosting the server
for a team*).

## Before anything is installed

1. **Ask SAP.** The ADT REST API is the protocol of SAP's own tools (`security.md`, *Scope limits
   that are also safety limits*). A hosted server adds a second question: several people now read
   through **one** SAP user. Whether that fits your licence and your user-type rules is your SAP
   contact's answer, not this repository's.
2. **Keep it on a development system.** Nothing here is tuned for the load or the data of a
   quality or production system.
3. **Decide who may see names.** `adt_runtime_errors` and `adt_transport` answer with the names of
   people. Withhold them with `tools.disabled` if your installation should not offer that.

## The SAP user

The server is read-only by what it can express. A service user lets the **system** hold the same
line, which a personal developer user never could:

- A technical user, not a person's. SAP's *System* user type does not log on in the SAP GUI and
  its password does not expire by the dialog rules, which is what an unattended logon needs.
  Confirm the type with your Basis team; it has not been measured here.
- A role with **display** activities only. With that role the system itself refuses a change,
  whatever any client sends. Derive it from the role your developers use, reduce every activity
  to display, and find what is missing with the authorisation trace while the tools are
  exercised. The minimal role is an open measurement (`backlog.md`).
- The role is everyone's: every caller reads with these authorisations. The `adt_customizing`
  tables, the ATC run and the launchpad services each need theirs, and a missing one comes back
  as the SAP error, never as an empty answer.
- `adt_atc_run` leaves result worklists under this user, as the IDE does for a person.

## Four things that hold on every platform

| Rule | Why |
|---|---|
| **One instance.** One process, one replica | Each instance is a logon of the same user. Two starting together are two logons with one password, and the index `adt_annotation_scan` keeps is in memory |
| **The state directory is persistent** (`SAP_ADT_STATE_DIR`) | A password the system refused is not sent again while its file is unchanged, and that rule reads the audit trail of earlier starts. On storage that is recreated at every start, a restart loop sends the wrong password every time and locks the user |
| **The password is a file** (`passwordFile`) | Readable by the service account only. Never an environment variable, never an argument |
| **TLS in front** | The server speaks plain HTTP. A proxy or an ingress terminates TLS for the name in `publicHosts` and forwards that `Host` unchanged |

## Settings of a hosted installation

All through `npm run config` (or one `import` of a file in the shape of `config.example.json`):

| Setting | Value |
|---|---|
| `host`, `port`, `client`, `user`, `system` | the connection, as in the README |
| `passwordFile` | the absolute path of the file the platform puts in place |
| `bindHost` | `0.0.0.0` in a container; the address of one interface on a machine |
| `publicHosts` | the name clients use, as it arrives in `Host` (required before `bindHost` leaves loopback) |
| `paths.logs` | a folder in the state directory: the default is inside the installation folder, which a service cannot write |
| `limits.callsPerMinute` | a number per caller, such as 120; the default 0 is for a single user |
| `limits.adtConcurrency` | 8 by default; lower it if the system has few dialog work processes to spare |
| `tools.disabled` | the tools you withhold, if any |

Then the callers, one per person or agent:

```bash
npm run config -- token add alice     # prints the token ONCE; hand it over now
npm run config -- token list
npm run config -- token remove alice
```

The server reads the callers at start: restart it after a change. A client registers with the
public URL and its own token:

```bash
claude mcp add --scope user --transport http sap-adt https://<public host>/mcp \
  --header "Authorization: Bearer <the caller's token>"
```

## Per platform

**Kubernetes.** [`../Dockerfile`](../Dockerfile) builds the image and
[`../deploy/kubernetes.example.yaml`](../deploy/kubernetes.example.yaml) is a starting point:
one replica with the `Recreate` strategy, a claim for the state directory, the password as a
mounted secret (mode `0440`; the server refuses a file every user can read), an init container
that imports the configuration, and probes on `/healthz` and `/readyz`. Add callers with
`kubectl exec deploy/sap-adt -- node scripts/config.mjs token add <name>`, then restart the pod.

**Linux.** [`../deploy/sap-adt.service`](../deploy/sap-adt.service) is a systemd unit: a system
user, `StateDirectory`, and the password handed over with `LoadCredential`, so `passwordFile` is
`/run/credentials/sap-adt.service/sap-password`.

**Windows.** Run `node server.mjs` under a dedicated local or managed service account, with a
service wrapper or a scheduled task set to run whether or not a user is logged on. Set
`SAP_ADT_STATE_DIR` for that account to a folder only it and the administrators can open, and put
the password in a file with the same access list. Windows has no mode bits for the server to
judge, so that access list is the whole protection of the file: check it with `icacls`.

## Operating it

- **Is it up?** `GET /healthz` says the process answers; `GET /readyz` says it holds an SAP
  session. Neither needs a token or sends anything to the system.
- **It did not start.** Read its output. A refused logon is one line in `audit.log`
  (`logon-refused`), and the next start says *NOT logging on* until the password file changes.
  Fix the password in the file (or unlock the user), then start again.
- **Changing the SAP password.** Change it in the system, replace the file, restart. A session
  that expires logs on again once with the password in memory; if that is refused the server
  stops serving and says so, and `/readyz` turns `503`.
- **Who read what.** `audit.log` in the state directory: one line per read with the caller, the
  tool and the object, never the content. `npm run report -- --runs` lists the starts and stops.
- **Keeping it bounded.** `npm run logs:prune -- --days N --apply [--audit]` on a schedule.
- **The Clean Core catalogue.** `npm run sync:catalog` monthly, as a scheduled job with the same
  state directory. It needs the internet (GitHub), or `--from <folder>` with the two files.
- **Upgrading.** Stop, install the new version, start. The store migrates itself forward and
  refuses a store written by a newer version.

## What a hosted installation still does not have

- **Single sign-on.** A caller holds a token made by the operator. OAuth through an identity
  provider was left for later (`security.md`, *A token per caller*).
- **Per-caller authorisation.** Every caller reads what the one SAP user may read.
- **More than one SAP system.** One installation, one system; run one instance per system.

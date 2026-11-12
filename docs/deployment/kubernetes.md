# Kubernetes

One Deployment of the server in a cluster, behind an Ingress that terminates TLS, from an image to
a client that answers. Read [`../deployment.md`](../deployment.md) first: the SAP user, the four
rules and the settings are explained there and not repeated here.

**Verified**: the image (built and run with a read-only root file system, `docker.md`), and the
ConfigMap of the example, which `tests/deploy.test.mjs` validates against every setting.
**Not verified**: the manifests applied to a cluster, an Ingress, and a logon against SAP.

## What you need

- A cluster and `kubectl` with rights on one namespace (below: `sap-adt`).
- A registry the cluster pulls from.
- A storage class that gives a `ReadWriteOnce` volume of 1 GiB that survives the pod.
- An Ingress controller that terminates TLS and forwards `Host` unchanged (ingress-nginx does by
  default), and a DNS name for it (below: `sap-adt.vhdemohost.example`).
- Egress from the namespace to the SAP host and port, and to GitHub once a month.
- The SAP service user and its password (`../deployment.md`, *The SAP user*).

## 1. The image

```sh
docker build -t <registry>/sap-adt-readonly-mcp:<version> .
docker push <registry>/sap-adt-readonly-mcp:<version>
```

Replace `<your-registry>/sap-adt-readonly-mcp:<version>` in both places of
`deploy/kubernetes.example.yaml`. Pin the image by digest once it is pushed.

## 2. The namespace and the password

```sh
kubectl create namespace sap-adt
read -rs SAP_PW && printf '%s' "$SAP_PW" > /tmp/sap-password && unset SAP_PW
kubectl -n sap-adt create secret generic sap-adt-password --from-file=password=/tmp/sap-password
shred -u /tmp/sap-password
```

The Secret is mounted as a file with mode `0440` and group 1000 (`fsGroup`): the server refuses a
password file every user of the container can read. It is never an environment variable. If your
cluster encrypts Secrets at rest or syncs them from a vault, use that instead of the file above;
what matters is that it arrives as a file.

## 3. The configuration

Copy the example and edit its ConfigMap. Every setting is already declared with the values of a
hosted server; change these:

| Key | Value |
|---|---|
| `host`, `port`, `client`, `user`, `system` | your system |
| `systemRole` | `DEV`, `QAS`, ... |
| `publicHosts` | `["sap-adt.vhdemohost.example"]`, the name of the Ingress |
| `catalog.release` | the release of your system |
| `customizingTables`, `atcVariants` | your own, or empty lists |

Keep `passwordFile` (`/run/secrets/sap-adt/password`, where the Secret is mounted), `bindHost`
(`0.0.0.0`) and `paths.logs` (in the state volume). The init container imports this file before
every start; `import` merges, so callers added later and values set by hand stay.

## 4. Apply

```sh
kubectl -n sap-adt apply -f deploy/kubernetes.example.yaml
kubectl -n sap-adt rollout status deploy/sap-adt
kubectl -n sap-adt logs deploy/sap-adt -c sap-adt
```

What the manifest holds and why: one replica with the `Recreate` strategy (two pods during a
rollout would be two logons with one password); a PersistentVolumeClaim for the state (the rule
that keeps a refused password from being sent again reads the audit trail of earlier starts); a
read-only root file system; probes on `/healthz` and `/readyz`, which send nothing to SAP.

The log, in order: `system confirmed`, the logon, `environment signature -> <SID>/<client>
(<category>)`, `Listening on ...`.

## 5. The catalogue

```sh
kubectl -n sap-adt exec deploy/sap-adt -c sap-adt -- node scripts/sync-catalog.mjs
kubectl -n sap-adt exec deploy/sap-adt -c sap-adt -- node scripts/config.mjs doctor
```

Run it in the running pod: a separate Job would need the same `ReadWriteOnce` volume, which only
one node can mount. The server reads the catalogue at each call, so no restart is needed.

## 6. The Ingress

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: sap-adt
  namespace: sap-adt
spec:
  ingressClassName: nginx
  tls:
    - hosts: [sap-adt.vhdemohost.example]
      secretName: sap-adt-tls          # your certificate, or the one cert-manager issues
  rules:
    - host: sap-adt.vhdemohost.example
      http:
        paths:
          - path: /mcp
            pathType: Exact
            backend: { service: { name: sap-adt, port: { name: mcp } } }
```

Only `/mcp` is published: `/healthz` and `/readyz` are for the kubelet, not for the internet.
Each MCP call is one POST; a package scan can take minutes, so raise the proxy read timeout
(ingress-nginx: `nginx.ingress.kubernetes.io/proxy-read-timeout: "600"`).

## 7. The callers, and a client

```sh
kubectl -n sap-adt exec deploy/sap-adt -c sap-adt -- node scripts/config.mjs token add alice
kubectl -n sap-adt rollout restart deploy/sap-adt
```

The token is printed once. The server reads the callers at start, hence the restart. On a
developer's machine:

```sh
claude mcp add --scope user --transport http sap-adt https://sap-adt.vhdemohost.example/mcp \
  --header "Authorization: Bearer <alice's token>"
```

## Operating it

| Task | How |
|---|---|
| A setting changed | edit the ConfigMap, `kubectl apply`, `kubectl rollout restart deploy/sap-adt` |
| The SAP password changed | change it in SAP, recreate the Secret, restart: the file is new, so one attempt is owed again |
| The catalogue, monthly | step 5, from a scheduled job of your own that holds `kubectl exec` rights |
| Bounding the logs | `kubectl exec ... -- node scripts/prune-logs.mjs --days 90 --apply --audit` |
| Who read what | `kubectl exec ... -- tail -n 50 /var/lib/sap-adt/audit.log` |
| Upgrading | push the new image, change the tag, `kubectl apply` |

Never scale above one replica.

## When it does not start

The pod's log names the reason; the table in [`docker.md`](docker.md#when-it-does-not-start)
applies unchanged. Two that are particular to a cluster:

- **The pod restarts and the log says `NOT logging on`.** The password in the Secret was refused
  before and has not changed. That is the lock protection at work, not a crash to retry:
  recreate the Secret with the right password.
- **`/readyz` stays `503`.** The SAP session was lost and its logon again was refused; the log says
  so. Same remedy.

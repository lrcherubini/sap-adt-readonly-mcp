# Windows Server

One Windows machine, the server under a service account, started by the Task Scheduler and
reached through a TLS proxy on the same machine. Read [`../deployment.md`](../deployment.md)
first: the SAP user, the four rules and the settings are explained there and not repeated here.

**Not verified**: none of these steps has been run on a Windows Server. The server itself is
developed and tested on Windows; the service account, the task and the proxy are not.

All commands are Windows PowerShell 5.1, run as an administrator unless a step says otherwise.

## What you need

- Windows Server with Node.js 22 LTS (22.13 or later) and Git.
- A DNS name for the machine (below: `sap-adt.vhdemohost.example`), port 443 open to it.
- From the machine: HTTPS to the SAP host and port, and to GitHub once a month for the catalogue.
- The SAP service user and its password (`../deployment.md`, *The SAP user*).

## 1. Install

```powershell
git clone <this repository> C:\sap-adt
Set-Location C:\sap-adt
npm ci --ignore-scripts --omit=dev
```

## 2. The service account and its folders

A local account for a single machine, or a group managed service account in a domain. Below, a
local one:

```powershell
$pw = Read-Host -AsSecureString 'Password of the Windows service account'
New-LocalUser -Name svc-sap-adt -Password $pw -PasswordNeverExpires -UserMayNotChangePassword
New-Item -ItemType Directory -Force C:\ProgramData\sap-adt\state, C:\ProgramData\sap-adt\secret
foreach ($dir in 'C:\ProgramData\sap-adt\state', 'C:\ProgramData\sap-adt\secret') {
  icacls $dir /inheritance:r /grant:r "Administrators:(OI)(CI)F" "SYSTEM:(OI)(CI)F" "svc-sap-adt:(OI)(CI)M"
}
[Environment]::SetEnvironmentVariable('SAP_ADT_STATE_DIR', 'C:\ProgramData\sap-adt\state', 'Machine')
$env:SAP_ADT_STATE_DIR = 'C:\ProgramData\sap-adt\state'
```

`/inheritance:r` removes what `ProgramData` grants every user: the state holds the audit trail and
the callers, the secret folder the SAP password. The server never checks an access list on
Windows (there are no mode bits to read), so this step is the whole protection of the password.

## 3. The password

Write it without a byte-order mark: Windows PowerShell's `Set-Content` and `Out-File` add one.
(The server drops a mark since this version, but an older one would send it and be refused.)

```powershell
$sec = Read-Host -AsSecureString 'SAP password of the service user'
$plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
[IO.File]::WriteAllText('C:\ProgramData\sap-adt\secret\sap-password', $plain)
Remove-Variable plain, sec
icacls C:\ProgramData\sap-adt\secret\sap-password
```

The last line shows the access list: only Administrators, SYSTEM and `svc-sap-adt`.

## 4. The configuration and the catalogue

```powershell
Copy-Item config.example.json C:\ProgramData\sap-adt\env.json
notepad C:\ProgramData\sap-adt\env.json
```

What changes against the example:

| Key | Value |
|---|---|
| `host`, `port`, `client`, `user`, `system` | your system |
| `systemRole` | `DEV`, `QAS`, ... |
| `passwordFile` | `C:\\ProgramData\\sap-adt\\secret\\sap-password` (add it; delete the `$passwordFile` line) |
| `bindHost` | `127.0.0.1`: the proxy runs on the same machine, so the server stays on loopback |
| `publicHosts` | `["sap-adt.vhdemohost.example"]`, the name the proxy forwards |
| `paths.logs` | `C:\\ProgramData\\sap-adt\\state\\logs`: the service account cannot write `C:\sap-adt` |
| `limits.callsPerMinute` | a number per caller, such as `120` |
| `catalog.release` | the release of your system |

```powershell
npm run config -- import C:\ProgramData\sap-adt\env.json
npm run sync:catalog
npm run config -- doctor
```

## 5. The callers

```powershell
npm run config -- token add alice      # printed ONCE: hand it over now
```

## 6. The task that runs the server

```powershell
$action  = New-ScheduledTaskAction -Execute (Get-Command node).Source -Argument 'server.mjs' -WorkingDirectory 'C:\sap-adt'
$trigger = New-ScheduledTaskTrigger -AtStartup
$set     = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$cred    = Get-Credential svc-sap-adt
Register-ScheduledTask -TaskName sap-adt -Action $action -Trigger $trigger -Settings $set -User $cred.UserName -Password $cred.GetNetworkCredential().Password -RunLevel Limited
Start-ScheduledTask sap-adt
```

`MultipleInstances IgnoreNew` keeps one instance: two would be two logons of the same SAP user.
Stopping the task ends the process without the shutdown sequence: the SAP session is left to
expire on its own, which holds no lock (it is stateless).

The task has no console, so the output is not kept. To see why a start failed, run the server
once by hand under the account, from an elevated prompt:

```powershell
runas /user:svc-sap-adt "cmd /k cd /d C:\sap-adt && node server.mjs"
```

## 7. TLS in front

Any reverse proxy on the same machine that terminates TLS for the DNS name and forwards to
`http://127.0.0.1:2237/mcp` **with the `Host` header unchanged**. Two that work:

- **IIS** with URL Rewrite and Application Request Routing. ARR rewrites `Host` by default; turn
  that off, or every request is refused as not a listed host:
  `%windir%\system32\inetsrv\appcmd.exe set config -section:system.webServer/proxy /preserveHostHeader:True /commit:apphost`.
  Raise the proxy timeout to 600 seconds for package scans.
- **Caddy for Windows**, as a second scheduled task:
  `caddy reverse-proxy --from sap-adt.vhdemohost.example --to 127.0.0.1:2237`.

Open only 443 (and 80 if the proxy obtains its certificate itself) in the Windows firewall. Port
2237 stays closed: the server listens on loopback.

## 8. Check it

```powershell
Invoke-WebRequest http://127.0.0.1:2237/readyz -UseBasicParsing | Select-Object StatusCode, Content
Invoke-WebRequest https://sap-adt.vhdemohost.example/mcp -Method Post -UseBasicParsing   # 401 without a token: the proxy reaches it
```

On a developer's machine:

```powershell
claude mcp add --scope user --transport http sap-adt https://sap-adt.vhdemohost.example/mcp --header "Authorization: Bearer <alice's token>"
```

## Operating it

| Task | How |
|---|---|
| A caller added or removed | `npm run config -- token add <name>`, then `Stop-ScheduledTask sap-adt; Start-ScheduledTask sap-adt` |
| A setting changed | edit `env.json`, `npm run config -- import ...`, restart the task |
| The SAP password changed | change it in SAP, rewrite the file (step 3), restart the task |
| The catalogue, monthly | a second task, monthly: `npm run sync:catalog`, working directory `C:\sap-adt`, same account |
| Bounding the logs | `npm run logs:prune -- --days 90 --apply --audit`, monthly |
| Who read what | `Get-Content C:\ProgramData\sap-adt\state\audit.log -Tail 50` |
| Upgrading | stop the task, `git pull`, `npm ci --ignore-scripts --omit=dev`, start the task |

`SAP_ADT_STATE_DIR` is a machine variable: every `npm run` on this machine uses the same state,
which is what these commands need. Run them as an administrator or as the service account.

## When it does not start

The table in [`docker.md`](docker.md#when-it-does-not-start) applies. On Windows also:

- **The task ends at once.** Run the server by hand (step 6) and read the first lines.
- **`Refusing to start: state directory ... is inside the git work tree`.** `SAP_ADT_STATE_DIR` points
  into the clone. Use `C:\ProgramData\sap-adt\state`.
- **`EPERM` or `EACCES` on the state directory.** The account lacks the `M` grant of step 2.

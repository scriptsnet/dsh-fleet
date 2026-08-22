# ⚡ dsh-fleet — DSH Multi-Machine Compute Fleet

> **Pool every idle machine** — friends' PCs, LAN servers, cloud ECS — into your own distributed AI compute fleet.
>
> One machine can dispatch to any machine in the fleet. One person, many Harnesses, parallel projects.

<p align="center">
  <b>🧠 Every idle machine's compute is your distributed AI pool.</b>
</p>

<p align="center">
  <b>💻 Cross-platform</b> — any machine that can run DSH can join the fleet<br>
  <i>Windows · Linux · macOS · Cloud ECS · Raspberry Pi — no OS limit, any machine joins</i>
</p>

---

> 🌏 **简体中文 README**: [README.md](README.md) · 中文版本请见 [README.md](README.md)

---

## ✨ Features

| Feature | Notes |
|---|---|
| 🪪 **Machine Identity** | Auto-generates `machineId` + permanent SK on install, zero-config |
| 🃏 **Machine Card** | One-line copyable string (ID/name/IP:port/CPU/mem/NAT/SK), one-click join |
| 🧑‍🤝‍🧑 **Multi-Team** | One machine can belong to many teams, each with an isolated roster |
| 🔐 **Trusted Handshake** | challenge-response + HMAC-SHA256 proves SK possession; SK never crosses the wire |
| 💓 **Heartbeat** | Long-lived connection + RTT/memory reporting, auto-reconnect |
| 🚀 **Task Dispatch** | `fleet_dispatch` sends a task to any online member; results flow back |
| 📦 **Sessions Retained** | Worker session auto-mounts to workspace; GUI-visible and traceable |
| 💻 **Cross-platform** | Windows / Linux / macOS as master or worker |
| 🧰 **Zero Deps** | Node built-ins only, no runtime dependencies |
| 🖥️ **One-click Installer** | Offline harness + plugin setup for Windows / Linux |

## 🏗️ Four-Layer Model

| Layer | Contents | Impl |
|---|---|---|
| **Identity** | `machineId` + permanent SK, listens on a port | `identity.js`, `listener.js` |
| **Trust** | Manual add via card or IP+SK, removable both ways | `card.js`, `roster.js` |
| **Authorization** | Temp taskToken (HMAC-verified), worker holds veto | `protocol.js` |
| **Control Plane** | Session/workspace directives, heartbeat reporting | `peer.js` |

> **Trust basis**: knowing someone's permanent SK = authorized to call them. SK never travels in plaintext; the handshake proves possession via challenge-response.

## 📦 Install

### As a DSH plugin (recommended)

```powershell
# Local path install
dsh plugin --profile web add "E:\DeepSeekHarness\dsh-fleet"

# From GitHub
dsh plugin --profile web add https://github.com/scriptsnet/dsh-fleet

# From npm (recommended)
dsh plugin --profile web add dsh-fleet
```

**Restart harness after install.** On plugin start:

1. Auto-generates machine identity (`data\fleet\identity.json`, portable)
2. Listens on port `47900` (worker role)
3. Registers **12 model tools** (below)
4. Registers `/fleet/api/*` routes (loopback-only)
5. Sidebar "Compute Fleet" panel appears

### One-click installer (no harness on target)

| File | OS | Usage |
|---|---|---|
| `install.ps1` | Windows | `powershell -ExecutionPolicy Bypass -File install.ps1 -HarnessZip "D:\DeepSeek-Harness-便携版.zip"` |
| `install.bat` | Windows | Double-click, or same args |
| `dsh-fleet-agent-installer.exe` | Windows | Double-click (ps2exe) |
| `install.sh` | Linux / macOS | `bash install.sh [<plugin-dir>]` (systemd autostart) |

## 🛠️ Tools (12)

| Tool | Purpose |
|---|---|
| `fleet_card` | Show local machine card |
| `fleet_teams` | List teams: members, online, compute, mem, RTT |
| `fleet_team_create` | Create a team |
| `fleet_team_delete` | Delete a team |
| `fleet_add` | Join via card or IP+SK, auto-handshake |
| `fleet_remove` | Remove a member |
| `fleet_test` | Connectivity test + handshake |
| `fleet_memberships` | List my memberships (worker view) |
| `fleet_leave` | Leave a team |
| `fleet_refuse` / `fleet_resume` | Refuse / resume calls (DND) |
| `fleet_dispatch` | **Dispatch** a task to a member |

## 🚀 Quick Start

### Join a team

```text
"show my machine card"          → fleet_card
"add this card to team XX"       → fleet_add
"which teams? who's online?"     → fleet_teams
```

Or use the sidebar panel.

### Dispatch a task

```text
Use fleet_dispatch to send the task to a member of "XX fleet":
- prompt: "use bash to run echo hello and output the result"
- provider / model: deepseek-official / deepseek-v4-flash
- keyHint: inherit (use master's key) or self (use worker's own key)
```

Returns: member / task ID / workspace / session ID / answer / logs. **Worker session auto-mounts to workspace**, full transcript in GUI.

### Plugin config (`cordis.patch.yml`)

```yaml
- id: dsh-fleet
  name: dsh-fleet
  config:
    port: 47900        # listen port
    # home: <path>     # identity/roster dir, default $DSH_HOME/fleet
    # listen: true     # false = master-only, no listen
```

### Env vars

| Var | Default | Notes |
|---|---|---|
| `DSH_FLEET_HOME` | `$DSH_HOME/fleet` or `~/.dsh/fleet` | Identity & roster dir; set per-machine for local multi-machine sim |
| `DSH_FLEET_DISPOSE_AFTER_TASK` | `0` | `1` = dispose session after task (recovers on refresh); default keeps it GUI-visible |

## 🔌 Protocol

JSON-lines over TCP. Handshake:

```
server → challenge { nonce, machineId, name }     server self-identifies + challenge
client → auth     { machineId, name, proof }      proof = HMAC(serverSK, nonce)
server → welcome | error(AUTH_FAILED)             local verify, SK never leaves
then periodic ping / pong (pong carries mem stats)
```

Task dispatch: `submit_task { taskId, token, prompt, provider, model }` → worker verifies → new workspace → agent session → execute → `task_result` back. token = HMAC(workerSK, taskId), anti-forgery.

## 🗺️ Roadmap

**Implemented**
- [x] Identity / card / multi-team / connectivity / heartbeat
- [x] Secure handshake (challenge-response), bad SK rejected
- [x] DSH plugin: 12 tools + fleet Service + `/fleet/api/*` routes
- [x] One-click installer (ps1 / bat / exe / sh)
- [x] **Task dispatch / execute / result back**, worker sessions mounted
- [x] keyHint dual mode (inherit / self), fail/timeout paths
- [x] Per-task provider / model / preset / workspace
- [x] **Public IP / NAT detection** (STUN with fallback tiers)

**Planned**
- [ ] Streaming task logs / artifact return
- [ ] UDP hole-punching; invite codes
- [ ] npm publish, standard `dsh plugin add` install

---

## 📄 License

[MIT](LICENSE)

---

## ☕ About This Project

<p align="center">
  <b>dsh-fleet began as a spark: "pool every idle machine's compute."</b><br>
  <i>Then... actually burned ~200M tokens building it.</i>
</p>

<p align="center">
  <b>If you build AI agents / full-stack, let's talk — collab, contract, or just chat.</b><br>
  📮 <a href="mailto:3292957@qq.com">3292957@qq.com</a> &nbsp;·&nbsp; GitHub: <a href="https://github.com/scriptsnet">@scriptsnet</a>
</p>

> 💡 Built for fun, not for profit. If it helps, a ⭐ is the best support.

<br>

<div align="center">

**Support the token burn ☕**

| WeChat | Alipay |
|:---:|:---:|
| <img src="docs/wechat-pay.png" width="220" alt="WeChat Pay"> | <img src="docs/alipay-pay.jpg" width="220" alt="Alipay"> |

</div>

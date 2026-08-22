# ⚡ dsh-fleet — DSH 多机算力组网

> **把朋友间、局域网里、云上 ECS 的每一份闲置算力，汇聚成你自己的分布式 AI 算力池。**
>
> 一台机可以调用整个团队任意一台机的算力——朋友闲置的 PC、公司局域网服务器、云上闲置的 ECS，全都能跑起来。一个人，掌控多台 Harness，并行推进多个开发与研究项目。

<p align="center">
  <b>🧠 每一台闲置机器的算力，都是你的分布式 AI 算力池</b>
</p>

<p align="center">
  <b>💻 跨平台</b> — 任何一台能跑 DSH 的电脑/机器都能加入算力团队<br>
  <i>Windows 台式机 · Linux 服务器 · macOS 笔记本 · 云上 ECS · 树莓派…… 不限操作系统，是机器就能组队</i>
</p>

---

> 🌐 **English README**: [README.en.md](README.en.md) · 英文版本请见 [README.en.md](README.en.md)

---

## ✨ 特性

| 能力 | 说明 |
|---|---|
| 🪪 **机器身份** | 每台机安装后自动生成 `machineId` + 永久 SK，零配置 |
| 🃏 **机器名片** | 一行可复制字符串（ID/名称/IP:端口/CPU/内存/NAT/SK），一键组队 |
| 🧑‍🤝‍🧑 **多团队** | 每台机可同时属于多个团队，每个团队独立名录互不干扰 |
| 🔐 **信任握手** | challenge-response + HMAC-SHA256 证明 SK 持有，SK 永不明文过网 |
| 💓 **心跳监控** | 长连接 + RTT/内存上报，断线自动重连，在线状态实时可见 |
| 🚀 **任务派发** | `fleet_dispatch` 把任务发给任意在线成员，worker 自动跑 agent 并回流结果 |
| 📦 **会话保留** | worker 任务会话自动挂载到工作区，GUI 可见、记录完整、可回溯 |
| 💻 **跨平台** | Windows / Linux / macOS 均可作为 master 或 worker 加入，不限操作系统 |
| 🧰 **零运行时依赖** | 仅用 Node 内置模块，无第三方依赖 |
| 🖥️ **一键安装器** | Windows / Linux 离线安装 harness + 插件，无需 pnpm/GitHub |

## 🏗️ 核心模型（四层）

| 层次 | 内容 | 实现 |
|---|---|---|
| **身份层** | 每台机生成 `machineId` + 永久 SK，监听端口 | `src/identity.js`、`src/listener.js` |
| **信任层** | 人工添加（粘贴名片 / IP+SK），双向可移除 | `src/card.js`、`src/roster.js` |
| **授权层** | 任务执行凭临时 taskToken（HMAC 验签防伪造），worker 拥有最终否决权 | `src/protocol.js` |
| **控制面** | 会话/工作区指令、心跳资源上报、名片/端点上报 | `src/peer.js` |

> **信任基础**：知道对方永久 SK = 被授权调用。SK 永不通过线路明文传输，握手用 challenge-response 证明持有。

## 📦 安装

### 作为 DSH 插件（推荐）

```powershell
# 方式一：本地路径安装（无需 GitHub）
dsh plugin --profile web add "E:\DeepSeekHarness\dsh-fleet"

# 方式二：从 GitHub 安装
dsh plugin --profile web add https://github.com/scriptsnet/dsh-fleet

# 方式三：从 npm 安装（推荐）
dsh plugin --profile web add dsh-fleet
```

**重启 harness 后生效。** 插件启动时：

1. 自动生成机器身份（`data\fleet\identity.json`，随便携版目录带走）
2. 监听端口 `47900`（被调用方 / worker 角色）
3. 注册 **12 个模型工具**（见下表）
4. 注册 `/fleet/api/*` 路由（仅回环可访问）供面板使用
5. 侧边栏出现「**算力舰队**」面板：名片一键复制、多团队列表、新建团队、粘贴名片添加成员、联通测试、移除成员

### 一键安装器（目标机没有 harness 时）

`installer/` 提供三种形态（任选其一，复制到目标机运行）——**按目标机操作系统选对应安装器，Windows / Linux 都覆盖**：

| 文件 | 适用系统 | 用法 |
|---|---|---|
| `install.ps1` | Windows | `powershell -ExecutionPolicy Bypass -File install.ps1 -HarnessZip "D:\DeepSeek-Harness-便携版.zip"` |
| `install.bat` | Windows | 双击，或带同样参数 |
| `dsh-fleet-agent-installer.exe` | Windows | 双击（ps2exe 封装） |
| `install.sh` | Linux / macOS | `bash install.sh [<插件目录>]`（含 systemd 自启） |

## 🛠️ 工具一览（12 个）

| 工具 | 作用 |
|---|---|
| `fleet_card` | 展示本机名片（可复制字符串） |
| `fleet_teams` | 查看所有团队：成员 / 在线 / 算力 / 内存 / RTT |
| `fleet_team_create` | 创建团队 |
| `fleet_team_delete` | 删除团队（连同名录） |
| `fleet_add` | 把一台机器加入团队（名片或 IP+SK，自动握手） |
| `fleet_remove` | 从团队移除成员 |
| `fleet_test` | 联通性测试 + SK 挑战握手 |
| `fleet_memberships` | 查看本机加入了哪些团队（worker 视角） |
| `fleet_leave` | 主动退出某个 master 的团队 |
| `fleet_refuse` / `fleet_resume` | 拒绝 / 恢复被调用（DND） |
| `fleet_dispatch` | **派发任务**到指定成员，worker 自动执行并回流结果 |

## 🚀 快速上手

### 组队

```text
"查看我的机器名片"                    → fleet_card
"把这张名片加入 XX 团队"               → fleet_add
"有哪些团队？成员在线吗？"             → fleet_teams
```

也可以在侧边栏「算力舰队」面板点点点。

### 派发任务

```text
用 fleet_dispatch 把任务发给「XX舰队」的成员：
- 任务提示语："用 bash 执行 echo hello 并输出结果"
- provider / model：deepseek-official / deepseek-v4-flash
- keyHint：inherit（worker 无 key 时用总机 key）或 self（worker 用自己的 key）
```

任务完成后返回：成员 / 任务 ID / 工作区 / 会话 ID / 完整回答 / 执行日志。**worker 侧会话自动挂载到工作区**，GUI 里可查看完整对话记录。

### 插件配置（`cordis.patch.yml`）

```yaml
- id: dsh-fleet
  name: dsh-fleet
  config:
    port: 47900        # 监听端口
    # home: <路径>     # 身份/名录目录，默认 $DSH_HOME/fleet
    # listen: true     # false = 仅当 master，不对外监听
```

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_FLEET_HOME` | `$DSH_HOME/fleet` 或 `~/.dsh/fleet` | 身份与名录目录；本地多机模拟时分别为每台机指定 |
| `DSH_FLEET_DISPOSE_AFTER_TASK` | `0` | `1` = 任务完成后立即 dispose 会话（从实时列表移除，刷新后恢复）；默认保留会话供 GUI 查看 |

## 🔌 协议

JSON-lines over TCP，握手：

```
server → challenge { nonce, machineId, name }     服务器自证身份 + 发挑战
client → auth     { machineId, name, proof }      proof = HMAC(服务器SK, nonce)
server → welcome | error(AUTH_FAILED)             服务器本地验签，SK 永不出本机
之后周期 ping / pong（pong 携带内存空闲等资源统计）
```

任务派发：`submit_task { taskId, token, prompt, provider, model }` → worker 验签 → 新建工作区 → 建 agent 会话 → 执行 → `task_result` 回流。token = HMAC(workerSK, taskId)，防伪造/重放。

## 🗺️ 路线图

**已实现**
- [x] 机器身份 / 名片 / 多团队 / 联通测试 / 心跳监控
- [x] 安全握手（challenge-response），错误 SK 拒收
- [x] DSH 插件化：12 个模型工具 + fleet Service + `/fleet/api/*` 路由
- [x] 一键安装器（ps1 / bat / exe / sh）
- [x] **任务派发 / 执行 / 结果回流**，worker 会话挂载工作区
- [x] keyHint 双模式（inherit / self），失败 / 超时路径处理
- [x] 任务可指定 provider / model / preset / 工作区路径
- [x] **公网 IP / NAT 类型探测**（STUN，带回退分级），名片补全公网信息

**待实现**
- [ ] 任务日志流式回流 / 产物回传
- [ ] UDP 打洞；邀请码入队
- [ ] 发布 npm（`dsh-plugin` topic）后走标准 `dsh plugin add` 安装

## 📖 相关文章

- [DSH 插件开发实战：把朋友的闲置电脑，组建成你的分布式 AI 算力池](https://blog.csdn.net/3cts/article/details/163906669)（CSDN）——从架构设计、协议握手到 7 个真实踩坑记录的完整实战记录

---

## 📄 License

[MIT](LICENSE)

---

## ☕ 关于这个项目

<p align="center">
  <b>dsh-fleet 始于一个闪光的想法：「把每台闲置机器的算力凑一块儿」</b><br>
  <i>然后……就真的烧了 token 把它做出来了。开发调试全程烧了约 2 亿 token。</i>
</p>

<p align="center">
  <b>如果你也在做 AI Agent / 全栈开发，欢迎聊聊 —— 无论是合作、外包，还是单纯交流。</b><br>
  📮 <a href="mailto:3292957@qq.com">3292957@qq.com</a> &nbsp;·&nbsp; GitHub: <a href="https://github.com/scriptsnet">@scriptsnet</a>
</p>

> 💡 做这个插件纯属兴趣驱动，目前不靠它盈利。如果你觉得它有用，点个 ⭐ 就是最大的支持。

<br>

<div align="center">

**喜欢的话，赏我点 token 继续造轮子吧 ☕**

| 微信 | 支付宝 |
|:---:|:---:|
| <img src="docs/wechat-pay.png" width="220" alt="微信收款码"> | <img src="docs/alipay-pay.jpg" width="220" alt="支付宝收款码"> |

</div>

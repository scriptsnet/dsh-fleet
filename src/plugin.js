// dsh-fleet — DSH Cordis 插件入口（Host half）
// 安装后：
//   1. 本机立即生成/加载机器身份（machineId + 永久SK），存入 <home>/identity.json
//   2. 本机开始监听一个端口（被调用方/worker 角色），接受团队内其他机器按 IP+SK 接入
//   3. 注册 7 个模型工具：fleet_card / fleet_teams / fleet_team_create / fleet_team_delete
//      / fleet_add / fleet_remove / fleet_test（多团队支持）
//   4. 提供 fleet Service 与 /fleet/api/* HTTP 路由（供 Fleet 面板使用）
// 配置（cordis patch 的 config）：
//   port  监听端口（默认 47900）
//   home  身份与名录目录（默认 $DSH_HOME/fleet，未设则 ~/.dsh/fleet；可用 DSH_FLEET_HOME 覆盖）
//   listen 是否启动监听（默认 true；仅当 master 用时设 false）
//
// 实现遵循 dsh-ssh 的已验证模式：模块级 inject + ctx.tools.register 直用 +
// defineTool 从 @deepseek-ai/dsh-tools 导入（loader 重锚定 bare 导入，便携版全新安装可解析）。
// 所有步骤的错误都 console.error 落盘（logs/dsh.out.log），便于排查。
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { loadOrCreateIdentity } from './identity.js'
import { startListener } from './listener.js'
import { buildCard, parseCard } from './card.js'
import { preferredIPv4, cpuLabel, memGB, memFreeGB } from './network.js'
import { probePeer, connectPeer } from './peer.js'
import { hmac } from './protocol.js'
import { runTask } from './task-runner.js'
import {
  findTeam, ensureDefaultTeam, createTeam, removeTeam,
  addPeerToTeam, removePeerFromTeam, findPeerAcrossTeams, setPeerState, listTeams,
} from './teams.js'
import {
  listMemberships, upsertMembership, findMembership, deleteMembership, removeTeamFromMembership, setMembershipState,
} from './memberships.js'

export const name = 'dsh-fleet'
export const inject = ['tools', 'webServer']

const TEXT_OUTPUT = (text) => [{ type: 'text', text }]

// ---------- HTTP helpers（与 dsh-ssh 同款） ----------
function writeJson(res, status, obj) {
  try {
    const body = JSON.stringify(obj)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
    res.end(body)
  } catch { /* noop */ }
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')) } catch { resolve(undefined) }
    })
    req.on('error', () => resolve(undefined))
  })
}

function queryParam(url, name) {
  return url.searchParams.get(name) ?? undefined
}

function isLoopback(req) {
  const addr = req.socket?.remoteAddress
  return addr === undefined || addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

export const apply = (ctx, config) => {
  const port = Number(config?.port ?? 47900)
  const home = String(
    config?.home ||
    process.env.DSH_FLEET_HOME ||
    path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'fleet')
  )
  const listen = config?.listen !== false

  const log = (msg) => { try { ctx.logger?.info?.(`[dsh-fleet] ${msg}`) } catch { console.log(`[dsh-fleet] ${msg}`) } }
  const err = (msg, e) => { try { console.error(`[dsh-fleet] ${msg}: ${e && e.stack ? e.stack : String(e)}`) } catch { /* noop */ } }

  const identity = loadOrCreateIdentity(home)

  // ---------- 常驻出站监控：保持到团队成员的持久连接，供在线状态使用 ----------
  const monitors = new Map() // machineId -> { stop, state, send }
  const pendingTasks = new Map() // taskId -> { resolve, reject, timer, logs }

  // 处理 worker 回传的任务消息
  function handleTaskMessage(msg) {
    const pend = pendingTasks.get(msg.taskId)
    if (!pend) return
    if (msg.type === 'task_log') {
      pend.logs.push(msg.text)
    } else if (msg.type === 'task_result') {
      clearTimeout(pend.timer)
      pendingTasks.delete(msg.taskId)
      pend.resolve({ taskId: msg.taskId, ok: true, answer: msg.answer, workspace: msg.workspace, sessionId: msg.sessionId, logs: pend.logs })
    } else if (msg.type === 'task_failed') {
      clearTimeout(pend.timer)
      pendingTasks.delete(msg.taskId)
      pend.reject(new Error(msg.error || '任务失败'))
    }
  }

  // 某 peer 在哪些团队（用于 hello 声明）
  function teamsOfPeer(machineId) {
    const names = []
    for (const t of listTeams(home)) {
      for (const p of t.peers || []) {
        if (p.machineId === machineId) { names.push(t.name); break }
      }
    }
    return names
  }

  // 处理 worker 发来的控制消息（经监控长连接）
  function handleControl(msg, peer) {
    try {
      if (msg.type === 'leave') {
        const team = typeof msg.team === 'string' && msg.team ? msg.team : null
        const targets = listTeams(home).filter((t) => !team || t.name === team)
        let removed = 0
        for (const t of targets) removed += removePeerFromTeam(t.id, peer.name, home)
        log(`成员退出: ${peer.name}${team ? `（团队 ${team}）` : '（全部团队）'} 已移除 ${removed} 条`)
        syncMonitors() // 移除后监控自动停止
      } else if (msg.type === 'refuse' || msg.type === 'paused') {
        for (const t of listTeams(home)) setPeerState(t.id, peer.name, msg.type === 'refuse' ? 'refused' : 'paused', home)
        log(`成员拒绝调用: ${peer.name}（${msg.type === 'refuse' ? '拒绝' : '暂停'}）`)
      } else if (msg.type === 'resume') {
        for (const t of listTeams(home)) setPeerState(t.id, peer.name, 'active', home)
        log(`成员恢复调用: ${peer.name}`)
      } else if (msg.type === 'state') {
        const st = String(msg.state || 'active')
        if (['active', 'refused', 'paused', 'left'].includes(st)) {
          for (const t of listTeams(home)) setPeerState(t.id, peer.name, st, home)
          log(`成员状态同步: ${peer.name} → ${st}`)
        }
      }
    } catch (e) {
      err('handleControl 失败', e)
    }
  }

  function syncMonitors() {
    try {
      const desired = new Map()
      for (const t of listTeams(home)) {
        for (const p of t.peers || []) {
          // 只监控"活跃"成员；已拒绝/暂停/退出的不主动连
          if (p.machineId && p.host && p.port && p.sk && (p.state ?? 'active') === 'active') desired.set(p.machineId, p)
        }
      }
      for (const [mid, m] of [...monitors]) {
        if (!desired.has(mid)) { try { m.stop() } catch { /* noop */ }; monitors.delete(mid) }
      }
      for (const [mid, peer] of desired) {
        if (monitors.has(mid)) continue
        const conn = connectPeer({
          identity,
          peer,
          helloTeams: teamsOfPeer(mid),
          onControl: handleControl,
          onTaskMessage: handleTaskMessage,
          log: (m) => log(m),
          onStatus: (s, p) => {
            if (s.online) log(`监控在线: ${p.name}(${String(p.machineId).slice(0, 8)}…) RTT=${s.rtt ?? '-'}ms 内存空闲=${s.memFreeGB ?? '-'}GB`)
          },
        })
        monitors.set(mid, conn)
      }
    } catch (e) {
      err('syncMonitors 失败', e)
    }
  }
  const stopMonitors = () => { for (const [, m] of [...monitors]) { try { m.stop() } catch { /* noop */ } }; monitors.clear() }

  // ---------- 监听端（被调用方角色） ----------
  let listener = null
  try {
    if (listen) {
      listener = startListener({
        identity,
        port,
        onHello: (info) => {
          // master 声明本机在其团队里 → 登记成员关系；返回本机对该 master 的状态（供回告）
          try {
            const r = upsertMembership(info, home)
            log(`成员关系${r.added ? '新增' : '更新'}: ${r.membership.masterName} 团队=[${(r.membership.teams || []).join(', ')}]`)
            return r.membership.state ?? 'active'
          } catch (e) {
            err('upsertMembership 失败', e)
            return 'active'
          }
        },
        onKicked: (info) => {
          // 被 master 移出团队 → 删除成员关系
          try {
            const r = info.team
              ? removeTeamFromMembership(info.masterId, info.team, home)
              : deleteMembership(info.masterId, home)
            log(`被移出团队: ${info.masterId.slice(0, 8)}…${info.team ? `（团队 ${info.team}）` : '（全部）'} 记录${r.found ? '已删除' : '未找到'}`)
          } catch (e) {
            err('onKicked 处理失败', e)
          }
        },
        onTask: (task, send) => {
          // master 下发任务 → 执行器（异步，独立 fiber 不阻塞连接）
          runTask(ctx, { identity, home, task, send, log })
            .catch((e) => err('任务执行异常', e))
        },
        onEvent: (evt, payload) => {
          if (evt === 'listening') log(`监听 ${payload.port}，本机名片：${buildCard(identity, { port })}`)
          else if (evt === 'peer-connected') log(`接入: ${payload.name}(${String(payload.machineId).slice(0, 8)}…) 通过验证`)
          else if (evt === 'peer-hello') log(`接入方声明团队: ${payload.name} → [${(payload.teams || []).join(', ')}]`)
          else if (evt === 'peer-disconnected') log(`断开: ${payload.name}(${String(payload.machineId).slice(0, 8)}…)`)
          else if (evt === 'auth-failed') log(`拒绝: ${payload.fromName}(${String(payload.fromMachineId || '').slice(0, 8)}…) 认证失败`)
          else if (evt === 'error') err(`监听错误 ${payload.code}`, payload.message)
        },
      })
    } else {
      log('listen=false，仅作为组织方（master）运行，不对外监听')
    }
  } catch (e) {
    err('监听端启动失败', e)
  }

  // ---------- fleet Service ----------
  // 成员状态判定（master 视角）：状态优先级 已退出 > 已拒绝/已暂停 > 认证失败 > 在线 > 离线
  function peerStatus(p) {
    const state = p.state ?? 'active'
    if (state === 'left') return { status: 'left', statusText: '已退出' }
    if (state === 'refused') return { status: 'refused', statusText: '已拒绝' }
    if (state === 'paused') return { status: 'paused', statusText: '已暂停' }
    const m = monitors.get(p.machineId)
    if (m?.state?.fatal) return { status: 'auth-failed', statusText: '认证失败' }
    if (m?.state?.online) {
      return { status: 'online', statusText: '在线', rtt: m.state.rtt, lastPong: m.state.lastPong, memFreeGB: m.state.memFreeGB }
    }
    return { status: 'offline', statusText: '离线' }
  }
  // 成员状态判定（worker 视角）：已退出 > 已拒绝/已暂停 > 连接中 > 离线
  function membershipStatus(m, connected) {
    if (m.state === 'left') return { status: 'left', statusText: '已退出' }
    if (m.state === 'refused') return { status: 'refused', statusText: '已拒绝' }
    if (m.state === 'paused') return { status: 'paused', statusText: '已暂停' }
    if (connected) return { status: 'online', statusText: '连接中' }
    return { status: 'offline', statusText: '离线' }
  }

  const fleet = {
    port,
    home,
    machineId: identity.machineId,
    name: identity.name,
    card: () => buildCard(identity, { port }),
    connections: () => (listener ? [...listener.connections.keys()] : []),
    listTeams: () => listTeams(home).map((t) => {
      const leader = {
        name: identity.name,
        machineId: identity.machineId,
        host: preferredIPv4(),
        port,
        online: true,
        status: 'leader',
        statusText: '本机（队长）',
        rtt: 0,
        lastPong: Date.now(),
        memFreeGB: memFreeGB(),
        state: 'leader',
        isLeader: true,
        cpu: cpuLabel(),
        mem: `${memGB()}GB`,
      }
      return {
        id: t.id,
        name: t.name,
        createdAt: t.createdAt,
        peers: [leader, ...(t.peers || []).map((p) => ({
          name: p.name,
          machineId: p.machineId,
          host: p.host,
          port: p.port,
          online: peerStatus(p).status === 'online',
          status: peerStatus(p).status,
          statusText: peerStatus(p).statusText,
          rtt: peerStatus(p).rtt ?? null,
          lastPong: peerStatus(p).lastPong ?? 0,
          memFreeGB: peerStatus(p).memFreeGB ?? null,
          state: p.state ?? 'active',
          cpu: p.cpu,
          mem: p.mem,
          addedAt: p.addedAt,
        }))],
      }
    }),
    // 我加入了哪些团队（worker 视角，可加入无数个团队/多个 master）
    memberships: () => {
      const connected = new Set(fleet.connections())
      return listMemberships(home).map((m) => {
        const st = membershipStatus(m, connected.has(m.masterId))
        return {
          masterId: m.masterId,
          masterName: m.masterName,
          host: m.host,
          port: m.port,
          teams: m.teams ?? [],
          state: m.state ?? 'active',
          status: st.status,
          statusText: st.statusText,
          lastSeen: m.lastSeen ?? 0,
          joinedAt: m.joinedAt ?? 0,
        }
      })
    },
    // 退出团队：team 缺省退出全部。直接删除成员关系记录，并告知已连接的 master 移除
    leave(masterIdOrName, team) {
      const m = findMembership(masterIdOrName, home)
      if (!m) return { ok: false, message: `未找到成员关系：${masterIdOrName}` }
      const r = team
        ? removeTeamFromMembership(m.masterId, team, home)
        : deleteMembership(m.masterId, home)
      listener?.send(m.masterId, { type: 'leave', team: team || undefined })
      return { ok: true, message: team
        ? (r.deleted ? `已退出 ${m.masterName} 的全部团队` : `已退出 ${m.masterName} 的团队「${team}」`)
        : `已退出 ${m.masterName} 的全部团队` }
    },
    // 拒绝/暂停：本机标记并告知 master（连接保持，恢复可实时同步）
    refuse(masterIdOrName, all) {
      const targets = all
        ? listMemberships(home)
        : [findMembership(masterIdOrName, home)].filter(Boolean)
      if (!targets.length) return { ok: false, message: '没有可拒绝的成员关系' }
      for (const m of targets) {
        setMembershipState(m.masterId, 'refused', home)
        listener?.send(m.masterId, { type: 'refuse' })
      }
      return { ok: true, message: all ? '已拒绝全部 master 的调用' : `已拒绝 ${targets[0].masterName} 的调用` }
    },
    resume(masterIdOrName, all) {
      const targets = all
        ? listMemberships(home)
        : [findMembership(masterIdOrName, home)].filter(Boolean)
      if (!targets.length) return { ok: false, message: '没有可恢复的成员关系' }
      for (const m of targets) {
        setMembershipState(m.masterId, 'active', home)
        listener?.send(m.masterId, { type: 'resume' })
      }
      return { ok: true, message: all ? '已恢复全部 master 的调用' : `已恢复 ${targets[0].masterName} 的调用` }
    },
    createTeam: (name) => { const t = createTeam(name, home); syncMonitors(); return t },
    removeTeam: (idOrName) => { const n = removeTeam(idOrName, home); syncMonitors(); return n },
    ensureTeam: (idOrName) => findTeam(idOrName, home) ?? ensureDefaultTeam(home),
    async add(teamIdOrName, args) {
      let peer = null
      if (args.card) peer = parseCard(args.card)
      else if (args.name && args.host && args.port && args.sk) {
        peer = { name: args.name, host: args.host, port: Number(args.port), sk: args.sk, machineId: null, cpu: '?', mem: '?' }
      }
      if (!peer) throw new Error('参数不足：请提供完整名片，或 name/host/port/sk 四项')
      const probe = await probePeer({ identity, peer })
      if (!probe.ok) throw new Error(`联通失败：${probe.error}`)
      const team = fleet.ensureTeam(teamIdOrName)
      const { added, peer: saved } = addPeerToTeam(team.id, {
        name: peer.name || probe.serverName,
        machineId: probe.serverId,
        host: peer.host,
        port: peer.port,
        sk: peer.sk,
        cpu: peer.cpu,
        mem: peer.mem,
      }, home)
      syncMonitors()
      return {
        team: team.name,
        added,
        message: `${added ? '已加入团队' : '已更新团队信息'}「${team.name}」：${saved.name}@${saved.host}:${saved.port}（握手通过 RTT=${probe.rtt}ms）`,
        peer: { name: saved.name, machineId: saved.machineId, host: saved.host, port: saved.port },
      }
    },
    remove(teamIdOrName, nameOrId) {
      const team = fleet.ensureTeam(teamIdOrName)
      // 先告知 worker 被踢（在线时），再移除名录
      const peer = findPeerAcrossTeams(nameOrId, home)
      if (peer?.machineId) {
        monitors.get(peer.machineId)?.send({ type: 'kicked', team: team.name })
      }
      const n = removePeerFromTeam(team.id, nameOrId, home)
      syncMonitors()
      return { team: team.name, removed: n > 0 }
    },
    async test(args) {
      let peer = null
      if (args.card) peer = parseCard(args.card)
      else if (args.name && args.host && args.port && args.sk) {
        peer = { name: args.name, host: args.host, port: Number(args.port), sk: args.sk, machineId: null, cpu: '?', mem: '?' }
      }
      if (!peer) peer = findPeerAcrossTeams(String(args.name || ''), home)
      if (!peer) throw new Error('找不到目标机：请提供名片、name/host/port/sk，或名录中的名称')
      return probePeer({ identity, peer })
    },
  }
  try {
    ctx.provide('fleet', fleet)
    log('fleet Service 已提供')
  } catch (e) {
    err('ctx.provide(fleet) 失败（不致命）', e)
  }

  // ---------- 工具注册 ----------
  const disposers = []
  try {
    const tools = [
      defineTool({
        name: 'fleet_card',
        description:
          '展示本机（当前 DSH 实例）的机器名片：一行可复制的字符串（machineId|名称|IP:端口|CPU|内存|NAT|永久SK）。' +
          '把名片粘贴到另一台机的组队框，即可把本机加入对方的算力团队。',
        parameters: {},
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              card: { type: 'string', required: true },
              machineId: { type: 'string', required: true },
              name: { type: 'string', required: true },
              port: { type: 'integer', required: true },
            },
          },
          render: (_args, value) => TEXT_OUTPUT(value.card),
        },
        async execute() {
          return { card: fleet.card(), machineId: identity.machineId, name: identity.name, port }
        },
      }),

      defineTool({
        name: 'fleet_teams',
        description:
          '查看本机的所有算力团队：每个团队的名录（名称/machineId/地址/算力）与当前已接入(在线)的机器。',
        parameters: {},
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              teams: {
                type: 'array', required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string', required: true },
                    name: { type: 'string', required: true },
                    createdAt: { type: 'string' },
                    peers: {
                      type: 'array', required: true,
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          name: { type: 'string', required: true },
                          machineId: { type: 'string', required: true },
                          host: { type: 'string', required: true },
                          port: { type: 'integer', required: true },
                          online: { type: 'boolean', required: true },
                          status: { type: 'string' },
                          statusText: { type: 'string' },
                          rtt: { type: 'integer' },
                          lastPong: { type: 'integer' },
                          memFreeGB: { type: 'number' },
                          state: { type: 'string' },
                          isLeader: { type: 'boolean' },
                          cpu: { type: 'string' },
                          mem: { type: 'string' },
                          addedAt: { type: 'string' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          render: (_args, value) => {
            const lines = value.teams.flatMap((t) => [
              `【${t.name}】`,
              ...(t.peers.length
                ? t.peers.map((p) => `  ${p.online ? '●' : '○'} ${p.name}  ${p.host}:${p.port}  算力:${p.cpu ?? '?'}  内存:${p.mem ?? '?'}`)
                : ['  （空）']),
            ])
            return TEXT_OUTPUT(lines.length ? lines.join('\n') : '还没有团队：用 fleet_team_create 创建')
          },
        },
        async execute() {
          return { teams: fleet.listTeams() }
        },
      }),

      defineTool({
        name: 'fleet_team_create',
        description: '创建一个新的算力团队（每个团队是独立的机器名录，可分别组队）。',
        parameters: {
          name: { type: 'string', required: true, description: '团队名称' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              message: { type: 'string', required: true },
              team: {
                oneOf: [
                  {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      id: { type: 'string', required: true },
                      name: { type: 'string', required: true },
                    },
                  },
                  { type: 'null' },
                ],
              },
            },
          },
          render: (_args, value) => TEXT_OUTPUT(value.message),
        },
        async execute(args) {
          try {
            const team = fleet.createTeam(args.name)
            return { ok: true, message: `已创建团队：${team.name}`, team: { id: team.id, name: team.name } }
          } catch (e) {
            return { ok: false, message: String(e.message || e), team: null }
          }
        },
      }),

      defineTool({
        name: 'fleet_team_delete',
        description: '删除一个算力团队（连同其机器名录）。',
        parameters: {
          nameOrId: { type: 'string', required: true, description: '团队名称或 id' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              message: { type: 'string', required: true },
            },
          },
          render: (_args, value) => TEXT_OUTPUT(value.message),
        },
        async execute(args) {
          const n = fleet.removeTeam(args.nameOrId)
          return { ok: n > 0, message: n > 0 ? `已删除团队：${args.nameOrId}` : `未找到团队：${args.nameOrId}` }
        },
      }),

      defineTool({
        name: 'fleet_add',
        description:
          '把一台机器加入指定算力团队：粘贴对方的完整名片字符串，或用 name/host/port/sk 四项。' +
          '自动执行联通性测试 + SK 挑战握手，成功后写入该团队名录。team 缺省用第一个团队。',
        parameters: {
          team: { type: 'string', description: '团队名称或 id（缺省用第一个团队）' },
          card: { type: 'string', description: '对方机器名片（dsh-fleet:// 开头的一行字符串）' },
          name: { type: 'string', description: '机器名称（与 card 二选一）' },
          host: { type: 'string', description: 'IP 或主机名（与 card 二选一）' },
          port: { type: 'integer', description: '监听端口（与 card 二选一）' },
          sk: { type: 'string', description: '对方永久 SK，64 位 hex（与 card 二选一）' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              message: { type: 'string', required: true },
              peer: {
                oneOf: [
                  {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      name: { type: 'string', required: true },
                      machineId: { type: 'string', required: true },
                      host: { type: 'string', required: true },
                      port: { type: 'integer', required: true },
                    },
                  },
                  { type: 'null' },
                ],
              },
            },
          },
          render: (_args, value) => TEXT_OUTPUT(value.message),
        },
        async execute(args) {
          try {
            const r = await fleet.add(args.team, args)
            return { ok: true, message: r.message, peer: r.peer }
          } catch (e) {
            return { ok: false, message: String(e.message || e), peer: null }
          }
        },
      }),

      defineTool({
        name: 'fleet_remove',
        description: '把一台机器移出指定算力团队（按名称或 machineId）。team 缺省用第一个团队。',
        parameters: {
          team: { type: 'string', description: '团队名称或 id（缺省用第一个团队）' },
          nameOrId: { type: 'string', required: true, description: '团队成员的名称或 machineId' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              message: { type: 'string', required: true },
            },
          },
          render: (_args, value) => TEXT_OUTPUT(value.message),
        },
        async execute(args) {
          const r = fleet.remove(args.team, args.nameOrId)
          return { ok: r.removed, message: r.removed ? `已从「${r.team}」移除：${args.nameOrId}` : `未找到：${args.nameOrId}` }
        },
      }),

      defineTool({
        name: 'fleet_test',
        description:
          '联通性测试：连接目标机并完成 SK 挑战握手，验证可达性与信任关系。' +
          '接受完整名片、name/host/port/sk 四项、或任意团队名录中的名称。',
        parameters: {
          card: { type: 'string', description: '对方机器名片' },
          name: { type: 'string', description: '机器名称（与 card 二选一；也可以是名录中的名称）' },
          host: { type: 'string', description: 'IP 或主机名（与 card 二选一）' },
          port: { type: 'integer', description: '监听端口（与 card 二选一）' },
          sk: { type: 'string', description: '对方永久 SK（与 card 二选一）' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              message: { type: 'string', required: true },
              rtt: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
              serverId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            },
          },
          render: (_args, value) => TEXT_OUTPUT(value.message),
        },
        async execute(args) {
          try {
            const probe = await fleet.test(args)
            return {
              ok: probe.ok,
              message: probe.ok
                ? `✓ 可达：${probe.serverName}(${probe.serverId}) RTT=${probe.rtt}ms，握手通过`
                : `✗ 不可达：${probe.error}`,
              rtt: probe.ok ? probe.rtt : null,
              serverId: probe.ok ? probe.serverId : null,
            }
          } catch (e) {
            return { ok: false, message: String(e.message || e), rtt: null, serverId: null }
          }
        },
      }),

      defineTool({
        name: 'fleet_memberships',
        description:
          '查看本机加入了哪些团队（被哪些 master 调用）：master 名称/machineId/团队列表/状态（连接中/离线/已拒绝/已退出）。' +
          '一台机可同时加入无数个团队。',
        parameters: {},
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              memberships: {
                type: 'array', required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    masterId: { type: 'string', required: true },
                    masterName: { type: 'string', required: true },
                    host: { type: 'string' },
                    port: { type: 'integer' },
                    teams: { type: 'array', required: true, items: { type: 'string' } },
                    state: { type: 'string' },
                    status: { type: 'string', required: true },
                    statusText: { type: 'string', required: true },
                    lastSeen: { type: 'integer' },
                    joinedAt: { type: 'integer' },
                  },
                },
              },
            },
          },
          render: (_args, value) => {
            const lines = value.memberships.map((m) =>
              `[${m.statusText}] ${m.masterName}  团队=[${(m.teams || []).join(', ') || '无'}]  最后联系:${m.lastSeen ? new Date(m.lastSeen).toLocaleTimeString('zh-CN', { hour12: false }) : '-'}`
            )
            return TEXT_OUTPUT(lines.length ? lines.join('\n') : '还没有被任何团队收录（等待 master 用你的名片加入）')
          },
        },
        async execute() {
          return { memberships: fleet.memberships() }
        },
      }),

      defineTool({
        name: 'fleet_leave',
        description:
          '退出团队：本机主动退出某个 master 的团队（team 缺省退出该 master 的全部团队），' +
          'master 侧会同步从名录移除并停止监控。',
        parameters: {
          master: { type: 'string', required: true, description: 'master 的名称或 machineId（见 fleet_memberships）' },
          team: { type: 'string', description: '要退出的团队名（缺省退出全部）' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              message: { type: 'string', required: true },
            },
          },
          render: (_args, value) => TEXT_OUTPUT(value.message),
        },
        async execute(args) {
          const r = fleet.leave(args.master, args.team)
          return { ok: r.ok, message: r.message }
        },
      }),

      defineTool({
        name: 'fleet_refuse',
        description:
          '拒绝调用（DND）：暂停被指定 master（或全部）调用本机。本机标记为已拒绝并告知 master，' +
          'master 侧名录同步显示「已拒绝」。用 fleet_resume 恢复。',
        parameters: {
          master: { type: 'string', description: 'master 的名称或 machineId（缺省全部）' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              message: { type: 'string', required: true },
            },
          },
          render: (_args, value) => TEXT_OUTPUT(value.message),
        },
        async execute(args) {
          const r = fleet.refuse(args.master, !args.master)
          return { ok: r.ok, message: r.message }
        },
      }),

      defineTool({
        name: 'fleet_resume',
        description:
          '恢复调用：取消对指定 master（或全部）的拒绝状态，重新接受其调用。',
        parameters: {
          master: { type: 'string', description: 'master 的名称或 machineId（缺省全部）' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              message: { type: 'string', required: true },
            },
          },
          render: (_args, value) => TEXT_OUTPUT(value.message),
        },
        async execute(args) {
          const r = fleet.resume(args.master, !args.master)
          return { ok: r.ok, message: r.message }
        },
      }),

      defineTool({
        name: 'fleet_dispatch',
        description:
          '把任务下发给团队中某台在线机器执行：worker 会新建工作区、新建同主题会话并跑一个 agent 任务，' +
          '完成后把最终回答回传到当前会话（结果落队长行）。taskToken 自动签发（HMAC 验签防伪造）。' +
          '测试时请用最简单的 prompt 以节省 token。',
        parameters: {
          team: { type: 'string', description: '团队名称或 id（缺省第一个团队）' },
          member: { type: 'string', description: '团队成员名称（缺省选第一个在线成员）' },
          prompt: { type: 'string', required: true, description: '任务 prompt（越简单越省 token）' },
          preset: { type: 'string', description: 'worker 上使用的 agent preset 名（缺省 worker 默认）' },
          workspace: { type: 'string', description: 'worker 上的工作区路径（缺省自动生成）' },
          provider: { type: 'string', description: '模型 provider（缺省取本机当前选择）' },
          model: { type: 'string', description: '模型名（缺省取本机当前选择）' },
          keyHint: { type: 'string', enum: ['self', 'inherit'], description: 'self=worker 用自己的 key；inherit=总机下发自己的 key（默认 inherit）' },
          timeoutMs: { type: 'integer', description: '等待超时毫秒（默认 120000）' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              message: { type: 'string' },
              taskId: { type: 'string' },
              member: { type: 'string' },
              answer: { type: 'string' },
              workspace: { type: 'string' },
              sessionId: { type: 'string' },
              logs: { type: 'array', items: { type: 'string' } },
            },
          },
          render: (_args, value) => TEXT_OUTPUT(
            value.ok
              ? `【舰队任务完成】\n成员: ${value.member}\n任务: ${value.taskId}\n工作区: ${value.workspace}\n会话: ${value.sessionId}\n\n回答:\n${value.answer}\n\n日志:\n- ${(value.logs || []).join('\n- ') || '（无）'}`
              : `✗ 任务失败：${value.message}`
          ),
        },
        async execute(args) {
          try {
            const team = fleet.ensureTeam(args.team)
            const peers = (team.peers || []).filter((p) => p.state !== 'refused' && p.state !== 'paused' && p.state !== 'left')
            let target = null
            if (args.member) target = peers.find((p) => p.name === args.member)
            if (!target) target = peers.find((p) => monitors.get(p.machineId)?.state?.online) || peers[0]
            if (!target) throw new Error(`团队「${team.name}」没有可用成员（全部离线或已拒绝）`)
            const mon = monitors.get(target.machineId)
            if (!mon?.state?.online) throw new Error(`成员 ${target.name} 不在线`)

            const taskId = crypto.randomUUID()
            const token = hmac(target.sk, taskId)

            // key：inherit 时取本机自己的 key 下发（worker 无 key 用总机）
            let apiKey
            if (args.keyHint !== 'self') {
              const creds = ctx.get('credentials')
              if (creds) {
                try {
                  const cred = await creds.resolve('DEEPSEEK_API_KEY')
                  if (cred && typeof cred.value === 'string') apiKey = cred.value
                } catch { /* 无 key 则走 worker 自带 */ }
              }
            }

            // provider/model 缺省用本机当前选择
            let provider = args.provider
            let model = args.model
            if (!provider || !model) {
              try {
                const sel = ctx.get('agentDefaultModel')?.currentSelection?.()
                if (sel?.provider && sel?.model) {
                  provider = provider || sel.provider
                  model = model || sel.model
                }
              } catch { /* 保留显式参数 */ }
            }

            const timeoutMs = Number(args.timeoutMs) > 0 ? Number(args.timeoutMs) : 120000
            const result = await new Promise((resolve, reject) => {
              const timer = setTimeout(() => {
                pendingTasks.delete(taskId)
                reject(new Error(`任务超时（${timeoutMs}ms），worker 可能仍在执行`))
              }, timeoutMs)
              pendingTasks.set(taskId, { resolve, reject, timer, logs: [] })
              const sent = mon.send({
                type: 'submit_task',
                taskId,
                token,
                workspace: args.workspace,
                title: `fleet-${taskId.slice(0, 8)}`,
                preset: args.preset,
                prompt: args.prompt,
                provider,
                model,
                apiKey,
              })
              if (!sent) {
                clearTimeout(timer)
                pendingTasks.delete(taskId)
                reject(new Error('发送失败（连接已断开）'))
              }
            })
            return { ok: true, taskId, member: target.name, ...result }
          } catch (e) {
            return { ok: false, message: String(e.message || e) }
          }
        },
      }),
    ]
    for (const tool of tools) disposers.push(ctx.tools.register(tool))
    log(`已注册 ${tools.length} 个工具`)
  } catch (e) {
    err('工具注册失败', e)
  }

  // ---------- /fleet/api/* 路由（Fleet 面板用；仅回环地址可访问） ----------
  try {
    const api = {
      card: '/fleet/api/card',
      teams: '/fleet/api/teams',
      peers: '/fleet/api/teams/peers',
      test: '/fleet/api/test',
      memberships: '/fleet/api/memberships',
      leave: '/fleet/api/memberships/leave',
      refuse: '/fleet/api/memberships/refuse',
      resume: '/fleet/api/memberships/resume',
    }
    const routes = [
      {
        kind: 'exact',
        path: api.card,
        handler: async (req, res) => {
          if (!isLoopback(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
          if ((req.method ?? 'GET') !== 'GET') return writeJson(res, 405, { error: 'method not allowed' })
          writeJson(res, 200, { card: fleet.card(), machineId: identity.machineId, name: identity.name, port })
        },
      },
      {
        kind: 'exact',
        path: api.teams,
        handler: async (req, res) => {
          if (!isLoopback(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
          const method = req.method ?? 'GET'
          if (method === 'GET') {
            return writeJson(res, 200, { teams: fleet.listTeams() })
          }
          if (method === 'POST') {
            const body = await readJsonBody(req)
            if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
            try {
              const team = fleet.createTeam(body.name)
              return writeJson(res, 201, { team })
            } catch (e) {
              return writeJson(res, 400, { error: e instanceof Error ? e.message : String(e) })
            }
          }
          if (method === 'DELETE') {
            const url = new URL(req.url ?? '/', 'http://localhost')
            const name = queryParam(url, 'name')
            if (!name) return writeJson(res, 400, { error: 'name query parameter is required' })
            const n = fleet.removeTeam(name)
            return writeJson(res, 200, { ok: n > 0 })
          }
          return writeJson(res, 405, { error: `method not allowed: ${method}` })
        },
      },
      {
        kind: 'exact',
        path: api.peers,
        handler: async (req, res) => {
          if (!isLoopback(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
          const method = req.method ?? 'GET'
          if (method === 'POST') {
            const body = await readJsonBody(req)
            if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
            try {
              const r = await fleet.add(body.team, body)
              return writeJson(res, 201, { ok: true, message: r.message, peer: r.peer })
            } catch (e) {
              return writeJson(res, 400, { error: e instanceof Error ? e.message : String(e) })
            }
          }
          if (method === 'DELETE') {
            const url = new URL(req.url ?? '/', 'http://localhost')
            const team = queryParam(url, 'team') ?? 'default'
            const name = queryParam(url, 'name')
            if (!name) return writeJson(res, 400, { error: 'name query parameter is required' })
            const r = fleet.remove(team, name)
            return writeJson(res, 200, { ok: r.removed })
          }
          return writeJson(res, 405, { error: `method not allowed: ${method}` })
        },
      },
      {
        kind: 'exact',
        path: api.test,
        handler: async (req, res) => {
          if (!isLoopback(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
          if ((req.method ?? 'GET') !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
          const body = await readJsonBody(req)
          if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
          try {
            const probe = await fleet.test(body)
            return writeJson(res, 200, { ok: probe.ok, message: probe.ok ? `✓ 可达 RTT=${probe.rtt}ms` : `✗ ${probe.error}`, rtt: probe.ok ? probe.rtt : null })
          } catch (e) {
            return writeJson(res, 400, { error: e instanceof Error ? e.message : String(e) })
          }
        },
      },
      {
        kind: 'exact',
        path: api.memberships,
        handler: async (req, res) => {
          if (!isLoopback(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
          if ((req.method ?? 'GET') !== 'GET') return writeJson(res, 405, { error: 'method not allowed' })
          writeJson(res, 200, { memberships: fleet.memberships() })
        },
      },
      {
        kind: 'exact',
        path: api.leave,
        handler: async (req, res) => {
          if (!isLoopback(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
          if ((req.method ?? 'GET') !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
          const body = await readJsonBody(req)
          if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
          const r = fleet.leave(String(body.master || ''), body.team)
          return writeJson(res, r.ok ? 200 : 404, { ok: r.ok, message: r.message })
        },
      },
      {
        kind: 'exact',
        path: api.refuse,
        handler: async (req, res) => {
          if (!isLoopback(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
          if ((req.method ?? 'GET') !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
          const body = await readJsonBody(req)
          if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
          const r = fleet.refuse(body.master, !body.master)
          return writeJson(res, r.ok ? 200 : 404, { ok: r.ok, message: r.message })
        },
      },
      {
        kind: 'exact',
        path: api.resume,
        handler: async (req, res) => {
          if (!isLoopback(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
          if ((req.method ?? 'GET') !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
          const body = await readJsonBody(req)
          if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
          const r = fleet.resume(body.master, !body.master)
          return writeJson(res, r.ok ? 200 : 404, { ok: r.ok, message: r.message })
        },
      },
    ]
    for (const route of routes) disposers.push(ctx.webServer.register(route))
    log('已注册 /fleet/api/* 路由')
  } catch (e) {
    err('路由注册失败', e)
  }

  // 启动时同步一次出站监控（已有团队成员则保持长连接）
  syncMonitors()
  log(`出站监控就绪（${monitors.size} 个成员）`)

  return async () => {
    for (const [, pend] of [...pendingTasks]) {
      clearTimeout(pend.timer)
      pend.reject(new Error('插件停止，任务取消'))
    }
    pendingTasks.clear()
    for (const dispose of disposers) {
      try { if (typeof dispose === 'function') dispose() } catch { /* noop */ }
    }
    try { listener?.stop() } catch { /* noop */ }
    stopMonitors()
    log('已停止')
  }
}

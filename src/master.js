// 命令实现：init / card / worker / add / remove / list / test / watch
import { loadOrCreateIdentity } from './identity.js'
import { buildCard, parseCard } from './card.js'
import { ensureDefaultTeam, addPeerToTeam, removePeerFromTeam, findPeerAcrossTeams, listTeams } from './teams.js'
import { probePeer, connectPeer } from './peer.js'
import { startListener } from './listener.js'
import { localIPv4s } from './network.js'

function identityOrExit() {
  try {
    return loadOrCreateIdentity()
  } catch (e) {
    console.error(`无法初始化身份：${e.message}`)
    process.exit(1)
  }
}

export function cmdInit({ port }) {
  const id = identityOrExit()
  console.log(`机器身份已就绪`)
  console.log(`  machineId : ${id.machineId}`)
  console.log(`  名称      : ${id.name}`)
  console.log(`  SK        : ${id.sk}`)
  console.log(`  监听端口  : ${port}（运行 "dsh-fleet worker --port ${port}" 开始监听）`)
  console.log('')
  console.log('机器名片（复制后粘贴到组建机的添加框）：')
  console.log(buildCard(id, { port }))
}

export function cmdCard({ port }) {
  const id = identityOrExit()
  console.log(buildCard(id, { port }))
}

export function cmdWorker({ port }) {
  const id = identityOrExit()
  startListener({
    identity: id,
    port,
    onEvent: (evt, payload) => {
      if (evt === 'listening') {
        console.log(`[监听中] ${id.name}(${id.machineId.slice(0, 8)}…) 端口 ${payload.port}，本机 IP：${localIPv4s().join(', ')}`)
        console.log(`[名片] ${buildCard(id, { port })}`)
      } else if (evt === 'peer-connected') {
        console.log(`[接入] ${payload.name}(${payload.machineId.slice(0, 8)}…) 通过验证`)
      } else if (evt === 'peer-disconnected') {
        console.log(`[断开] ${payload.name}(${payload.machineId.slice(0, 8)}…)`)
      } else if (evt === 'auth-failed') {
        console.log(`[拒绝] ${payload.fromName}(${payload.fromMachineId?.slice(0, 8)}…) 认证失败（SK 错误）`)
      }
    },
  })
}

function resolvePeerArg(arg) {
  if (String(arg).includes('dsh-fleet://')) {
    return parseCard(arg)
  }
  return null
}

export async function cmdAdd({ args }) {
  const id = identityOrExit()
  let peer
  try {
    peer = resolvePeerArg(args[0]) || null
    if (!peer) {
      const [name, host, port, sk] = args
      if (!name || !host || !port || !sk) throw new Error('用法：dsh-fleet add "<名片>" 或 dsh-fleet add <名称> <host> <port> <sk>')
      if (!/^[0-9a-f]{64}$/.test(sk)) throw new Error('SK 不是 64 位 hex')
      peer = { name, host, port: Number(port), sk, machineId: null, cpu: '?', mem: '?' }
    }
  } catch (e) {
    console.error(`参数错误：${e.message}`)
    process.exit(1)
  }
  console.log(`正在测试联通性：${peer.name || peer.machineId} @ ${peer.host}:${peer.port} …`)
  const probe = await probePeer({ identity: id, peer })
  if (!probe.ok) {
    console.error(`✗ 联通失败：${probe.error}`)
    process.exit(1)
  }
  console.log(`✓ 联通成功：${probe.serverName}(${probe.serverId})  RTT ${probe.rtt}ms  握手通过（SK 验证 OK）`)
  const { added, peer: saved } = addPeerToTeam(ensureDefaultTeam().id, {
    name: peer.name || probe.serverName,
    machineId: probe.serverId,
    host: peer.host,
    port: peer.port,
    sk: peer.sk,
    cpu: peer.cpu,
    mem: peer.mem,
  })
  console.log(added ? `已加入团队：${saved.name}（${saved.host}:${saved.port}）` : `已更新团队信息：${saved.name}`)
}

export async function cmdTest({ args }) {
  const id = identityOrExit()
  const arg = args[0]
  if (!arg) {
    console.error('用法：dsh-fleet test "<名片>" 或 dsh-fleet test <名录中的名称>')
    process.exit(1)
  }
  let peer
  try {
    peer = resolvePeerArg(arg) || findPeerAcrossTeams(arg)
    if (!peer) throw new Error(`找不到对等机：${arg}（不在名录中，也不是合法名片）`)
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }
  const probe = await probePeer({ identity: id, peer })
  if (probe.ok) {
    console.log(`✓ ${peer.name}(${probe.serverId}) 可达  RTT ${probe.rtt}ms  握手通过`)
  } else {
    console.log(`✗ ${peer.name} 不可达：${probe.error}`)
    process.exit(1)
  }
}

export function cmdRemove({ args }) {
  const name = args[0]
  if (!name) {
    console.error('用法：dsh-fleet remove <名称|machineId>')
    process.exit(1)
  }
  const n = removePeerFromTeam(ensureDefaultTeam().id, name)
  if (n === 0) {
    console.log(`未找到：${name}`)
  } else {
    console.log(`已从团队移除：${name}`)
  }
}

export function cmdList() {
  const teams = listTeams()
  const peers = teams.flatMap((t) => t.peers || [])
  if (!peers.length) {
    console.log('团队为空。用 "dsh-fleet add <名片>" 添加第一台机器。')
    return
  }
  for (const t of teams) {
    if (!(t.peers || []).length) continue
    console.log(`【${t.name}】`)
    for (const p of t.peers) {
      console.log(`  ${p.name.padEnd(16)} ${p.host}:${p.port}  算力:${p.cpu || '?'}  内存:${p.mem || '?'}  加入:${(p.addedAt || '').slice(0, 10)}`)
    }
  }
}

export function cmdWatch({ duration }) {
  const id = identityOrExit()
  const peers = listTeams().flatMap((t) => t.peers || [])
  if (!peers.length) {
    console.log('团队为空。先 "dsh-fleet add <名片>"。')
    process.exit(1)
  }
  const deadline = Date.now() + duration * 1000
  const connections = peers.map((peer) => {
    let last = null
    return connectPeer({
      identity: id,
      peer,
      log: (m) => console.log(m),
      onStatus: (s, p) => {
        if (s.online && s.memFreeGB !== null) {
          console.log(`[${ts()}] ${p.name} 在线  RTT=${s.rtt ?? '-'}ms  内存空闲=${s.memFreeGB}GB`)
        } else if (last === null || last.online === true) {
          console.log(`[${ts()}] ${p.name} 离线（自动重连中…）`)
        }
        last = { online: s.online }
      },
    })
  })
  console.log(`开始监控团队（${duration}s，Ctrl+C 退出）…`)
  const t = setInterval(() => {
    if (Date.now() >= deadline) {
      clearInterval(t)
      for (const c of connections) c.stop()
      console.log('监控结束')
      process.exit(0)
    }
  }, 200)
}

function ts() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false })
}

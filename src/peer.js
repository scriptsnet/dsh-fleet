// 连接端（调用方/master 角色）：主动连向对等机，完成挑战握手 + 心跳 + 断线自动重连。
import net from 'node:net'
import { encode, hmac, makeLineParser } from './protocol.js'

const DEFAULT_HEARTBEAT_MS = 5000
const DEFAULT_RECONNECT_MS = 3000

// 一次性联通性探测（add/test 命令用）：连接 → 握手 → 测 RTT → 断开。
export function probePeer({ identity, peer, timeoutMs = 5000 }) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: peer.host, port: peer.port })
    const t0 = Date.now()
    let settled = false
    const done = (r) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sock.destroy()
      resolve(r)
    }
    const timer = setTimeout(() => done({ ok: false, error: 'timeout' }), timeoutMs)
    sock.on('data', makeLineParser((msg) => {
      if (msg.type === 'challenge') {
        if (peer.machineId && msg.machineId !== peer.machineId) {
          done({ ok: false, error: `machineId 不匹配(期望 ${peer.machineId}，实际 ${msg.machineId})` })
          return
        }
        const rtt = Date.now() - t0
        sock.write(encode({ type: 'auth', machineId: identity.machineId, name: identity.name, proof: hmac(peer.sk, msg.nonce) }))
        void rtt
      } else if (msg.type === 'welcome') {
        done({ ok: true, rtt: Date.now() - t0, serverId: msg.machineId, serverName: msg.name })
      } else if (msg.type === 'error') {
        done({ ok: false, error: `auth_failed:${msg.code}` })
      }
    }))
    sock.on('error', (e) => done({ ok: false, error: e.code || 'error' }))
    sock.on('close', () => done({ ok: false, error: 'closed' }))
  })
}

// 长连接：握手 + 周期心跳 + 断线自动重连（固定退避）。
// 握手成功后发 hello（声明对方在我哪些团队里，供对方登记成员关系）；
// 接收 worker 的控制消息（leave/refuse/paused/resume），经 onControl 回调处理；
// 任务消息（submit_task 由 send 发送；task_log/task_result/task_failed 经 onTaskMessage 回调）。
export function connectPeer({ identity, peer, onStatus, onControl, onTaskMessage, helloTeams = [], log = () => {}, heartbeatMs = DEFAULT_HEARTBEAT_MS, reconnectMs = DEFAULT_RECONNECT_MS }) {
  let sock = null
  let timer = null
  let stopped = false
  let fatal = false
  let helloSent = false
  const state = { online: false, rtt: null, lastPong: 0, memFreeGB: null, fatal: false }

  const report = () => onStatus({ ...state }, peer)

  function teardown() {
    if (sock) {
      sock.removeAllListeners()
      sock.destroy()
      sock = null
    }
  }

  function connect() {
    if (stopped || fatal) return
    sock = net.connect({ host: peer.host, port: peer.port })
    const t0 = Date.now()
    sock.on('data', makeLineParser((msg) => {
      if (msg.type === 'challenge') {
        if (peer.machineId && msg.machineId !== peer.machineId) {
          log(`[${peer.name}] 警告：远端 machineId 与名录不符（期望 ${peer.machineId}，实际 ${msg.machineId}），可能连错机器`)
        }
        state.rtt = Date.now() - t0
        sock.write(encode({ type: 'auth', machineId: identity.machineId, name: identity.name, proof: hmac(peer.sk, msg.nonce) }))
      } else if (msg.type === 'welcome') {
        state.online = true
        state.lastPong = Date.now()
        report()
        if (!helloSent) {
          helloSent = true
          sock.write(encode({ type: 'hello', machineId: identity.machineId, name: identity.name, teams: helloTeams }))
        }
        sock.write(encode({ type: 'ping', ts: Date.now() }))
      } else if (msg.type === 'pong') {
        state.online = true
        state.lastPong = Date.now()
        state.memFreeGB = msg.stats?.memFreeGB ?? null
        report()
      } else if (msg.type === 'leave' || msg.type === 'refuse' || msg.type === 'paused' || msg.type === 'resume' || msg.type === 'state') {
        onControl?.(msg, peer)
      } else if (msg.type === 'task_log' || msg.type === 'task_result' || msg.type === 'task_failed') {
        onTaskMessage?.(msg, peer)
      } else if (msg.type === 'error') {
        if (msg.code === 'AUTH_FAILED') {
          fatal = true
          state.fatal = true
          log(`[${peer.name}] 认证失败（SK 不匹配或已更换），停止重连`)
          clearInterval(timer)
          state.online = false
          report()
          sock.end()
        }
      }
    }))
    sock.on('error', () => {
      // 错误后由 close 统一收尾
    })
    sock.on('close', () => {
      const was = state.online
      state.online = false
      state.rtt = null
      if (was) report()
      teardown()
      if (!stopped && !fatal) setTimeout(connect, reconnectMs)
    })
  }

  report() // 先上报一次初始离线状态，便于监控端第一时间展示
  connect()
  timer = setInterval(() => {
    if (sock && state.online) sock.write(encode({ type: 'ping', ts: Date.now() }))
  }, heartbeatMs)

  return {
    stop() {
      stopped = true
      clearInterval(timer)
      teardown()
    },
    // 向对端发控制消息（在线时有效）
    send(msg) {
      if (sock && state.online) {
        sock.write(encode(msg))
        return true
      }
      return false
    },
    state,
  }
}

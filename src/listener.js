// 监听端（被调用方/worker 角色）：每台机器安装后都监听一个端口。
// 握手流程：
//   server → challenge { nonce, machineId, name }        （服务器自证身份 + 发挑战）
//   client → auth     { machineId, name, proof }          （proof = HMAC(服务器SK, nonce)）
//   server → welcome / error(AUTH_FAILED)                 （服务器用自己 SK 验签，SK 永不出本机）
// 之后周期 ping/pong 心跳。
// 成员关系：master 认证后发 hello { machineId, name, teams }，worker 据此登记成员关系。
// worker 控制消息经 send(machineId, msg) 发给已连接的 master（leave/refuse/resume）。
import net from 'node:net'
import crypto from 'node:crypto'
import { encode, hmac, makeLineParser } from './protocol.js'
import { memFreeGB } from './network.js'

export function startListener({ identity, port, onEvent, onHello, onKicked, onTask }) {
  const connections = new Map() // machineId -> peer session

  const server = net.createServer((sock) => {
    const session = { machineId: null, name: null, authed: false, nonce: null, sock }
    sock.on('data', makeLineParser((msg) => handle(session, msg)))
    sock.on('error', () => {})
    sock.on('close', () => {
      if (session.authed && session.machineId) {
        connections.delete(session.machineId)
        onEvent?.('peer-disconnected', { machineId: session.machineId, name: session.name })
      }
    })

    // 服务器先发挑战
    session.nonce = crypto.randomBytes(16).toString('hex')
    sock.write(encode({ type: 'challenge', nonce: session.nonce, machineId: identity.machineId, name: identity.name }))
  })

  function handle(s, msg) {
    if (msg.type === 'auth') {
      if (s.authed) return
      const expected = hmac(identity.sk, s.nonce)
      if (msg.proof !== expected) {
        s.sock.write(encode({ type: 'error', code: 'AUTH_FAILED' }))
        s.sock.end()
        onEvent?.('auth-failed', { fromMachineId: msg.machineId, fromName: msg.name || '?' })
        return
      }
      s.authed = true
      s.machineId = msg.machineId
      s.name = msg.name || '?'
      connections.set(s.machineId, s)
      s.sock.write(encode({ type: 'welcome', machineId: identity.machineId, name: identity.name }))
      onEvent?.('peer-connected', { machineId: s.machineId, name: s.name })
    } else if (msg.type === 'hello' && s.authed) {
      // master 声明本机在其哪些团队里 → 登记成员关系；若本机对该 master 处于非活跃状态，回告
      s.name = msg.name || s.name
      const workerState = onHello?.({
        masterId: msg.machineId || s.machineId,
        masterName: msg.name || s.name,
        host: s.sock.remoteAddress,
        port: s.sock.remotePort,
        teams: Array.isArray(msg.teams) ? msg.teams : [],
      })
      if (workerState && workerState !== 'active') {
        s.sock.write(encode({ type: 'state', state: workerState }))
      }
      onEvent?.('peer-hello', { machineId: s.machineId, name: s.name, teams: msg.teams })
    } else if (msg.type === 'kicked' && s.authed) {
      // master 把我移出团队 → 删除对应成员关系
      onKicked?.({ masterId: msg.machineId || s.machineId, team: msg.team })
      onEvent?.('peer-kicked', { machineId: s.machineId, name: s.name, team: msg.team })
    } else if (msg.type === 'submit_task' && s.authed) {
      // master 下发任务 → 交给 worker 执行器（异步执行，不阻塞解析）
      onTask?.(msg, (reply) => s.sock.write(encode(reply)))
      onEvent?.('task-submitted', { taskId: msg.taskId, from: s.name })
    } else if (msg.type === 'ping' && s.authed) {
      s.sock.write(encode({ type: 'pong', ts: Date.now(), stats: { memFreeGB: memFreeGB() } }))
    }
    // 其他报文类型在后续里程碑扩展
  }

  server.listen(port, () => {
    onEvent?.('listening', { port, machineId: identity.machineId, name: identity.name })
  })
  server.on('error', (e) => {
    onEvent?.('error', { code: e.code || 'error', message: e.message })
  })

  return {
    server,
    stop() {
      server.close()
    },
    connections,
    // 向指定已连接 master 发控制消息
    send(machineId, msg) {
      const s = connections.get(machineId)
      if (s && s.authed) {
        s.sock.write(encode(msg))
        return true
      }
      return false
    },
  }
}

// 双实例端到端测试：master(A) + worker(B)。
// 覆盖：A 建团队并加入 B（真实跨实例握手）→ B 登记成员关系 → A 监控在线 →
//      B 拒绝 → A 显示已拒绝 → B 恢复 → A 显示在线 → B 退出 → A 名录移除。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../src/plugin.js'
import { loadOrCreateIdentity } from '../src/identity.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeInstance(label, port, home) {
  let captured = null
  const registered = []
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: (...a) => console.error(`[err:${label}]`, ...a) },
    tools: { register: (t) => { registered.push(t); return () => {} } },
    webServer: { register: () => () => {} },
    provide: (n, v) => { if (n === 'fleet') captured = v; return () => {} },
    // worker 任务执行器依赖的可选服务桩（干跑验证协议/验签/会话创建链路，不烧 token）
    get: (name) => {
      if (name === 'workspaceRegistry') return { create: async (p, t) => ({ id: 'ws-stub', path: p, title: t }) }
      if (name === 'credentials') return { set: async () => {}, resolve: async () => ({ value: 'master-key' }) }
      if (name === 'agents') return {
        create: async (opts) => ({
          agent: { followup: () => {}, whenIdle: async () => {}, session: { events: [] } },
          dispose: async () => {},
        }),
      }
      if (name === 'sessionQuery') return {
        readSurface: async () => ({
          events: [
            { type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: 'x' }] } } },
            { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '你好，来自子机会话' }] } } },
          ],
        }),
      }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }) }
      return undefined
    },
  }
  return { label, ctx, registered, get fleet() { return captured } }
}

const homeA = path.join(os.tmpdir(), 'dsh-fleet-e2e-A-' + Date.now())
const homeB = path.join(os.tmpdir(), 'dsh-fleet-e2e-B-' + Date.now())
fs.mkdirSync(homeA, { recursive: true })
fs.mkdirSync(homeB, { recursive: true })

const A = makeInstance('A', 48001, homeA)
const B = makeInstance('B', 48002, homeB)
const disposeA = await apply(A.ctx, { port: 48001, home: homeA })
const disposeB = await apply(B.ctx, { port: 48002, home: homeB })
await sleep(800)

console.log('=== 1. A 建团队，加入 B（真实跨实例握手）===')
const team = A.fleet.createTeam('测试队')
const idB = loadOrCreateIdentity(homeB)
const cardB = B.fleet.card()
console.log('B card:', cardB.split('|').slice(0, 4).join('|') + '|…')
const addR = await A.fleet.add(team.name, { card: cardB })
console.log('add:', addR.message)
await sleep(1500)

console.log('=== 2. B 的成员关系（应出现 A + 测试队 + 连接中）===')
console.log('B memberships:', JSON.stringify(B.fleet.memberships().map((m) => ({ master: m.masterName, teams: m.teams, status: m.status, statusText: m.statusText }))))

console.log('=== 3. A 侧状态（应在线）===')
console.log('=== 3. A 侧状态（应有 队长 + B 在线）===')
let peers = A.fleet.listTeams().find((t) => t.id === team.id).peers
console.log('A peers:', JSON.stringify(peers.map((p) => ({ name: p.name, isLeader: !!p.isLeader, status: p.status, statusText: p.statusText, rtt: p.rtt }))))

console.log('=== 4. B 拒绝 → A 显示已拒绝，B 显示已拒绝 ===')
const masterIdA = loadOrCreateIdentity(homeA).machineId
console.log('refuse result:', JSON.stringify(B.fleet.refuse(masterIdA, false)))
await sleep(600)
peers = A.fleet.listTeams().find((t) => t.id === team.id).peers
console.log('A peers:', JSON.stringify(peers.map((p) => ({ name: p.name, status: p.status, statusText: p.statusText }))))
console.log('B memberships:', JSON.stringify(B.fleet.memberships().map((m) => ({ master: m.masterName, status: m.status, statusText: m.statusText }))))

console.log('=== 5. B 恢复 → A 显示在线 ===')
console.log('resume result:', JSON.stringify(B.fleet.resume(masterIdA, false)))
await sleep(600)
peers = A.fleet.listTeams().find((t) => t.id === team.id).peers
console.log('A peers:', JSON.stringify(peers.map((p) => ({ name: p.name, status: p.status, statusText: p.statusText }))))

console.log('=== 6. B 退出 → A 名录移除，B 成员关系记录删除 ===')
console.log('leave result:', JSON.stringify(B.fleet.leave(masterIdA)))
await sleep(600)
peers = A.fleet.listTeams().find((t) => t.id === team.id).peers
console.log('A peers after leave:', JSON.stringify(peers.filter((p) => !p.isLeader)))
console.log('B memberships after leave (应为空):', JSON.stringify(B.fleet.memberships()))

console.log('=== 7. A 重新加入 B，然后踢掉 → B 成员关系记录删除 ===')
await A.fleet.add(team.name, { card: cardB })
await sleep(1200)
console.log('B memberships after re-add:', JSON.stringify(B.fleet.memberships().map((m) => ({ master: m.masterName, teams: m.teams, status: m.status }))))
console.log('A kick result:', JSON.stringify(A.fleet.remove(team.name, idB.machineId)))
await sleep(600)
console.log('B memberships after kick (应为空):', JSON.stringify(B.fleet.memberships()))
peers = A.fleet.listTeams().find((t) => t.id === team.id).peers
console.log('A peers after kick:', JSON.stringify(peers.filter((p) => !p.isLeader)))

console.log('=== 8. A 重新加入 B，然后派发任务（干跑：桩服务，不烧 token）===')
await A.fleet.add(team.name, { card: cardB })
await sleep(1200)
const dispatchTool = A.registered.find((t) => t.name === 'fleet_dispatch')
console.log('fleet_dispatch registered:', !!dispatchTool)
const dr = await dispatchTool.execute({ team: team.name, prompt: '只回答一句话：你好', keyHint: 'self', timeoutMs: 15000 })
console.log('dispatch result:', JSON.stringify({ ok: dr.ok, member: dr.member, answer: dr.answer, workspace: dr.workspace, sessionId: dr.sessionId, logs: dr.logs, message: dr.message }))

console.log('=== 9. 非法 token 应被拒（防伪造验证，直接调 worker 执行器）===')
const { runTask } = await import('../src/task-runner.js')
const { hmac } = await import('../src/protocol.js')
const idB2 = loadOrCreateIdentity(homeB)
let rejected = false
await runTask(B.ctx, {
  identity: idB2,
  home: homeB,
  task: { taskId: 'fake-1', token: 'wrong-token', prompt: 'x' },
  send: (m) => { if (m.type === 'task_failed' && m.error.includes('TOKEN_INVALID')) rejected = true },
})
console.log('非法 token 被拒:', rejected)

await disposeA()
await disposeB()
console.log('dispose OK')
process.exit(0)

// worker 任务执行器：收到 submit_task 后验签，在自身 harness 里
// 新建工作区 + 新建会话 + 挂 preset 跑 agent，完成后回传结果。
// 只依赖可选的 Host 服务（workspaceRegistry / credentials / agents / sessionQuery），
// 用 ctx.get() 读取并在缺失时明确报错。
import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import crypto from 'node:crypto'
import { hmac } from './protocol.js'

// 从会话 surface 事件里取最后一条 assistant 文本（宽容解析，兼容多种 data 形状）
export function extractLastAssistantText(events) {
  if (!Array.isArray(events)) return undefined
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (!ev || ev.type !== 'assistant/message') continue
    const msg = ev.data?.message ?? ev.message ?? ev.data
    const content = msg?.content
    if (Array.isArray(content)) {
      const text = content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n').trim()
      if (text) return text
    } else if (typeof content === 'string' && content.trim()) {
      return content.trim()
    }
  }
  return undefined
}

// 在 worker harness 进程内执行一个任务
export async function runTask(ctx, { identity, home, task, send, log = () => {} }) {
  const taskId = String(task?.taskId || '')
  const reply = (m) => { try { send({ ...m, taskId }) } catch { /* noop */ } }

  // 1. 验签：token = HMAC(workerSK, taskId)，防伪造/重放
  const expect = hmac(identity.sk, taskId)
  if (String(task?.token || '') !== expect) {
    reply({ type: 'task_failed', error: 'TOKEN_INVALID: 任务令牌校验失败' })
    return
  }

  try {
    // 2. 新建工作区
    const workspaceRegistry = ctx.get('workspaceRegistry')
    if (!workspaceRegistry) throw new Error('本机未提供 workspaceRegistry 服务')
    const wsPath = String(task.workspace || path.join(home, 'tasks', taskId))
    await mkdir(wsPath, { recursive: true }) // workspaceRegistry.create 要求路径已存在
    const workspace = await workspaceRegistry.create(wsPath, task.title || `fleet-${taskId.slice(0, 8)}`)
    reply({ type: 'task_log', text: `工作区就绪: ${wsPath}` })

    // 3. key 注入（keyHint=inherit 且 master 下发了 apiKey）
    if (task.apiKey && ctx.get('credentials')) {
      try {
        await ctx.get('credentials').set('DEEPSEEK_API_KEY', String(task.apiKey))
        reply({ type: 'task_log', text: '已注入模型 key（inherit）' })
      } catch (e) {
        reply({ type: 'task_log', text: `key 注入失败（忽略，可能用本机自带 key）: ${e.message}` })
      }
    }

    // 4. 建 agent + 会话（meta.cwd=工作区，agentPreset=任务指定 preset）
    const agents = ctx.get('agents')
    if (!agents) throw new Error('本机未提供 agents 服务')
    const sessionId = `fleet-${taskId}`
    // setup 里挂载 agent preset：直接 agents.create 不会自动 join preset，
    // 否则 agent 没有 bash/fs 等工具（agent-presets 会告警 "published without joining an agent preset"）。
    // 参照 host-apiproxy composeAgent()：presets.resolve -> presets.mount(agentCtx, resolvedId)
    const agentPresets = ctx.get('agentPresets')
    const resolvePreset = async (presetId) => {
      if (!agentPresets) return undefined
      const id = (await agentPresets.resolve(presetId)).id
      return id
    }
    const setup = async (agentCtx) => {
      if (agentPresets) {
        try {
          const presetId = task.preset
            ? await resolvePreset(task.preset)
            : await resolvePreset(agentPresets.defaultId)
          if (presetId) await agentPresets.mount(agentCtx, presetId)
        } catch (e) {
          reply({ type: 'task_log', text: `preset 挂载失败（agent 将无工具）: ${e.message}` })
        }
      }
    }
    const handle = await agents.create({
      sessionId,
      meta: {
        cwd: wsPath,
        // 不带 origin:'subagent'：前端 sessionVisible() 会过滤掉 subagent 会话，
        // 导致任务会话在 GUI 工作区里不显示。作为普通会话创建即可正常展示。
        ...(task.preset ? { agentPreset: task.preset } : {}),
      },
      agentOptions: {
        ...(task.provider ? { provider: task.provider } : {}),
        ...(task.model ? { model: task.model } : {}),
        ...(task.maxTokens ? { maxTokens: Number(task.maxTokens) } : {}),
      },
      setup,
    })
    reply({ type: 'task_log', text: `会话已创建: ${sessionId}（${task.provider || '默认 provider'}/${task.model || '默认 model'}）` })

    // 4.5 将会话挂到工作区（与 GUI/API 层一致），否则会话会落进"未分组"
    try {
      await workspace.attachSession(sessionId)
      reply({ type: 'task_log', text: `会话已挂载到工作区: ${wsPath}` })
    } catch (e) {
      reply({ type: 'task_log', text: `工作区挂载失败（忽略）: ${e.message}` })
    }

    // 5. 提交 prompt 并等待完成
    const agent = handle.agent
    agent.followup({ id: crypto.randomUUID(), role: 'user', content: [{ type: 'text', text: String(task.prompt || '') }], source: { kind: 'user' } })
    await agent.whenIdle()

    // 6. 读最终回答（优先 sessionQuery.readSurface，回退 handle.agent.session 上的事件）
    let answer = undefined
    const sessionQuery = ctx.get('sessionQuery')
    if (sessionQuery) {
      try {
        const surface = await sessionQuery.readSurface(sessionId)
        answer = extractLastAssistantText(surface?.events)
      } catch { /* 回退 */ }
    }
    if (answer === undefined && agent.session && Array.isArray(agent.session.events)) {
      answer = extractLastAssistantText(agent.session.events)
    }

    reply({ type: 'task_result', ok: true, answer: answer ?? '（未读到回答）', workspace: wsPath, sessionId })
    // 默认不 dispose：dispose 会触发 host/session-removed，前端把会话从 GUI 列表删除，
    // 任务会话就看不到了（headless 也是进程退出自然清理，从不在完成后 dispose 会话）。
    // 副作用是 live session 常驻（与 DSH 正常 GUI 使用一致），worker 定期重启即可清理。
    // 高吞吐场景可设 DSH_FLEET_DISPOSE_AFTER_TASK=1 强制完成任务后立即 dispose（会话从
    // 实时列表移除，但持久化仍在，刷新页面后从 session.list 恢复显示）。
    if (process.env.DSH_FLEET_DISPOSE_AFTER_TASK === '1') {
      try { await handle.dispose() } catch { /* noop */ }
    }
  } catch (e) {
    reply({ type: 'task_failed', error: String(e?.message || e) })
  }
}

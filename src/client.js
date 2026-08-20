// dsh-fleet — DSH Cordis 插件入口（Client half）
// Fleet 面板：侧边栏「算力舰队」入口 + 中栏覆盖视图。
// 展示本机名片（一键复制）、多团队列表（在线状态/算力/内存）、
// 新建团队、添加成员（粘贴名片或位置参数）、联通测试、移除成员。
// 数据经 /fleet/api/*（仅回环可访问）轮询，无需任何第三方依赖。
// 挂载方式与 dsh-ssh 相同：直接操作 DOM + MutationObserver 自愈。
//
// 客户端 bundle 契约（与 dsh-ssh / dsh-better-sidebar 的 lib/client.js 相同）：
// 以经典脚本形式执行，并同步调用 window.__ModuleLoader__.load({ id, factory })
// 注册，id 必须等于 loader entry id（dsh-fleet）；factory 为 CommonJS 工厂，
// 返回 { inject, apply }。裸 ESM（export …）不会触发注册，会导致
// "loaded without registering \"dsh-fleet\" via __ModuleLoader__.load"。
window.__ModuleLoader__.load({
  id: 'dsh-fleet',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const inject = ['slots']

const CSS = `
[data-dsh-fleet-view]{z-index:60;background:var(--dsw-alias-bg-base, #fff);display:none;position:absolute;inset:0;overflow:auto;color:var(--dsw-alias-label-primary,#111);font-family:var(--dsw-font-family,system-ui);font-size:13px}
html[data-dsh-fleet-active]:not([data-dsh-taskboard-active]) [data-dsh-fleet-view]{display:block}
html[data-dsh-fleet-active]:not([data-dsh-taskboard-active]) [data-pane=conversation]>:not([data-dsh-fleet-view]),html[data-dsh-fleet-active]:not([data-dsh-taskboard-active]) [class*=centerCol]>:not([data-dsh-fleet-view]){display:none!important}
.fleet-entry{width:100%;height:32px;color:var(--dsw-alias-label-secondary,#666);cursor:pointer;white-space:nowrap;background:0 0;border:none;border-radius:8px;align-items:center;gap:8px;padding:0 12px;font-size:13px;display:flex}
.fleet-entry:hover{background:var(--dsw-specific-sidebar-nav-item-hover,#f2f2f2);color:var(--dsw-alias-label-primary,#111)}
.fleet-entry[data-active]{background:var(--dsw-specific-sidebar-nav-item-active,#e8e8e8);color:var(--dsw-alias-label-primary,#111);font-weight:600}
.fleet-entryIcon{flex:none;justify-content:center;align-items:center;display:inline-flex}
.fleet-entryLabel{text-overflow:ellipsis;overflow:hidden}
[data-dsh-frame][data-sidebar-collapsed] .fleet-entry{justify-content:center;width:100%;padding:0}
[data-dsh-frame][data-sidebar-collapsed] .fleet-entryLabel{display:none}
.fleet-panel{background:var(--dsw-alias-bg-base,#fff);min-width:0;height:100%;min-height:0;color:var(--dsw-alias-label-primary,#111);font-family:var(--dsw-font-family,system-ui);flex-direction:column;gap:10px;padding:14px 16px 16px;display:flex;font-size:13px}
.fleet-panelHeader{flex:none;align-items:center;gap:10px;display:flex}
.fleet-panelTitle{white-space:nowrap;flex:1;margin:0;font-size:16px;font-weight:700}
.fleet-backButton{background:0 0;border:none;cursor:pointer;color:var(--dsw-alias-label-secondary,#666);font-size:13px;padding:4px 8px;border-radius:6px}
.fleet-backButton:hover{background:var(--dsw-specific-sidebar-nav-item-hover,#f2f2f2)}
.fleet-section{flex:none;border:1px solid var(--dsw-alias-border-l1,#e5e5e5);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}
.fleet-sectionTitle{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#666);margin:0}
.fleet-cardRow{display:flex;gap:6px;align-items:center}
.fleet-cardInput{flex:1;font-size:11px;font-family:ui-monospace,Consolas,monospace;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1,#e5e5e5);border-radius:6px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111);min-width:0}
.fleet-btn{border:1px solid var(--dsw-alias-border-l1,#e5e5e5);background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111);border-radius:6px;padding:5px 10px;font-size:12px;cursor:pointer;white-space:nowrap}
.fleet-btn:hover{background:var(--dsw-specific-sidebar-nav-item-hover,#f2f2f2)}
.fleet-btn.primary{background:#2563eb;border-color:#2563eb;color:#fff}
.fleet-btn.primary:hover{background:#1d4ed8}
.fleet-btn.danger{color:#dc2626;border-color:#fca5a5}
.fleet-btn:disabled{opacity:.5;cursor:not-allowed}
.fleet-team{border:1px solid var(--dsw-alias-border-l1,#e5e5e5);border-radius:10px;overflow:hidden;display:flex;flex-direction:column}
.fleet-teamHead{display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--dsw-specific-sidebar-nav-item-hover,#f7f7f7);font-weight:600}
.fleet-teamHead .count{font-weight:400;color:var(--dsw-alias-label-secondary,#666);font-size:12px}
.fleet-teamHead .spacer{flex:1}
.fleet-member{display:flex;align-items:center;gap:8px;padding:6px 12px;border-top:1px solid var(--dsw-alias-border-l1,#f0f0f0)}
.fleet-dot{width:8px;height:8px;border-radius:50%;flex:none}
.fleet-dot.on{background:#22c55e}.fleet-dot.off{background:#d1d5db}
.fleet-badge{flex:none;font-size:11px;padding:2px 8px;border-radius:999px;white-space:nowrap;border:1px solid transparent}
.fleet-badge.online{background:#f0fdf4;color:#166534;border-color:#bbf7d0}
.fleet-badge.offline{background:#f9fafb;color:#6b7280;border-color:#e5e7eb}
.fleet-badge.refused{background:#fef2f2;color:#991b1b;border-color:#fecaca}
.fleet-badge.paused{background:#fffbeb;color:#92400e;border-color:#fde68a}
.fleet-badge.left{background:#f3f4f6;color:#6b7280;border-color:#d1d5db;text-decoration:line-through}
.fleet-badge.auth-failed{background:#fef2f2;color:#b91c1c;border-color:#fca5a5;font-weight:600}
.fleet-badge.leader{background:#eef2ff;color:#4338ca;border-color:#c7d2fe;font-weight:600}
.fleet-badge.connecting{background:#eff6ff;color:#1d4ed8;border-color:#bfdbfe}
.fleet-meta{color:var(--dsw-alias-label-secondary,#888);font-size:11px;flex:none}
.fleet-membership{display:flex;align-items:center;gap:8px;padding:6px 12px;border-top:1px solid var(--dsw-alias-border-l1,#f0f0f0)}
.fleet-membership .m-name{font-weight:500;min-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fleet-membership .m-teams{color:var(--dsw-alias-label-secondary,#666);font-size:11px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fleet-member .m-name{font-weight:500;min-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fleet-member .m-addr{color:var(--dsw-alias-label-secondary,#666);font-size:11px;font-family:ui-monospace,Consolas,monospace;min-width:120px}
.fleet-member .m-spec{color:var(--dsw-alias-label-secondary,#888);font-size:11px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fleet-member .m-actions{display:flex;gap:4px;flex:none}
.fleet-addRow{display:flex;gap:6px;padding:6px 12px;border-top:1px solid var(--dsw-alias-border-l1,#f0f0f0)}
.fleet-addCard{flex:1;font-size:11px;font-family:ui-monospace,Consolas,monospace;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1,#e5e5e5);border-radius:6px;min-width:0}
.fleet-msg{padding:6px 12px;font-size:12px;border-radius:8px;flex:none;display:none}
.fleet-msg.show{display:block}
.fleet-msg.ok{background:#f0fdf4;color:#166534;border:1px solid #bbf7d0}
.fleet-msg.err{background:#fef2f2;color:#991b1b;border:1px solid #fecaca}
`

function makeEl(tag, attrs = {}, children = []) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') node.textContent = v
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v)
    else node.setAttribute(k, v)
  }
  for (const c of children) if (c) node.appendChild(c)
  return node
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'content-type': 'application/json' },
    ...opts,
  })
  return res.json()
}

class PanelController {
  constructor() { this.panelOpen = false; this.listeners = new Set() }
  getSnapshot() { return { panelOpen: this.panelOpen } }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) }
  open() { if (this.panelOpen) return; this.panelOpen = true; this.notify() }
  close() { if (!this.panelOpen) return; this.panelOpen = false; this.notify() }
  toggle() { this.panelOpen ? this.close() : this.open() }
  notify() { for (const fn of [...this.listeners]) fn() }
}

function sidebarRoot() {
  const column = document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]')
  if (column === null) return undefined
  return column.querySelector('[class*="logoRow"]')?.parentElement ?? column.firstElementChild
}

function newSessionButton(root) {
  const nested = root.querySelector('button[class*="newSession"]')
  if (nested !== null) return nested
  for (const child of root.children) if (child.tagName === 'BUTTON') return child
}

function createEntry(controller) {
  const entry = makeEl('button', { type: 'button', 'data-dsh-fleet-entry': '', class: 'fleet-entry', 'aria-label': '算力舰队', title: '算力舰队：发现与联通' })
  entry.innerHTML = '<span class="fleet-entryIcon"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="4" width="13" height="8" rx="1.5"/><path d="M4.5 6h.01M6.5 6h.01M8.5 6h.01"/><path d="M4 12v1.5M8 12v1.5M12 12v1.5"/></svg></span><span class="fleet-entryLabel">算力舰队</span>'
  entry.addEventListener('click', () => controller.toggle())
  return entry
}

function placeEntry(root, entry) {
  const button = newSessionButton(root)
  if (button === undefined) return false
  if (entry.parentElement !== root) {
    const row = button.closest('[class*="logoRow"]')
    const base = row !== null && row.parentElement === root ? row : button
    const family = Array.from(root.children).filter((el) => el instanceof HTMLElement && el.matches('[data-dsh-taskboard-entry], [data-dsh-ssh-entry], [data-dsh-fleet-entry]'))
    const anchor = family.length > 0 ? family[family.length - 1].nextElementSibling : base.nextElementSibling
    root.insertBefore(entry, anchor)
  }
  return true
}

function mountSidebarEntry(controller) {
  const entry = createEntry(controller)
  let root
  let placed = false
  const tryPlace = () => {
    if (root !== undefined && !root.isConnected) { rootObserver.disconnect(); root = undefined; placed = false }
    if (placed) {
      if (document.body.contains(entry)) return
      rootObserver.disconnect(); root = undefined; placed = false
    }
    root ??= sidebarRoot()
    if (root === undefined) return
    placed = placeEntry(root, entry)
    if (placed) rootObserver.observe(root, { childList: true, subtree: true })
  }
  const waitObserver = new MutationObserver(() => tryPlace())
  waitObserver.observe(document.body, { childList: true, subtree: true })
  const rootObserver = new MutationObserver(() => {
    if (root === undefined || !root.isConnected) { placed = false; tryPlace(); return }
    if (!root.contains(entry)) placed = placeEntry(root, entry)
  })
  const syncActive = () => { if (controller.getSnapshot().panelOpen) entry.dataset.active = 'true'; else delete entry.dataset.active }
  const unsubscribe = controller.subscribe(syncActive)
  syncActive()
  tryPlace()
  return () => {
    waitObserver.disconnect(); rootObserver.disconnect(); unsubscribe(); entry.remove()
    document.documentElement.removeAttribute('data-dsh-fleet-active')
  }
}

function mountPanel(controller) {
  const view = makeEl('div', { 'data-dsh-fleet-view': '' })
  view.innerHTML = '<div class="fleet-panel"></div>'
  const panel = view.firstElementChild

  let state = { card: '', machineId: '', name: '', port: 0, teams: [], memberships: [] }
  let refreshTimer = null

  // 头部
  const header = makeEl('div', { class: 'fleet-panelHeader' })
  const title = makeEl('h2', { class: 'fleet-panelTitle', text: '算力舰队' })
  const refreshBtn = makeEl('button', { class: 'fleet-btn', text: '刷新', onClick: () => refresh() })
  const backBtn = makeEl('button', { class: 'fleet-backButton', text: '← 返回', onClick: () => controller.close() })
  header.appendChild(backBtn); header.appendChild(title); header.appendChild(refreshBtn)

  // 本机名片
  const cardSection = makeEl('div', { class: 'fleet-section' })
  const cardRow = makeEl('div', { class: 'fleet-cardRow' })
  const cardInput = makeEl('input', { class: 'fleet-cardInput', readonly: '', value: '加载中…' })
  const copyBtn = makeEl('button', { class: 'fleet-btn primary', text: '复制', onClick: () => {
    const text = cardInput.value
    // 优先 clipboard API（localhost 属安全上下文可用），失败回退选中+execCommand
    const fallback = () => {
      cardInput.select()
      cardInput.setSelectionRange(0, cardInput.value.length)
      let ok = false
      try { ok = document.execCommand('copy') } catch { ok = false }
      flashMsg(ok ? '已复制' : '复制失败，请手动选中复制', !ok)
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => flashMsg('已复制'), fallback)
    } else {
      fallback()
    }
  } })
  cardRow.appendChild(cardInput); cardRow.appendChild(copyBtn)
  cardSection.appendChild(makeEl('p', { class: 'fleet-sectionTitle', text: '本机名片（发给对方加入你的团队）' }))
  cardSection.appendChild(cardRow)

  // 消息条
  const msg = makeEl('div', { class: 'fleet-msg' })

  // 新建团队
  const newTeamRow = makeEl('div', { class: 'fleet-cardRow' })
  const teamNameInput = makeEl('input', { class: 'fleet-cardInput', placeholder: '新团队名称' })
  const createTeamBtn = makeEl('button', { class: 'fleet-btn primary', text: '新建团队', onClick: async () => {
    const name = teamNameInput.value.trim()
    if (!name) return flashMsg('团队名称不能为空', true)
    const r = await fetchJson('/fleet/api/teams', { method: 'POST', body: JSON.stringify({ name }) })
    if (r.error) return flashMsg(r.error, true)
    teamNameInput.value = ''
    flashMsg(`已创建团队：${name}`)
    refresh()
  } })
  newTeamRow.appendChild(teamNameInput); newTeamRow.appendChild(createTeamBtn)

  // 团队列表容器
  const teamsBox = makeEl('div', { style: 'display:flex;flex-direction:column;gap:10px' })

  // 我加入的团队（成员关系）容器
  const membershipsSection = makeEl('div', { class: 'fleet-section' })
  const membershipsHeader = makeEl('div', { class: 'fleet-cardRow' })
  membershipsHeader.appendChild(makeEl('p', { class: 'fleet-sectionTitle', text: '我加入的团队（被调用方）' }))
  const pauseAllBtn = makeEl('button', { class: 'fleet-btn danger', text: '全部拒绝', onClick: async () => {
    const r = await fetchJson('/fleet/api/memberships/refuse', { method: 'POST', body: JSON.stringify({}) })
    flashMsg(r.message || r.error || (r.ok ? '已拒绝全部' : '操作失败'), !r.ok)
    refresh()
  } })
  membershipsHeader.appendChild(pauseAllBtn)
  const membershipsBox = makeEl('div', { style: 'display:flex;flex-direction:column' })
  membershipsSection.appendChild(membershipsHeader)
  membershipsSection.appendChild(membershipsBox)

  panel.appendChild(header)
  panel.appendChild(msg)
  panel.appendChild(cardSection)
  panel.appendChild(newTeamRow)
  panel.appendChild(teamsBox)
  panel.appendChild(membershipsSection)

  function flashMsg(text, isErr) {
    msg.textContent = text
    msg.className = `fleet-msg show ${isErr ? 'err' : 'ok'}`
    setTimeout(() => { msg.className = 'fleet-msg' }, 4000)
  }

  async function refresh() {
    try {
      const [cardR, teamsR, memR] = await Promise.all([fetchJson('/fleet/api/card'), fetchJson('/fleet/api/teams'), fetchJson('/fleet/api/memberships')])
      if (cardR.card) {
        state = { ...state, card: cardR.card, machineId: cardR.machineId, name: cardR.name, port: cardR.port }
        cardInput.value = cardR.card
      }
      if (teamsR.teams) { state.teams = teamsR.teams; renderTeams() }
      if (memR.memberships) { state.memberships = memR.memberships; renderMemberships() }
    } catch (e) {
      flashMsg('刷新失败：' + String(e?.message || e), true)
    }
  }

  function memberRow(teamId, teamName, p) {
    const row = makeEl('div', { class: 'fleet-member' })
    if (p.isLeader) {
      row.appendChild(makeEl('span', { class: 'fleet-badge leader', text: '本机（队长）' }))
      row.appendChild(makeEl('span', { class: 'm-name', text: `${p.name}（本机）`, title: p.machineId || '' }))
      row.appendChild(makeEl('span', { class: 'm-addr', text: `${p.host}:${p.port}` }))
      row.appendChild(makeEl('span', { class: 'm-spec', text: `${p.cpu ? p.cpu.split(' x')[0] : '?'} / ${p.mem || '?'}` }))
      row.appendChild(makeEl('span', { class: 'fleet-meta', text: '永远在线 · 队长' }))
      return row
    }
    const st = p.status || (p.online ? 'online' : 'offline')
    const stText = p.statusText || (p.online ? '在线' : '离线')
    row.appendChild(makeEl('span', { class: `fleet-badge ${st}`, text: stText }))
    row.appendChild(makeEl('span', { class: 'm-name', text: p.name, title: p.machineId || '' }))
    row.appendChild(makeEl('span', { class: 'm-addr', text: `${p.host}:${p.port}` }))
    row.appendChild(makeEl('span', { class: 'm-spec', text: `${p.cpu ? p.cpu.split(' x')[0] : '?'} / ${p.mem || '?'}` }))
    if (st === 'online' && p.rtt != null) {
      row.appendChild(makeEl('span', { class: 'fleet-meta', text: `RTT ${p.rtt}ms${p.memFreeGB != null ? ` · 空闲${p.memFreeGB}GB` : ''}${p.lastPong ? ` · ${new Date(p.lastPong).toLocaleTimeString('zh-CN', { hour12: false })}` : ''}` }))
    }
    const actions = makeEl('div', { class: 'm-actions' })
    if (st === 'refused' || st === 'paused') {
      // 对方拒绝/暂停时，master 只能移除（恢复权在对方）
      const rmBtn = makeEl('button', { class: 'fleet-btn danger', text: '移除', onClick: async () => {
        const r = await fetchJson(`/fleet/api/teams/peers?team=${encodeURIComponent(teamId)}&name=${encodeURIComponent(p.name)}`, { method: 'DELETE' })
        flashMsg(r.ok ? `已移除 ${p.name}` : '移除失败', !r.ok)
        refresh()
      } })
      actions.appendChild(rmBtn)
    } else {
      const testBtn = makeEl('button', { class: 'fleet-btn', text: '测试', onClick: async () => {
        // 按名录名称走服务端 findPeerAcrossTeams（SK 不出浏览器）
        const r = await fetchJson('/fleet/api/test', { method: 'POST', body: JSON.stringify({ name: p.name }) })
        flashMsg(r.message || r.error || (r.ok ? '✓ 可达' : '✗ 不可达'), !r.ok)
        if (r.ok) refresh()
      } })
      const rmBtn = makeEl('button', { class: 'fleet-btn danger', text: '移除', onClick: async () => {
        const r = await fetchJson(`/fleet/api/teams/peers?team=${encodeURIComponent(teamId)}&name=${encodeURIComponent(p.name)}`, { method: 'DELETE' })
        flashMsg(r.ok ? `已移除 ${p.name}` : '移除失败', !r.ok)
        refresh()
      } })
      actions.appendChild(testBtn); actions.appendChild(rmBtn)
    }
    row.appendChild(actions)
    return row
  }

  function membershipRow(m) {
    const row = makeEl('div', { class: 'fleet-membership' })
    const st = m.status || 'offline'
    row.appendChild(makeEl('span', { class: `fleet-badge ${st === 'online' ? 'connecting' : st}`, text: m.statusText || m.status }))
    row.appendChild(makeEl('span', { class: 'm-name', text: m.masterName, title: m.masterId || '' }))
    row.appendChild(makeEl('span', { class: 'm-teams', text: `团队=[${(m.teams || []).join(', ') || '无'}]` }))
    if (m.lastSeen) {
      row.appendChild(makeEl('span', { class: 'fleet-meta', text: `最后联系 ${new Date(m.lastSeen).toLocaleTimeString('zh-CN', { hour12: false })}` }))
    }
    const actions = makeEl('div', { class: 'm-actions' })
    if (m.state === 'refused' || m.state === 'paused') {
      const resumeBtn = makeEl('button', { class: 'fleet-btn', text: '恢复', onClick: async () => {
        const r = await fetchJson('/fleet/api/memberships/resume', { method: 'POST', body: JSON.stringify({ master: m.masterId }) })
        flashMsg(r.message || r.error || (r.ok ? '已恢复' : '失败'), !r.ok)
        refresh()
      } })
      actions.appendChild(resumeBtn)
    } else if (m.state !== 'left') {
      const refuseBtn = makeEl('button', { class: 'fleet-btn', text: '拒绝', onClick: async () => {
        const r = await fetchJson('/fleet/api/memberships/refuse', { method: 'POST', body: JSON.stringify({ master: m.masterId }) })
        flashMsg(r.message || r.error || (r.ok ? '已拒绝' : '失败'), !r.ok)
        refresh()
      } })
      actions.appendChild(refuseBtn)
    }
    const leaveBtn = makeEl('button', { class: 'fleet-btn danger', text: '退出', onClick: async () => {
      const r = await fetchJson('/fleet/api/memberships/leave', { method: 'POST', body: JSON.stringify({ master: m.masterId }) })
      flashMsg(r.message || r.error || (r.ok ? '已退出' : '失败'), !r.ok)
      refresh()
    } })
    actions.appendChild(leaveBtn)
    row.appendChild(actions)
    return row
  }

  function renderMemberships() {
    membershipsBox.replaceChildren(...(state.memberships || []).map(membershipRow))
    if (!(state.memberships || []).length) {
      membershipsBox.appendChild(makeEl('div', { style: 'color:var(--dsw-alias-label-secondary,#888);padding:8px', text: '还没被任何团队收录——把本机名片发给对方即可' }))
    }
  }

  function teamCard(t) {
    const card = makeEl('div', { class: 'fleet-team' })
    const head = makeEl('div', { class: 'fleet-teamHead' })
    head.appendChild(makeEl('span', { text: t.name }))
    head.appendChild(makeEl('span', { class: 'count', text: `${t.peers.length} 台` }))
    head.appendChild(makeEl('span', { class: 'spacer' }))
    const delBtn = makeEl('button', { class: 'fleet-btn danger', text: '删除', onClick: async () => {
      const r = await fetchJson(`/fleet/api/teams?name=${encodeURIComponent(t.name)}`, { method: 'DELETE' })
      flashMsg(r.ok ? `已删除团队 ${t.name}` : '删除失败', !r.ok)
      refresh()
    } })
    head.appendChild(delBtn)
    card.appendChild(head)

    for (const p of t.peers) card.appendChild(memberRow(t.id, t.name, p))

    // 添加成员（粘贴名片 或 位置参数）
    const addRow = makeEl('div', { class: 'fleet-addRow' })
    const addInput = makeEl('input', { class: 'fleet-addCard', placeholder: '粘贴对方名片 dsh-fleet://… 或 名称 IP 端口 SK' })
    const addBtn = makeEl('button', { class: 'fleet-btn primary', text: '添加', onClick: async () => {
      const raw = addInput.value.trim()
      if (!raw) return flashMsg('请粘贴名片或填写 名称 IP 端口 SK', true)
      let body
      if (raw.startsWith('dsh-fleet://')) body = { team: t.name, card: raw }
      else {
        const parts = raw.split(/\s+/)
        if (parts.length < 4) return flashMsg('位置参数需要 4 项：名称 IP 端口 SK', true)
        body = { team: t.name, name: parts[0], host: parts[1], port: Number(parts[2]), sk: parts[3] }
      }
      const r = await fetchJson('/fleet/api/teams/peers', { method: 'POST', body: JSON.stringify(body) })
      if (r.error) return flashMsg(r.error, true)
      flashMsg(r.message || '已添加')
      addInput.value = ''
      refresh()
    } })
    addRow.appendChild(addInput); addRow.appendChild(addBtn)
    card.appendChild(addRow)
    return card
  }

  function renderTeams() {
    teamsBox.replaceChildren(...state.teams.map(teamCard))
    if (!state.teams.length) teamsBox.appendChild(makeEl('div', { style: 'color:var(--dsw-alias-label-secondary,#888);padding:8px', text: '还没有团队，先在上面新建一个' }))
  }

  const syncActive = () => {
    if (controller.getSnapshot().panelOpen) {
      document.documentElement.setAttribute('data-dsh-fleet-active', 'true')
      if (refreshTimer === null) {
        refresh()
        refreshTimer = setInterval(refresh, 3000)
      }
    } else {
      document.documentElement.removeAttribute('data-dsh-fleet-active')
      if (refreshTimer !== null) { clearInterval(refreshTimer); refreshTimer = null }
    }
  }
  const unsubscribe = controller.subscribe(syncActive)
  syncActive()

  // 面板视图挂到中栏
  const mountTarget = () => document.querySelector('[data-pane="conversation"], [class*="centerCol"]')
  const placeView = () => {
    const target = mountTarget()
    if (target === null || view.parentElement === target) return
    target.appendChild(view)
  }
  placeView()
  const viewObserver = new MutationObserver(() => placeView())
  viewObserver.observe(document.body, { childList: true, subtree: true })

  return () => {
    viewObserver.disconnect()
    unsubscribe()
    if (refreshTimer !== null) clearInterval(refreshTimer)
    view.remove()
    document.documentElement.removeAttribute('data-dsh-fleet-active')
  }
}

function apply(ctx) {
  const style = makeEl('style')
  style.textContent = CSS
  document.head.appendChild(style)
  const controller = new PanelController()
  const disposers = []
  try {
    disposers.push(mountSidebarEntry(controller))
    disposers.push(mountPanel(controller))
  } catch (error) {
    console.warn('[dsh-fleet] mount failed:', error)
  }
  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) dispose()
    style.remove()
  }, 'dsh-fleet: ui mounts')
  }

  exports.inject = inject
  exports.apply = apply
  return module.exports
  }
})

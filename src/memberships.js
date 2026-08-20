// 成员关系（worker 视角）：记录"我加入了哪些团队/被哪些 master 调用"。
// 当 master 连上本机并完成握手后，会发 hello 声明本机在其哪些团队里，
// 本机据此维护 memberships.json。状态机：
//   active  正常（可被调用）
//   refused 已拒绝该 master（暂停被其调用）
//   left    已退出（保留记录供审计，master 侧会同步移除）
import fs from 'node:fs'
import path from 'node:path'
import { homeDir } from './identity.js'

const FILE = 'memberships.json'

function filePath(home) {
  return path.join(home, FILE)
}

function save(data, home) {
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(filePath(home), JSON.stringify(data, null, 2))
}

export function loadMemberships(home = homeDir()) {
  const p = filePath(home)
  if (!fs.existsSync(p)) return { memberships: [] }
  try {
    const r = JSON.parse(fs.readFileSync(p, 'utf8'))
    return { memberships: Array.isArray(r.memberships) ? r.memberships : [] }
  } catch {
    return { memberships: [] }
  }
}

export function listMemberships(home = homeDir()) {
  return loadMemberships(home).memberships
}

// master 连入并 hello 时调用：登记/更新成员关系
export function upsertMembership({ masterId, masterName, host, port, teams }, home = homeDir()) {
  const { memberships } = loadMemberships(home)
  const i = memberships.findIndex((m) => m.masterId === masterId)
  const now = Date.now()
  if (i >= 0) {
    memberships[i] = {
      ...memberships[i],
      masterName: masterName ?? memberships[i].masterName,
      host: host ?? memberships[i].host,
      port: port ?? memberships[i].port,
      teams: [...new Set([...(teams ?? []), ...(memberships[i].teams ?? [])])],
      state: memberships[i].state === 'left' ? 'active' : memberships[i].state,
      lastSeen: now,
    }
    save({ memberships }, home)
    return { added: false, membership: memberships[i] }
  }
  const m = {
    masterId,
    masterName: masterName ?? '?',
    host: host ?? '',
    port: port ?? 0,
    teams: [...(teams ?? [])],
    state: 'active',
    joinedAt: now,
    lastSeen: now,
  }
  memberships.push(m)
  save({ memberships }, home)
  return { added: true, membership: m }
}

export function findMembership(masterIdOrName, home = homeDir()) {
  return listMemberships(home).find((m) => m.masterId === masterIdOrName || m.masterName === masterIdOrName)
}

// 退出/被踢：直接删除成员关系记录（不留 left 残影）
export function deleteMembership(masterIdOrName, home = homeDir()) {
  const { memberships } = loadMemberships(home)
  const before = memberships.length
  const rest = memberships.filter((m) => m.masterId !== masterIdOrName && m.masterName !== masterIdOrName)
  save({ memberships: rest }, home)
  return { found: before - rest.length > 0 }
}

// 从成员关系中移除某个团队；团队列表空了则整条删除
export function removeTeamFromMembership(masterIdOrName, team, home = homeDir()) {
  const { memberships } = loadMemberships(home)
  const m = memberships.find((x) => x.masterId === masterIdOrName || x.masterName === masterIdOrName)
  if (!m) return { found: false }
  if (team) {
    m.teams = (m.teams ?? []).filter((t) => t !== team)
    if (m.teams.length === 0) {
      const rest = memberships.filter((x) => x !== m)
      save({ memberships: rest }, home)
      return { found: true, deleted: true }
    }
    save({ memberships }, home)
    return { found: true, deleted: false }
  }
  const rest = memberships.filter((x) => x !== m)
  save({ memberships: rest }, home)
  return { found: true, deleted: true }
}

// 拒绝/暂停 或 恢复
export function setMembershipState(masterIdOrName, state, home = homeDir()) {
  const { memberships } = loadMemberships(home)
  const m = memberships.find((x) => x.masterId === masterIdOrName || x.masterName === masterIdOrName)
  if (!m) return { found: false }
  m.state = state
  save({ memberships }, home)
  return { found: true, membership: m }
}

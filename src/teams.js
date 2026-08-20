// 组队层 v2：多团队名录（teams.json）。
// 一台机可同时属于多个团队（每个团队 = 一个独立的 peer 名录），
// 方向即角色：向某团队派发任务 = 该团队的组织方(master)，被调用 = 执行方(worker)。
// 旧版单团队数据（peers.json）首次加载时自动迁移进"默认团队"。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { homeDir } from './identity.js'

const TEAMS_FILE = 'teams.json'
const LEGACY_FILE = 'peers.json'
const DEFAULT_TEAM_NAME = '默认团队'

function teamsPath(home) {
  return path.join(home, TEAMS_FILE)
}

function legacyPath(home) {
  return path.join(home, LEGACY_FILE)
}

function save(teams, home) {
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(teamsPath(home), JSON.stringify(teams, null, 2))
}

export function loadTeams(home = homeDir()) {
  const p = teamsPath(home)
  if (!fs.existsSync(p)) {
    // 迁移旧版单团队数据
    const lp = legacyPath(home)
    if (fs.existsSync(lp)) {
      try {
        const legacy = JSON.parse(fs.readFileSync(lp, 'utf8'))
        if (Array.isArray(legacy.peers) && legacy.peers.length > 0) {
          const team = { id: 'default', name: DEFAULT_TEAM_NAME, createdAt: new Date().toISOString(), peers: legacy.peers }
          save({ teams: [team] }, home)
          return { teams: [team] }
        }
      } catch { /* 忽略损坏的旧文件 */ }
    }
    return { teams: [] }
  }
  try {
    const r = JSON.parse(fs.readFileSync(p, 'utf8'))
    return { teams: Array.isArray(r.teams) ? r.teams : [] }
  } catch {
    return { teams: [] }
  }
}

export function findTeam(idOrName, home = homeDir()) {
  const { teams } = loadTeams(home)
  return teams.find((t) => t.id === idOrName || t.name === idOrName)
}

// 返回第一个团队；没有则创建"默认团队"（兼容旧 CLI 用法）
export function ensureDefaultTeam(home = homeDir()) {
  const { teams } = loadTeams(home)
  if (teams.length > 0) return teams[0]
  const t = { id: 'default', name: DEFAULT_TEAM_NAME, createdAt: new Date().toISOString(), peers: [] }
  save({ teams: [t] }, home)
  return t
}

export function createTeam(name, home = homeDir()) {
  const clean = String(name || '').trim()
  if (!clean) throw new Error('团队名称不能为空')
  const { teams } = loadTeams(home)
  if (teams.some((t) => t.name === clean)) throw new Error(`团队已存在：${clean}`)
  const t = { id: crypto.randomUUID(), name: clean, createdAt: new Date().toISOString(), peers: [] }
  teams.push(t)
  save({ teams }, home)
  return t
}

export function removeTeam(idOrName, home = homeDir()) {
  const { teams } = loadTeams(home)
  const before = teams.length
  const rest = teams.filter((t) => t.id !== idOrName && t.name !== idOrName)
  save({ teams: rest }, home)
  return before - rest.length
}

// 返回 { added, peer }
export function addPeerToTeam(teamIdOrName, peer, home = homeDir()) {
  const { teams } = loadTeams(home)
  const team = teams.find((t) => t.id === teamIdOrName || t.name === teamIdOrName)
  if (!team) throw new Error(`找不到团队：${teamIdOrName}`)
  const i = team.peers.findIndex((p) => peer.machineId && p.machineId === peer.machineId)
  if (i >= 0) {
    team.peers[i] = { ...team.peers[i], ...peer, addedAt: team.peers[i].addedAt }
    save({ teams }, home)
    return { added: false, peer: team.peers[i] }
  }
  const item = { ...peer, addedAt: new Date().toISOString() }
  team.peers.push(item)
  save({ teams }, home)
  return { added: true, peer: item }
}

export function removePeerFromTeam(teamIdOrName, nameOrId, home = homeDir()) {
  const { teams } = loadTeams(home)
  const team = teams.find((t) => t.id === teamIdOrName || t.name === teamIdOrName)
  if (!team) return 0
  const before = team.peers.length
  team.peers = team.peers.filter((p) => p.name !== nameOrId && p.machineId !== nameOrId)
  save({ teams }, home)
  return before - team.peers.length
}

// 跨团队查找（test 命令按名称定位）
export function findPeerAcrossTeams(nameOrId, home = homeDir()) {
  const { teams } = loadTeams(home)
  for (const t of teams) {
    const p = t.peers.find((x) => x.name === nameOrId || x.machineId === nameOrId)
    if (p) return p
  }
  return undefined
}

// 设置某成员在团队中的状态（active/refused/paused/left）
export function setPeerState(teamIdOrName, nameOrId, state, home = homeDir()) {
  const { teams } = loadTeams(home)
  const team = teams.find((t) => t.id === teamIdOrName || t.name === teamIdOrName)
  if (!team) return false
  const p = team.peers.find((x) => x.name === nameOrId || x.machineId === nameOrId)
  if (!p) return false
  p.state = state
  save({ teams }, home)
  return true
}

export function listTeams(home = homeDir()) {
  return loadTeams(home).teams
}

// 组队层：对等机名录（peer roster）。
// 一台机可同时属于多个团队：既是某些团队的执行机(被调用方)，也是另一些团队的组织机(调用方)。
// 名录只记录"我信任谁 / 我知道谁的 SK"；方向即角色。
import fs from 'node:fs'
import path from 'node:path'
import { homeDir, rosterPath } from './identity.js'

export function loadRoster(home = homeDir()) {
  const p = rosterPath(home)
  if (!fs.existsSync(p)) return { peers: [] }
  try {
    const r = JSON.parse(fs.readFileSync(p, 'utf8'))
    return { peers: Array.isArray(r.peers) ? r.peers : [] }
  } catch {
    return { peers: [] }
  }
}

function save(roster, home) {
  const p = rosterPath(home)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(roster, null, 2))
}

// 返回 { added: boolean, peer }
export function addPeer(peer, home = homeDir()) {
  const r = loadRoster(home)
  const i = r.peers.findIndex((p) => p.machineId === peer.machineId)
  if (i >= 0) {
    r.peers[i] = { ...r.peers[i], ...peer, addedAt: r.peers[i].addedAt }
    save(r, home)
    return { added: false, peer: r.peers[i] }
  }
  const item = { ...peer, addedAt: new Date().toISOString() }
  r.peers.push(item)
  save(r, home)
  return { added: true, peer: item }
}

export function removePeer(nameOrId, home = homeDir()) {
  const r = loadRoster(home)
  const before = r.peers.length
  r.peers = r.peers.filter((p) => p.name !== nameOrId && p.machineId !== nameOrId)
  save(r, home)
  return before - r.peers.length
}

export function findPeer(nameOrId, home = homeDir()) {
  const r = loadRoster(home)
  return r.peers.find((p) => p.name === nameOrId || p.machineId === nameOrId)
}

export function listPeers(home = homeDir()) {
  return loadRoster(home).peers
}

// 身份层：每台机器安装插件后生成并持久化 machineId + 永久 SK。
// 身份文件默认存于 ~/.dsh/fleet/identity.json，可用 DSH_FLEET_HOME 覆盖（便于本地多机模拟）。
import crypto from 'node:crypto'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

export function homeDir() {
  return process.env.DSH_FLEET_HOME || path.join(os.homedir(), '.dsh', 'fleet')
}

export function identityPath(home = homeDir()) {
  return path.join(home, 'identity.json')
}

export function rosterPath(home = homeDir()) {
  return path.join(home, 'peers.json')
}

export function loadOrCreateIdentity(home = homeDir()) {
  const p = identityPath(home)
  if (fs.existsSync(p)) {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  }
  const identity = {
    machineId: crypto.randomUUID(),
    sk: crypto.randomBytes(32).toString('hex'), // 64 hex 字符 = 256 bit
    name: os.hostname(),
    createdAt: new Date().toISOString(),
  }
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(p, JSON.stringify(identity, null, 2), { encoding: 'utf8', mode: 0o600 })
  return identity
}

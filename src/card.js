// 机器名片：一行可复制的字符串，人工粘贴到组建机即可入队。
// 格式：dsh-fleet://<machineId>|<名称>|<host>:<port>|<cpu>|<内存GB>GB|<NAT类型>|<永久SK>
// 字段间用 | 分隔（字段内部允许空格）；NAT 类型 MVP 阶段固定 unknown，后续里程碑探测。
import { cpuLabel, memGB, preferredIPv4 } from './network.js'

export function buildCard(identity, { host, port, nat = 'unknown' } = {}) {
  const ip = host || preferredIPv4()
  const fields = [identity.machineId, identity.name, `${ip}:${port}`, cpuLabel(), `${memGB()}GB`, nat, identity.sk]
  return `dsh-fleet://${fields.join('|')}`
}

export function parseCard(str) {
  const s = String(str || '').trim()
  if (!s.startsWith('dsh-fleet://')) throw new Error('不是合法的 dsh-fleet 名片（缺少 dsh-fleet:// 前缀）')
  const parts = s.slice('dsh-fleet://'.length).split('|')
  if (parts.length !== 7) throw new Error(`名片字段数不对（期望 7 段，实际 ${parts.length}）`)
  const [machineId, name, hostport, cpu, mem, nat, sk] = parts
  const m = /^(.+):(\d+)$/.exec(hostport)
  if (!m) throw new Error(`名片 host:port 格式不对：${hostport}`)
  if (!/^[0-9a-f]{64}$/.test(sk)) throw new Error('名片 SK 不是 64 位 hex（可能被截断）')
  return { machineId, name, host: m[1], port: Number(m[2]), cpu, mem, nat, sk }
}

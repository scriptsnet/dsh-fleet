// 本机网络与算力探测。
// preferredIPv4()：选"最可能是内网地址"的 IPv4 —— 默认路由网卡优先（UDP connect 探测，
// 不发包），其次过滤虚拟网卡（docker/br-*/veth 等）后按常见内网段排序。
import os from 'node:os'
import dgram from 'node:dgram'

// 常见虚拟/隧道网卡名前缀：卡片不应使用这些地址
const SKIP_NAMES = /^(docker|veth|br-|virbr|vmnet|vboxnet|tun|utun|tailscale|wintun|zt|lo\d*)/i

let cachedDefault = null
let probing = false

function startDefaultRouteProbe() {
  if (probing || cachedDefault !== null) return
  probing = true
  try {
    const sock = dgram.createSocket('udp4')
    sock.once('error', () => { try { sock.close() } catch { /* noop */ }; probing = false })
    sock.connect(80, '1.1.1.1', () => {
      try {
        const addr = sock.address().address
        if (addr && addr !== '0.0.0.0') cachedDefault = addr
      } catch { /* noop */ }
      try { sock.close() } catch { /* noop */ }
      probing = false
    })
    setTimeout(() => { try { sock.close() } catch { /* noop */ }; probing = false }, 3000)
  } catch {
    probing = false
  }
}

export function localIPv4s() {
  const out = []
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (SKIP_NAMES.test(name)) continue
    for (const it of list || []) {
      if (it.family === 'IPv4' && !it.internal) out.push(it.address)
    }
  }
  return out.length ? out : ['127.0.0.1']
}

// 内网段优先级：192.168.* > 10.* > 172.16-31.* > 其他
function rank(a) {
  if (/^192\.168\./.test(a)) return 0
  if (/^10\./.test(a)) return 1
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(a)) return 2
  return 3
}

export function preferredIPv4() {
  startDefaultRouteProbe()
  if (cachedDefault && cachedDefault !== '0.0.0.0') return cachedDefault
  const addrs = localIPv4s()
  return [...addrs].sort((a, b) => rank(a) - rank(b))[0] ?? '127.0.0.1'
}

export function cpuLabel() {
  const c = os.cpus()
  return c.length ? `${c[0].model.trim()} x${c.length}` : 'unknown'
}

export function memGB() {
  return Math.round(os.totalmem() / 2 ** 30)
}

export function memFreeGB() {
  return Math.round((os.freemem() / 2 ** 30) * 10) / 10
}

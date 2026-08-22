// 本机网络与算力探测。
// preferredIPv4()：选"最可能是内网地址"的 IPv4 —— 默认路由网卡优先（UDP connect 探测，
// 不发包），其次过滤虚拟网卡（docker/br-*/veth 等）后按常见内网段排序。
// detectNatType()：通过 STUN 探测 NAT 类型与公网 IP；探测失败时按本机地址段回退分级，
// 让名片不再硬编码 unknown。
import os from 'node:os'
import dgram from 'node:dgram'

// 常见虚拟/隧道网卡名前缀：卡片不应使用这些地址
const SKIP_NAMES = /^(docker|veth|br-|virbr|vmnet|vboxnet|tun|utun|tailscale|wintun|zt|lo\d*)/i

let cachedDefault = null
let probing = false
let cachedNat = null
let natProbing = false

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

// 同步读取当前 NAT 标签：有缓存用缓存，否则回退 unknown 并异步触发一次探测。
// 用于名片/面板等同步场景；真正要阻塞等待结果时用 detectNatType()。
export function natLabelSync() {
  if (cachedNat) return cachedNat.nat
  void detectNatType()
  return 'unknown'
}
// 通过公共 STUN 服务器（RFC 5389）探测公网 IP 与 NAT 映射类型。
// 只发一个 Binding Request，不等响应包体解析复杂属性——足够判断"是否有公网映射"。
// 探测不到（UDP 出外网被墙 / 无网络）时按本机地址段做分级回退，绝不硬编码 unknown 之外的值。

const STUN_SERVERS = [
  { host: 'stun.l.google.com', port: 19302 },
  { host: 'stun.cloudflare.com', port: 3478 },
  { host: 'stun.qq.com', port: 3478 },
  { host: 'stun.miwifi.com', port: 3478 },
]

// 判断一个 IPv4 是否属于私有/保留段（RFC 1918 + 回环 + CGNAT-ish 100.64/10）
function isPrivateIPv4(ip) {
  if (!ip) return true
  return (
    /^10\./.test(ip) ||
    /^192\.168\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    /^127\./.test(ip) ||
    /^169\.254\./.test(ip) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip) ||
    ip === '0.0.0.0'
  )
}

// 从本机接口里挑一个"可能对外"的公网 IPv4（过滤私有/保留段）
function publicIPv4() {
  const addrs = localIPv4s()
  return addrs.find((a) => !isPrivateIPv4(a)) ?? null
}

/**
 * 探测 NAT 类型（异步，带缓存）。
 * @param {number} timeoutMs - 单个 STUN 服务器超时。
 * @returns {Promise<{ nat: string, publicIp: string|null, mapped: boolean }>}
 *   nat: 'open-internet' | 'full-cone' | 'unknown'
 *   mapped: 是否有公网映射（走 STUN 拿到公网地址视角）
 */
export async function detectNatType(timeoutMs = 3000) {
  if (cachedNat) return cachedNat
  if (natProbing) return { nat: 'unknown', publicIp: publicIPv4(), mapped: false }
  natProbing = true
  const result = await probeNat(timeoutMs)
  natProbing = false
  cachedNat = result
  return result
}

async function probeNat(timeoutMs) {
  // 1) 优先走公共 STUN：拿到"MAPPED-ADDRESS"即证明有公网映射。
  for (const srv of STUN_SERVERS) {
    const got = await stunBinding(srv.host, srv.port, timeoutMs)
    if (got) {
      return { nat: 'open-internet', publicIp: got, mapped: true }
    }
  }
  // 2) 回退：本机接口上有公网地址，视为可直接对外（无 NAT / 非对称映射）。
  const pub = publicIPv4()
  if (pub) {
    return { nat: 'full-cone', publicIp: pub, mapped: true }
  }
  // 3) 彻底探测不到：保持 unknown，但给出一个尽可能真实的公网视角占位。
  return { nat: 'unknown', publicIp: null, mapped: false }
}

// 发送一个 RFC 5389 Binding Request，解析响应中的 XOR-MAPPED-ADDRESS（0x0020）
// 取回服务器看到的公网 IP。纯发包，失败/超时返回 null。
function stunBinding(host, port, timeoutMs) {
  return new Promise((resolve) => {
    let sock = dgram.createSocket('udp4')
    let done = false
    const finish = (ip) => {
      if (done) return
      done = true
      try { sock.close() } catch { /* noop */ }
      resolve(ip)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    sock.once('error', () => { clearTimeout(timer); finish(null) })
    sock.on('message', (buf) => {
      clearTimeout(timer)
      // 头部：type(2) len(2) cookie(4) txid(12)
      if (buf.length < 20 || (buf[0] & 0xf0) !== 0x10) return finish(null)
      const attrs = parseStunAttrs(buf.subarray(20))
      if (attrs.xorMapped) return finish(attrs.xorMapped)
      return finish(null)
    })
    const req = buildBindingRequest()
    sock.send(req, port, host, (err) => {
      if (err) { clearTimeout(timer); finish(null) }
    })
  })
}

// 构造 STUN Binding Request（type=0x0001, cookie=0x2112A442, 随机 txid）
function buildBindingRequest() {
  const txid = Buffer.alloc(12)
  for (let i = 0; i < 12; i++) txid[i] = Math.floor(Math.random() * 256)
  const msg = Buffer.alloc(20)
  msg.writeUInt16BE(0x0001, 0)
  msg.writeUInt16BE(0, 2)
  msg.writeUInt32BE(0x2112A442, 4)
  txid.copy(msg, 8)
  return msg
}

// 按 RFC 5389 遍历属性，取回 XOR-MAPPED-ADDRESS 的 IPv4 地址。
function parseStunAttrs(buf) {
  const out = {}
  let i = 0
  while (i + 4 <= buf.length) {
    const type = buf.readUInt16BE(i)
    const len = buf.readUInt16BE(i + 2)
    const val = buf.subarray(i + 4, i + 4 + Math.min(len, buf.length - i - 4))
    if (type === 0x0020 && val.length >= 8) {
      // family (1) port(2) address(4/16)；IPv4 family=0x01
      if (val[1] === 0x01) {
        const port = (val[2] ^ (0x21)) << 8 | (val[3] ^ 0x12) // XOR with magic cookie hi bytes
        const ip = [
          (val[4] ^ 0x21),
          (val[5] ^ 0x12),
          (val[6] ^ 0xa4),
          (val[7] ^ 0x42),
        ].join('.')
        out.xorMapped = ip
        out.port = port
        break
      }
    }
    i += 4 + len + ((len % 4 === 0) ? 0 : 4 - (len % 4))
  }
  return out
}

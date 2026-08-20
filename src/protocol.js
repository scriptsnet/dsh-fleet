// 协议层：JSON-lines 报文 + HMAC-SHA256 证明。
// 永久 SK 永不通过线路明文传输，只在握手时用 challenge-response 证明持有。
import crypto from 'node:crypto'

export function hmac(sk, data) {
  return crypto.createHmac('sha256', String(sk)).update(String(data)).digest('hex')
}

export function encode(msg) {
  return JSON.stringify(msg) + '\n'
}

export function parseLine(line) {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

// 从 TCP 数据流中切出完整的 JSON-lines 消息
export function makeLineParser(onMessage) {
  let buf = ''
  return (chunk) => {
    buf += chunk.toString('utf8')
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      const msg = parseLine(line)
      if (msg) onMessage(msg)
    }
  }
}

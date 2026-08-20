#!/usr/bin/env node
// dsh-fleet CLI 入口
import { cmdInit, cmdCard, cmdWorker, cmdAdd, cmdRemove, cmdList, cmdTest, cmdWatch } from '../src/master.js'

const HELP = `dsh-fleet - 多机算力组网（MVP）

用法：
  dsh-fleet init [--port 47900]            初始化机器身份，打印名片
  dsh-fleet card [--port 47900]            只打印本机名片
  dsh-fleet worker --port 47900            开始监听（每台机器都要跑这个）
  dsh-fleet add "<名片字符串>"              入队：解析名片→联通性测试→握手→加入团队
  dsh-fleet add <名称> <host> <port> <sk>  同上（位置参数形式）
  dsh-fleet test <名称|名片>                只做联通性测试，不入队
  dsh-fleet list                           查看团队名录
  dsh-fleet remove <名称|machineId>        从团队移除
  dsh-fleet watch [--duration 10]          监控团队心跳（在线/离线/自动重连）

环境变量：
  DSH_FLEET_HOME   身份与名录目录（默认 ~/.dsh/fleet），本地多机模拟时可为每台机指定不同目录
`

function parseArgs(argv) {
  const out = { args: [], port: 47900, duration: 10 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--port') out.port = Number(argv[++i])
    else if (a === '--duration') out.duration = Number(argv[++i])
    else out.args.push(a)
  }
  return out
}

const [cmd, ...rest] = process.argv.slice(2)
const opts = parseArgs(rest)

switch (cmd) {
  case 'init': cmdInit(opts); break
  case 'card': cmdCard(opts); break
  case 'worker': cmdWorker(opts); break
  case 'add': await cmdAdd(opts); break
  case 'test': await cmdTest(opts); break
  case 'remove': cmdRemove(opts); break
  case 'list': cmdList(); break
  case 'watch': cmdWatch(opts); break
  case 'help': case '-h': case '--help': console.log(HELP); break
  default:
    console.log(HELP)
    process.exit(cmd ? 1 : 0)
}

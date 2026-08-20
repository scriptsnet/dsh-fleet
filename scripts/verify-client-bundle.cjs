// Verify the dsh-fleet client bundle registers via window.__ModuleLoader__.load
// the way the browser's dsh-client-modules loader expects (classic script +
// __ModuleLoader__.load({ id, factory }) where factory returns { inject, apply }).
'use strict'
const vm = require('node:vm')
const fs = require('node:fs')
const path = require('node:path')

const bundlePath = path.join(__dirname, '..', 'src', 'client.js')
const code = fs.readFileSync(bundlePath, 'utf8')

let handoff = null
const sandbox = {
  window: {
    __ModuleLoader__: {
      load: (h) => { handoff = h },
    },
  },
  document: undefined,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  MutationObserver: class {},
  fetch: () => Promise.reject(new Error('unexpected fetch in factory')),
}
vm.createContext(sandbox)
vm.runInContext(code, sandbox, { filename: 'client.js' })

if (handoff === null) {
  console.error('FAIL: bundle did not call window.__ModuleLoader__.load')
  process.exit(1)
}
if (handoff.id !== 'dsh-fleet') {
  console.error(`FAIL: registered id "${handoff.id}" != "dsh-fleet"`)
  process.exit(1)
}
const mod = handoff.factory((spec) => { throw new Error(`factory must not require("${spec}") — dsh-fleet has zero deps`) })
if (typeof mod !== 'object' || mod === null) {
  console.error('FAIL: factory did not return module.exports object')
  process.exit(1)
}
if (!Array.isArray(mod.inject) || mod.inject.join(',') !== 'slots') {
  console.error(`FAIL: exports.inject = ${JSON.stringify(mod.inject)}`)
  process.exit(1)
}
if (typeof mod.apply !== 'function') {
  console.error(`FAIL: exports.apply = ${typeof mod.apply}`)
  process.exit(1)
}
console.log('OK: registered id="dsh-fleet", factory returns inject=["slots"], apply=function')

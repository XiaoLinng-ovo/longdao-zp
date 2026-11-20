const net = require('node:net')
const dgram = require('node:dgram')
const assert = require('node:assert/strict')
assert.match(process.env.ISOLATED_TEST_CLUSTER || '', /^closure_[a-f0-9]{32}$/)
const ports = new Set((process.env.ISOLATED_ALLOWED_PORTS || '').split(',').map(Number))
assert.ok(ports.size && [...ports].every(port => Number.isInteger(port) && port > 0 && port <= 65535))
const connect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0]
  const port = Number(typeof options === 'object' ? options.port : options)
  const host = typeof options === 'object' ? options.host ?? 'localhost' : typeof args[1] === 'string' ? args[1] : 'localhost'
  assert.ok(['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host) && ports.has(port), '隔离测试阻止未授权网络连接')
  return connect.apply(this, args)
}
dgram.createSocket = () => { throw new Error('隔离测试禁止 UDP 出站') }
module.exports.allowLoopbackPort = port => {
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535)
  ports.add(port)
}

const net = require('node:net')
const assert = require('node:assert/strict')
const guard = require('./isolated-network-guard.cjs')
const emit = net.Server.prototype.emit

// Register only ports this child actually bound on loopback, before listening callbacks run.
net.Server.prototype.emit = function (name, ...args) {
  if (name === 'listening') {
    const address = this.address()
    assert.ok(address && typeof address === 'object' && ['127.0.0.1', '::1'].includes(address.address), '隔离测试只允许监听回环地址')
    guard.allowLoopbackPort(address.port)
  }
  return emit.call(this, name, ...args)
}

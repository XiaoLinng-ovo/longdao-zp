import assert from "node:assert/strict";
import test from "node:test";
import { publicPaymentIP, resolvePaymentAddresses } from "./network.js";

test("payment DNS preserves public answers without consulting a fallback", async () => {
  const addresses = [{address: "110.75.231.202", family: 4}];
  assert.deepEqual(await resolvePaymentAddresses("openapi.alipay.com", async () => addresses,
    async () => { throw Error("unexpected fallback"); }), addresses);
});

test("only exact Alipay gateways may resolve proxy Fake-IP through trusted DNS", async () => {
  for (const host of ["openapi.alipay.com", "openapi-sandbox.dl.alipaydev.com"]) {
    let calls = 0;
    const addresses = [{address: "110.75.231.202", family: 4}];
    assert.deepEqual(await resolvePaymentAddresses(host, async () => [{address: "198.18.1.51", family: 4}],
      async name => { assert.equal(name, host); calls++; return addresses; }), addresses);
    assert.equal(calls, 1);
  }
  for (const host of ["pay.example.com", "openapi.alipay.com.attacker.test", "localhost"]) {
    await assert.rejects(resolvePaymentAddresses(host, async () => [{address: "198.18.1.51", family: 4}],
      async () => { throw Error("unexpected fallback"); }), {code: "PAYMENT_ENDPOINT_BLOCKED"});
  }
});

test("payment DNS rejects private, mixed and invalid answers even for official hosts", async () => {
  for (const addresses of [[], [{address: "127.0.0.1", family: 4}],
    [{address: "198.18.1.51", family: 4}, {address: "10.0.0.1", family: 4}],
    [{address: "110.75.231.202", family: 4}, {address: "192.168.1.1", family: 4}],
    [{address: "110.75.231.202", family: 6}], [{address: "999.1.1.1", family: 4}]]) {
    await assert.rejects(resolvePaymentAddresses("openapi.alipay.com", async () => addresses,
      async () => { throw Error("unexpected fallback"); }), {code: "PAYMENT_ENDPOINT_BLOCKED"});
  }
  for (const address of ["127.0.0.1", "169.254.169.254", "198.19.1.1", "::1", "::ffff:127.0.0.1", "fc00::1", "invalid"])
    assert.equal(publicPaymentIP(address), false);
});

test("trusted DNS never authorizes a nonpublic or empty result", async () => {
  for (const addresses of [[], [{address: "127.0.0.1", family: 4}], [{address: "198.18.1.2", family: 4}]])
    await assert.rejects(resolvePaymentAddresses("openapi.alipay.com", async () => [{address: "198.18.1.51", family: 4}],
      async () => addresses), {code: "PAYMENT_ENDPOINT_BLOCKED"});
  await assert.rejects(resolvePaymentAddresses("openapi.alipay.com", async () => [{address: "198.18.1.51", family: 4}],
    async () => { throw Error("DNS unavailable"); }), /DNS unavailable/);
});

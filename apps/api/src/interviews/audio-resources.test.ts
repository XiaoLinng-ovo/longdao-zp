import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Readable } from 'node:stream'
import { access, rm } from 'node:fs/promises'
import { AudioWorkspace, audioResourceSnapshot, runAudioProcess } from './audio-resources.js'
import { runWithRuntimeSignal } from '@smartrecruit-pro/runtime-lifecycle'

test('运行时关停取消阻塞音频流和真实子进程并回收目录', async () => {
  const controller = new AbortController()
  await runWithRuntimeSignal(controller.signal, async () => {
    const workspace = await AudioWorkspace.create('transcription')
    const input = new Readable({ read() {} })
    const receiving = assert.rejects(workspace.receive('input', input, 8))
    const processing = assert.rejects(runAudioProcess(process.env.FFMPEG_PATH || 'ffmpeg', ['-re','-f','lavfi','-i','sine=sample_rate=16000','-t','600','-f','null','-']), /取消/)
    controller.abort()
    await Promise.all([receiving, processing])
    await workspace.close()
    assert.equal(input.destroyed, true)
    assert.equal(audioResourceSnapshot().childPids.length, 0)
    assert.ok(!audioResourceSnapshot().temporaryDirectories.includes(workspace.directory))
  })
})

test('临时音频空间有归属、真实字节限额，失败与重复关闭均可回收', async () => {
  const baseline = audioResourceSnapshot().temporaryReservedBytes
  const workspace = await AudioWorkspace.create('transcription')
  try {
    await assert.rejects(workspace.receive('input', Readable.from([Buffer.alloc(8)]), 4), /实际读取字节数/)
    assert.equal(audioResourceSnapshot().temporaryReservedBytes, baseline + 4)
    await assert.rejects(workspace.reserve('oversized', 17 * 1024 ** 3), /额度不足/)
  } finally { await workspace.close(); await workspace.close() }
  await assert.rejects(access(workspace.directory))
  assert.equal(audioResourceSnapshot().temporaryReservedBytes, baseline)
})

test('音频进程超时、输出超限和取消均等待子进程退出', async () => {
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg'
  const realtime = ['-re','-f','lavfi','-i','sine=frequency=440:sample_rate=16000','-t','600','-f','null','-']
  await assert.rejects(runAudioProcess(ffmpeg, realtime, { timeoutMs: 20 }), /超时/)
  assert.equal(audioResourceSnapshot().childPids.length, 0)
  await assert.rejects(runAudioProcess(ffmpeg, ['-f','lavfi','-i','sine=duration=0.1','-f','wav','pipe:1'], { maxOutputBytes: 1 }), /输出超过上限/)
  const controller = new AbortController()
  const work = runAudioProcess(ffmpeg, realtime, { signal: controller.signal })
  controller.abort()
  await assert.rejects(work, /取消/)
  assert.equal(audioResourceSnapshot().childPids.length, 0)
})

test('音频短读失败，文件名不能逃逸受管目录', async () => {
  const workspace = await AudioWorkspace.create('transcription')
  try {
    await assert.rejects(workspace.receive('input', Readable.from([Buffer.alloc(2)]), 4, undefined, 4), /读取不完整/)
    for (const name of ['../escape', 'a/b', 'owner.json']) await assert.rejects(workspace.receive(name, Readable.from([Buffer.alloc(1)]), 1), /申请无效/)
  } finally { await workspace.close() }
})

test('临时目录删除失败保留额度和归属，允许再次关闭', async () => {
  const baseline = audioResourceSnapshot().temporaryReservedBytes
  let attempts = 0
  const workspace = await AudioWorkspace.create('assembly', async (path, options) => {
    if (++attempts === 1) throw new Error('synthetic cleanup failure')
    await rm(path, options)
  })
  await workspace.reserve('input', 16)
  await assert.rejects(workspace.close(), /synthetic cleanup failure/)
  assert.equal(audioResourceSnapshot().temporaryReservedBytes, baseline + 16)
  assert.ok(audioResourceSnapshot().temporaryDirectories.includes(workspace.directory))
  const closing = workspace.close()
  assert.equal(workspace.close(), closing)
  await closing
  assert.equal(audioResourceSnapshot().temporaryReservedBytes, baseline)
  await assert.rejects(access(workspace.directory))
})

test('关闭会取消阻塞的输入并等待清理完成', async () => {
  const workspace = await AudioWorkspace.create('transcription')
  const input = new Readable({ read() {} })
  const receiving = workspace.receive('input', input, 8)
  const rejected = assert.rejects(receiving)
  await workspace.close()
  await rejected
  assert.equal(input.destroyed, true)
  assert.ok(!audioResourceSnapshot().temporaryDirectories.includes(workspace.directory))
})

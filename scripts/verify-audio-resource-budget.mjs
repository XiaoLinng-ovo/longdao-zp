import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { totalmem, freemem } from 'node:os'
import { resolve, join, relative, isAbsolute } from 'node:path'
import { createInterface } from 'node:readline'
import { createLocalObjectStorage } from '../packages/object-storage/dist/index.js'
import { FullInterviewAudio } from '../apps/api/dist/src/interviews/full-audio.js'
import { splitFullInterviewAudio, wavDurationMs } from '../apps/api/dist/src/interviews/full-audio-transcription.js'
import { audioResourceSnapshot, runAudioProcess } from '../apps/api/dist/src/interviews/audio-resources.js'
import { sendInterviewAudioStream } from '../apps/api/dist/src/interviews/audio-response.js'

// No environment loader, database, model client or remote storage is used here.
assert.equal(process.platform, 'win32', '本验收需要 Windows 进程树采样器，其他平台不能伪报完整资源统计')
const root = resolve(import.meta.dirname, '..'), MiB = 1024 * 1024
const durations = (process.env.AUDIO_VERIFY_DURATIONS || '30,120').split(',').map(Number)
assert.ok(durations.length >= 1 && durations.length <= 3 && durations.every(value => Number.isInteger(value) && value >= 1 && value <= 120))
const budget = Object.freeze({ taskTemporaryBytes: 1280 * MiB, sharedTemporaryBytes: 3072 * MiB,
  minFreeDiskBytes: 512 * MiB, processTreeRssBytes: Math.min(1536 * MiB, Math.floor(totalmem() / 4)),
  processTreeHandles: 2048, perChunkBytes: 2 * MiB, phaseTimeoutMs: 10 * 60_000, sampledCpuSeconds: 600 })
Object.assign(process.env, { AUDIO_TEMP_TASK_MAX_BYTES: String(budget.taskTemporaryBytes),
  AUDIO_TEMP_SHARED_MAX_BYTES: String(budget.sharedTemporaryBytes), AUDIO_TEMP_MIN_FREE_BYTES: String(budget.minFreeDiskBytes) })
await mkdir(join(root, 'tmp'), { recursive: true })
const directory = await mkdtemp(join(root, 'tmp', 'audio-stream-budget-'))
const stopPath = join(directory, 'monitor.stop'), data = join(directory, 'objects')
const diskBefore = await statfs(directory)
assert.ok(diskBefore.bavail * diskBefore.bsize > budget.sharedTemporaryBytes + budget.minFreeDiskBytes, '测试磁盘余量不足，停止生成')
const report = { startedAt: new Date().toISOString(), syntheticOnly: true, distinctRecordings: 2, externalCalls: 0,
  budget, machine: { totalMemoryBytes: totalmem(), freeMemoryBytesBefore: freemem(), freeDiskBytesBefore: diskBefore.bavail * diskBefore.bsize },
  phases: [], osSamples: 0, osSamplingErrors: [],
  limitations: ['进程树是定时采样，短命 ffmpeg 可能未被 OS 样本捕获，CPU 与 IO 是观察下界，不冒充精确总量。',
    '这是实际音频组件与本机 HTTP 下载链路，不包含业务数据库；连接池与锁等待由独立数据库场景验证。',
    '30/120 分钟表示合成录音时长，不是墙钟持续负载，也不是识别准确率验收。'],
  connectionPool: { applicable: false, reason: '资源脚本不创建数据库连接池' } }
const observedChildPids = new Set(), osChildPids = new Set()
const osPeak = { rssBytes: 0, handles: 0, observedCpuSeconds: 0, liveChildrenReadBytes: 0, liveChildrenWriteBytes: 0 }
let current, failure, timer, diskTimer, monitor, monitorExit, monitorError = '', server
const sample = () => {
  const snapshot = audioResourceSnapshot(), memory = process.memoryUsage()
  for (const id of snapshot.childPids) observedChildPids.add(id)
  if (!current) return
  current.nodePeakRssBytes = Math.max(current.nodePeakRssBytes, memory.rss)
  current.peakReservedBytes = Math.max(current.peakReservedBytes, snapshot.temporaryReservedBytes)
  current.peakChildren = Math.max(current.peakChildren, snapshot.childPids.length)
  if (snapshot.temporaryReservedBytes > budget.sharedTemporaryBytes || memory.rss > budget.processTreeRssBytes) {
    failure ??= new Error('音频资源超过预设内存或临时空间上限'); current.controller.abort(failure)
  }
}
async function sizeOf(path) {
  let sum = 0
  for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
    if (entry.isSymbolicLink()) throw new Error('合成目录中出现意外符号链接')
    const child = join(path, entry.name)
    sum += entry.isDirectory() ? await sizeOf(child) : (await stat(child).catch(() => ({ size: 0 }))).size
  }
  return sum
}
let diskSampling = Promise.resolve(), diskBusy = false
async function hashStream(body, delayMs = 0) {
  const hash = createHash('sha256'); let bytes = 0
  for await (const part of body) { hash.update(part); bytes += part.length; if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs)) }
  return { sha256: hash.digest('hex'), bytes }
}
try {
  await writeFile(join(directory, 'budget-before-run.json'), JSON.stringify({ budget, durations, machine: report.machine }, null, 2), { flag: 'wx' })
  monitor = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts/measure-audio-process-tree.ps1'), '-TargetProcessId', String(process.pid), '-StopPath', stopPath], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  monitorExit = new Promise((resolveExit, reject) => { monitor.once('error', reject); monitor.once('exit', code => resolveExit(code)) })
  monitorExit.catch(() => undefined)
  monitor.stderr.on('data', part => { monitorError += part.toString().slice(0, 2000) })
  createInterface({ input: monitor.stdout }).on('line', line => {
    try {
      const row = JSON.parse(line)
      if (row.type === 'sample') {
        report.osSamples++
        const rss = row.processes.reduce((sum, item) => sum + item.rssBytes, 0), handles = row.processes.reduce((sum, item) => sum + item.handles, 0)
        for (const item of row.processes) if (item.pid !== process.pid) osChildPids.add(item.pid)
        osPeak.rssBytes = Math.max(osPeak.rssBytes, rss); osPeak.handles = Math.max(osPeak.handles, handles)
        for (const key of ['observedCpuSeconds', 'liveChildrenReadBytes', 'liveChildrenWriteBytes']) osPeak[key] = Math.max(osPeak[key], row[key])
        if (current) { current.treePeakRssBytes = Math.max(current.treePeakRssBytes, rss); current.treePeakHandles = Math.max(current.treePeakHandles, handles) }
        if (rss > budget.processTreeRssBytes || handles > budget.processTreeHandles || row.observedCpuSeconds > budget.sampledCpuSeconds) {
          failure ??= new Error('进程树资源超过测前预算'); current?.controller.abort(failure)
        }
      } else if (row.type === 'connections') report.finalNodeTcpConnections = row.count
      else report.osSamplingErrors.push(row)
    } catch { report.osSamplingErrors.push({ type: 'invalid-sample' }) }
  })
  timer = setInterval(sample, 25)
  diskTimer = setInterval(() => {
    if (!current || diskBusy) return
    diskBusy = true
    const phase = current
    diskSampling = (async () => {
      let bytes = 0
      for (const path of audioResourceSnapshot().temporaryDirectories) bytes += await sizeOf(path)
      phase.peakActualTemporaryBytes = Math.max(phase.peakActualTemporaryBytes, bytes)
      const free = await statfs(directory)
      phase.minFreeDiskBytes = Math.min(phase.minFreeDiskBytes, free.bavail * free.bsize)
      if (bytes > budget.sharedTemporaryBytes || free.bavail * free.bsize < budget.minFreeDiskBytes) {
        failure ??= new Error('实际临时磁盘或可用余量越过安全门槛'); phase.controller.abort(failure)
      }
    })().catch(error => { failure ??= error; phase.controller.abort(error) }).finally(() => { diskBusy = false })
  }, 500)
  const sessions = new Map()
  server = createServer((request, response) => {
    const entry = sessions.get(request.url?.slice(1))
    if (!entry) { response.writeHead(404).end(); return }
    const controller = new AbortController()
    response.once('close', () => controller.abort())
    void entry.service.loadStream(entry.sessionId, entry.manifest, 'all', controller.signal)
      .then(audio => sendInterviewAudioStream(response, audio, 'audio/mp4', request.headers.range, controller.signal))
      .catch(() => response.destroy())
  })
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  const base = 'http://127.0.0.1:' + server.address().port
  for (const minutes of durations) {
    if (failure) throw failure
    const controller = new AbortController(), deadline = setTimeout(() => controller.abort(new Error('阶段超时')), budget.phaseTimeoutMs)
    const phase = { minutes, recordings: [], startedAt: new Date().toISOString(), nodeBaselineRssBytes: process.memoryUsage().rss,
      nodePeakRssBytes: 0, treePeakRssBytes: 0, treePeakHandles: 0, peakReservedBytes: 0,
      peakActualTemporaryBytes: 0, minFreeDiskBytes: Number.MAX_SAFE_INTEGER, peakChildren: 0, stages: [], controller }
    current = phase
    const started = performance.now(), cpu = process.cpuUsage(), services = []
    try {
      const tasks = []
      for (const [index, frequency] of [440, 880].entries()) {
        const stage = { index, stage: '生成合成原音频', startedAt: new Date().toISOString() }
        phase.stages.push(stage)
        const sessionId = randomUUID(), folder = join(data, sessionId)
        await mkdir(folder, { recursive: true })
        await runAudioProcess(process.env.FFMPEG_PATH || 'ffmpeg', ['-y', '-f','lavfi','-i','sine=frequency=' + frequency + ':sample_rate=16000',
          '-t', String(minutes * 60), '-c:a','aac','-b:a','24k','-f','segment','-segment_time','300','-reset_timestamps','1',join(folder,'source-%03d.m4a')], { signal: controller.signal, timeoutMs: 120000 })
        const manifest = []
        for (const [part, name] of (await readdir(folder)).filter(name => /^source-[0-9]+\.m4a$/.test(name)).sort().entries()) {
          manifest.push({ id: randomUUID(), sessionId, sessionStartedAt: phase.startedAt, createdAt: phase.startedAt,
            objectKey: sessionId + '/' + name, offsetMs: part * 300000, endMs: (part + 1) * 300000, byteLength: (await stat(join(folder,name))).size, contentType: 'audio/mp4', audioSource: 'microphone' })
        }
        assert.ok(manifest.length)
        const objects = createLocalObjectStorage(data); let writes = 0
        const storage = { read: async () => { throw new Error('禁止整份读取') }, write: async () => { throw new Error('禁止整份写入') },
          openRead: objects.openRead.bind(objects), writeStream: async (...args) => { writes++; await objects.putStream(...args) } }
        const service = new FullInterviewAudio(storage); services.push(service)
        const entry = { sessionId, service, manifest }; sessions.set(sessionId, entry)
        stage.stage = '等待并发开始'
        tasks.push(async () => {
          stage.stage = '生成整场音频'
          const generated = await service.loadStream(sessionId, manifest, 'all', controller.signal)
          stage.stage = '读取生成结果'
          const expected = await hashStream(generated.body)
          stage.stage = '验证缓存重用'
          const cached = await service.loadStream(sessionId, manifest, 'all', controller.signal)
          assert.deepEqual(await hashStream(cached.body), expected)
          stage.stage = '验证本机下载'
          const response = await fetch(base + '/' + sessionId, { signal: controller.signal })
          assert.equal(response.status, 200)
          assert.deepEqual(await hashStream(response.body, 1), expected)
          let chunks = 0, durationMs = 0, maxChunkBytes = 0
          stage.stage = '逐片读取转写输入'
          const input = await service.loadStream(sessionId, manifest, 'all', controller.signal)
          for await (const chunk of splitFullInterviewAudio(input, undefined, controller.signal)) {
            chunks++; durationMs += wavDurationMs(chunk); maxChunkBytes = Math.max(maxChunkBytes, chunk.length)
            assert.ok(chunk.length <= budget.perChunkBytes)
          }
          assert.ok(chunks >= minutes && chunks <= minutes + 1)
          assert.ok(Math.abs(durationMs - minutes * 60000) < 2000)
          assert.equal(writes, 1, '同版本生成、缓存、下载、转写只能持久写一次')
          stage.stage = '完成'
          stage.completedAt = new Date().toISOString()
          return { index, frequency, sessionId, originalObjects: manifest.length, compressedBytes: expected.bytes,
            sha256: expected.sha256, cacheReused: true, downloadHashMatched: true, chunks, durationMs, maxChunkBytes, writes }
        })
      }
      const outcomes = await Promise.allSettled(tasks.map(task => task()))
      for (const result of outcomes) if (result.status === 'rejected') throw result.reason
      phase.recordings = outcomes.map(result => result.value)
      assert.notEqual(phase.recordings[0].sha256, phase.recordings[1].sha256)
      if (failure) throw failure
      phase.passed = true
    } catch (error) {
      phase.error = { message: error.message, stack: error.stack }
      throw error
    } finally {
      clearTimeout(deadline); controller.abort()
      await Promise.all(services.map(service => service.close()))
      await diskSampling
      phase.durationMs = performance.now() - started; phase.nodeCpuMicroseconds = process.cpuUsage(cpu)
      phase.resourcesAfterClose = audioResourceSnapshot()
      assert.equal(phase.resourcesAfterClose.temporaryReservedBytes, 0)
      assert.equal(phase.resourcesAfterClose.childPids.length, 0)
      assert.equal(phase.resourcesAfterClose.temporaryDirectories.length, 0)
      const { controller: _controller, ...record } = phase
      report.phases.push(record); current = undefined; sessions.clear()
      await rm(data, { recursive: true, force: true })
    }
  }
  assert.ok(report.osSamples > 0 && osChildPids.size > 0, '没有取得 ffmpeg OS 样本，不能判定资源验收通过')
  assert.equal(report.osSamplingErrors.length, 0, '资源采样存在错误')
  report.passed = true
} catch (error) { report.passed = false; report.error = error.message; report.errorStack = error.stack; process.exitCode = 1 }
finally {
  clearInterval(timer); clearInterval(diskTimer)
  await diskSampling
  if (server?.listening) { server.closeAllConnections(); await new Promise(resolveClose => server.close(() => resolveClose())) }
  await writeFile(stopPath, 'stop', { flag: 'wx' })
  if (monitorExit) {
    const force = setTimeout(() => monitor.kill(), 15000)
    try { report.monitorExitCode = await monitorExit } catch (error) { report.monitorError = error.message }
    finally { clearTimeout(force) }
  }
  if (report.monitorExitCode !== 0 || monitorError) { report.passed = false; report.monitorStderr = monitorError; process.exitCode = 1 }
  report.processTree = { peak: osPeak, ffmpegPidsSeenByNode: [...observedChildPids], ffmpegPidsSampledByOS: [...osChildPids], samplingIsExact: false }
  report.completedAt = new Date().toISOString()
  const child = relative(directory, data)
  assert.ok(child && !child.startsWith('..') && !isAbsolute(child))
  await rm(data, { recursive: true, force: true })
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' })
  console.log(JSON.stringify({ ...report, reportPath: join(directory, 'report.json') }, null, 2))
}

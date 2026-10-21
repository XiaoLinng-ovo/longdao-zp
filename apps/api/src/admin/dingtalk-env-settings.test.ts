import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readDingTalkEnvSettings, updateDingTalkEnvSettings, readResumeVirusScanSetting, updateResumeVirusScanSetting, DINGTALK_ENV_KEYS } from './dingtalk-env-settings.js'

const original = { ...process.env }

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]
  for (const [key, value] of Object.entries(original)) process.env[key] = value
})

describe('DingTalk env settings', () => {
  it('reads only supported keys and masks secret values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'smartrecruit-dingtalk-'))
    const file = join(root, '.env')
    await writeFile(file, 'DINGTALK_APP_KEY=app-key\nDINGTALK_APP_SECRET=super-secret\nOTHER=value\n', 'utf8')
    const result = await readDingTalkEnvSettings(file)
    assert.deepEqual(Object.keys(result), DINGTALK_ENV_KEYS)
    assert.equal(result.DINGTALK_APP_KEY.value, 'app-key')
    assert.equal(result.DINGTALK_APP_SECRET.value, 'su••••et')
    assert.equal(result.DINGTALK_APP_SECRET.configured, true)
  })

  it('updates supported values, preserves unrelated lines, and updates process.env', async () => {
    const root = await mkdtemp(join(tmpdir(), 'smartrecruit-dingtalk-'))
    const file = join(root, '.env')
    await writeFile(file, '# keep me\nOTHER=value\nDINGTALK_APP_SECRET=old\n', 'utf8')
    await updateDingTalkEnvSettings(file, { DINGTALK_APP_SECRET: 'new-secret', DINGTALK_CALLBACK_TOKEN: 'callback-token' })
    const content = await readFile(file, 'utf8')
    assert.match(content, /# keep me/)
    assert.match(content, /OTHER=value/)
    assert.match(content, /DINGTALK_APP_SECRET=new-secret/)
    assert.match(content, /DINGTALK_CALLBACK_TOKEN=callback-token/)
    assert.equal(process.env.DINGTALK_APP_SECRET, 'new-secret')
    assert.equal(process.env.DINGTALK_CALLBACK_TOKEN, 'callback-token')
  })

  it('rejects unknown keys and unsafe newlines', async () => {
    const root = await mkdtemp(join(tmpdir(), 'smartrecruit-dingtalk-'))
    const file = join(root, '.env')
    await assert.rejects(updateDingTalkEnvSettings(file, { DATABASE_URL: 'oops' } as never), /不支持的钉钉配置项/)
    await assert.rejects(updateDingTalkEnvSettings(file, { DINGTALK_APP_KEY: 'a\nb' }), /不能包含换行符/)
  })

  it('defaults virus scanning to disabled and persists the settings-page toggle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'smartrecruit-scan-setting-'))
    const file = join(root, '.env')
    assert.equal(await readResumeVirusScanSetting(file), false)
    await updateResumeVirusScanSetting(file, true)
    assert.equal(await readResumeVirusScanSetting(file), true)
    assert.match(await readFile(file, 'utf8'), /RESUME_VIRUS_SCAN_ENABLED=true/)
    await updateResumeVirusScanSetting(file, false)
    assert.equal(await readResumeVirusScanSetting(file), false)
    assert.match(await readFile(file, 'utf8'), /RESUME_VIRUS_SCAN_ENABLED=false/)
  })
})

# Channel Integration Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an admin-configurable channel integration foundation for BOSS直聘、猎聘、前程无忧 and 公司官网 without pretending unavailable platform APIs are connected.

**Architecture:** Provider definitions and masked environment settings live behind a channel settings service. A connector registry exposes typed test/publish/pull/webhook interfaces. The administration page renders one provider card per channel and saves write-only secrets to the existing `.env` mechanism.

**Tech Stack:** TypeScript, Node HTTP API, Vue 3, Vitest, Node test runner, PostgreSQL migration.

## Global Constraints

- Only `admin` and `hr_admin` may read or change channel settings.
- Secrets must be write-only from the browser and masked when read.
- Missing credentials or unimplemented provider protocols must return `not_configured` or `not_implemented`; never fake a successful connection.
- Provider base URLs use configured values only after validation and must reject credentials in URLs.
- Do not log AppSecret, webhook token, signing secret or full request bodies.

---

### Task 1: Channel Provider Definitions

**Files:**
- Create: `apps/api/src/integrations/channels/types.ts`
- Create: `apps/api/src/integrations/channels/providers.ts`
- Test: `apps/api/src/integrations/channels/providers.test.ts`

**Interfaces:**
- Produces: `CHANNEL_PROVIDERS`, `ChannelProvider`, `ChannelEnvKey`, `ChannelConnectionInput`.
- Produces: `channelEnvKeys(provider): readonly ChannelEnvKey[]`.
- Produces: `channelProviderDefinition(provider): ChannelProviderDefinition`.

- [x] **Step 1: Write the failing provider test**

```ts
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CHANNEL_PROVIDERS, channelEnvKeys, channelProviderDefinition } from './providers.js'

describe('channel provider definitions', () => {
  it('defines exactly the approved channels in display order', () => {
    assert.deepEqual(CHANNEL_PROVIDERS.map((item) => item.id), ['boss', 'liepin', '51job', 'official_site'])
  })

  it('marks secrets and emits a stable environment key set', () => {
    const boss = channelProviderDefinition('boss')
    assert.equal(boss.fields.find((field) => field.key.endsWith('_APP_SECRET'))?.secret, true)
    assert.deepEqual(channelEnvKeys('boss').slice(0, 5), [
      'CHANNEL_BOSS_ENABLED',
      'CHANNEL_BOSS_BASE_URL',
      'CHANNEL_BOSS_APP_KEY',
      'CHANNEL_BOSS_APP_SECRET',
      'CHANNEL_BOSS_WEBHOOK_TOKEN',
    ])
  })
})
```

- [x] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @smartrecruit-pro/api test -- --test-name-pattern="channel provider definitions"`

Expected: build or test fails because `providers.ts` does not exist.

- [x] **Step 3: Add provider types and definitions**

```ts
export type ChannelProvider = 'boss' | 'liepin' | '51job' | 'official_site'
export type ChannelEnvKey =
  | `CHANNEL_${string}_ENABLED`
  | `CHANNEL_${string}_BASE_URL`
  | `CHANNEL_${string}_APP_KEY`
  | `CHANNEL_${string}_APP_SECRET`
  | `CHANNEL_${string}_WEBHOOK_TOKEN`
  | `CHANNEL_${string}_SIGNING_SECRET`
```

Implement the provider array with labels, capabilities and fields. Secrets are `APP_SECRET`, `WEBHOOK_TOKEN` and `SIGNING_SECRET`.

- [x] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @smartrecruit-pro/api test -- --test-name-pattern="channel provider definitions"`

Expected: PASS.

---

### Task 2: Masked Settings Service

**Files:**
- Create: `apps/api/src/integrations/channels/settings.ts`
- Test: `apps/api/src/integrations/channels/settings.test.ts`

**Interfaces:**
- Consumes: `CHANNEL_PROVIDERS`, `channelEnvKeys`, `ChannelProvider`.
- Produces: `readChannelSettings(filePath?)`, `updateChannelSettings(filePath, patch)`, `describeChannelSettings`.

- [x] **Step 1: Write failing tests for validation and masking**

```ts
it('masks secrets and never returns raw secret values', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'channel-settings-'))
  const file = join(directory, '.env')
  await writeFile(file, 'CHANNEL_BOSS_APP_KEY=key\nCHANNEL_BOSS_APP_SECRET=very-secret\n')
  const result = await readChannelSettings(file)
  assert.equal(result.boss.values.CHANNEL_BOSS_APP_KEY.value, 'key')
  assert.equal(result.boss.values.CHANNEL_BOSS_APP_SECRET.value, 've••••et')
})

it('rejects newlines and unsupported keys', async () => {
  await assert.rejects(() => updateChannelSettings(file, { CHANNEL_BOSS_APP_SECRET: 'x\ny' }), /不能包含换行/)
  await assert.rejects(() => updateChannelSettings(file, { UNKNOWN: 'x' }), /不支持/)
})
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @smartrecruit-pro/api test -- --test-name-pattern="channel settings"`

Expected: FAIL because the module does not exist.

- [x] **Step 3: Implement the settings service using `readEnvValues` and `writeEnvFile`**

Validate keys against the provider field list, reject newlines, mask secret values, and return per-provider `configured`, `enabled`, `missing` and `fields`.

- [x] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @smartrecruit-pro/api test -- --test-name-pattern="channel settings"`

Expected: PASS.

---

### Task 3: Connector Registry and Fail-Closed Adapters

**Files:**
- Create: `apps/api/src/integrations/channels/connector.ts`
- Create: `apps/api/src/integrations/channels/registry.ts`
- Create: `apps/api/src/integrations/channels/official-site-connector.ts`
- Test: `apps/api/src/integrations/channels/registry.test.ts`

**Interfaces:**
- Consumes: `ChannelProvider`, `ChannelConnectionInput`.
- Produces: `ChannelConnector`, `ChannelConnectorError`, `createChannelConnector(provider)`.

- [x] **Step 1: Write failing connector tests**

```ts
it('fails closed when credentials are absent', async () => {
  const result = await createChannelConnector('boss').test({ enabled: true, baseUrl: '', appKey: '', appSecret: '', webhookToken: '', signingSecret: '' })
  assert.equal(result.status, 'not_configured')
})

it('accepts an official-site inbound webhook only with a valid HMAC signature', async () => {
  const connector = createChannelConnector('official_site')
  const body = Buffer.from('{"name":"张三"}')
  const timestamp = '1789927200'
  const signature = signOfficialSiteWebhook('secret', timestamp, body)
  assert.equal((await connector.verifyWebhook({ body, timestamp, signature, secret: 'secret' })).ok, true)
  assert.equal((await connector.verifyWebhook({ body, timestamp, signature: 'bad', secret: 'secret' })).ok, false)
})
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @smartrecruit-pro/api test -- --test-name-pattern="channel connector"`

Expected: FAIL because the registry and connector interface do not exist.

- [x] **Step 3: Implement typed connector contracts**

Use a shared result shape:

```ts
export interface ChannelOperationResult {
  status: 'ok' | 'not_configured' | 'not_implemented' | 'error'
  message: string
}
```

Implement official-site HMAC verification with `createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex')`.

- [x] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @smartrecruit-pro/api test -- --test-name-pattern="channel connector"`

Expected: PASS.

---

### Task 4: Admin API Routes

**Files:**
- Modify: `apps/api/src/admin/service.ts`
- Modify: `apps/api/src/routes.ts`
- Test: `apps/api/src/admin/channel-settings.test.ts`

**Interfaces:**
- Consumes: `readChannelSettings`, `updateChannelSettings`, `createChannelConnector`.
- Produces: `AdminService.getChannelSettings()`, `AdminService.updateChannelSettings()`, `AdminService.testChannelConnection(provider)`.

- [x] **Step 1: Write failing service tests**

```ts
it('returns masked channel settings without exposing app secrets', async () => {
  const service = new AdminService(pool)
  const settings = await service.getChannelSettings()
  assert.equal(settings.boss.fields.find((field) => field.key.endsWith('_APP_SECRET'))?.secret, true)
})
```

- [x] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @smartrecruit-pro/api test -- --test-name-pattern="channel settings service"`

Expected: FAIL because the AdminService methods are missing.

- [x] **Step 3: Add methods and routes**

Add `GET /api/v1/admin/channel-settings`, `PATCH /api/v1/admin/channel-settings`, and `POST /api/v1/admin/channel-connections/:provider/test`. Restrict all three to `ADMIN_ROLES`.

- [x] **Step 4: Run API tests**

Run: `pnpm --filter @smartrecruit-pro/api test`

Expected: PASS.

---

### Task 5: Administration Settings Component

**Files:**
- Create: `web/src/modules/administration/components/ChannelIntegrationSettings.vue`
- Create: `web/src/modules/administration/components/ChannelIntegrationSettings.test.ts`
- Modify: `web/src/modules/administration/api/index.ts`
- Modify: `web/src/modules/administration/pages/AdministrationPage.vue`

**Interfaces:**
- Consumes: `/admin/channel-settings`, `/admin/channel-connections/:provider/test`.
- Produces: a provider card grid with save/test actions and masked secret placeholders.

- [x] **Step 1: Write failing component tests**

```ts
it('renders every provider and keeps secrets masked on save', async () => {
  mockGet.mockResolvedValue(channelSettingsFixture)
  const root = mountComponent()
  await flush()
  expect(root.textContent).toContain('BOSS直聘')
  expect(root.querySelector('input[type="password"]')).not.toBeNull()
  const save = [...root.querySelectorAll('button')].find((button) => button.textContent === '保存渠道配置')!
  save.click()
  await flush()
  expect(mockPatch).toHaveBeenCalled()
})
```

- [x] **Step 2: Run the test to verify it fails**

Run: `pnpm --dir web test -- ChannelIntegrationSettings`

Expected: FAIL because the component does not exist.

- [x] **Step 3: Implement the component and API functions**

Render one card per provider. Secret inputs start empty and show masked placeholders. Save sends only non-empty fields. Test buttons never mark unimplemented providers as connected.

- [x] **Step 4: Run web tests and typecheck**

Run: `pnpm --dir web test -- ChannelIntegrationSettings`

Run: `pnpm --dir web typecheck`

Expected: PASS.

---

### Task 6: Schema, Environment Documentation and Verification

**Files:**
- Create: `db/migrations/0019_channel_integrations.sql`
- Modify: `.env.example`
- Modify: `README.md`

- [x] **Step 1: Add future-facing tables**

Create `channel_connections`, `job_channel_publications`, `channel_resume_events`, and `channel_sync_runs` with UUID keys, provider checks, idempotency constraints and timestamps.

- [x] **Step 2: Document all environment keys**

Add commented `CHANNEL_BOSS_*`, `CHANNEL_LIEPIN_*`, `CHANNEL_51JOB_*`, and `CHANNEL_OFFICIAL_SITE_*` entries to `.env.example`.

- [x] **Step 3: Run full focused verification**

Run: `pnpm --filter @smartrecruit-pro/api test`

Run: `pnpm --dir web test`

Run: `pnpm --dir web typecheck`

Run: `git diff --check`

Expected: all commands pass.

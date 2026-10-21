# Shared JSON API client

`web/src/shared/api/` 是正式前端与 SmartRecruit Pro API 之间的传输边界。业务页面和领域模块不直接调用 `fetch`，只通过这里的客户端发起 JSON 请求。

## 约定

- 默认 API 根路径为 `/api/v1`；调用时传 `/health` 或 `health` 均可。
- 成功响应必须是 `{ ok: true, data, requestId, meta? }`。
- 失败响应使用 `{ ok: false, error: { code, message, ... }, requestId }`，客户端统一转换为 `ApiClientError` 并抛出。
- 服务器返回的 `x-request-id` 优先于 JSON body 中的 `requestId`，用于日志和问题定位。
- 默认 `credentials: 'include'`，以支持服务端 Session Cookie。
- HTTP 401 抛出 `ApiAuthenticationError`，HTTP 403 抛出 `ApiForbiddenError`；客户端不自动跳转、不伪造登录状态。
- 网络失败、JSON 解析失败和响应契约错误分别以 `ApiNetworkError`、`ApiParseError` 和 `ApiProtocolError` 表示。

## 用法

```ts
import { getJson, postJson } from '@/shared/api'

const health = await getJson<{ status: string }>('/health')
console.log(health.data, health.requestId)

const created = await postJson<{ id: string }, { title: string }>(
  '/jobs',
  { title: '后端工程师' },
)
console.log(created.data)
```

需要独立 API 地址或测试注入时使用 `createApiClient`：

```ts
const client = createApiClient({
  baseUrl: 'http://localhost:3100/api/v1',
  fetcher: mockedFetch,
})
```

客户端只负责传输、响应解包和错误归一化；认证守卫、页面提示、重试策略和业务状态变更由更上层模块实现。

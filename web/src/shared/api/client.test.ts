import { describe, expect, it, vi } from 'vitest'
import {
  ApiAuthenticationError,
  ApiClientError,
  ApiForbiddenError,
  ApiHttpError,
  ApiNetworkError,
  ApiParseError,
  ApiProtocolError,
  ApiResponseError,
  createApiClient,
} from './index'

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const status = init.status ?? 200
  const bodyNotAllowed = status === 204 || status === 205 || status === 304
  return new Response(bodyNotAllowed || body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...init.headers },
    ...init,
  })
}

function makeFetchMock(response: Response | Error | (() => Response)) {
  const fetcher = vi.fn()
  if (response instanceof Error) {
    fetcher.mockRejectedValue(response)
  } else if (typeof response === 'function') {
    fetcher.mockImplementation(response)
  } else {
    fetcher.mockImplementation(async () => response.clone())
  }
  return fetcher
}

function requestInit(fetcher: ReturnType<typeof vi.fn>): RequestInit {
  const init = fetcher.mock.calls[0]?.[1]
  expect(init).toBeDefined()
  return init as RequestInit
}

describe('shared JSON API client', () => {
  it('把空响应体的 5xx 判定为后端不可达，而不是笼统的请求失败', async () => {
    const fetcher = makeFetchMock(new Response(null, { status: 500 }))
    const client = createApiClient({ baseUrl: '/api/v1', fetcher })
    await expect(client.getJson('/jobs')).rejects.toBeInstanceOf(ApiNetworkError)
    await expect(client.getJson('/jobs')).rejects.toThrow(/无法连接后端服务/)
  })

  it('保留 API 自身返回的 5xx 错误信封文案', async () => {
    const fetcher = makeFetchMock(jsonResponse({ ok: false, error: { code: 'INTERNAL_ERROR', message: '服务器内部错误' } }, { status: 500 }))
    const client = createApiClient({ baseUrl: '/api/v1', fetcher })
    await expect(client.getJson('/jobs')).rejects.toThrow('服务器内部错误')
  })

  it('uses /api/v1 by default and preserves request id from the response header', async () => {
    const fetcher = makeFetchMock(
      jsonResponse(
        {
          ok: true,
          data: { status: 'ok' },
          requestId: 'body-request-id',
          meta: { warnings: [] },
        },
        { headers: { 'x-request-id': 'header-request-id' } },
      ),
    )
    const client = createApiClient({ fetcher: fetcher as typeof globalThis.fetch })

    const result = await client.getJson<{ status: string }>('/health')

    expect(result).toEqual({
      ok: true,
      data: { status: 'ok' },
      requestId: 'header-request-id',
      meta: { warnings: [] },
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/v1/health')

    const init = requestInit(fetcher)
    expect(init.method).toBe('GET')
    expect(init.credentials).toBe('include')
    const headers = new Headers(init.headers)
    expect(headers.get('accept')).toBe('application/json')
    expect(headers.get('content-type')).toBeNull()
  })

  it('supports relative paths with or without a leading slash and custom base URLs', async () => {
    const fetcher = makeFetchMock(() => jsonResponse({ ok: true, data: 1, requestId: 'req-1' }))
    const client = createApiClient({ baseUrl: 'http://localhost:3100/api/v1', fetcher: fetcher as typeof globalThis.fetch })

    await client.getJson<number>('health')
    expect(fetcher.mock.calls[0]?.[0]).toBe('http://localhost:3100/api/v1/health')

    await client.getJson<number>('/api/v1/health')
    expect(fetcher.mock.calls[1]?.[0]).toBe('http://localhost:3100/api/v1/health')
  })

  it('serializes JSON bodies and supports POST, PUT and DELETE', async () => {
    const fetcher = vi.fn()
    fetcher
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { id: 'job-1' }, requestId: 'post-1' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { id: 'job-1' }, requestId: 'put-1' }))
      .mockResolvedValueOnce(new Response(null, { status: 204, headers: { 'x-request-id': 'delete-1' } }))
    const client = createApiClient({ fetcher: fetcher as typeof globalThis.fetch })

    await client.postJson<{ id: string }>('/jobs', { title: '后端工程师' })
    await client.putJson<{ id: string }>('/jobs/job-1', { title: '高级后端工程师' }, { headers: { 'x-test': '1' } })
    await client.deleteJson<void>('/jobs/job-1')

    const postInit = requestInit(fetcher)
    // The helper above reads the first call; use the calls directly for the remaining assertions.
    expect(postInit.method).toBe('POST')
    expect(postInit.body).toBe(JSON.stringify({ title: '后端工程师' }))
    expect(new Headers(postInit.headers).get('content-type')).toBe('application/json; charset=utf-8')

    const putInit = fetcher.mock.calls[1]?.[1] as RequestInit
    expect(putInit.method).toBe('PUT')
    expect(putInit.body).toBe(JSON.stringify({ title: '高级后端工程师' }))
    expect(new Headers(putInit.headers).get('x-test')).toBe('1')

    const deleteInit = fetcher.mock.calls[2]?.[1] as RequestInit
    expect(deleteInit.method).toBe('DELETE')
    expect(deleteInit.body).toBeUndefined()
  })

  it('throws a structured API error for ok:false JSON responses', async () => {
    const fetcher = makeFetchMock(
      jsonResponse(
        {
          ok: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: '岗位标题不能为空',
            details: { field: 'title' },
            fieldErrors: [{ field: 'title', messages: ['必填'] }],
            retryable: false,
          },
          requestId: 'body-request-id',
        },
        { status: 422, headers: { 'x-request-id': 'header-request-id' } },
      ),
    )
    const client = createApiClient({ fetcher: fetcher as typeof globalThis.fetch })

    const promise = client.postJson('/jobs', {})
    await expect(promise).rejects.toBeInstanceOf(ApiResponseError)

    try {
      await promise
    } catch (error) {
      expect(error).toBeInstanceOf(ApiClientError)
      expect(error).toMatchObject({
        kind: 'api',
        status: 422,
        code: 'VALIDATION_ERROR',
        message: '岗位标题不能为空',
        requestId: 'header-request-id',
        details: { field: 'title' },
        fieldErrors: [{ field: 'title', messages: ['必填'] }],
        retryable: false,
      })
    }
  })

  it('maps HTTP 401 and 403 to dedicated errors while keeping request ids', async () => {
    const unauthenticatedFetch = makeFetchMock(
      jsonResponse(
        { ok: false, error: { code: 'AUTHENTICATION_REQUIRED', message: '未登录' }, requestId: 'auth-1' },
        { status: 401 },
      ),
    )
    const forbiddenFetch = makeFetchMock(
      jsonResponse(
        { ok: false, error: { code: 'FORBIDDEN', message: '无权限' }, requestId: 'forbidden-1' },
        { status: 403 },
      ),
    )

    const authenticationError = await createApiClient({ fetcher: unauthenticatedFetch as typeof globalThis.fetch })
      .getJson('/me')
      .catch((error: unknown) => error)
    const forbiddenError = await createApiClient({ fetcher: forbiddenFetch as typeof globalThis.fetch })
      .getJson('/admin')
      .catch((error: unknown) => error)

    expect(authenticationError).toBeInstanceOf(ApiAuthenticationError)
    expect(authenticationError).toMatchObject({ status: 401, code: 'AUTHENTICATION_REQUIRED', requestId: 'auth-1' })
    expect(forbiddenError).toBeInstanceOf(ApiForbiddenError)
    expect(forbiddenError).toMatchObject({ status: 403, code: 'FORBIDDEN', requestId: 'forbidden-1' })
  })

  it('turns transport failures into a retryable network error', async () => {
    const cause = new TypeError('Failed to fetch')
    const client = createApiClient({ fetcher: makeFetchMock(cause) as typeof globalThis.fetch })

    const promise = client.getJson('/health')
    await expect(promise).rejects.toBeInstanceOf(ApiNetworkError)
    await expect(promise).rejects.toMatchObject({ kind: 'network', retryable: true, cause })
  })

  it('reports invalid JSON and malformed successful envelopes as client errors', async () => {
    const parseClient = createApiClient({
      fetcher: makeFetchMock(new Response('not-json', { status: 502, headers: { 'x-request-id': 'parse-1' } })) as typeof globalThis.fetch,
    })
    await expect(parseClient.getJson('/health')).rejects.toBeInstanceOf(ApiParseError)
    await expect(parseClient.getJson('/health')).rejects.toMatchObject({ status: 502, requestId: 'parse-1' })

    const protocolClient = createApiClient({
      fetcher: makeFetchMock(jsonResponse({ ok: true, requestId: 'protocol-1' })) as typeof globalThis.fetch,
    })
    await expect(protocolClient.getJson('/health')).rejects.toBeInstanceOf(ApiProtocolError)
  })

  it('uses a generic HTTP error when a failed response is not an API error envelope', async () => {
    const client = createApiClient({
      fetcher: makeFetchMock(jsonResponse({ message: 'gateway failure' }, { status: 500 })) as typeof globalThis.fetch,
    })

    const error = await client.getJson('/health').catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(ApiHttpError)
    expect(error).toMatchObject({ status: 500, code: 'HTTP_ERROR' })
  })
})





describe('AI generation errors', () => {
  it('preserves the actual model error rather than showing generic HTTP_ERROR for a 502', async () => {
    const client=createApiClient({fetcher:makeFetchMock(jsonResponse({ok:false,error:{code:'MODEL_RESPONSE_INVALID',message:'模型服务返回了 HTML 网页，请检查接口地址'},requestId:'model-request-1'},{status:502})) as typeof globalThis.fetch})
    const error=await client.getJson('/health').catch((cause:unknown)=>cause)
    expect(error).toBeInstanceOf(ApiResponseError)
    expect(error).toMatchObject({status:502,code:'MODEL_RESPONSE_INVALID',message:'模型服务返回了 HTML 网页，请检查接口地址',requestId:'model-request-1'})
  })
})

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { errorMiddleware } from './error-middleware.js'
import { HttpError, type RequestContext } from './http.js'

function fakeContext() {
  const state = { statusCode: 0, body: '' }
  const response = {
    headersSent: false,
    get statusCode() { return state.statusCode },
    set statusCode(value: number) { state.statusCode = value },
    setHeader() { /* noop */ },
    end(payload: string) { state.body = payload },
  }
  const context = {
    req: {} as never,
    res: response as never,
    config: {} as never,
    requestId: 'req-1',
    url: new URL('http://127.0.0.1/api/v1/auth/login'),
  } as unknown as RequestContext
  return { context, state }
}

describe('errorMiddleware', () => {
  it('maps HttpError to its own status and code', async () => {
    const { context, state } = fakeContext()
    await errorMiddleware(context, async () => { throw new HttpError(404, 'NOT_FOUND', '未找到接口') })
    assert.equal(state.statusCode, 404)
    assert.deepEqual(JSON.parse(state.body), {
      ok: false,
      error: { code: 'NOT_FOUND', message: '未找到接口' },
      requestId: 'req-1',
    })
  })

  // 回归：AuthService.login 抛的是带 code/status 的普通 Error，不是 HttpError 实例。
  // 修好之前「邮箱或密码错误」会变成 500 服务器内部错误。
  it('keeps the status of domain errors that carry code and status', async () => {
    const { context, state } = fakeContext()
    await errorMiddleware(context, async () => {
      const error = new Error('邮箱或密码错误') as Error & { code?: string; status?: number }
      error.code = 'INVALID_CREDENTIALS'
      error.status = 401
      throw error
    })
    assert.equal(state.statusCode, 401)
    const body = JSON.parse(state.body)
    assert.equal(body.error.code, 'INVALID_CREDENTIALS')
    assert.equal(body.error.message, '邮箱或密码错误')
  })

  it('still hides unknown errors behind a 500 INTERNAL_ERROR', async () => {
    const { context, state } = fakeContext()
    const originalError = console.error
    console.error = () => { /* silence the expected log */ }
    try {
      await errorMiddleware(context, async () => { throw new Error('boom') })
    } finally {
      console.error = originalError
    }
    assert.equal(state.statusCode, 500)
    assert.equal(JSON.parse(state.body).error.code, 'INTERNAL_ERROR')
  })

  it('does not promote errors that only look like domain errors', async () => {
    const { context, state } = fakeContext()
    const originalError = console.error
    console.error = () => { /* silence the expected log */ }
    try {
      // 数据库错误只带 code（如 23505）但没有 status，必须仍然是 500，不能外泄内部代码
      const databaseError = new Error('duplicate key value violates unique constraint') as Error & { code?: string }
      databaseError.code = '23505'
      await errorMiddleware(context, async () => { throw databaseError })
    } finally {
      console.error = originalError
    }
    assert.equal(state.statusCode, 500)
    assert.equal(JSON.parse(state.body).error.code, 'INTERNAL_ERROR')
  })
})

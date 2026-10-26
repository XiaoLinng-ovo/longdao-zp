import type { RegisterInput } from './types.js'

export interface NormalizedRegistration {
  name: string
  email: string
  password: string
  companyName: string
  phone: string | null
}

function validationError(message: string): Error {
  return Object.assign(new Error(message), { code: 'VALIDATION_ERROR', status: 400 })
}

export function normalizePhone(value: unknown): string | null {
  if (value === undefined || value === null) return null
  const raw = String(value).trim()
  if (!raw) return null
  const compact = raw.replace(/[\s()-]/g, '')
  if (/^1[3-9]\d{9}$/u.test(compact)) return `+86${compact}`
  if (/^\+[1-9]\d{6,14}$/u.test(compact)) return compact
  throw validationError('请输入有效的手机号')
}

export function normalizeRegistrationInput(input: RegisterInput): NormalizedRegistration {
  const name = input.name.trim()
  const email = input.email.trim().toLowerCase()
  const password = String(input.password ?? '')
  const companyName = input.companyName.trim()
  if (name.length < 2 || name.length > 80) throw validationError('姓名长度需为 2 到 80 个字符')
  if (email.length > 254 || !/^\S+@\S+\.\S+$/u.test(email)) throw validationError('请输入有效邮箱')
  if (password.length < 8 || password.length > 128 || !password.trim()) throw validationError('密码须为 8 至 128 个字符，不能全部为空格')
  if (companyName.length < 2 || companyName.length > 120) throw validationError('企业名称长度需为 2 到 120 个字符')
  return { name, email, password, companyName, phone: normalizePhone(input.phone) }
}

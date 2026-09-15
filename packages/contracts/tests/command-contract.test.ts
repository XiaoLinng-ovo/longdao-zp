import {
  validateCreateJob,
  validateCreateRecruitmentRequest,
  type CreateJobInput,
  type CreateRecruitmentRequestInput,
} from '../src/index.js'

const validRequest: CreateRecruitmentRequestInput = {
  title: '高级后端工程师',
  departmentId: 'dept-1',
  headcount: 2,
  employmentType: 'full_time',
  workMode: 'hybrid',
  justification: '业务增长',
}

const validJob: CreateJobInput = {
  title: validRequest.title,
  departmentId: validRequest.departmentId,
  recruitmentRequestId: 'request-1',
  headcount: validRequest.headcount,
  employmentType: validRequest.employmentType,
  workMode: validRequest.workMode,
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

assert(validateCreateRecruitmentRequest(validRequest).length === 0, 'valid request should pass')
assert(
  validateCreateRecruitmentRequest({ ...validRequest, title: '', headcount: 0, justification: '' }).length === 3,
  'invalid request should report required fields'
)
assert(
  validateCreateRecruitmentRequest({
    ...validRequest,
    salaryRange: {
      min: { amount: 50, currency: 'CNY' },
      max: { amount: 30, currency: 'CNY' },
    },
  }).some((issue) => issue.field === 'salaryRange'),
  'invalid salary range should be rejected'
)
assert(validateCreateJob(validJob).length === 0, 'valid job should pass')
assert(
  validateCreateJob({ ...validJob, departmentId: '', recruitmentRequestId: '', headcount: 0 }).length === 3,
  'invalid job should report required fields'
)
console.log('command contract tests passed: 5')

import {
  assertJobCanBeCreatedFromRequest,
  JobStatus,
  RecruitmentRequestStatus,
  transitionJob,
  transitionRecruitmentRequest,
  WorkflowTransitionError,
} from '../src/index.js'

function equal<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`)
}

function errorOf(run: () => unknown): WorkflowTransitionError {
  try {
    run()
  } catch (error) {
    if (error instanceof WorkflowTransitionError) return error
    throw new Error('expected WorkflowTransitionError')
  }
  throw new Error('expected workflow transition to fail')
}

function testRecruitmentRequestWorkflow(): void {
    let status = RecruitmentRequestStatus.Draft
    status = transitionRecruitmentRequest(status, 'submit')
    equal(status, RecruitmentRequestStatus.PendingApproval, 'submit')
    status = transitionRecruitmentRequest(status, 'reject', { reason: '预算需要调整' })
    equal(status, RecruitmentRequestStatus.Rejected, 'reject')
    status = transitionRecruitmentRequest(status, 'resubmit')
    equal(status, RecruitmentRequestStatus.PendingApproval, 'resubmit')
    status = transitionRecruitmentRequest(status, 'approve')
    equal(status, RecruitmentRequestStatus.Approved, 'approve')
    status = transitionRecruitmentRequest(status, 'convert', { hasConvertedJob: true })
    equal(status, RecruitmentRequestStatus.Converted, 'convert')
    status = transitionRecruitmentRequest(status, 'close', { reason: '招聘计划完成' })
    equal(status, RecruitmentRequestStatus.Closed, 'close')
  }

function testRequestValidation(): void {
    const missingReason = errorOf(() => transitionRecruitmentRequest(RecruitmentRequestStatus.PendingApproval, 'reject'))
    equal(missingReason.code, 'REASON_REQUIRED', 'missing reason')
    const illegal = errorOf(() => transitionRecruitmentRequest(RecruitmentRequestStatus.Approved, 'approve'))
    equal(illegal.code, 'INVALID_TRANSITION', 'illegal request transition')
  }

function testJobWorkflow(): void {
    let status = JobStatus.Draft
    status = transitionJob(status, 'confirm_spec', { jdConfirmed: false })
    equal(status, JobStatus.Draft, 'spec confirmation waits for JD')
    status = transitionJob(status, 'confirm_jd', { specConfirmed: true })
    equal(status, JobStatus.Ready, 'both documents confirmed')
    status = transitionJob(status, 'publish', {
      specConfirmed: true,
      jdConfirmed: true,
      recruitmentRequestApproved: true,
    })
    equal(status, JobStatus.Published, 'publish')
    equal(transitionJob(status, 'pause'), JobStatus.Paused, 'pause')
    equal(transitionJob(JobStatus.Paused, 'resume'), JobStatus.Published, 'resume')
    equal(transitionJob(JobStatus.Published, 'close'), JobStatus.Closed, 'close job')
  }

function testJobPreconditions(): void {
    const requestError = errorOf(() => assertJobCanBeCreatedFromRequest(RecruitmentRequestStatus.PendingApproval))
    equal(requestError.code, 'PRECONDITION_FAILED', 'request approval')
    const publishError = errorOf(() =>
      transitionJob(JobStatus.Ready, 'publish', {
        specConfirmed: true,
        jdConfirmed: true,
        recruitmentRequestApproved: false,
      })
    )
    equal(publishError.code, 'PRECONDITION_FAILED', 'publish approval')
  }

testRecruitmentRequestWorkflow()
testRequestValidation()
testJobWorkflow()
testJobPreconditions()
console.log('workflow tests passed: 4')

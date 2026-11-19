import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { RecruitingService } from "./service.js"
import { LocalRecruitingStore } from "./store.js"
import type { ApplicationRecord, OfferRecord } from "./types.js"

async function fixture() {
  process.env.NODE_ENV = "test"
  const store = new LocalRecruitingStore()
  await store.transaction(state => {
    const timestamp = "2026-11-01T00:00:00.000Z"
    const statuses: ApplicationRecord["status"][] = ["offer_approval", "offer_declined", "offer_cancelled", "onboarding_archived", "onboarding_archived"]
    state.applications = statuses.map((status, index) => ({
      id: "p2-application-" + index, code: "P2-" + index, candidateId: "candidate-8821", jobId: "job-108",
      status, source: index === 0 ? "referral" : "resume-import:p2", aiStatus: "completed", appliedAt: timestamp,
      updatedAt: index === 4 ? "2026-11-07T00:00:00.000Z" : "2026-11-03T00:00:00.000Z",
    }))
    const offerStatuses: OfferRecord["status"][] = ["draft", "declined", "cancelled", "accepted", "accepted"]
    state.offers = offerStatuses.map((status, index) => ({
      id: "p2-offer-" + index, code: "OFF-P2-" + index, applicationId: "p2-application-" + index, status,
      ...(index ? { sentAt: timestamp } : {}), approval: { status: "pending", approver: "p2-user" },
      version: 1, createdAt: timestamp, updatedAt: timestamp,
    }))
    state.interviews = [{ id: "p2-interview", code: "INT-P2", applicationId: "p2-application-1", round: 2, stage: "final",
      type: "technical", title: "隔离复试", status: "completed", createdAt: timestamp, updatedAt: timestamp,
      participants: [
        { userId: "p2-interviewer", role: "interviewer", required: true },
        { userId: "p2-interviewer", role: "interviewer", required: true },
        { userId: "p2-other", role: "interviewer", required: true },
        { userId: "p2-coordinator", role: "coordinator", required: false },
      ],
    }]
    state.interviewFeedback = ["p2-interviewer", "p2-interviewer", "p2-coordinator"].map((interviewerId, index) => ({
      id: "p2-feedback-" + index, interviewId: "p2-interview", interviewerId, status: "locked", ratings: {}, strengths: [], concerns: [],
    }))
  })
  return { store, service: new RecruitingService(store) }
}

describe("P2 招聘报表指标回归", () => {
  it("草稿不计已发，拒绝和已发后取消不丢失历史发出量", async () => {
    const { service } = await fixture()
    const report = await service.getReports()
    assert.equal(report.funnel.find(item => item.stage === "发出 Offer")?.count, 4)
    assert.deepEqual(report.offerAcceptance, { sent: 4, accepted: 2, acceptanceRate: 50 })
    assert.equal(report.channels.find(item => item.channel === "批量导入")?.offers, 4)
    assert.equal(report.channels.find(item => item.channel === "内部推荐")?.offers, 0)
  })

  it("偶数入职周期取中间两数平均，重复反馈和协调人不进入完成分子", async () => {
    const { service } = await fixture()
    const report = await service.getReports()
    assert.deepEqual(report.recruitmentCycle, { averageDaysToHire: 4, medianDaysToHire: 4, hiredCount: 2 })
    assert.deepEqual(report.feedbackCompletion, { expected: 2, locked: 1, completionRate: 50 })
  })

  it("状态筛选同步限制漏斗、渠道、Offer 和岗位填补统计", async () => {
    const { service } = await fixture()
    const report = await service.getReports(undefined, { status: "onboarding_archived" })
    assert.equal(report.funnel[0]?.count, 2)
    assert.equal(report.funnel[3]?.count, 2)
    assert.deepEqual(report.offerAcceptance, { sent: 2, accepted: 2, acceptanceRate: 100 })
    assert.equal(report.channels.reduce((sum, row) => sum + row.applications, 0), 2)
    assert.equal(report.jobFilling.find(item => item.jobId === "job-108")?.filledCount, 2)
    assert.deepEqual(report.feedbackCompletion, { expected: 0, locked: 0, completionRate: null })
  })

  it("招聘人数更新为 3 后服务回读保持为 3", async () => {
    const { service } = await fixture()
    const updated = await service.updateJob("job-108", { headcount: 3 })
    assert.equal(updated.headcount, 3)
    assert.equal((await service.getJob("job-108")).headcount, 3)
  })
})

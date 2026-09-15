import { describe, expect, it } from 'vitest'
import { DemoRecruitingData } from './demo-recruiting-data'
import { listJobs } from '../../modules/jobs/api'

describe('demo recruiting data', () => {
  it('contains all readonly slices', () => {
    expect(DemoRecruitingData.metrics.length).toBeGreaterThan(0)
    expect(DemoRecruitingData.requisitions.length).toBeGreaterThan(0)
    expect(DemoRecruitingData.jobs.length).toBeGreaterThan(0)
    expect(DemoRecruitingData.candidates.length).toBeGreaterThan(0)
    expect(DemoRecruitingData.interviews.length).toBeGreaterThan(0)
    expect(DemoRecruitingData.offers.length).toBeGreaterThan(0)
    expect(DemoRecruitingData.reports.length).toBeGreaterThan(0)
    expect(DemoRecruitingData.adminChecks.length).toBeGreaterThan(0)
  })

  it('exposes frozen source records to demo-only adapters', () => {
    expect(listJobs()).toBe(DemoRecruitingData.jobs)
    expect(Object.isFrozen(DemoRecruitingData.candidates)).toBe(true)
  })
})
import type { Pool } from 'pg'
import type { GeneratedInterviewQuestion } from './question-generator.js'

export interface InterviewQuestionSetRecord {
  interviewId: string
  generatedBy: string
  engine: 'llm' | 'local_fallback'
  questions: GeneratedInterviewQuestion[]
  updatedAt: string
}

export interface InterviewQuestionSetRepository {
  get(interviewId: string): Promise<InterviewQuestionSetRecord | null>
  save(record: Omit<InterviewQuestionSetRecord, 'updatedAt'>): Promise<InterviewQuestionSetRecord>
}

export class PostgresInterviewQuestionSetRepository implements InterviewQuestionSetRepository {
  constructor(private readonly pool: Pool) {}

  async get(interviewId: string): Promise<InterviewQuestionSetRecord | null> {
    const result = await this.pool.query(
      `SELECT interview_id, generated_by, engine, questions, updated_at
         FROM interview_resume_question_sets WHERE interview_id = $1::uuid`,
      [interviewId],
    )
    const row = result.rows[0]
    if (!row) return null
    return {
      interviewId: String(row.interview_id),
      generatedBy: String(row.generated_by),
      engine: row.engine === 'local_fallback' ? 'local_fallback' : 'llm',
      questions: Array.isArray(row.questions) ? row.questions as GeneratedInterviewQuestion[] : [],
      updatedAt: new Date(String(row.updated_at)).toISOString(),
    }
  }

  async save(record: Omit<InterviewQuestionSetRecord, 'updatedAt'>): Promise<InterviewQuestionSetRecord> {
    const result = await this.pool.query(
      `INSERT INTO interview_resume_question_sets (interview_id, generated_by, engine, questions)
       VALUES ($1::uuid, $2::uuid, $3, $4::jsonb)
       ON CONFLICT (interview_id) DO UPDATE
         SET generated_by = EXCLUDED.generated_by, engine = EXCLUDED.engine,
             questions = EXCLUDED.questions, updated_at = now()
       RETURNING interview_id, generated_by, engine, questions, updated_at`,
      [record.interviewId, record.generatedBy, record.engine, JSON.stringify(record.questions)],
    )
    const row = result.rows[0]
    return {
      interviewId: String(row.interview_id),
      generatedBy: String(row.generated_by),
      engine: row.engine === 'local_fallback' ? 'local_fallback' : 'llm',
      questions: Array.isArray(row.questions) ? row.questions as GeneratedInterviewQuestion[] : [],
      updatedAt: new Date(String(row.updated_at)).toISOString(),
    }
  }
}

export class MemoryInterviewQuestionSetRepository implements InterviewQuestionSetRepository {
  private readonly records = new Map<string, InterviewQuestionSetRecord>()

  async get(interviewId: string): Promise<InterviewQuestionSetRecord | null> {
    return this.records.get(interviewId) ?? null
  }

  async save(record: Omit<InterviewQuestionSetRecord, 'updatedAt'>): Promise<InterviewQuestionSetRecord> {
    const saved = { ...record, updatedAt: new Date().toISOString() }
    this.records.set(record.interviewId, saved)
    return saved
  }
}

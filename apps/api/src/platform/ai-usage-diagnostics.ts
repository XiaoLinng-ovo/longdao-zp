import { HttpError } from '../http.js'
export type FailureCategory = 'upstream_rejected'|'request_timeout'|'network_error'|'invalid_response'|'generation_failed'|'settlement_failed'
export interface UsageFilters {operation?:'job_spec'|'jd';state?:'reserved'|'settled'|'released'|'uncertain';reviewOnly?:boolean;from?:string;to?:string}
// Never store error messages, upstream bodies, URLs or credentials in usage diagnostics.
export function classifyUsageFailure(error:unknown,settling=false):FailureCategory {
 if(settling)return 'settlement_failed'
 const code=error instanceof Error && 'code' in error ? error.code : undefined
 if(code==='MODEL_HTTP_ERROR')return 'upstream_rejected'
 if(code==='MODEL_RESPONSE_INVALID')return 'invalid_response'
 if(code==='MODEL_REQUEST_FAILED') {
  const cause=error instanceof Error ? error.cause : undefined
  return cause instanceof Error && ['TimeoutError','AbortError'].includes(cause.name) ? 'request_timeout' : 'network_error'
 }
 return 'generation_failed'
}
export function validateUsageFilters(filters:UsageFilters):UsageFilters {
 if(filters.operation!==undefined && !['job_spec','jd'].includes(filters.operation))throw new HttpError(400,'VALIDATION_ERROR','生成类型无效')
 if(filters.state!==undefined && !['reserved','settled','released','uncertain'].includes(filters.state))throw new HttpError(400,'VALIDATION_ERROR','调用状态无效')
 if(filters.reviewOnly!==undefined && typeof filters.reviewOnly!=='boolean')throw new HttpError(400,'VALIDATION_ERROR','待核对筛选无效')
 for(const value of [filters.from,filters.to])if(value!==undefined && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value))throw new HttpError(400,'VALIDATION_ERROR','时间筛选无效')
 if(filters.from && filters.to && filters.from>=filters.to)throw new HttpError(400,'VALIDATION_ERROR','结束时间必须晚于开始时间')
 return filters
}
export function parseUsageFilters(query:URLSearchParams):UsageFilters {
 for(const key of ['operation','state','reviewOnly','from','to','page'])if(query.getAll(key).length>1)throw new HttpError(400,'VALIDATION_ERROR','筛选参数不能重复')
 const review=query.get('reviewOnly');if(review!==null&&!['true','false'].includes(review))throw new HttpError(400,'VALIDATION_ERROR','待核对筛选无效')
 const filters:UsageFilters={}
 const operation=query.get('operation'),state=query.get('state'),from=query.get('from'),to=query.get('to')
 if(operation!==null)filters.operation=operation as NonNullable<UsageFilters['operation']>
 if(state!==null)filters.state=state as NonNullable<UsageFilters['state']>
 if(review!==null)filters.reviewOnly=review==='true'
 if(from!==null)filters.from=from
 if(to!==null)filters.to=to
 return validateUsageFilters(filters)
}

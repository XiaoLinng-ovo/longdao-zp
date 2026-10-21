import { apiClient } from '../../../shared/api'
export interface PlanVersion { id:string; code:string; version:number; name:string; seatLimit:number|null; jobLimit:number|null }
export interface Entitlements { plan:PlanVersion; entitlementVersion:number; seats:{used:number;limit:number|null}; jobs:{used:number;limit:number|null}; serviceAvailable:boolean }
export async function listPlans() {return (await apiClient.getJson<PlanVersion[]>('/platform/plans')).data}
export async function publishPlan(input:{code:string;version:number;name:string;seatLimit:number;jobLimit:number;reason:string}) {return (await apiClient.postJson<PlanVersion>('/platform/plans',input)).data}
export async function getEntitlements(id:string,platform=false) {return (await apiClient.getJson<Entitlements>(platform?`/platform/customers/${encodeURIComponent(id)}/entitlements`:`/workspaces/${encodeURIComponent(id)}/entitlements`)).data}
export async function assignPlan(id:string,planVersionId:string,expectedVersion:number,reason:string) {return (await apiClient.patchJson<Entitlements>(`/platform/customers/${encodeURIComponent(id)}/entitlements`,{planVersionId,expectedVersion,reason})).data}

import { apiClient } from '../../../shared/api'
export type MemberBusinessRole = 'recruiter'
export interface MemberInput {

  membershipRole: 'member' | 'admin'
  businessRole: MemberBusinessRole
  departmentId?: string | null

}
export interface Invitation {
  id: string; workspaceId: string; workspaceName: string; workspaceKind: 'test' | 'production'
  email: string | null; membershipRole: 'member' | 'admin'; businessRole: MemberBusinessRole
  departmentId: string | null; departmentName: string | null; createdAt: string; expiresAt: string
  acceptedAt: string | null; status: 'pending' | 'accepted' | 'expired' | 'revoked'; code?: string; shared?: boolean; joinedCount?: number
}
export interface WorkspaceMember {
  id: string; name: string; email: string; membershipRole: 'owner' | 'admin' | 'member'
  isActive: boolean; accountActive: boolean; businessRole: string; departmentId: string | null; departmentName: string | null; joinedAt: string
}
const base = (id: string) => '/workspaces/' + encodeURIComponent(id)
export const listInvitations = async (id: string) => (await apiClient.getJson<Invitation[]>(base(id) + '/invitations')).data
export const createInvitation = async (id: string, input: { replace?: boolean } = {}) => (await apiClient.postJson<Invitation>(base(id) + '/invitations', input)).data
export interface SharedInvitationSummary { workspaceName: string; expiresAt: string; shared: boolean }
export const getInvitationSummary = async (code: string) => (await apiClient.postJson<SharedInvitationSummary>('/workspace-invitations/summary', { code })).data
export const revokeInvitation = async (id: string, invitationId: string) => (await apiClient.deleteJson<{ ok: boolean }>(base(id) + '/invitations/' + encodeURIComponent(invitationId))).data
export const previewInvitation = async (code: string) => (await apiClient.postJson<Invitation>('/workspace-invitations/preview', { code })).data
export const acceptInvitation = async (code: string) => (await apiClient.postJson<{ workspaceId: string; workspaceName: string }>('/workspace-invitations/accept', { code })).data
export const listWorkspaceMembers = async (id: string) => (await apiClient.getJson<WorkspaceMember[]>(base(id) + '/members')).data
export const updateWorkspaceMember = async (id: string, userId: string, input: MemberInput) => (await apiClient.patchJson<{ ok: boolean }>(base(id) + '/members/' + encodeURIComponent(userId), input)).data
export const setWorkspaceMemberStatus = async (id: string, userId: string, isActive: boolean, reason: string) => (await apiClient.patchJson<{ ok: boolean }>(base(id) + '/members/' + encodeURIComponent(userId) + '/status', { isActive, reason })).data
export const transferWorkspaceOwnership = async (id: string, userId: string, reason: string, currentPassword: string) => (await apiClient.postJson<{ ok: boolean }>(base(id) + '/members/' + encodeURIComponent(userId) + '/transfer', { reason, currentPassword })).data
export const listInvitationDepartments = async () => (await apiClient.getJson<{ id: string; name: string }[]>('/departments')).data

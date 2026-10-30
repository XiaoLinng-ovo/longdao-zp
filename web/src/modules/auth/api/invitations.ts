import { apiClient } from '../../../shared/api'
export type MemberBusinessRole = 'recruiter' | 'hiring_manager' | 'approver' | 'interviewer'
export interface InvitationInput {
  email?: string
  membershipRole: 'member' | 'admin'
  businessRole: MemberBusinessRole
  departmentId?: string | null
  expiresInDays?: number
}
export interface Invitation {
  id: string; workspaceId: string; workspaceName: string; workspaceKind: 'test' | 'production'
  email: string | null; membershipRole: 'member' | 'admin'; businessRole: MemberBusinessRole
  departmentId: string | null; departmentName: string | null; createdAt: string; expiresAt: string
  acceptedAt: string | null; status: 'pending' | 'accepted' | 'expired' | 'revoked'; code?: string
}
export interface WorkspaceMember {
  id: string; name: string; email: string; membershipRole: 'owner' | 'admin' | 'member'
  businessRole: string; departmentId: string | null; departmentName: string | null; joinedAt: string
}
const base = (id: string) => '/workspaces/' + encodeURIComponent(id)
export const listInvitations = async (id: string) => (await apiClient.getJson<Invitation[]>(base(id) + '/invitations')).data
export const createInvitation = async (id: string, input: InvitationInput) => (await apiClient.postJson<Invitation>(base(id) + '/invitations', input)).data
export const revokeInvitation = async (id: string, invitationId: string) => (await apiClient.deleteJson<{ ok: boolean }>(base(id) + '/invitations/' + encodeURIComponent(invitationId))).data
export const previewInvitation = async (code: string) => (await apiClient.postJson<Invitation>('/workspace-invitations/preview', { code })).data
export const acceptInvitation = async (code: string) => (await apiClient.postJson<{ workspaceId: string; workspaceName: string }>('/workspace-invitations/accept', { code })).data
export const listWorkspaceMembers = async (id: string) => (await apiClient.getJson<WorkspaceMember[]>(base(id) + '/members')).data
export const updateWorkspaceMember = async (id: string, userId: string, input: InvitationInput) => (await apiClient.patchJson<{ ok: boolean }>(base(id) + '/members/' + encodeURIComponent(userId), input)).data
export const listInvitationDepartments = async () => (await apiClient.getJson<{ id: string; name: string }[]>('/departments')).data

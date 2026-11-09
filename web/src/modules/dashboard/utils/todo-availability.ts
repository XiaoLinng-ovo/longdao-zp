import type { DashboardTodo } from '../api'

export interface TodoFeatureAvailability {
  externalJobPublishingEnabled: boolean
  recruitmentRequestsEnabled: boolean
}

export function isDashboardTodoAvailable(
  todo: Pick<DashboardTodo, 'category' | 'actionKey' | 'title'>,
  features: TodoFeatureAvailability,
): boolean {
  if (todo.category === 'requisition' && !features.recruitmentRequestsEnabled) return false

  // The title fallback keeps older API instances safe during a rolling deployment.
  const isJobPublishing = todo.actionKey === 'publish-job'
    || (todo.category === 'job' && todo.title === '岗位待发布')
  return features.externalJobPublishingEnabled || !isJobPublishing
}

export function availableDashboardTodos(
  todos: DashboardTodo[],
  features: TodoFeatureAvailability,
): DashboardTodo[] {
  return todos.filter(todo => isDashboardTodoAvailable(todo, features))
}

// External recruitment-platform publishing is temporarily hidden; explicitly enable to restore it.
export const externalJobPublishingEnabled = import.meta.env.VITE_EXTERNAL_JOB_PUBLISHING_ENABLED === 'true'

// Recruitment-request pages and their settings are disabled by default. Historical data and Offer approval remain intact.
// Set VITE_RECRUITMENT_REQUESTS_ENABLED=true and restart Vite (or rebuild Web) to restore those pages.
export const recruitmentRequestsEnabled = import.meta.env.VITE_RECRUITMENT_REQUESTS_ENABLED === 'true'

// The historical reporting page is currently hidden together with its dashboard entry point.
// Set VITE_RECRUITMENT_REPORTS_ENABLED=true to restore it explicitly.
export const recruitmentReportsEnabled = import.meta.env.VITE_RECRUITMENT_REPORTS_ENABLED === 'true'

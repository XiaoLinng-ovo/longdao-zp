// Environment-only typing avoids mixing the build tool and test runner's HMR types.
interface ImportMetaEnv {
  readonly [key: string]: unknown
  readonly VITE_RECRUITMENT_REQUESTS_ENABLED?: string
  readonly VITE_EXTERNAL_JOB_PUBLISHING_ENABLED?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

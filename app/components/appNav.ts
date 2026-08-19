// Shared MU app registry + context-aware switcher config.
// Identical across mu-wp-staging, mu-deployment, mu-vrt (keep in sync).
// A future user registry (RBAC) will filter these entries per user; for now
// the admin sees the full context-aware set below.

export type AppKey = 'staging' | 'deployment' | 'vrt'

export interface AppDef {
  key: AppKey
  label: string
  url: string
}

export const APPS: Record<AppKey, AppDef> = {
  staging:    { key: 'staging',    label: 'Staging',    url: 'https://mu-wp-staging-production.up.railway.app' },
  deployment: { key: 'deployment', label: 'Deployment', url: 'https://mu-deployment-production.up.railway.app' },
  vrt:        { key: 'vrt',        label: 'VRT',        url: 'https://mu-vrt-production.up.railway.app' },
}

// Which switcher entries each app shows. Staging (AR) and Deployment (AP) stay
// independent and don't cross-link; VRT is the shared hub both reach into.
export const SWITCHER: Record<AppKey, AppKey[]> = {
  staging:    ['staging', 'vrt'],
  deployment: ['deployment', 'vrt'],
  vrt:        ['staging', 'deployment', 'vrt'],
}

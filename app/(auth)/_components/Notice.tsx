'use client'

import { Alert, AlertDescription } from '@/components/ui/alert'

/**
 * The error and success banners.
 *
 * shadcn's Alert ships `default` and `destructive` only, so the success tone is
 * passed as a class rather than invented as a variant — a fork of the component
 * would drift from upstream the first time it is regenerated.
 */
export function Notice({ tone, children }: { tone: 'error' | 'success'; children: React.ReactNode }) {
  return (
    <Alert
      variant={tone === 'error' ? 'destructive' : 'default'}
      className={
        tone === 'error'
          ? 'border-pantheon-error/40 bg-pantheon-error/10 font-mono text-xs'
          : 'border-pantheon-success/40 bg-pantheon-success/10 font-mono text-xs text-pantheon-success'
      }
    >
      <AlertDescription className={tone === 'error' ? 'text-pantheon-error' : 'text-pantheon-success'}>
        {children}
      </AlertDescription>
    </Alert>
  )
}

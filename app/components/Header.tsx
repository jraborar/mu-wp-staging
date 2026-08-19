import { Terminal, Rocket, ScanEye, type LucideIcon } from 'lucide-react'
import { APPS, SWITCHER, type AppKey } from '@/app/components/appNav'

// Shared MU app header — matches the brand-block pattern the apps already use
// (w-10 yellow icon tile + text-2xl sans title + subtitle) and adds the
// context-aware app switcher on the right. Identical across the three apps;
// only `current` differs. Per-app brand mark: >_ Staging, Rocket Deployment,
// ScanEye VRT.

const BRAND: Record<AppKey, { icon: LucideIcon; name: string; subtitle: string }> = {
  staging:    { icon: Terminal, name: 'MU Staging',    subtitle: 'Automated WordPress plugin, theme & upstream updates' },
  deployment: { icon: Rocket,   name: 'MU Deployment', subtitle: 'Automated Pantheon pipeline deployments' },
  vrt:        { icon: ScanEye,  name: 'MU VRT',         subtitle: 'Visual regression testing for managed updates' },
}

export default function Header({ current }: { current: AppKey }) {
  const brand = BRAND[current]
  const BrandIcon = brand.icon
  const items = SWITCHER[current]

  return (
    <div className="flex items-center gap-3">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-pantheon-yellow">
        <BrandIcon className="h-5 w-5 text-slate-900" strokeWidth={2.5} />
      </div>
      <div className="min-w-0">
        <h1 className="text-2xl font-bold text-white">{brand.name}</h1>
        <p className="text-sm text-slate-400">{brand.subtitle}</p>
      </div>
      <nav className="ml-auto flex flex-wrap justify-end gap-1">
        {items.map((key) => {
          const app = APPS[key]
          const active = key === current
          return (
            <a
              key={key}
              href={active ? '#' : app.url}
              aria-current={active ? 'page' : undefined}
              className={[
                'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                active
                  ? 'border border-pantheon-yellow/40 bg-pantheon-yellow/10 text-pantheon-yellow'
                  : 'border border-transparent text-slate-400 hover:bg-slate-800 hover:text-slate-200',
              ].join(' ')}
            >
              {app.label}
            </a>
          )
        })}
      </nav>
    </div>
  )
}

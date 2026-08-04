import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'WP Staging | Pantheon',
  description: 'Automated WordPress plugin, theme, and upstream updates for Pantheon multidev environments',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  )
}

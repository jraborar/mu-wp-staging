import type { Metadata } from 'next'
import { Toaster } from 'sonner'
import UserMenu from '@/app/components/UserMenu'
import Footer from '@/app/components/Footer'
import './globals.css'

export const metadata: Metadata = {
  title: 'WP Staging | Pantheon',
  description: 'Automated WordPress plugin, theme, and upstream updates for Pantheon multidev environments',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased">
        <div className="border-b border-pantheon-border/40 bg-pantheon-bg/60 backdrop-blur-sm sticky top-0 z-10">
          <div className="mx-auto flex max-w-3xl items-center justify-end px-6 py-2">
            <UserMenu />
          </div>
        </div>

        {children}

        <Footer />

        <Toaster theme="dark" position="bottom-right" />
      </body>
    </html>
  )
}

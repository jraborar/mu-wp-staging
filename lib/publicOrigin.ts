/**
 * Resolve the app's real public origin for server-side redirects.
 *
 * Behind Railway's proxy, `new URL(request.url).origin` resolves to the
 * internal container address (`https://localhost:8080`) — never the public
 * hostname. Redirecting to that bounces the user's browser to their own
 * machine, which is the "OAuth sends me to localhost" bug.
 *
 * Mirror `signInWithOAuth`: `RAILWAY_PUBLIC_DOMAIN` is always set by Railway
 * to the correct public host and is never baked at build time. Fall back to
 * `NEXT_PUBLIC_APP_URL`, then the request origin for local dev.
 */
export function publicOrigin(request: Request): string {
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN
  if (domain) return `https://${domain}`
  return process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin
}

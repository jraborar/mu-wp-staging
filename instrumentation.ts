// Node.js-only startup logic lives in instrumentation.node.ts.
// Dynamic import avoids edge-runtime static analysis warnings on Node.js APIs.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { register: registerNode } = await import('./instrumentation.node')
    await registerNode()
  }
}

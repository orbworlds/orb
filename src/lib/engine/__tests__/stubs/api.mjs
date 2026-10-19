// Test stub for src/lib/api.ts (the engine only needs deviceHeaders).
export function deviceHeaders(extra = {}) {
  return { 'x-orb-device': 'test-device-key-0123456789', ...extra };
}

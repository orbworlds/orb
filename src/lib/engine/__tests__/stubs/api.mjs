// Test stub for src/lib/api.ts (the engine only needs deviceHeaders; src/lib/photos.ts names api).
export function deviceHeaders(extra = {}) {
  return { 'x-orb-device': 'test-device-key-0123456789', ...extra };
}
export const api = {};

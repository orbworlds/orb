// Shared test setup: an in-memory localStorage (src/lib/local.ts reads window.localStorage) and
// the resolve hooks that let node load the engine's TypeScript sources.
import { register } from 'node:module';

register('./resolve-hooks.mjs', import.meta.url);

class MemoryStorage {
  #m = new Map();
  get length() {
    return this.#m.size;
  }
  key(i) {
    return [...this.#m.keys()][i] ?? null;
  }
  getItem(k) {
    return this.#m.has(k) ? this.#m.get(k) : null;
  }
  setItem(k, v) {
    this.#m.set(k, String(v));
  }
  removeItem(k) {
    this.#m.delete(k);
  }
  clear() {
    this.#m.clear();
  }
}

Object.defineProperty(globalThis, 'localStorage', { value: new MemoryStorage(), configurable: true, writable: true });
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;

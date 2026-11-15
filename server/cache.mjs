import { ApiError, hash } from './validation.mjs';

// Only hashes and bounded successful responses survive a request; never raw audio.
export class RequestCache {
  constructor({ ttlMs = 10 * 60_000, maxEntries = 100, maxBytes = 8 * 1024 * 1024, maxConcurrent = 4, now = Date.now } = {}) {
    this.entries = new Map();
    Object.assign(this, { ttlMs, maxEntries, maxBytes, maxConcurrent, now });
  }

  remove(key) {
    const entry = this.entries.get(key);
    if (entry?.timer) clearTimeout(entry.timer);
    this.entries.delete(key);
  }

  prune() {
    const now = this.now();
    for (const [key, entry] of this.entries) if (!entry.pending && entry.expiresAt <= now) this.remove(key);
    let bytes = [...this.entries.values()].reduce((sum, entry) => sum + (entry.bytes ?? 0), 0);
    for (const [key, entry] of this.entries) {
      if (this.entries.size < this.maxEntries && bytes <= this.maxBytes) break;
      if (!entry.pending) { bytes -= entry.bytes; this.remove(key); }
    }
  }

  async run(stage, operationId, payloadHash, work) {
    this.prune();
    const key = hash(`${stage}\0${operationId}\0${payloadHash}`);
    const found = this.entries.get(key);
    if (found) return found.promise;
    if ([...this.entries.values()].filter(entry => entry.pending).length >= this.maxConcurrent || this.entries.size >= this.maxEntries) throw new ApiError(429, 'BUSY', 'Das lokale Backend ist ausgelastet. Bitte kurz warten.');
    const entry = { pending: true, bytes: 0, expiresAt: Infinity, promise: null };
    this.entries.set(key, entry);
    entry.promise = Promise.resolve().then(work).then(value => {
      entry.pending = false;
      entry.bytes = Buffer.byteLength(JSON.stringify(value));
      entry.expiresAt = this.now() + this.ttlMs;
      entry.timer = setTimeout(() => this.remove(key), this.ttlMs);
      entry.timer.unref();
      this.prune();
      return value;
    }, error => { this.remove(key); throw error; });
    return entry.promise;
  }

  clear() { for (const key of this.entries.keys()) this.remove(key); }
}

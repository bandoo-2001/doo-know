import { sha256 } from '@noble/hashes/sha2.js';

/** Exact SHA-256 in HTTPS and ordinary HTTP; never claim to provide other Web Crypto operations. */
export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  // Snapshot before awaiting so callers cannot change the bytes being bound.
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
  const subtle = globalThis.crypto?.subtle;
  const digest =
    typeof subtle?.digest === 'function'
      ? new Uint8Array(await subtle.digest('SHA-256', bytes))
      : sha256(bytes);
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

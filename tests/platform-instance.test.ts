import { it, expect } from 'vitest';
import { createFixture } from './support/fixture.js';
import { acquireInstance, readInstance } from '../apps/server/platform/instance.js';
it('refuses a second live owner for one database and releases only its own instance token', async () => {
  const f = await createFixture();
  let release: (() => void) | undefined;
  try {
    release = acquireInstance(f.config, 'fixture-version');
    expect(readInstance(f.dataRoot)?.version).toBe('fixture-version');
    expect(() => acquireInstance(f.config, 'other-version')).toThrowError(/已有/);
    release();
    release = undefined;
    expect(readInstance(f.dataRoot)).toBeUndefined();
  } finally {
    release?.();
    await f.close();
  }
});

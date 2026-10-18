import { expect, it } from 'vitest';
import { createFixture, loginFixtureOwner, testPassword } from './support/fixture.js';
import { createApp } from '../apps/server/app.js';
import { loadHostConfig } from '../apps/server/platform/config.js';

it('restored copies start with no inherited downloadable artifacts and preserve the live catalog', async () => {
  const f = await createFixture();
  let restored: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    const headers = await loginFixtureOwner(f);
    const wait = async (id: string) => {
      for (let i = 0; i < 2000; i++) {
        const result = await f.app.inject({ url: '/api/manage/tasks/' + id, headers });
        const task = result.json();
        if (!['queued', 'running'].includes(task.state)) {
          expect(task.state, task.error).toBe('succeeded');
          return task;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw Error('fixture task timed out');
    };
    const first = (
      await f.app.inject({
        method: 'POST',
        url: '/api/manage/backups',
        headers,
        payload: { requestId: 'restore-ledger-first' },
      })
    ).json();
    const a = await wait(first.id);
    const second = (
      await f.app.inject({
        method: 'POST',
        url: '/api/manage/backups',
        headers,
        payload: { requestId: 'restore-ledger-second' },
      })
    ).json();
    const b = await wait(second.id);
    const operation = (
      await f.app.inject({
        method: 'POST',
        url: '/api/manage/restores',
        headers,
        payload: { backupId: b.result.backupId, requestId: 'restore-ledger-copy' },
      })
    ).json();
    const copy = await wait(operation.id);
    const config = loadHostConfig({ profileFile: copy.result.verification.profileFile });
    restored = await createApp(config);
    const login = await restored.inject({
      method: 'POST',
      url: '/api/auth/sign-in/username',
      headers: { origin: config.origin },
      payload: { username: 'owner', password: testPassword },
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies.map((item) => `${item.name}=${item.value}`).join('; ');
    const backups = await restored.inject({ url: '/api/manage/backups', headers: { cookie } });
    expect(backups.statusCode).toBe(200);
    expect(backups.json().items).toEqual([]);
    expect(
      (await restored.inject({ url: '/api/manage/tasks', headers: { cookie } })).json().items,
    ).toEqual([]);
    expect((await f.app.inject({ url: '/api/manage/backups', headers })).json().items).toHaveLength(
      2,
    );
    expect(
      (
        await f.app.inject({
          url: '/api/manage/backups/' + a.result.backupId + '/download',
          headers,
        })
      ).statusCode,
    ).toBe(200);
  } finally {
    await restored?.close();
    await f.close();
  }
}, 30000);

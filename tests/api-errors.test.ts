import { afterEach, expect, it, vi } from 'vitest';
import { api, ApiError } from '../apps/web/api';
import { PASSWORD_POLICY_MESSAGE } from '../shared/password-policy';

afterEach(() => vi.unstubAllGlobals());

it('explains a rejected username login from the authentication response without losing its status', async () => {
  const data = {
    code: 'INVALID_USERNAME_OR_PASSWORD',
    message: 'Invalid username or password',
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(data), { status: 401 })),
  );
  const error = await api('/api/auth/sign-in/username', 'POST', {
    username: 'sample-owner',
    password: 'synthetic-incorrect-password',
  }).catch((error: unknown) => error);

  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({
    status: 401,
    data,
  });
  expect((error as ApiError).message).toBe('用户名或密码不正确，请核对后重试');
});

it('preserves a server explanation supplied in the top-level message field', () => {
  expect(new ApiError(400, { code: 'INVALID_INPUT', message: '输入内容无效' }).message).toBe(
    '输入内容无效',
  );
});

it.each([
  [{ error: '原有错误说明', message: '次要说明' }, '原有错误说明'],
  [{ error: { code: 'CONFLICT', message: '版本已变更' } }, '版本已变更'],
  [{ code: 'PASSWORD_TOO_SHORT', message: 'Password too short' }, PASSWORD_POLICY_MESSAGE],
  [{ message: { invalid: true } }, '请求失败'],
])('retains the existing API error and password-policy behavior for %j', (data, message) => {
  expect(new ApiError(400, data).message).toBe(message);
});

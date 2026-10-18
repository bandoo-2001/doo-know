import { ApiError } from '../../api';
export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
/** The private key is returned as a binary attachment and never kept in component state. */
export async function downloadRecoveryKey(currentPassword: string) {
  // CSRF tokens deliberately stay private to api.ts; fetch a fresh token for the binary response.
  const csrfResponse = await fetch('/api/security/csrf', { cache: 'no-store' });
  if (!csrfResponse.ok) throw Error('无法验证请求，请重试。');
  const csrf = await csrfResponse.json();
  const response = await fetch('/api/manage/backups/key', {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf.token },
    body: JSON.stringify({ currentPassword }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({ error: '无法下载恢复密钥' }));
    throw new ApiError(response.status, data);
  }
  downloadBlob(await response.blob(), 'dooknow-recovery-key.pem');
}

/** Applies when setting a new password; existing credential verification stays compatible. */
export const MIN_PASSWORD_LENGTH = 8;
export const PASSWORD_POLICY_MESSAGE = `密码至少需要 ${MIN_PASSWORD_LENGTH} 个字符`;

export function validateNewPassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(PASSWORD_POLICY_MESSAGE);
}

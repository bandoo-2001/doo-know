/** Validate interactive input before any account write; terminal errors still abort. */
export async function collectAccount(io: {
  username(): Promise<string>;
  password(prompt: string): Promise<string>;
  report(message: string): void;
}, reset = false) {
  let username = '';
  if (!reset) {
    for (;;) {
      username = await io.username();
      if (/^[a-zA-Z0-9_.]{3,30}$/.test(username)) break;
      io.report('用户名需为 3–30 个字母、数字、点或下划线，请重新输入。');
    }
  }
  for (;;) {
    const password = await io.password('密码（至少12位，输入隐藏）：');
    if (password.length < 12) {
      io.report('密码至少需要 12 位，请重新输入。');
      continue;
    }
    if (password !== await io.password('再次输入密码：')) {
      io.report('两次密码不一致，请重新输入密码。');
      continue;
    }
    return { username, password };
  }
}

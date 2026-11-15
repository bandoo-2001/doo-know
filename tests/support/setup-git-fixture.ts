import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppDatabase } from '../../packages/core/db.js';
import { localGitTransport } from './git-remote-fixture.js';

/** Local-only remotes for first-install browser acceptance. No production option enables this mapping. */
export async function createSetupGitFixture(fixtureRoot: string) {
  const seedRoot = join(fixtureRoot, 'git-seed');
  const bareRoot = join(fixtureRoot, 'git-remote.git');
  await mkdir(join(seedRoot, '00-Inbox'), { recursive: true });
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', seedRoot, ...args], { stdio: 'pipe' });
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'Onboarding Fixture');
  git('config', 'user.email', 'onboarding@example.invalid');
  await writeFile(
    join(seedRoot, '00-Inbox', 'imported-note.md'),
    '# 导入的验收笔记\n\n这是隔离测试仓库，不包含用户资料。\n',
  );
  await writeFile(join(seedRoot, 'README.md'), '# 隔离 Git 导入验收\n');
  git('add', '.');
  git('commit', '-m', 'Create isolated onboarding fixture');
  execFileSync('git', ['clone', '--bare', seedRoot, bareRoot], { stdio: 'pipe' });
  const remoteUrl = 'https://github.com/fixture/onboarding.git';
  const giteeRemoteUrl = 'https://gitee.com/fixture/onboarding.git';
  return {
    remoteUrl,
    giteeRemoteUrl,
    seedRoot,
    bareRoot,
    gitExec: (db: AppDatabase) =>
      localGitTransport(db, {
        [remoteUrl]: bareRoot,
        [giteeRemoteUrl]: bareRoot,
      }),
  };
}

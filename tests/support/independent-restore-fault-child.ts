import fs from 'node:fs';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const [configFile, id, source, dest, fault] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
const unlink = fs.unlinkSync,
  copy = fs.copyFileSync;
const readFile = fs.readFileSync;
let injected = false,
  competingExit: number | null = null;
if (fault === 'bounded-read') {
  fs.readFileSync = ((path: fs.PathOrFileDescriptor, ...args: any[]) => {
    if (
      typeof path === 'string' &&
      (path === source || path === dest || path.includes('.doo-restore-'))
    )
      throw new Error('fixture budget forbids whole-file restore buffers');
    return (readFile as any)(path, ...args);
  }) as typeof fs.readFileSync;
} else if (fault === 'target-disappears') {
  fs.unlinkSync = ((path: fs.PathLike) => {
    if (String(path) === source && !injected) {
      injected = true;
      const removed = spawnSync(
        process.execPath,
        ['-e', 'require("node:fs").unlinkSync(process.argv[1])', dest],
        { encoding: 'utf8', timeout: 10000 },
      );
      competingExit = removed.status;
      if (removed.status !== 0) throw new Error('isolated competing process failed');
    }
    unlink(path);
  }) as typeof fs.unlinkSync;
} else if (fault === 'partial-copy') {
  fs.copyFileSync = ((from: fs.PathLike, to: fs.PathLike, ...args: any[]) => {
    if (String(from) === source && String(to).includes('.doo-restore-')) {
      fs.writeFileSync(to, fs.readFileSync(from).subarray(0, 4), { flag: 'wx', mode: 0o600 });
      process.exit(73);
    }
    copy(from, to, ...args);
  }) as typeof fs.copyFileSync;
}
syncBuiltinESMExports();
const { openDatabase } = await import('../../server/db.js');
const { mutationCore, webPrincipal } = await import('../../server/knowledge/core.js');
const db = openDatabase(config.dataRoot);
let error: unknown;
try {
  mutationCore(config, db).restore(webPrincipal, id, undefined, 'independent-restore');
} catch (e) {
  error = { status: (e as any).statusCode, code: (e as any).code };
} finally {
  fs.readFileSync = readFile;
  fs.unlinkSync = unlink;
  fs.copyFileSync = copy;
  syncBuiltinESMExports();
  db.close();
}
const candidates = [
  source,
  dest,
  ...fs
    .readdirSync(dirname(dest))
    .filter((name) => name.startsWith('.doo-restore-'))
    .map((name) => dirname(dest) + '/' + name),
];
const copies = candidates
  .filter((path) => fs.existsSync(path) && fs.lstatSync(path).isFile())
  .map((path) => ({ path, content: fs.readFileSync(path, 'utf8') }));
process.stdout.write(JSON.stringify({ injected, competingExit, error, copies }));

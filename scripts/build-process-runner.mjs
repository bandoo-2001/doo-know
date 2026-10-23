import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  renameSync,
  mkdtempSync,
  rmSync,
  copyFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, 'packages/core/processes/process-runner.c');
const build = join(root, 'packages/core/processes/.build');
const flags = [
  '-std=c11',
  '-O2',
  '-Wall',
  '-Wextra',
  '-Werror',
  '-fPIE',
  '-pie',
  '-fstack-protector-strong',
  '-Wl,-z,relro,-z,now,-z,noexecstack',
];
const hash = (value) => createHash('sha256').update(value).digest('hex');
function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const st = lstatSync(path);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || st.mode & 0o022)
    throw Error('Native build directory is not an owned private directory');
}
function regularFile(path) {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.())
      throw Error('Native build output is not an owned regular file');
    return st;
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}
export function buildProcessRunner({ copyDist = false } = {}) {
  if (process.platform !== 'linux' || process.arch !== 'x64')
    throw Error('Native process runner requires Linux x86_64');
  privateDirectory(build);
  const binary = join(build, 'process-runner'),
    receipt = join(build, 'receipt.json');
  const sourceHash = hash(
    Buffer.concat([readFileSync(source), Buffer.from(JSON.stringify(flags))]),
  );
  const binaryInfo = regularFile(binary),
    receiptInfo = regularFile(receipt);
  let accepted = false;
  if (binaryInfo && receiptInfo) {
    try {
      const previous = JSON.parse(readFileSync(receipt, 'utf8'));
      accepted =
        previous.sourceHash === sourceHash &&
        previous.binaryHash === hash(readFileSync(binary)) &&
        !(binaryInfo.mode & 0o022) &&
        !!(binaryInfo.mode & 0o100);
    } catch {}
  }
  if (!accepted) {
    const temporary = mkdtempSync(join(build, '.compile-'));
    try {
      const output = join(temporary, 'process-runner');
      execFileSync('cc', [...flags, source, '-o', output], {
        stdio: 'inherit',
        env: { ...process.env, TMPDIR: temporary },
      });
      chmodSync(output, 0o700);
      execFileSync(output, ['--check'], { stdio: 'inherit', timeout: 3000 });
      const proof = { sourceHash, binaryHash: hash(readFileSync(output)) };
      renameSync(output, binary);
      writeFileSync(join(temporary, 'receipt.json'), JSON.stringify(proof) + '\n', { mode: 0o600 });
      renameSync(join(temporary, 'receipt.json'), receipt);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  if (copyDist) {
    const destination = join(root, 'dist/server/packages/core/processes/.build');
    privateDirectory(destination);
    regularFile(join(destination, 'process-runner'));
    const temporary = mkdtempSync(join(destination, '.copy-'));
    try {
      copyFileSync(binary, join(temporary, 'process-runner'));
      chmodSync(join(temporary, 'process-runner'), 0o700);
      renameSync(join(temporary, 'process-runner'), join(destination, 'process-runner'));
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  return binary;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  buildProcessRunner({ copyDist: process.argv.includes('--copy-dist') });

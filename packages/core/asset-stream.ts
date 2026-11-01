import {
  createReadStream,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  constants,
  readSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { HttpError } from './errors.js';
export type AssetDescriptor = {
  path: string;
  absolutePath: string;
  mime: string;
  sizeBytes: number;
  stamp: string;
};
export function assetStamp(path: string) {
  const s = lstatSync(path, { bigint: true });
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1n) throw new HttpError(404, '附件不存在');
  return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':');
}
export function hashAssetSync(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW),
    hash = createHash('sha256'),
    bytes = Buffer.allocUnsafe(65536);
  try {
    let n;
    while ((n = readSync(fd, bytes, 0, bytes.length, null)) > 0) hash.update(bytes.subarray(0, n));
    return hash.digest('hex');
  } finally {
    closeSync(fd);
  }
}
export function openAsset(
  descriptor: AssetDescriptor,
  options: { start?: number; end?: number; check?: () => void } = {},
) {
  const check = () => {
    options.check?.();
    if (assetStamp(descriptor.absolutePath) !== descriptor.stamp)
      throw new HttpError(409, '附件已变化');
  };
  check();
  const start = options.start ?? 0,
    end = options.end ?? descriptor.sizeBytes - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end >= descriptor.sizeBytes
  )
    throw new HttpError(416, '附件范围无效');
  const fd = openSync(descriptor.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = fstatSync(fd, { bigint: true });
    if ([s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':') !== descriptor.stamp)
      throw new HttpError(409, '附件已变化');
  } catch (e) {
    closeSync(fd);
    throw e;
  }
  const input = createReadStream(descriptor.absolutePath, {
    fd,
    autoClose: true,
    start,
    end,
    highWaterMark: 65536,
  });
  const checked = new Transform({
    transform(chunk, _encoding, callback) {
      try {
        check();
        callback(null, chunk);
      } catch (e) {
        callback(e as Error);
      }
    },
    flush(callback) {
      try {
        check();
        callback();
      } catch (e) {
        callback(e as Error);
      }
    },
  });
  input.on('error', (e) => checked.destroy(e));
  checked.on('close', () => input.destroy());
  input.pipe(checked);
  return checked;
}

import { afterEach, expect, it } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  readFileSync,
  openSync,
  closeSync,
  ftruncateSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { portableResourceLimits } from '../shared/portable-resource-limits';
import { inspectMediaFile, MEDIA_MIMES } from '../packages/core/media';
const root = mkdtempSync(join(tmpdir(), 'media-validation-'));
afterEach(() => {
  for (const name of ['valid.wav', 'bad.wav', 'valid.mp4', 'bad.mp4'])
    rmSync(join(root, name), { force: true });
});
function wav(size = 16) {
  const b = Buffer.alloc(44 + size);
  b.write('RIFF');
  b.writeUInt32LE(b.length - 8, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(size, 40);
  return b;
}
it('validates WAV chunks, exact size and declared MIME without a file-sized read', () => {
  const path = join(root, 'valid.wav');
  writeFileSync(path, wav());
  expect(inspectMediaFile(path, 'audio/wav').sizeBytes).toBe(60);
  expect(() => inspectMediaFile(path, 'video/mp4')).toThrow();
  writeFileSync(join(root, 'bad.wav'), wav().subarray(0, 50));
  expect(() => inspectMediaFile(join(root, 'bad.wav'), 'audio/wav')).toThrow();
});
it('rejects a signature-only MP4 and quota excess', () => {
  const path = join(root, 'bad.mp4');
  writeFileSync(path, Buffer.from('000000186674797069736f6d0000000069736f6d6d703432', 'hex'));
  expect(() => inspectMediaFile(path, 'video/mp4')).toThrow();
  const p = join(root, 'valid.wav');
  writeFileSync(p, wav());
  expect(() => inspectMediaFile(p, 'audio/wav', 59)).toThrow();
});
it.each(Object.entries(MEDIA_MIMES))('accepts real %s container fixture', (ext, mime) => {
  const path = join(import.meta.dirname, 'fixtures/media', `sample${ext}`);
  expect(inspectMediaFile(path, mime).sizeBytes).toBe(readFileSync(path).length);
  const bad = join(root, 'bad' + ext);
  writeFileSync(bad, readFileSync(path).subarray(0, 30));
  expect(() => inspectMediaFile(bad, mime)).toThrow();
  rmSync(bad);
});

it('validates the 128 MiB media boundary using bounded structural reads', () => {
  const p = join(root, 'valid.wav'),
    limit = portableResourceLimits.mediaBytes,
    fd = openSync(p, 'w');
  try {
    const head = wav(0).subarray(0, 44);
    head.writeUInt32LE(limit - 8, 4);
    head.writeUInt32LE(limit - 44, 40);
    writeSync(fd, head);
    ftruncateSync(fd, limit);
  } finally {
    closeSync(fd);
  }
  expect(inspectMediaFile(p, 'audio/wav').sizeBytes).toBe(limit);
  const large = openSync(p, 'r+');
  try {
    ftruncateSync(large, limit + 1);
  } finally {
    closeSync(large);
  }
  expect(() => inspectMediaFile(p, 'audio/wav')).toThrow(/配额/);
});

it('review regression: rejects forged MP4 with valid signatures but no movie/track/sample hierarchy', () => {
  const box = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length + 8);
    head.write(type, 4);
    return Buffer.concat([head, body]);
  };
  const fake = Buffer.concat([
    box('ftyp', Buffer.from('isom0000')),
    box(
      'moov',
      Buffer.concat([
        box('hdlr', Buffer.concat([Buffer.alloc(8), Buffer.from('vide')])),
        box(
          'stsd',
          Buffer.concat([Buffer.from('0000000000000001', 'hex'), box('xxxx', Buffer.alloc(8))]),
        ),
      ]),
    ),
    box('mdat', Buffer.from('x')),
  ]);
  const path = join(root, 'bad.mp4');
  writeFileSync(path, fake);
  expect(() => inspectMediaFile(path, 'video/mp4')).toThrow();
});

it('retains a real H.264 video MP4 with an AAC audio track after hierarchy validation', () => {
  const path = join(import.meta.dirname, 'fixtures/media/video.mp4');
  expect(inspectMediaFile(path, 'video/mp4').sizeBytes).toBe(readFileSync(path).length);
});

it.each(['mvhd', 'trak', 'tkhd', 'mdia', 'mdhd', 'minf', 'stbl', 'stsd', 'avc1'])(
  'rejects a real MP4 with required %s structure replaced',
  (tag) => {
    const bytes = Buffer.from(readFileSync(join(import.meta.dirname, 'fixtures/media/video.mp4'))),
      offset = bytes.lastIndexOf(Buffer.from(tag));
    expect(offset).toBeGreaterThan(0);
    if (tag === 'trak') {
      let at = bytes.indexOf(Buffer.from(tag));
      while (at >= 0) {
        bytes.write('xxxx', at);
        at = bytes.indexOf(Buffer.from(tag), at + 4);
      }
    } else bytes.write('xxxx', offset);
    const path = join(root, 'bad.mp4');
    writeFileSync(path, bytes);
    expect(() => inspectMediaFile(path, 'video/mp4')).toThrow();
  },
);

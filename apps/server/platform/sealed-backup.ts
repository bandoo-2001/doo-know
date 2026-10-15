import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createHash,
} from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, writeFile, mkdir, open, stat, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { privateFile } from '../../../packages/core/agent/config.js';
const MAGIC = Buffer.from('DOOKNOWBK1');
export async function backupKey(file: string) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  let key;
  try {
    key = createPrivateKey(privateFile(file));
  } catch (e) {
    if ((e as any).code !== 'ENOENT') {
      try {
        await stat(file);
        throw e;
      } catch (missing) {
        if ((missing as any).code !== 'ENOENT') throw e;
      }
    }
    const pair = generateKeyPairSync('x25519');
    await writeFile(file, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), {
      flag: 'wx',
      mode: 0o600,
    });
    key = pair.privateKey;
  }
  if (key.asymmetricKeyType !== 'x25519') throw Error('备份恢复密钥类型不正确');
  const publicKey = createPublicKey(key);
  return {
    privateKey: key,
    publicKey,
    fingerprint: createHash('sha256')
      .update(publicKey.export({ format: 'der', type: 'spki' }))
      .digest('hex'),
  };
}
function derived(
  privateKey: ReturnType<typeof createPrivateKey>,
  publicKey: ReturnType<typeof createPublicKey>,
  salt: Buffer,
) {
  return Buffer.from(
    hkdfSync(
      'sha256',
      diffieHellman({ privateKey, publicKey }),
      salt,
      'DooKnow encrypted backup v1',
      32,
    ),
  );
}
export async function sealBackup(
  source: string,
  destination: string,
  keyFile: string,
  payloadBytes: number,
) {
  const recipient = await backupKey(keyFile),
    ephemeral = generateKeyPairSync('x25519'),
    iv = randomBytes(12),
    salt = randomBytes(32);
  const json = Buffer.from(
    JSON.stringify({
      version: 1,
      ephemeral: ephemeral.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      iv: iv.toString('base64'),
      salt: salt.toString('base64'),
      payloadBytes,
    }),
  );
  const length = Buffer.alloc(4);
  length.writeUInt32BE(json.length);
  const header = Buffer.concat([MAGIC, length, json]);
  const cipher = createCipheriv(
    'aes-256-gcm',
    derived(ephemeral.privateKey, recipient.publicKey, salt),
    iv,
  );
  cipher.setAAD(header);
  let created = false;
  const output = createWriteStream(destination, { flags: 'wx', mode: 0o600 });
  output.once('open', () => {
    created = true;
  });
  output.on('error', () => {});
  try {
    await new Promise<void>((yes, no) => output.write(header, (e) => (e ? no(e) : yes())));
    const input = createReadStream(source);
    input.on('error', (error) => cipher.destroy(error));
    cipher.once('close', () => input.destroy());
    for await (const block of input.pipe(cipher))
      await new Promise<void>((yes, no) => output.write(block, (e) => (e ? no(e) : yes())));
    await new Promise<void>((yes, no) => {
      output.once('error', no);
      output.end(cipher.getAuthTag(), () => yes());
    });
  } catch (e) {
    output.destroy();
    if (created) await rm(destination, { force: true });
    throw e;
  }
  const saved = await open(destination, 'r');
  try {
    await saved.sync();
  } finally {
    await saved.close();
  }
  return { fingerprint: recipient.fingerprint, keyFile };
}
export async function unsealBackup(source: string, destination: string, keyFile: string) {
  let created = false;
  const input = await open(source, 'r');
  try {
    const st = await input.stat();
    if (!st.isFile() || st.size < 30) throw Error('备份格式不正确');
    const prefix = Buffer.alloc(14);
    await input.read(prefix, 0, 14, 0);
    if (!prefix.subarray(0, 10).equals(MAGIC)) throw Error('备份格式不正确');
    const size = prefix.readUInt32BE(10);
    if (size > 65536 || size < 2 || st.size < 14 + size + 16) throw Error('备份格式不正确');
    const json = Buffer.alloc(size);
    await input.read(json, 0, size, 14);
    const header = Buffer.concat([prefix, json]),
      data = JSON.parse(json.toString('utf8'));
    if (data.version !== 1 || !Number.isSafeInteger(data.payloadBytes) || data.payloadBytes < 0)
      throw Error('备份格式不正确');
    const recipient = createPrivateKey(privateFile(keyFile)),
      publicKey = createPublicKey({
        key: Buffer.from(data.ephemeral, 'base64'),
        format: 'der',
        type: 'spki',
      }),
      tag = Buffer.alloc(16);
    await input.read(tag, 0, 16, st.size - 16);
    const decipher = createDecipheriv(
      'aes-256-gcm',
      derived(recipient, publicKey, Buffer.from(data.salt, 'base64')),
      Buffer.from(data.iv, 'base64'),
    );
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    const output = createWriteStream(destination, { flags: 'wx', mode: 0o600 });
    output.once('open', () => {
      created = true;
    });
    await pipeline(
      createReadStream(source, { start: header.length, end: st.size - 17 }),
      decipher,
      output,
    );
    return { payloadBytes: data.payloadBytes };
  } catch {
    if (created) await rm(destination, { force: true });
    throw Error('备份解密或完整性验证失败；请核对恢复密钥和文件');
  } finally {
    await input.close();
  }
}

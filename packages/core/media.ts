import { openSync, closeSync, constants, fstatSync, readSync } from 'node:fs';
import { HttpError } from './errors.js';
import { portableResourceLimits } from '../../shared/portable-resource-limits.js';
export { MEDIA_MIMES } from '../../shared/media.js';

/** Structural container validation. Every allocation is bounded; payloads are never decoded or buffered. */
export function inspectMediaFile(
  path: string,
  mime: string,
  maxBytes: number = portableResourceLimits.mediaBytes,
) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes)
      throw new HttpError(413, '媒体超过配置配额');
    const size = stat.size;
    const page = Buffer.allocUnsafe(65536);
    let pageStart = -1,
      pageLength = 0;
    const bad = () => {
      throw new HttpError(400, '媒体 MIME 与完整文件结构不匹配');
    };
    const read = (offset: number, length: number) => {
      if (
        !Number.isSafeInteger(offset) ||
        length < 0 ||
        length > 65536 ||
        offset < 0 ||
        offset + length > size
      )
        return bad();
      if (length === 0) return Buffer.alloc(0);
      if (offset >= pageStart && offset + length <= pageStart + pageLength)
        return page.subarray(offset - pageStart, offset - pageStart + length);
      const start = Math.floor(offset / page.length) * page.length;
      if (offset + length <= start + page.length) {
        pageStart = start;
        pageLength = readSync(fd, page, 0, Math.min(page.length, size - start), start);
        if (offset + length > start + pageLength) return bad();
        return page.subarray(offset - start, offset - start + length);
      }
      const bytes = Buffer.allocUnsafe(length);
      if (readSync(fd, bytes, 0, length, offset) !== length) return bad();
      return bytes;
    };
    if (mime === 'audio/wav') {
      const head = read(0, 12);
      if (
        head.toString('ascii', 0, 4) !== 'RIFF' ||
        head.toString('ascii', 8) !== 'WAVE' ||
        head.readUInt32LE(4) + 8 !== size
      )
        bad();
      let at = 12,
        fmt = false,
        data = false,
        align = 0;
      while (at < size) {
        const h = read(at, 8),
          n = h.readUInt32LE(4),
          tag = h.toString('ascii', 0, 4);
        if (at + 8 + n + (n % 2) > size) bad();
        if (tag === 'fmt ') {
          if (fmt || n < 16) bad();
          const f = read(at + 8, 16),
            format = f.readUInt16LE(0),
            channels = f.readUInt16LE(2),
            rate = f.readUInt32LE(4),
            bits = f.readUInt16LE(14);
          align = f.readUInt16LE(12);
          if (
            ![1, 3, 0xfffe].includes(format) ||
            channels < 1 ||
            channels > 64 ||
            !rate ||
            !bits ||
            bits > 64 ||
            align !== channels * Math.ceil(bits / 8) ||
            f.readUInt32LE(8) !== rate * align
          )
            bad();
          if (![8, 16, 24, 32, 64].includes(bits) || (format === 3 && ![32, 64].includes(bits)))
            bad();
          if (format === 0xfffe) {
            if (n < 40) bad();
            const extension = read(at + 8 + 16, 24),
              cb = extension.readUInt16LE(0),
              valid = extension.readUInt16LE(2),
              subtype = extension.readUInt32LE(8);
            if (
              cb < 22 ||
              18 + cb > n ||
              !valid ||
              valid > bits ||
              ![1, 3].includes(subtype) ||
              (subtype === 3 && ![32, 64].includes(bits)) ||
              !extension.subarray(12).equals(Buffer.from('00001000800000aa00389b71', 'hex'))
            )
              bad();
          }
          fmt = true;
        }
        if (tag === 'data') {
          if (!fmt || !n || n % align) bad();
          data = true;
        }
        at += 8 + n + (n % 2);
      }
      if (at !== size || !fmt || !data) bad();
    } else if (mime === 'video/mp4') {
      let ftyp = false,
        moov = false,
        mdat = false,
        track = false,
        sample = false;
      let boxes = 0;
      function walk(start: number, end: number, depth: number) {
        if (depth > 8) bad();
        let at = start;
        while (at < end) {
          if (++boxes > 100000) bad();
          const h = read(at, 8),
            type = h.toString('ascii', 4),
            n = h.readUInt32BE(0);
          let header = 8,
            length = n;
          if (n === 1) {
            const large = read(at + 8, 8).readBigUInt64BE();
            if (large > BigInt(Number.MAX_SAFE_INTEGER)) bad();
            length = Number(large);
            header = 16;
          }
          if (n === 0) length = end - at;
          if (length < header || at + length > end) bad();
          if (!depth && type === 'ftyp') {
            if (length < header + 8 || (length - header) % 4) bad();
            const brands = read(at + header, Math.min(length - header, 256)).toString('ascii');
            if (!/(?:isom|iso[2-9]|mp4[12]|avc1|M4V |dash)/.test(brands)) bad();
            ftyp = true;
          }
          if (!depth && type === 'mdat' && length > header) mdat = true;
          if (type === 'moov') moov = true;
          if (type === 'hdlr') {
            const h = read(at + header, 12);
            if (['vide', 'soun'].includes(h.toString('ascii', 8, 12))) track = true;
          }
          if (type === 'stsd') {
            const h = read(at + header, 8),
              count = h.readUInt32BE(4);
            if (!count || count > 10000 || length < header + 16) bad();
            let entry = at + header + 8;
            for (let index = 0; index < count; index++) {
              const e = read(entry, 8),
                n = e.readUInt32BE();
              if (n < 16 || entry + n > at + length) bad();
              entry += n;
            }
            if (entry !== at + length) bad();
            sample = true;
          }
          if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(type))
            walk(at + header, at + length, depth + 1);
          at += length;
        }
        if (at !== end) bad();
      }
      walk(0, size, 0);
      if (!ftyp || !moov || !mdat || !track || !sample) bad();
    } else if (mime === 'video/webm') {
      let doctype = false,
        tracks = false,
        block = false,
        segment = false,
        codec = false,
        elements = 0;
      function vint(at: number, id = false) {
        const first = read(at, 1)[0];
        let n = 1,
          mask = 128;
        while (n <= 8 && !(first & mask)) {
          n++;
          mask >>= 1;
        }
        if (n > 8 || (id && n > 4)) return bad();
        const b = read(at, n);
        let value = BigInt(id ? first : first & (mask - 1));
        for (let i = 1; i < n; i++) value = (value << 8n) | BigInt(b[i]);
        const unknown = !id && value === (1n << BigInt(7 * n)) - 1n;
        if (!unknown && value > BigInt(Number.MAX_SAFE_INTEGER)) bad();
        return { n, value: Number(value), unknown };
      }
      function walk(start: number, end: number, depth: number) {
        if (depth > 8) bad();
        let at = start;
        while (at < end) {
          if (++elements > 1000000) bad();
          const id = vint(at, true),
            n = vint(at + id.n),
            body = at + id.n + n.n,
            stop = n.unknown ? end : body + n.value;
          if (
            stop > end ||
            stop < body ||
            (n.unknown && ![0x18538067, 0x1f43b675].includes(id.value))
          )
            bad();
          if (!depth && id.value === 0x18538067) segment = true;
          if (id.value === 0x4282) {
            if (n.value > 16 || read(body, n.value).toString() !== 'webm') bad();
            doctype = true;
          }
          if (id.value === 0x1654ae6b) tracks = true;
          if (id.value === 0x86) {
            if (n.value > 32) bad();
            codec = /^(?:V_VP8|V_VP9|V_AV1|A_OPUS|A_VORBIS)$/.test(read(body, n.value).toString());
            if (!codec) bad();
          }
          if (id.value === 0xa3 || id.value === 0xa1) {
            if (stop - body < 5) bad();
            block = true;
          }
          if ([0x1a45dfa3, 0x18538067, 0x1654ae6b, 0xae, 0x1f43b675, 0xa0].includes(id.value))
            walk(body, stop, depth + 1);
          at = stop;
        }
        if (at !== end) bad();
      }
      if (read(0, 4).readUInt32BE() !== 0x1a45dfa3) bad();
      walk(0, size, 0);
      if (!doctype || !segment || !tracks || !codec || !block) bad();
    } else if (mime === 'audio/mpeg') {
      let at = 0,
        frames = 0;
      if (read(0, 3).toString() === 'ID3') {
        const h = read(0, 10);
        if (h[3] < 2 || h[3] > 4 || h.subarray(6, 10).some((b) => b > 127)) bad();
        at = 10 + ((h[6] << 21) | (h[7] << 14) | (h[8] << 7) | h[9]) + (h[5] & 16 ? 10 : 0);
        if (at > size) bad();
      }
      while (at < size) {
        if (size - at === 128 && read(at, 3).toString() === 'TAG') {
          at = size;
          break;
        }
        const h = read(at, 4),
          word = h.readUInt32BE(),
          ver = (word >>> 19) & 3,
          layer = (word >>> 17) & 3,
          bi = (word >>> 12) & 15,
          ri = (word >>> 10) & 3,
          pad = (word >>> 9) & 1;
        if (word >>> 21 !== 0x7ff || ver === 1 || layer !== 1 || !bi || bi === 15 || ri === 3)
          bad();
        const rate = [44100, 48000, 32000][ri] / (ver === 3 ? 1 : ver === 2 ? 2 : 4),
          bitrate = (
            ver === 3
              ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
              : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
          )[bi];
        const n = Math.floor(((ver === 3 ? 144000 : 72000) * bitrate) / rate) + pad;
        if (n < 4 || at + n > size) bad();
        at += n;
        frames++;
      }
      if (at !== size || frames < 1) bad();
    } else bad();
    return { sizeBytes: size, mime };
  } finally {
    closeSync(fd);
  }
}

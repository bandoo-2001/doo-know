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
      type Box = { type: string; body: number; end: number };
      let boxCount = 0;
      const requiredParent: Record<string, string> = {
        ftyp: 'root',
        moov: 'root',
        mdat: 'root',
        mvhd: 'moov',
        trak: 'moov',
        tkhd: 'trak',
        mdia: 'trak',
        mdhd: 'mdia',
        hdlr: 'mdia',
        minf: 'mdia',
        vmhd: 'minf',
        smhd: 'minf',
        dinf: 'minf',
        dref: 'dinf',
        stbl: 'minf',
        stsd: 'stbl',
        stts: 'stbl',
        stsc: 'stbl',
        stsz: 'stbl',
        stz2: 'stbl',
        stco: 'stbl',
        co64: 'stbl',
      };
      function boxes(start: number, end: number, parent: string): Box[] {
        const found: Box[] = [];
        let at = start;
        while (at < end) {
          if (++boxCount > 100000 || end - at < 8) bad();
          const h = read(at, 8),
            type = h.toString('ascii', 4),
            small = h.readUInt32BE();
          let header = 8,
            length = small;
          if (small === 1) {
            if (end - at < 16) bad();
            const n = read(at + 8, 8).readBigUInt64BE();
            if (n > BigInt(Number.MAX_SAFE_INTEGER)) bad();
            length = Number(n);
            header = 16;
          }
          if (small === 0) length = end - at;
          if (
            length < header ||
            at + length > end ||
            (requiredParent[type] && requiredParent[type] !== parent)
          )
            bad();
          found.push({ type, body: at + header, end: at + length });
          at += length;
        }
        if (at !== end) bad();
        return found;
      }
      function one(list: Box[], type: string) {
        const matching = list.filter((box) => box.type === type);
        if (matching.length !== 1) return bad();
        return matching[0];
      }
      const versioned = (box: Box, v0: number, v1: number) => {
        const v = read(box.body, 1)[0];
        if (v > 1 || box.end - box.body < (v ? v1 : v0)) bad();
        return v;
      };
      const table = (box: Box, stride: number) => {
        if (box.end - box.body < 8 || read(box.body, 4).readUInt32BE() !== 0) bad();
        const n = read(box.body + 4, 4).readUInt32BE();
        if (box.end - box.body !== 8 + n * stride) bad();
        return n;
      };
      const root = boxes(0, size, 'root'),
        ftyp = one(root, 'ftyp'),
        movie = one(root, 'moov');
      if (
        ftyp.end - ftyp.body < 8 ||
        (ftyp.end - ftyp.body) % 4 ||
        !/(?:isom|iso[2-9]|mp4[12]|avc1|M4V |dash)/.test(
          read(ftyp.body, Math.min(ftyp.end - ftyp.body, 256)).toString('ascii'),
        )
      )
        bad();
      const payloads = root.filter((box) => box.type === 'mdat' && box.end > box.body);
      if (!payloads.length) bad();
      const movieBoxes = boxes(movie.body, movie.end, 'moov'),
        header = one(movieBoxes, 'mvhd'),
        version = versioned(header, 100, 112);
      if (!read(header.body + (version ? 20 : 12), 4).readUInt32BE()) bad();
      const tracks = movieBoxes.filter((box) => box.type === 'trak');
      if (!tracks.length) bad();
      let mediaTrack = false;
      for (const track of tracks) {
        const trackBoxes = boxes(track.body, track.end, 'trak'),
          tkhd = one(trackBoxes, 'tkhd'),
          tv = versioned(tkhd, 84, 96);
        if (!read(tkhd.body + (tv ? 20 : 12), 4).readUInt32BE()) bad();
        const media = one(trackBoxes, 'mdia'),
          mediaBoxes = boxes(media.body, media.end, 'mdia'),
          mdhd = one(mediaBoxes, 'mdhd'),
          mv = versioned(mdhd, 24, 36);
        if (!read(mdhd.body + (mv ? 20 : 12), 4).readUInt32BE()) bad();
        const handler = one(mediaBoxes, 'hdlr');
        if (handler.end - handler.body < 24 || read(handler.body, 4).readUInt32BE() !== 0) bad();
        const kind = read(handler.body + 8, 4).toString('ascii'),
          visual = kind === 'vide',
          audio = kind === 'soun';
        mediaTrack ||= visual || audio;
        const minf = one(mediaBoxes, 'minf'),
          mediaInfo = boxes(minf.body, minf.end, 'minf');
        if (
          (visual && one(mediaInfo, 'vmhd').end - one(mediaInfo, 'vmhd').body < 12) ||
          (audio && one(mediaInfo, 'smhd').end - one(mediaInfo, 'smhd').body < 8)
        )
          bad();
        const dinf = one(mediaInfo, 'dinf'),
          dref = one(boxes(dinf.body, dinf.end, 'dinf'), 'dref');
        if (dref.end - dref.body < 8 || read(dref.body, 4).readUInt32BE() !== 0) bad();
        const references = boxes(dref.body + 8, dref.end, 'dref');
        if (!references.length || references.length !== read(dref.body + 4, 4).readUInt32BE())
          bad();
        // External data references cannot establish a self-contained media attachment.
        for (const ref of references)
          if (
            ref.type !== 'url ' ||
            ref.end - ref.body !== 4 ||
            read(ref.body, 4).readUInt32BE() !== 1
          )
            bad();
        const stbl = one(mediaInfo, 'stbl'),
          samples = boxes(stbl.body, stbl.end, 'stbl'),
          stsd = one(samples, 'stsd');
        if (stsd.end - stsd.body < 8 || read(stsd.body, 4).readUInt32BE() !== 0) bad();
        const descriptions = boxes(stsd.body + 8, stsd.end, 'stsd');
        if (!descriptions.length || descriptions.length !== read(stsd.body + 4, 4).readUInt32BE())
          bad();
        const videoCodecs: Record<string, string> = {
          avc1: 'avcC',
          avc2: 'avcC',
          avc3: 'avcC',
          avc4: 'avcC',
          hvc1: 'hvcC',
          hev1: 'hvcC',
          mp4v: 'esds',
          av01: 'av1C',
          vp08: 'vpcC',
          vp09: 'vpcC',
        };
        const audioCodecs: Record<string, string> = {
          mp4a: 'esds',
          Opus: 'dOps',
          fLaC: 'dfLa',
          'ac-3': 'dac3',
          'ec-3': 'dec3',
          alac: 'alac',
        };
        for (const entry of descriptions) {
          if (entry.end - entry.body < 8) bad();
          const base = read(entry.body, 8),
            reference = base.readUInt16BE(6);
          if (
            base.subarray(0, 6).some((byte) => byte !== 0) ||
            !reference ||
            reference > references.length
          )
            bad();
          if (visual) {
            if (entry.end - entry.body < 78 || !videoCodecs[entry.type]) bad();
            const h = read(entry.body, 78);
            if (!h.readUInt16BE(24) || !h.readUInt16BE(26) || !h.readUInt16BE(40)) bad();
            const config = one(
              boxes(entry.body + 78, entry.end, 'visual-entry'),
              videoCodecs[entry.type],
            );
            if (config.end - config.body < 4) bad();
          } else if (audio) {
            if (entry.end - entry.body < 28 || !audioCodecs[entry.type]) bad();
            const h = read(entry.body, 28),
              v = h.readUInt16BE(8);
            if (v > 1 || !h.readUInt16BE(16) || !h.readUInt16BE(18) || !h.readUInt32BE(24)) bad();
            const skip = v === 1 ? 44 : 28;
            if (entry.end - entry.body < skip) bad();
            const config = one(
              boxes(entry.body + skip, entry.end, 'audio-entry'),
              audioCodecs[entry.type],
            );
            if (config.end - config.body < 4) bad();
          }
        }
        const timeCount = table(one(samples, 'stts'), 8),
          chunkMapCount = table(one(samples, 'stsc'), 12);
        const sizeBoxes = samples.filter((box) => box.type === 'stsz' || box.type === 'stz2');
        if (sizeBoxes.length !== 1) bad();
        const sizes = sizeBoxes[0];
        if (sizes.end - sizes.body < 12 || read(sizes.body, 4).readUInt32BE() !== 0) bad();
        const count = read(sizes.body + 8, 4).readUInt32BE();
        if (sizes.type === 'stsz') {
          const uniform = read(sizes.body + 4, 4).readUInt32BE();
          if (sizes.end - sizes.body !== 12 + (uniform ? 0 : count * 4)) bad();
        } else {
          const bits = read(sizes.body + 7, 1)[0];
          if (
            ![4, 8, 16].includes(bits) ||
            sizes.end - sizes.body !== 12 + Math.ceil((count * bits) / 8)
          )
            bad();
        }
        const offsets = samples.filter((box) => box.type === 'stco' || box.type === 'co64');
        if (offsets.length !== 1) bad();
        const offsetCount = table(offsets[0], offsets[0].type === 'co64' ? 8 : 4);
        if (count && (!timeCount || !chunkMapCount || !offsetCount)) bad();
        if (
          !count &&
          (!root.some((box) => box.type === 'moof') ||
            !movieBoxes.some((box) => box.type === 'mvex'))
        )
          bad();
      }
      if (!mediaTrack) bad();
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

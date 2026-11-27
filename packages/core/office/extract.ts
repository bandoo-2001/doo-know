import { Worker } from 'node:worker_threads';
import { HttpError } from '../errors.js';
import { extractOoxmlText, type OfficeTextSegment } from './extract-ooxml.js';
import { validateOfficeFile, type OfficeFormat } from './formats.js';
import { pdfOcrConfiguration, recognizePdfPages } from './pdf-ocr.js';

type PdfPageText = { page: number; text: string };
export type IndexedOfficeText = {
  segments: OfficeTextSegment[];
  ocrPending?: boolean;
  ocrIncomplete?: boolean;
};

function pdfText(bytes: Buffer, signal?: AbortSignal): Promise<PdfPageText[]> {
  signal?.throwIfAborted();
  validateOfficeFile(bytes, 'pdf');
  return new Promise((resolve, reject) => {
    const data = new Uint8Array(bytes);
    const source = import.meta.url.endsWith('.ts');
    const entry = new URL(
      source ? './pdf-text-worker.ts' : './pdf-text-worker.js',
      import.meta.url,
    );
    // Development runs the source with TSX, including on Node builds without
    // native type stripping. Releases load the emitted JS directly.
    const workerEntry = source
      ? `import(${JSON.stringify(import.meta.resolve('tsx/esm/api'))}).then(({ tsImport }) => tsImport(${JSON.stringify(entry.href)}, ${JSON.stringify(import.meta.url)}));`
      : entry;
    const worker = new Worker(workerEntry, {
      workerData: data,
      transferList: [data.buffer],
      resourceLimits: { maxOldGenerationSizeMb: 128 },
      execArgv: [],
      eval: source,
      stdout: true,
      stderr: true,
    });
    worker.stdout.resume();
    worker.stderr.resume();
    let settled = false;
    const clean = () => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      void worker.terminate().catch(() => {});
      return true;
    };
    const fail = (message: string, cause?: unknown) => {
      if (!clean()) return;
      const error = new HttpError(422, message);
      if (cause) Object.defineProperty(error, 'cause', { value: cause });
      reject(error);
    };
    const timer = setTimeout(() => fail('PDF 正文提取超时'), 15_000);
    function abort() {
      if (clean()) reject(signal?.reason);
    }
    worker.once('message', (result: { pages?: PdfPageText[]; error?: string }) => {
      if (result.pages) {
        if (clean()) resolve(result.pages);
      } else if (result.error === 'limit') fail('PDF 页数或正文超过索引上限');
      else if (result.error === 'password') fail('加密 PDF 无法提取正文');
      else fail('无法读取 PDF 正文');
    });
    worker.once('error', (error) => fail('PDF 正文提取未完成', error));
    worker.once('exit', () => fail('PDF 正文提取未完成'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export async function extractIndexedOfficeText(
  bytes: Buffer,
  fileType: OfficeFormat,
  options: { signal?: AbortSignal; ocrConfiguration?: ReturnType<typeof pdfOcrConfiguration> } = {},
): Promise<IndexedOfficeText> {
  const { signal, ocrConfiguration } = options;
  signal?.throwIfAborted();
  if (fileType !== 'pdf') return { segments: extractOoxmlText(bytes, fileType) };

  const pages = await pdfText(bytes, signal);
  const missingTextPages = pages.filter(({ text }) => !text).map(({ page }) => page);
  const missing = new Map<number, string>();
  let ocrPending = false;
  let ocrIncomplete = false;
  if (missingTextPages.length) {
    try {
      const result = await recognizePdfPages(
        bytes,
        missingTextPages,
        ocrConfiguration ?? pdfOcrConfiguration(),
        { signal },
      );
      signal?.throwIfAborted();
      ocrPending = result.unavailable;
      ocrIncomplete = result.incomplete;
      let remaining = 1_000_000 - pages.reduce((length, page) => length + page.text.length, 0);
      for (const { page, text } of result.pages) {
        if (text.length > remaining) ocrIncomplete = true;
        const kept = text
          .slice(0, remaining)
          .replace(/[\ud800-\udbff]$/, '')
          .trim();
        if (kept) missing.set(page, kept);
        remaining -= kept.length;
      }
    } catch {
      signal?.throwIfAborted();
      // A failed rasterization or recognition must not discard usable text-layer pages.
      ocrIncomplete = true;
    }
  }
  const segments = pages.flatMap(({ page, text }) => {
    const body = text || missing.get(page);
    return body ? [{ heading: `第 ${page} 页`, text: body }] : [];
  });
  return {
    segments,
    ...(ocrPending ? { ocrPending } : {}),
    ...(ocrIncomplete ? { ocrIncomplete } : {}),
  };
}

export async function extractOfficeText(
  bytes: Buffer,
  fileType: OfficeFormat,
): Promise<OfficeTextSegment[]> {
  return (await extractIndexedOfficeText(bytes, fileType)).segments;
}

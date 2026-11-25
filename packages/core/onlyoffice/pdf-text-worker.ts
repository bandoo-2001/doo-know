import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

type PdfPageText = { page: number; text: string };

const packageDirectory = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));

async function extract(data: Uint8Array) {
  // Supplying only bytes and local bundled assets keeps text extraction offline.
  const task = getDocument({
    data,
    cMapUrl: join(packageDirectory, 'cmaps') + '/',
    cMapPacked: true,
    standardFontDataUrl: join(packageDirectory, 'standard_fonts') + '/',
    useWorkerFetch: false,
    useSystemFonts: false,
    useWasm: false,
    disableFontFace: true,
    enableXfa: false,
    stopAtErrors: true,
    maxImageSize: 0,
    verbosity: 0,
  });
  try {
    const document = await task.promise;
    if (document.numPages > 512) return { error: 'limit' };
    const pages: PdfPageText[] = [];
    let length = 0;
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const reader = page.streamTextContent({ includeMarkedContent: false }).getReader();
      const content: string[] = [];
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const item of value.items) {
            if (!('str' in item) || (!item.str && !item.hasEOL)) continue;
            const text = item.str + (item.hasEOL ? '\n' : ' ');
            length += text.length;
            if (length > 1_000_000) {
              await reader.cancel();
              return { error: 'limit' };
            }
            content.push(text);
          }
        }
      } finally {
        reader.releaseLock();
        page.cleanup();
      }
      const text = content
        .join('')
        .replace(/[ \t]+/g, ' ')
        .replace(/ +\n/g, '\n')
        .trim();
      pages.push({ page: number, text });
    }
    return { pages };
  } finally {
    await task.destroy();
  }
}

try {
  parentPort?.postMessage(await extract(workerData as Uint8Array));
} catch (error) {
  parentPort?.postMessage({
    error: (error as Error)?.name === 'PasswordException' ? 'password' : 'parse',
  });
}

import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { pdfOcrConfiguration, recognizePdfPages } from '../packages/core/office/pdf-ocr.js';

const samplePdf = Buffer.from('%PDF-1.7\n%%EOF\n');

async function fixture({ hold = false, largePage }: { hold?: boolean; largePage?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dooknow-ocr-test-'));
  const tessdata = join(root, 'models');
  const renderer = join(root, 'pdftoppm');
  const tesseract = join(root, 'tesseract');
  const record = join(root, 'record.jsonl');
  await mkdir(tessdata);
  await writeFile(join(tessdata, 'chi_sim.traineddata'), 'model fixture');
  await writeFile(join(tessdata, 'eng.traineddata'), 'model fixture');
  await writeFile(
    renderer,
    String.raw`#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const first = Number(args[args.indexOf('-f') + 1]);
const last = Number(args[args.indexOf('-l') + 1]);
const source = args.at(-1);
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({first,last,source,pid:process.pid,mode:fs.statSync(source).mode&0o777})+'\n');
if (${hold}) setInterval(() => {}, 1000);
else {
  const png = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a','hex').copy(png);
  png.writeUInt32BE(13,8);
  png.write('IHDR',12);
  png.writeUInt32BE(20,16);
  png.writeUInt32BE(20,20);
  png[32] = first;
  process.stdout.write(png);
}
`,
    { mode: 0o700 },
  );
  await writeFile(
    tesseract,
    String.raw`#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--list-langs')) {
  const path = args[args.indexOf('--tessdata-dir')+1];
  const models = fs.readdirSync(path).filter((file) => file.endsWith('.traineddata')).map((file) => file.slice(0,-12));
  console.log('List of available languages in "'+path+'" ('+models.length+'):');
  console.log(models.join('\n'));
} else {
  const page = fs.readFileSync(0)[32];
  process.stdout.write(page === ${largePage ?? -1} ? 'x'.repeat(70*1024) : '备 用\t电 源\nEnglish page '+page);
}
`,
    { mode: 0o700 },
  );
  const env = {
    DOOKNOW_PDF_OCR_PDFTOPPM: renderer,
    DOOKNOW_PDF_OCR_TESSERACT: tesseract,
    DOOKNOW_PDF_OCR_TESSDATA: tessdata,
  };
  const records = async (): Promise<
    { first: number; last: number; mode: number; source: string; pid: number }[]
  > =>
    (await readFile(record, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  return { env, tessdata, records, close: () => rm(root, { recursive: true, force: true }) };
}

it('distinguishes disabled, missing model, and configured OCR profiles', async () => {
  const helper = await fixture();
  try {
    const disabled = pdfOcrConfiguration({ ...helper.env, DOOKNOW_PDF_OCR_ENABLED: '0' });
    const missing = pdfOcrConfiguration({
      ...helper.env,
      DOOKNOW_PDF_OCR_LANGUAGES: 'chi_tra+eng',
    });
    expect(disabled).toMatchObject({ enabled: false, available: false, cacheKey: 'off' });
    expect(await recognizePdfPages(samplePdf, [2], disabled)).toMatchObject({
      unavailable: false,
      incomplete: false,
    });
    expect(await recognizePdfPages(samplePdf, [2], missing)).toMatchObject({
      unavailable: true,
      incomplete: false,
    });
    const configured = pdfOcrConfiguration(helper.env);
    expect(configured).toMatchObject({
      enabled: true,
      available: true,
      languages: 'chi_sim+eng',
      maxPages: 32,
    });
    expect(configured.cacheKey).not.toBe(missing.cacheKey);
    const capped = pdfOcrConfiguration({ ...helper.env, DOOKNOW_PDF_OCR_MAX_PAGES: '2' });
    expect(capped).toMatchObject({ available: true, maxPages: 2 });
    expect(capped.cacheKey).not.toBe(configured.cacheKey);
    await appendFile(join(helper.tessdata, 'chi_sim.traineddata'), '\nnew model revision');
    expect(pdfOcrConfiguration(helper.env).cacheKey).not.toBe(configured.cacheKey);
  } finally {
    await helper.close();
  }
});

it('uses only selected one-based pages and preserves lines while joining Han characters', async () => {
  const helper = await fixture({ largePage: 3 });
  try {
    const config = pdfOcrConfiguration({ ...helper.env, DOOKNOW_PDF_OCR_MAX_PAGES: '2' });
    const result = await recognizePdfPages(samplePdf, [7, 9, 3, 7], config);
    expect(result).toEqual({
      pages: [{ page: 7, text: '备用电源\nEnglish page 7' }],
      unavailable: false,
      incomplete: true,
    });
    const jobs = await helper.records();
    expect(jobs.map(({ first, last, mode }) => [first, last, mode])).toEqual([
      [3, 3, 0o600],
      [7, 7, 0o600],
    ]);
    await expect(stat(jobs[0].source)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await helper.close();
  }
});

it('terminates the rasterizer and removes the temporary PDF after cancellation', async () => {
  const helper = await fixture({ hold: true });
  const controller = new AbortController();
  const pending = recognizePdfPages(samplePdf, [1], pdfOcrConfiguration(helper.env), {
    signal: controller.signal,
  });
  void pending.catch(() => {});
  try {
    await expect.poll(async () => (await helper.records().catch(() => [])).length).toBe(1);
    const [job] = await helper.records();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(() => process.kill(job.pid, 0)).toThrow();
    await expect(stat(job.source)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    controller.abort();
    await pending.catch(() => {});
    await helper.close();
  }
});

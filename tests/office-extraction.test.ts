import { crc32, deflateRawSync } from 'node:zlib';
import { expect, it, vi } from 'vitest';
import {
  extractIndexedOfficeText,
  extractOfficeText,
} from '../packages/core/office/extract.js';
import { recognizePdfPages } from '../packages/core/office/pdf-ocr.js';

vi.mock('../packages/core/office/pdf-ocr.js', () => ({
  pdfOcrConfiguration: () => ({ enabled: true }),
  recognizePdfPages: vi.fn(async () => ({ pages: [], unavailable: false, incomplete: false })),
}));

const word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const sheet = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const slide = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const draw = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const relationship = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const rels = (contents: string) =>
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${contents}</Relationships>`;
const rel = (id: string, type: string, target: string, mode = '') =>
  `<Relationship Id="${id}" Type="${relationship}/${type}" Target="${target}"${mode ? ` TargetMode="${mode}"` : ''}/>`;

function archive(parts: Record<string, string>) {
  const entries = Object.entries({ '[Content_Types].xml': '<Types/>', ...parts });
  const content: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0,
    centralLength = 0;
  for (const [path, xml] of entries) {
    const name = Buffer.from(path),
      bytes = Buffer.from(xml),
      compressed = deflateRawSync(bytes);
    const local = Buffer.alloc(30),
      index = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(bytes), 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    index.writeUInt32LE(0x02014b50, 0);
    index.writeUInt16LE(20, 4);
    local.copy(index, 6, 4, 28);
    index.writeUInt32LE(offset, 42);
    content.push(local, name, compressed);
    central.push(index, name);
    offset += local.length + name.length + compressed.length;
    centralLength += index.length + name.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralLength, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...content, ...central, end]);
}

it('preserves Word headings and text while skipping deleted text and refusing unsafe XML', async () => {
  const part = 'word/document.xml';
  const paragraph = (value: string, heading = false) =>
    `<w:p>${heading ? '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>' : ''}<w:r><w:t>${value}</w:t></w:r></w:p>`;
  const xml = `<w:document xmlns:w="${word}"><w:body>${paragraph('开始')}${paragraph('恢复步骤', true)}<w:p><w:r><w:t>先检查</w:t><w:tab/><w:t>备份</w:t><w:br/><w:t>再恢复</w:t></w:r><w:del><w:r><w:delText>删掉的内容</w:delText></w:r></w:del></w:p>${paragraph('核对', true)}</w:body></w:document>`;
  await expect(extractOfficeText(archive({ [part]: xml }), 'docx')).resolves.toEqual([
    { heading: '正文', text: '开始' },
    { heading: '恢复步骤', text: '先检查\t备份\n再恢复' },
    { heading: '核对', text: '核对' },
  ]);
  await expect(
    extractOfficeText(
      archive({ [part]: '<!DOCTYPE x SYSTEM "https://example.invalid/x">' + xml }),
      'docx',
    ),
  ).rejects.toMatchObject({ statusCode: 422 });
  await expect(
    extractOfficeText(archive({ [part]: 'x'.repeat(13 * 1024 * 1024) }), 'docx'),
  ).rejects.toMatchObject({ statusCode: 422 });
});

it('uses workbook order and joins cell references, rich strings, cached values and formulas', async () => {
  const spreadsheet = (row: string) =>
    `<worksheet xmlns="${sheet}"><sheetData><row>${row}</row></sheetData></worksheet>`;
  const file = archive({
    'xl/workbook.xml': `<workbook xmlns="${sheet}" xmlns:r="${relationship}"><sheets><sheet name="预算" r:id="two"/><sheet name="核对" r:id="one"/><sheet name="外部" r:id="external"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': rels(
      rel('one', 'worksheet', 'worksheets/sheet1.xml') +
        rel('two', 'worksheet', '/xl/worksheets/sheet2.xml') +
        rel('strings', 'sharedStrings', 'sharedStrings.xml') +
        rel('external', 'worksheet', 'https://example.invalid/x', 'External'),
    ),
    'xl/sharedStrings.xml': `<sst xmlns="${sheet}"><si><r><t>恢复</t></r><r><t>预算</t></r><rPh><t>忽略注音</t></rPh></si></sst>`,
    'xl/worksheets/sheet1.xml': spreadsheet(
      '<c r="A1" t="inlineStr"><is><t>确认</t></is></c><c r="B1" t="b"><v>1</v></c>',
    ),
    'xl/worksheets/sheet2.xml': spreadsheet(
      '<c r="A5" t="s"><v>0</v></c><c r="B5"><f>SUM(B1:B4)</f><v>42</v></c>',
    ),
  });
  await expect(extractOfficeText(file, 'xlsx')).resolves.toEqual([
    { heading: '预算', text: 'A5: 恢复预算 | B5: =SUM(B1:B4) → 42' },
    { heading: '核对', text: 'A1: 确认 | B1: TRUE' },
  ]);
});

it('honors presentation order and indexes only speaker note bodies', async () => {
  const body = (value: string) => `<p:txBody><a:p><a:r><a:t>${value}</a:t></a:r></a:p></p:txBody>`;
  const contents = (value: string) =>
    `<p:sld xmlns:p="${slide}" xmlns:a="${draw}"><p:cSld><p:spTree><p:sp>${body(value)}</p:sp></p:spTree></p:cSld></p:sld>`;
  const file = archive({
    'ppt/presentation.xml': `<p:presentation xmlns:p="${slide}" xmlns:r="${relationship}"><p:sldIdLst><p:sldId r:id="two"/><p:sldId r:id="one"/></p:sldIdLst></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': rels(
      rel('one', 'slide', 'slides/slide1.xml') + rel('two', 'slide', 'slides/slide2.xml'),
    ),
    'ppt/slides/slide1.xml': contents('验证'),
    'ppt/slides/slide2.xml': contents('操作概览'),
    'ppt/slides/_rels/slide2.xml.rels': rels(
      rel('n', 'notesSlide', '../notesSlides/notesSlide1.xml'),
    ),
    'ppt/notesSlides/notesSlide1.xml': `<p:notes xmlns:p="${slide}" xmlns:a="${draw}"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>${body('讲解')}</p:sp><p:sp>${body('自动页码')}</p:sp></p:spTree></p:cSld></p:notes>`,
  });
  await expect(extractOfficeText(file, 'pptx')).resolves.toEqual([
    { heading: '幻灯片 1', text: '操作概览\n\n讲者备注\n讲解' },
    { heading: '幻灯片 2', text: '验证' },
  ]);
});

function mixedPdf() {
  const stream = 'BT /F1 12 Tf 20 50 Td (DooKnow PDF text) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 220 80] /Resources << >> >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 220 80] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let body = '%PDF-1.7\n';
  const offsets = objects.map((value, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj\n${value}\nendobj\n`;
    return String(offset).padStart(10, '0');
  });
  const crossRef = body.length;
  return Buffer.from(
    `${body}xref\n0 7\n0000000000 65535 f \n${offsets.map((offset) => `${offset} 00000 n \n`).join('')}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${crossRef}\n%%EOF\n`,
  );
}

it('preserves numbers for empty PDF pages and gives OCR only those pages', async () => {
  const bytes = mixedPdf();
  await expect(extractOfficeText(bytes, 'pdf')).resolves.toEqual([
    { heading: '第 2 页', text: 'DooKnow PDF text' },
  ]);
  expect(recognizePdfPages).toHaveBeenLastCalledWith(
    bytes,
    [1],
    { enabled: true },
    { signal: undefined },
  );

  vi.mocked(recognizePdfPages).mockResolvedValueOnce({
    pages: [{ page: 1, text: '  Scanned text  ' }],
    unavailable: false,
    incomplete: true,
  });
  await expect(extractIndexedOfficeText(bytes, 'pdf')).resolves.toEqual({
    segments: [
      { heading: '第 1 页', text: 'Scanned text' },
      { heading: '第 2 页', text: 'DooKnow PDF text' },
    ],
    ocrIncomplete: true,
  });
  vi.mocked(recognizePdfPages).mockResolvedValueOnce({
    pages: [],
    unavailable: true,
    incomplete: false,
  });
  await expect(extractIndexedOfficeText(bytes, 'pdf')).resolves.toEqual({
    segments: [{ heading: '第 2 页', text: 'DooKnow PDF text' }],
    ocrPending: true,
  });

  const controller = new AbortController();
  const stopped = new Error('cancelled extraction');
  vi.mocked(recognizePdfPages).mockImplementationOnce(async () => {
    controller.abort(stopped);
    throw stopped;
  });
  await expect(extractIndexedOfficeText(bytes, 'pdf', { signal: controller.signal })).rejects.toBe(
    stopped,
  );
});

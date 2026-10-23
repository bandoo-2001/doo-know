import { isMap, isScalar, isSeq, parseDocument, type Node } from 'yaml';
import { frontmatterOpening, frontmatterRange } from './frontmatter-range.js';

export type DocumentPropertyValue =
  | string
  | number
  | boolean
  | null
  | (string | number | boolean | null)[];
export type DocumentProperty = { key: string; value?: DocumentPropertyValue; editable: boolean };
export type DocumentProperties = {
  present: boolean;
  properties: DocumentProperty[];
  error?: string;
};
export type PropertyUpdateResult = { ok: true; markdown: string } | { ok: false; message: string };

function splitFrontmatter(markdown: string) {
  if (!frontmatterOpening.test(markdown)) return undefined;
  const range = frontmatterRange(markdown);
  if (!range) throw Error('YAML 属性缺少结束标记，请先在源码中补齐');
  return range;
}

function simpleValue(node: Node | null | undefined): {
  editable: boolean;
  value?: DocumentPropertyValue;
} {
  if (!node) return { editable: true, value: null };
  if (('anchor' in node && node.anchor) || node.tag) return { editable: false };
  if (isScalar(node)) {
    const value = node.value;
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    ) {
      // Comments inside a block scalar are part of its header. The source
      // editor is needed to retain them when changing the scalar's style.
      if ((node.type === 'BLOCK_LITERAL' || node.type === 'BLOCK_FOLDED') && node.comment)
        return { editable: false };
      return { editable: true, value };
    }
  }
  if (
    isSeq(node) &&
    !node.comment &&
    !node.items.some(
      (item) => (item as Node | null)?.comment || (item as Node | null)?.commentBefore,
    )
  ) {
    const values = node.items.map((item) => simpleValue(item as Node | null));
    if (values.every((item) => item.editable && !Array.isArray(item.value)))
      return { editable: true, value: values.map((item) => item.value!) as DocumentPropertyValue };
  }
  return { editable: false };
}

function parseProperties(markdown: string) {
  const front = splitFrontmatter(markdown);
  if (!front) return undefined;
  const document = parseDocument(front.yaml, {
    keepSourceTokens: true,
    prettyErrors: false,
    uniqueKeys: true,
  });
  if (document.errors.length) throw Error('YAML 属性格式有误，请在源码中修正后再编辑');
  if (document.contents && !isMap(document.contents))
    throw Error('YAML 属性需要使用“名称: 值”的形式');
  return { ...front, document, map: isMap(document.contents) ? document.contents : undefined };
}

export function readDocumentProperties(markdown: string): DocumentProperties {
  try {
    const parsed = parseProperties(markdown);
    if (!parsed) return { present: false, properties: [] };
    return {
      present: true,
      properties: (parsed.map?.items || []).map((pair) => {
        if (!isScalar(pair.key) || typeof pair.key.value !== 'string')
          return { key: '复杂属性名（请在源码中编辑）', editable: false };
        return { key: pair.key.value, ...simpleValue(pair.value as Node | null) };
      }),
    };
  } catch (cause) {
    return {
      present: true,
      properties: [],
      error: cause instanceof Error ? cause.message : '无法读取 YAML 属性',
    };
  }
}

/** Patch only selected scalar ranges; never reserialize the untouched YAML. */
export function updateDocumentProperties(
  markdown: string,
  updates: Record<string, DocumentPropertyValue>,
): PropertyUpdateResult {
  try {
    const parsed = parseProperties(markdown);
    const eol = markdown.includes('\r\n') ? '\r\n' : '\n';
    const pending: [string, DocumentPropertyValue][] = Object.entries(updates);
    for (const [key, value] of pending) {
      if (
        !key.trim() ||
        key !== key.trim() ||
        key.length > 128 ||
        /[\u0000-\u001f\u007f]/.test(key)
      )
        throw Error('属性名不能为空或包含控制字符');
      const values = Array.isArray(value) ? value : [value];
      if (
        !values.every(
          (item) =>
            item === null ||
            typeof item === 'string' ||
            typeof item === 'boolean' ||
            (typeof item === 'number' && Number.isFinite(item)),
        )
      )
        throw Error('表单仅支持文字、数字、开关和简单列表');
    }
    if (!pending.length) return { ok: true, markdown };
    if (!parsed) {
      const bom = markdown.startsWith('\uFEFF') ? '\uFEFF' : '';
      const yaml = pending
        .map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`)
        .join(eol);
      return {
        ok: true,
        markdown: `${bom}---${eol}${yaml}${eol}---${eol}${eol}${markdown.slice(bom.length)}`,
      };
    }
    const changes: { from: number; to: number; insert: string }[] = [];
    const additions: string[] = [];
    for (const [key, value] of pending) {
      const pair = parsed.map?.items.find((item) => isScalar(item.key) && item.key.value === key);
      if (!pair) {
        if (parsed.map?.flow) throw Error('行内 YAML 属性请在源码中新增字段');
        additions.push(`${JSON.stringify(key)}: ${JSON.stringify(value)}${eol}`);
        continue;
      }
      const current = simpleValue(pair.value as Node | null);
      if (!current.editable) throw Error(`“${key}”包含结构、锚点或注释，请在源码中编辑`);
      if (JSON.stringify(current.value) === JSON.stringify(value)) continue;
      const range = (pair.value as Node | null)?.range;
      if (!range || !isScalar(pair.key) || !pair.key.range)
        throw Error('属性位置无法安全识别，请使用源码编辑');
      const previous = parsed.yaml.slice(range[0], range[1]);
      let insert = JSON.stringify(value);
      if (parsed.yaml.slice(pair.key.range[1], range[0]) === ':') insert = ' ' + insert;
      if (/\r?\n$/.test(previous)) insert += eol;
      changes.push({ from: range[0], to: range[1], insert });
    }
    if (additions.length)
      changes.push({
        from: parsed.yaml.length,
        to: parsed.yaml.length,
        insert: (parsed.yaml && !/\n$/.test(parsed.yaml) ? eol : '') + additions.join(''),
      });
    let yaml = parsed.yaml;
    for (const change of changes.sort((a, b) => b.from - a.from))
      yaml = yaml.slice(0, change.from) + change.insert + yaml.slice(change.to);
    const checked = parseDocument(yaml, { uniqueKeys: true, prettyErrors: false });
    if (checked.errors.length || (checked.contents && !isMap(checked.contents)))
      throw Error('修改未能安全转换为 YAML，请使用源码编辑');
    return {
      ok: true,
      markdown: markdown.slice(0, parsed.from) + yaml + markdown.slice(parsed.to),
    };
  } catch (cause) {
    return {
      ok: false,
      message: cause instanceof Error ? cause.message : '属性修改未完成，原文已保留',
    };
  }
}

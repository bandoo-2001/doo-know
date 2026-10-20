import type { Eligibility } from './contracts';
export function documentEditorEnabled(): boolean {
  return import.meta.env?.VITE_DOCUMENT_EDITOR_ENABLED === '1';
}
export function evaluateDocumentEligibility(input: {
  editorMode: string;
  markdown: string;
  units: number;
  depth: number;
  enabled: boolean;
}): Eligibility {
  if (!input.enabled) return { allowed: false, reason: 'disabled', message: '文档编辑尚未启用' };
  if (input.editorMode !== 'full')
    return { allowed: false, reason: 'large-file', message: '此文件使用大文件编辑方式' };
  if (new TextEncoder().encode(input.markdown).length > 262144)
    return { allowed: false, reason: 'size', message: '此笔记较大，请使用 Markdown 源码编辑' };
  if (input.units > 5000)
    return { allowed: false, reason: 'units', message: '此笔记结构较多，请使用 Markdown 源码编辑' };
  if (input.depth > 32)
    return { allowed: false, reason: 'depth', message: '此笔记嵌套较深，请使用 Markdown 源码编辑' };
  return { allowed: true };
}

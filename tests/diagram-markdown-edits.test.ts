import{it,expect}from'vitest';
import{findDiagramRange,withDiagramPreview}from'../apps/web/editor/diagram-edits';
const code='<svg width="1" height="1"></svg>';
it('keeps original fences/CRLF and updates only a generated preview',()=>{
  const raw='# 标题\r\n\r\n~~~svg\r\n'+code+'\r\n~~~\r\n\r\n尾部  \r\n';
  const range=findDiagramRange(raw,{kind:'svg',code});
  const png='assets/diagram-'+'a'.repeat(64)+'.png';
  const next=withDiagramPreview(raw,range,png,'assets/diagram-'+'b'.repeat(64)+'.svg');
  expect(next).toContain(raw.slice(range.from));
  expect(next).toContain('![');expect(next).toContain(png);
  const updated=withDiagramPreview(next,findDiagramRange(next,{kind:'svg',code}),'assets/diagram-'+'c'.repeat(64)+'.png');
  expect(updated.match(/!\[/g)).toHaveLength(1);
  expect(updated).toContain('尾部  \r\n');
});
it('rejects ambiguous identical diagrams and targets the specified source line',()=>{
  const raw='```svg\n'+code+'\n```\n\n```svg\n'+code+'\n```\n';
  expect(()=>findDiagramRange(raw,{kind:'svg',code})).toThrow();
  expect(findDiagramRange(raw,{kind:'svg',code,line:5}).from).toBe(raw.indexOf('```svg',4));
});

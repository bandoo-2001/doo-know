import {it,expect}from'vitest';
import{parseSource}from'../apps/web/editor/source-codec';
import{createRichProjection}from'../apps/web/editor/rich-adapter';
it('keeps every paragraph of a footnote in one protected source unit',()=>{
  const raw='ref[^a]\r\n\r\n[^a]: first\r\n\r\n    second\r\n\r\nBody\r\n';
  const source=parseSource(raw);
  expect(source.eligibility.allowed).toBe(true);
  const unit=source.units.find(u=>u.raw.includes('second'))!;
  expect(unit.opaque).toBe(true);expect(unit.raw).toContain('[^a]: first');
  const p=createRichProjection(raw);
  expect(p.json.content?.some(n=>n.type==='codeBlock')).toBe(false);
  const result=p.serialize(p.json);expect(result).toEqual({ok:true,markdown:raw});
});
it('does not treat a footnote example in a fence as an actual definition',()=>{
  const raw='```md\n[^a]: example\n\n    second\n```\n\nBody\n';
  expect(parseSource(raw).units.filter(u=>u.opaque)).toHaveLength(0);
});

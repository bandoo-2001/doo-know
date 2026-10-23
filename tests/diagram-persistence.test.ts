import {it,expect} from 'vitest';
import {prepareDiagramUpload} from '../apps/web/diagrams/persist-preview';
it('binds retry identity to exact note, source and preview bytes',async()=>{
  const input={noteId:'note-one',kind:'svg' as const,source:'<svg/>',png:new Blob(['png'],{type:'image/png'})};
  const first=await prepareDiagramUpload(input),again=await prepareDiagramUpload(input);
  expect(again).toEqual(first);
  expect(first.requestId).toMatch(/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/);
  expect((await prepareDiagramUpload({...input,noteId:'another'})).requestId).not.toBe(first.requestId);
  expect((await prepareDiagramUpload({...input,notePath:'00-Inbox/moved.md'})).requestId).not.toBe(first.requestId);
  expect((await prepareDiagramUpload({...input,png:new Blob(['changed'],{type:'image/png'})})).requestId).not.toBe(first.requestId);
  expect(Buffer.from(first.pngBase64,'base64').toString()).toBe('png');
});
it('rejects other MIME types before requesting an upload',async()=>{
  await expect(prepareDiagramUpload({noteId:'n',kind:'svg',source:'x',png:new Blob(['x'],{type:'text/html'})})).rejects.toThrow();
});

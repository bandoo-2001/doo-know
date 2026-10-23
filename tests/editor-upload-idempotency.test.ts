import { it, expect } from 'vitest';
import { createFixture, loginFixtureOwner } from './support/fixture';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/b9sAAAAASUVORK5CYII=','base64');
it('replays a completed upload with the same request id and rejects changed payload',async()=>{
  const f=await createFixture();
  try{
    const headers=await loginFixtureOwner(f);
    const note=(await f.app.inject({method:'POST',url:'/api/notes',headers,payload:{folderPath:'00-Inbox',fileName:'upload.md',content:'# 图'}})).json();
    const upload=(bytes:Buffer)=>{
      const boundary='fixture-upload-boundary';
      const payload=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="pic.png"\r\nContent-Type: image/png\r\n\r\n`),bytes,Buffer.from(`\r\n--${boundary}--\r\n`)]);
      return f.app.inject({method:'POST',url:`/api/notes/${note.id}/assets`,headers:{...headers,'x-dooknow-upload-id':'upload-retry-1234','content-type':`multipart/form-data; boundary=${boundary}`},payload});
    };
    const first=await upload(png),second=await upload(png);
    expect(first.statusCode).toBe(201);expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual(first.json());
    expect((await f.app.inject({url:`/api/notes/${note.id}/assets`,headers})).json()).toHaveLength(1);
    expect((await upload(Buffer.concat([png,Buffer.from('different')]))).statusCode).toBe(409);
  }finally{await f.close();}
});

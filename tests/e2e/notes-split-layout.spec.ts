import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';
import { closeSidebar } from '../support/settings-navigation';
test.setTimeout(60000);
test.use({ sourceEditorPreference: true });
test.beforeEach(async ({context})=>context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json','utf8'))));
async function note(page:Page){
 await page.goto('/');
 const csrf=await(await page.request.get('/api/security/csrf')).json();
 const name='header-'+crypto.randomUUID();
 const response=await page.request.post('/api/notes',{headers:{origin:new URL(page.url()).origin,'x-csrf-token':csrf.token},data:{folderPath:'00-Inbox',fileName:name+'.md',content:'# 搭建自己的知识库\n\n把想法记录下来，让知识慢慢积累。\n\n## 整理方法\n\n- 收集零散想法\n- 按主题整理笔记\n- 定期回顾与更新\n'}});
 expect(response.status()).toBe(201);const n=await response.json();await page.goto('/?note='+n.id);await expect(page.locator('.note-workspace')).toBeVisible();return{name,id:n.id};
}
test('desktop notes use fullheight left directory and right workspace with avatar above Notes',async({page},info)=>{
 await page.setViewportSize({width:1440,height:1000});const n=await note(page);
 await expect(page.getByRole('banner',{name:'DooKnow 工作区',exact:true})).toHaveCount(0);
 const sidebar=page.locator('#notebook-navigation');const main=page.locator('.main-content');
 expect((await sidebar.boundingBox())!.y).toBe(0);expect((await main.boundingBox())!.y).toBe(0);
 expect((await main.boundingBox())!.x).toBeCloseTo((await sidebar.boundingBox())!.x+(await sidebar.boundingBox())!.width,0);
 const rail=page.locator('.workspace-footer');const account=rail.getByRole('button',{name:'个人账户',exact:true});const notes=rail.getByRole('navigation',{name:'工作区',exact:true}).getByRole('button',{name:'笔记',exact:true});
 await expect(account).toBeVisible();expect((await account.boundingBox())!.y+(await account.boundingBox())!.height).toBeLessThanOrEqual((await notes.boundingBox())!.y);
 await account.click();const menu=page.getByRole('dialog',{name:'账户菜单',exact:true});await expect(menu.getByRole('button',{name:'账户设置',exact:true})).toBeFocused();await page.keyboard.press('Escape');await expect(menu).not.toBeVisible();await expect(account).toBeFocused();
 const search=sidebar.getByRole('textbox',{name:'搜索笔记与目录',exact:true});await search.fill(n.name);await expect(sidebar.locator('.search-result').filter({hasText:n.name})).toBeVisible();await search.clear();
 await sidebar.getByRole('button',{name:'新建笔记',exact:true}).click();const create=page.getByRole('dialog',{name:'新建笔记',exact:true});await expect(create).toBeVisible();await create.getByRole('button',{name:'取消',exact:true}).click();await expect(create).not.toBeVisible();
 const rich=page.getByRole('button',{name:'文档编辑',exact:true});if(await rich.isVisible()){await rich.click();await expect(page.locator('.document-editor .ProseMirror')).toContainText('搭建自己的知识库');}
 await page.screenshot({path:info.outputPath('desktop-split-layout.png'),animations:'disabled'});
});
for(const width of [320,390])test('document-local directory control and fullheight content remain usable at '+width,async({page},info)=>{
 await page.setViewportSize({width,height:844});await note(page);await closeSidebar(page);
 await expect(page.getByRole('banner',{name:'DooKnow 工作区',exact:true})).toHaveCount(0);
 const trigger=page.getByRole('button',{name:'打开侧栏',exact:true});await expect(page.locator('.note-topline').getByRole('button',{name:'打开侧栏',exact:true})).toBeVisible();await trigger.click();
 const search=page.getByRole('textbox',{name:'搜索笔记与目录',exact:true});await expect(search).toBeVisible();await search.fill('header');
 await page.getByRole('button',{name:'关闭侧栏',exact:true}).click();await expect(trigger).toBeFocused();
 expect((await page.locator('.main-content').boundingBox())!.y).toBe(0);
 const tab=await page.locator('.workspace-tabbar').boundingBox();const main=await page.locator('.main-content').boundingBox();expect(main!.height).toBeLessThanOrEqual(tab!.y+1);
 await trigger.click();await expect(search).toHaveValue('header');await page.getByRole('button',{name:'新建笔记',exact:true}).click();const dialog=page.getByRole('dialog',{name:'新建笔记',exact:true});await dialog.getByLabel('文件名',{exact:true}).fill('kept-draft-'+width);await page.setViewportSize({width:1440,height:1000});await page.setViewportSize({width,height:844});await expect(dialog.getByLabel('文件名',{exact:true})).toHaveValue('kept-draft-'+width);await dialog.getByRole('button',{name:'取消',exact:true}).click();await expect(dialog).not.toBeVisible();await closeSidebar(page);await expect(page.locator('.drawer-scrim')).toHaveCount(0);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);await page.screenshot({path:info.outputPath('phone-split-'+width+'.png'),animations:'disabled'});
});
test('empty compact workspace has a local directory entry without a global header',async({page})=>{
 await page.setViewportSize({width:320,height:844});await page.goto('/');await closeSidebar(page);
 await expect(page.getByRole('banner',{name:'DooKnow 工作区',exact:true})).toHaveCount(0);await page.getByRole('button',{name:'打开侧栏',exact:true}).click();await expect(page.getByRole('textbox',{name:'搜索笔记与目录',exact:true})).toBeVisible();
});
test('search and dirty editor identities survive resize and a ToDoo roundtrip',async({page})=>{
 await page.setViewportSize({width:1440,height:1000});await note(page);const search=page.getByRole('textbox',{name:'搜索笔记与目录',exact:true});const input=await search.elementHandle();
 const editor=page.locator('.cm-content[contenteditable=true]').first();await editor.click();await page.keyboard.press('ControlOrMeta+End');await page.keyboard.insertText('保留未保存的正文');const editorNode=await editor.elementHandle();
 await search.fill('header');await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'打开侧栏',exact:true}).click();await expect(search).toHaveValue('header');await page.getByRole('button',{name:'关闭侧栏',exact:true}).click();await page.setViewportSize({width:1440,height:1000});await expect(editor).toContainText('保留未保存的正文');expect(await search.evaluate((el,previous)=>el===previous,input!)).toBe(true);
 await page.getByRole('navigation',{name:'工作区',exact:true}).getByRole('button',{name:'应用',exact:true}).click();await page.locator('.app-card').filter({has:page.getByRole('heading',{name:'To Doo',exact:true})}).click();await expect(page.locator('.todo-topbar')).toBeVisible();await page.locator('.workspace-footer').getByRole('button',{name:'返回 DooKnow',exact:true}).click();await page.getByRole('navigation',{name:'工作区',exact:true}).getByRole('button',{name:'笔记',exact:true}).click();
 await expect(search).toBeVisible();await expect(editor).toContainText('保留未保存的正文');expect(await search.evaluate((el,previous)=>el===previous,input!)).toBe(true);expect(await editor.evaluate((el,previous)=>el===previous,editorNode!)).toBe(true);
});
test('sharing status stays beside its action with public-save guidance instead of a full width strip',async({page},info)=>{
 await page.setViewportSize({width:1440,height:1000});await note(page);await page.getByRole('button',{name:'分享',exact:true}).click();
 const dialog=page.locator('.share-dialog');await dialog.getByRole('button',{name:'生成分享链接',exact:true}).click();await dialog.getByRole('button',{name:'完成',exact:true}).click();
 const share=page.locator('.note-topline').getByRole('button',{name:'分享',exact:true});await expect(share).toContainText('已分享');await expect(share).toHaveAttribute('title',/同步公开/);await expect(page.locator('.note-workspace > .shared-status')).toHaveCount(0);
 for(const width of [320,390]){await page.setViewportSize({width,height:844});expect(await share.evaluate(el=>parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(11);expect((await share.boundingBox())!.width).toBeGreaterThanOrEqual(54);expect((await share.boundingBox())!.x+(await share.boundingBox())!.width).toBeLessThanOrEqual(width);await share.click({trial:true});await page.screenshot({path:info.outputPath('shared-cue-'+width+'.png'),animations:'disabled'});}
 await page.setViewportSize({width:1440,height:1000});
 await share.click();await expect(dialog).toBeVisible();await dialog.getByRole('button',{name:'完成',exact:true}).click();await expect(dialog).not.toBeVisible();await page.screenshot({path:info.outputPath('shared-note-compact-status.png'),animations:'disabled'});
});

test('native document sharing uses the same compact action cue',async({page},info)=>{
 await page.setViewportSize({width:1440,height:1000});await page.goto('/');
 await page.getByRole('button',{name:'创建与导入',exact:true}).click();await page.getByRole('button',{name:'新建白板',exact:true}).click();
 const create=page.getByRole('dialog',{name:'新建白板',exact:true});await create.getByLabel('文件名',{exact:true}).fill('header-native-'+crypto.randomUUID());await create.getByRole('button',{name:'创建',exact:true}).click();
 const workspace=page.getByTestId('diagram-document-workspace');await expect(workspace.getByRole('status')).toContainText('已保存');
 await workspace.getByRole('button',{name:'分享',exact:true}).click();const dialog=page.locator('.share-dialog');await dialog.getByRole('button',{name:'生成分享链接',exact:true}).click();await dialog.getByRole('button',{name:'完成',exact:true}).click();await expect(dialog).not.toBeVisible();
 const share=workspace.getByRole('button',{name:'分享',exact:true});await expect(share).toContainText('已分享');await expect(share).toHaveAttribute('title',/同步公开/);await expect(workspace.locator('.shared-status')).toHaveCount(0);
 for(const width of [320,390]){await page.setViewportSize({width,height:844});expect(await share.evaluate(el=>parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(11);expect((await share.boundingBox())!.width).toBeGreaterThanOrEqual(54);expect((await share.boundingBox())!.x+(await share.boundingBox())!.width).toBeLessThanOrEqual(width);await share.click({trial:true});await page.screenshot({path:info.outputPath('shared-cue-'+width+'.png'),animations:'disabled'});}
});


test('rail avatar and account menu remain clear in light and dark themes',async({page},info)=>{
 await page.setViewportSize({width:1440,height:900});await page.goto('/');
 for(const theme of ['light','dark']){
  await page.evaluate(async theme=>{const path='/preferences.ts';const preferences=await import(path);preferences.setEditorPreferences({theme});},theme);await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
  const account=page.locator('.workspace-footer').getByRole('button',{name:'个人账户',exact:true});const avatar=account.locator('.avatar');
  await expect.poll(()=>avatar.evaluate(el=>{const rgb=(v:string)=>v.match(/[\d.]+/g)!.slice(0,3).map(Number);const lum=(c:number[])=>c.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);const style=getComputedStyle(el);const fg=lum(rgb(style.color)),bg=lum(rgb(style.backgroundColor));return(Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05)})).toBeGreaterThanOrEqual(4.5);
  await account.click();const menu=page.getByRole('dialog',{name:'账户菜单',exact:true});await expect(menu.getByRole('button',{name:'账户设置',exact:true})).toBeFocused();await page.keyboard.press('Escape');await expect(menu).not.toBeVisible();await page.mouse.move(400,400);await page.screenshot({path:info.outputPath('split-'+theme+'.png'),animations:'disabled'});
 }
});

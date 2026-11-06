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
test('desktop header exposes existing search, creation and account while directory is collapsed',async({page},info)=>{
 await page.setViewportSize({width:1440,height:1000});const n=await note(page);
 const header=page.getByRole('banner',{name:'DooKnow 工作区',exact:true});
 await expect(header.getByRole('textbox',{name:'搜索笔记与目录',exact:true})).toBeVisible();
 await expect(page.locator('#notebook-navigation').getByRole('textbox',{name:'搜索笔记与目录',exact:true})).toHaveCount(0);
 await header.getByRole('button',{name:'新建笔记',exact:true}).click();const dialog=page.getByRole('dialog',{name:'新建笔记',exact:true});await expect(dialog).toBeVisible();await dialog.getByRole('button',{name:'取消',exact:true}).click();await expect(dialog).not.toBeVisible();
 const account=header.getByRole('button',{name:'个人账户',exact:true});await account.click();await expect(page.getByRole('dialog',{name:'账户菜单',exact:true}).getByRole('button',{name:'账户设置',exact:true})).toBeFocused();await page.keyboard.press('Escape');await expect(account).toBeFocused();await expect(page.getByRole('dialog',{name:'账户菜单',exact:true})).not.toBeVisible();
 await page.getByRole('button',{name:'收起侧栏',exact:true}).click();await header.getByRole('textbox',{name:'搜索笔记与目录',exact:true}).fill(n.name);
 await expect(page.locator('#notebook-navigation .search-result').filter({hasText:n.name})).toBeVisible();
 await header.getByRole('textbox',{name:'搜索笔记与目录',exact:true}).clear();
 await expect(page.locator('#notebook-navigation .search-result')).toHaveCount(0);
 const rich=page.getByRole('button',{name:'文档编辑',exact:true});if(await rich.isVisible()){await rich.click();await expect(page.locator('.document-editor .ProseMirror')).toContainText('搭建自己的知识库');}
 await page.screenshot({path:info.outputPath('desktop-functional-header.png'),animations:'disabled'});
});
for(const width of [320,390])test('compact search and create remain usable at '+width,async({page},info)=>{
 await page.setViewportSize({width,height:844});await note(page);await closeSidebar(page);
 const header=page.getByRole('banner',{name:'DooKnow 工作区',exact:true});await header.getByRole('button',{name:'搜索笔记',exact:true}).click();
 const search=page.getByRole('textbox',{name:'搜索笔记与目录',exact:true});await expect(search).toBeFocused();await search.fill('header');
 await page.getByRole('button',{name:'关闭侧栏',exact:true}).click();await header.getByRole('button',{name:'新建笔记',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'新建笔记',exact:true});await expect(dialog).toBeVisible();await dialog.getByLabel('文件名',{exact:true}).fill('mobile-unsaved-'+width);
 await page.setViewportSize({width:1440,height:1000});await page.setViewportSize({width,height:844});await expect(dialog.getByLabel('文件名',{exact:true})).toHaveValue('mobile-unsaved-'+width);
 await dialog.getByRole('button',{name:'取消',exact:true}).click();await expect(dialog).not.toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
 await page.screenshot({path:info.outputPath('compact-'+width+'.png'),animations:'disabled'});
});
test('resizing relocates one search without losing query or the edited document',async({page})=>{
 await page.setViewportSize({width:1440,height:1000});await note(page);
 const editor=page.locator('.cm-content[contenteditable=true]').first();await editor.click();await page.keyboard.press('ControlOrMeta+End');await page.keyboard.insertText('未保存的调整草稿');
 const search=page.getByRole('banner',{name:'DooKnow 工作区',exact:true}).getByRole('textbox',{name:'搜索笔记与目录',exact:true});await search.fill('header');
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'搜索笔记',exact:true}).click();await expect(page.getByRole('textbox',{name:'搜索笔记与目录',exact:true})).toHaveValue('header');
 await page.getByRole('button',{name:'关闭侧栏',exact:true}).click();await page.setViewportSize({width:1440,height:1000});await expect(search).toHaveValue('header');await expect(editor).toContainText('未保存的调整草稿');
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

test('returning from ToDoo retains live header controls and their input identity',async({page})=>{
 await page.setViewportSize({width:1440,height:1000});await note(page);
 const header=page.getByRole('banner',{name:'DooKnow 工作区',exact:true});const search=header.getByRole('textbox',{name:'搜索笔记与目录',exact:true});const original=await search.elementHandle();
 await page.getByRole('navigation',{name:'工作区',exact:true}).getByRole('button',{name:'应用',exact:true}).click();
 await page.locator('.app-card').filter({has:page.getByRole('heading',{name:'To Doo',exact:true})}).click();await expect(page.locator('.todo-topbar')).toBeVisible();await expect(header).not.toBeVisible();
 await page.locator('.workspace-footer').getByRole('button',{name:'返回 DooKnow',exact:true}).click();
 await page.getByRole('navigation',{name:'工作区',exact:true}).getByRole('button',{name:'笔记',exact:true}).click();
 await expect(search).toBeVisible();expect(await original!.evaluate(el=>el.isConnected)).toBe(true);expect(await search.evaluate((el,previous)=>el===previous,original!)).toBe(true);
 await search.fill('返回后仍可搜索');await header.getByRole('button',{name:'新建笔记',exact:true}).click();await expect(page.getByRole('dialog',{name:'新建笔记',exact:true})).toBeVisible();
});

test('header account remains readable and usable in light and dark themes',async({page},info)=>{
 await page.setViewportSize({width:1440,height:900});await page.goto('/');
 for(const theme of ['light','dark']){
  await page.evaluate(async theme=>{const path='/preferences.ts';const preferences=await import(path);preferences.setEditorPreferences({theme});},theme);
  await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
  const account=page.getByRole('banner',{name:'DooKnow 工作区',exact:true}).getByRole('button',{name:'个人账户',exact:true});
  await expect.poll(()=>account.evaluate(el=>{
   const rgb=(value:string)=>value.match(/[\d.]+/g)!.slice(0,3).map(Number);
   const lum=(color:number[])=>color.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
   const fg=lum(rgb(getComputedStyle(el.querySelector('.account-name')!).color));const bg=lum(rgb(getComputedStyle(el.closest('header')!).backgroundColor));return(Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05);
  })).toBeGreaterThanOrEqual(4.5);
  await account.click();const menu=page.getByRole('dialog',{name:'账户菜单',exact:true});await expect(menu.getByRole('button',{name:'账户设置',exact:true})).toBeFocused();await page.keyboard.press('Escape');await expect(menu).not.toBeVisible();await page.mouse.move(400,400);
  await page.screenshot({path:info.outputPath('header-'+theme+'.png'),animations:'disabled'});
 }
});

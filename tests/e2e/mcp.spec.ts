import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
test('loads independently built MCP settings and exposes connection requirements on desktop and mobile', async ({page,context},info)=>{
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json','utf8')));
  await page.goto('/'); await page.getByRole('button',{name:'设置',exact:true}).click();
  await page.getByRole('button',{name:'安装MCP 服务',exact:true}).click();
  await page.getByRole('button',{name:'启用MCP 服务',exact:true}).click();
  await expect(page.getByText('OAuth 尚未就绪：需要浏览器可达的 HTTPS 授权站点和 MCP 地址',{exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'最近调用',exact:true})).toBeVisible();
  await expect(page.getByLabel('Tunnel Bearer 密钥',{exact:true})).toHaveValue('');
  if(info.project.name==='mobile') await page.getByRole('button',{name:'打开侧栏',exact:true}).click();
  await page.getByRole('button',{name:'MCP 连接',exact:true}).click();
  await expect(page.getByRole('button',{name:'关闭插件面板',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'关闭插件面板',exact:true}).click();
  if(info.project.name==='mobile') await page.getByRole('button',{name:'关闭侧栏',exact:true}).click();
  await page.getByRole('button',{name:'停用MCP 服务',exact:true}).click();
  await expect(page.getByRole('button',{name:'MCP 连接',exact:true})).toHaveCount(0);
});

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.LIKEMIND_PLAYWRIGHT_MODULE||'playwright-core');
const context=await chromium.launchPersistentContext('',{executablePath:process.env.LIKEMIND_CHROMIUM,headless:true,ignoreDefaultArgs:['--disable-extensions'],args:['--enable-unsafe-extension-debugging','--disable-background-networking']});
try {
 const session=await context.browser().newBrowserCDPSession();
 const {id}=await session.send('Extensions.loadUnpacked',{path:fileURLToPath(new URL('../dist',import.meta.url))});
 await session.detach();
 const page=await context.newPage();
 await page.addInitScript(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{
  if(!window.__allowFixtureCopy)throw new DOMException('fixture denial','NotAllowedError');
  window.__fixtureCopiedReport=text;
 }}}));
 await page.goto(`chrome-extension://${id}/dashboard.html?profile=default#settings`);
 await page.getByRole('button',{name:'查看诊断',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'运行自检与诊断'});
 const copy=dialog.getByRole('button',{name:'复制诊断内容',exact:true});
 await copy.click();
 await dialog.getByRole('alert').getByText('复制失败，请下载报告，或在 JSON 页手动复制。',{exact:true}).waitFor();
 assert.equal(await dialog.getByText('已复制',{exact:true}).count(),0);
 const pendingDownload=page.waitForEvent('download');
 await dialog.getByRole('button',{name:'下载报告 (JSON)',exact:true}).click();
 const download=await pendingDownload;
 const report=JSON.parse(await readFile(await download.path(),'utf8'));
 assert.ok(report&&typeof report==='object');
 await page.evaluate(()=>{window.__allowFixtureCopy=true;});
 await copy.click();
 await dialog.getByText('已复制',{exact:true}).waitFor();
 assert.deepEqual(await page.evaluate(()=>JSON.parse(window.__fixtureCopiedReport)),report);
 console.log('PASS: denied clipboard reports failure, JSON download remains valid, and a successful retry copies the actual report');
}finally{await context.close();}

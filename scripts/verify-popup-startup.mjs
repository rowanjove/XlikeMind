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
 await page.setViewportSize({width:380,height:600});
 const html=await readFile(new URL('../dist/popup.html',import.meta.url),'utf8');
 await page.setContent(html.replace(/<script[\s\S]*?<\/script>/g,'').replace(/<link[^>]*>/g,''));
 const bounds=()=>page.evaluate(()=>({width:document.body.getBoundingClientRect().width,height:document.body.getBoundingClientRect().height,background:getComputedStyle(document.body).backgroundColor}));
 const checkOverflow=async()=>assert.deepEqual(await page.evaluate(()=>({
   htmlWidth:document.documentElement.scrollWidth,htmlHeight:document.documentElement.scrollHeight,
   bodyWidth:document.body.scrollWidth,bodyHeight:document.body.scrollHeight,
   rootHeight:document.getElementById('root').getBoundingClientRect().height,
 })),{htmlWidth:380,htmlHeight:600,bodyWidth:380,bodyHeight:600,rootHeight:600});
 const initial=await bounds();
 await checkOverflow();
 assert.deepEqual(initial,{width:380,height:600,background:'rgb(242, 246, 251)'});
 await page.goto(`chrome-extension://${id}/popup.html`);
 await page.getByRole('button',{name:'设置',exact:true}).waitFor();
 assert.deepEqual(await bounds(),initial);
 await checkOverflow();
 const normal=await page.locator('.lm-popup-content').evaluate(n=>({client:n.clientHeight,scroll:n.scrollHeight}));
 assert.ok(normal.scroll<=normal.client,JSON.stringify(normal));
 await page.getByRole('button',{name:'设置',exact:true}).click();
 await page.getByRole('dialog',{name:'扩展设置'}).waitFor();
 assert.deepEqual(await bounds(),initial);
 await checkOverflow();
 await page.getByRole('button',{name:'返回',exact:true}).click();
 await page.getByLabel('本次扫描上限').selectOption('custom');
 await checkOverflow();
 const content=page.locator('.lm-popup-content');
 await content.evaluate(node=>{node.scrollTop=node.scrollHeight;});
 await page.getByRole('button',{name:'打开文库',exact:true}).scrollIntoViewIfNeeded();
 assert.equal(await page.getByRole('button',{name:'打开文库',exact:true}).isVisible(),true);
 console.log('PASS: Chrome popup keeps 380x600 bounds and the same background before assets load, after React mounts and in settings, with no document overflow and reachable controls');
} finally {await context.close();}

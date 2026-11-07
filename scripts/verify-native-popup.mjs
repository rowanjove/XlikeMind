import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.LIKEMIND_PLAYWRIGHT_MODULE||'playwright-core');
const ctx=await chromium.launchPersistentContext('',{executablePath:process.env.LIKEMIND_CHROMIUM,headless:true,ignoreDefaultArgs:['--disable-extensions'],args:['--enable-unsafe-extension-debugging','--disable-background-networking']});
try {
 const cdp=await ctx.browser().newBrowserCDPSession();
 await cdp.send('Extensions.loadUnpacked',{path:process.env.LIKEMIND_EXTENSION_DIST || fileURLToPath(new URL('../dist',import.meta.url))});
 const worker=ctx.serviceWorkers()[0]||await ctx.waitForEvent('serviceworker');
 await worker.evaluate(()=>chrome.action.openPopup());
 const {targetInfos}=await cdp.send('Target.getTargets');
 const target=targetInfos.find(t=>t.url.endsWith('/popup.html'));
 assert.ok(target,'native action popup target missing');
 const {sessionId}=await cdp.send('Target.attachToTarget',{targetId:target.targetId,flatten:false});
 let next=0;
 const pending=new Map();
 cdp.on('Target.receivedMessageFromTarget',event=>{
  if(event.sessionId!==sessionId)return;
  const message=JSON.parse(event.message);
  const callback=pending.get(message.id);
  if(callback){pending.delete(message.id);callback(message);}
 });
 const send=async(method,params={})=>{
  const id=++next;
  const response=new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{pending.delete(id);reject(new Error('native popup CDP timeout'));},10000);
   pending.set(id,message=>{clearTimeout(timer);resolve(message);});
  });
  await cdp.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id,method,params})});
  const reply=await response;
  if(reply.error)throw new Error(reply.error.message);
  return reply.result;
 };
 const result=await send('Runtime.evaluate',{awaitPromise:true,returnByValue:true,expression:`new Promise(resolve=>{
  const frames=[];
  function sample(){
   if(document.body){const content=document.querySelector('.lm-popup-content');frames.push({width:innerWidth,height:innerHeight,docHeight:document.documentElement.scrollHeight,bodyHeight:document.body.getBoundingClientRect().height,rootHeight:document.getElementById('root')?.getBoundingClientRect().height,ready:Boolean(content),content:content?{height:content.clientHeight,scroll:content.scrollHeight}:null});}
   if(frames.length>=30)resolve(frames);else requestAnimationFrame(sample);
  }
  sample();
 })`});
 const frames=result.result.value;
 console.log(JSON.stringify({first:frames[0],last:frames.at(-1),sizes:[...new Set(frames.map(f=>f.width+'x'+f.height))]}));
 assert.ok(frames.at(-1).ready,'popup did not mount');
 assert.ok(frames.every(f=>f.width===380&&f.height>=300&&f.height<=600&&f.bodyHeight<=f.height&&f.rootHeight<=f.height),'native popup bounds overflow or collapsed');
 const accessible=await send('Runtime.evaluate',{returnByValue:true,expression:`(()=>{const c=document.querySelector('.lm-popup-content');c.scrollTop=c.scrollHeight;const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='打开文库');const r=b.getBoundingClientRect();return r.bottom<=innerHeight&&r.top>=0;})()`});
 assert.equal(accessible.result.value,true,'bottom controls are clipped in the native popup');
 console.log('PASS: native chrome.action.openPopup stays within its available viewport');
}finally{await ctx.close();}

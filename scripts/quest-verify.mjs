/** Caboledo Quest verifier: no OpenAI key, no AI calls inside GitHub.
 *  HTML comes from the EXISTING n8n OpenAI credential.
 *  Validate -> Chromium interaction/layout tests -> publish only on pass.
 *  Generated code is never run in Node, only in isolated Chromium.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright';

const event=JSON.parse(await fs.readFile(process.env.GITHUB_EVENT_PATH,'utf8'));
const payload=event.client_payload||{};
const slot=String(payload.slot||'');
const requestId=String(payload.request_id||'');
const htmlPayload=String(payload.html||'').trim();
if(!/^(0[1-9]|1\d|20)$/.test(slot)||!/^[a-zA-Z0-9_-]{12,56}$/.test(requestId))throw Error('Bad slot or request ID');
if(htmlPayload.length<1400||htmlPayload.length>40000)throw Error('Missing or oversized game HTML in GitHub dispatch payload');

const forbidden=[
  [/<script\b[^>]*\bsrc\s*=/i,'external script'],
  [/<link\b[^>]*\bhref\s*=/i,'external resource'],
  [/<(?:iframe|embed|object|base)\b/i,'nested frame/embed'],
  [/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\s*\(/i,'network API'],
  [/\b(?:eval|Function)\s*\(/i,'dynamic evaluation'],
  [/\bimport\s*\(/i,'dynamic import'],
  [/\b(?:serviceWorker|window\.open|top\.location|parent\.location)\b/i,'navigation/service worker'],
];
function validate(input){
  let html=input.replace(/^```(?:html)?\s*/i,'').replace(/\s*```$/,'').trim();
  const start=html.search(/<!doctype\s+html\s*>/i);if(start>0&&start<400)html=html.slice(start);
  if(!/^<!doctype\s+html\s*>/i.test(html)||!/<\/html>\s*$/i.test(html)||!/<head\b/i.test(html)||!/<body\b/i.test(html))throw Error('Incomplete HTML document');
  if(html.length<1400||html.length>30000)throw Error('HTML length outside 1.4-30 KB');
  if(!/<style\b/i.test(html)||!/<script\b/i.test(html))throw Error('Missing inline CSS or JS');
  if(!/<meta[^>]*name\s*=\s*['"]viewport['"]/i.test(html))throw Error('Viewport meta tag missing');
  for(const [pattern,reason] of forbidden)if(pattern.test(html))throw Error('Forbidden '+reason);
  const sanitized=html.replace(/\bxmlns(?::xlink)?\s*=\s*['"]https?:\/\/www\.w3\.org\/[^'"]+['"]/gi,'');
  if(/https?:\/\//i.test(sanitized))throw Error('External URL disallowed');
  const scripts=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)];
  if(!scripts.length)throw Error('No script contents');
  for(const [,javascript] of scripts)new vm.Script(javascript,{timeout:1000});
  return html;
}

async function browserTest(html){
  const browser=await chromium.launch({headless:true,args:['--disable-dev-shm-usage']});
  try{
    const errors=[];
    const context=await browser.newContext({viewport:{width:900,height:500},serviceWorkers:'block'});
    await context.route('**/*',route=>route.abort('blockedbyclient')); // no network
    const page=await context.newPage();
    page.on('pageerror',e=>errors.push(e.message));
    await page.setContent(html,{waitUntil:'domcontentloaded',timeout:15000});
    await page.waitForTimeout(450);
    const layout=async()=>await page.evaluate(()=>{
      const e=document.documentElement;return {width:e.scrollWidth,height:e.scrollHeight,viewportWidth:innerWidth,viewportHeight:innerHeight};
    });
    const first=await layout();
    if(first.width>first.viewportWidth+8||first.height>first.viewportHeight+8)throw Error('Overflow at 900x500: '+JSON.stringify(first));
    const digest=async()=>await page.evaluate(()=>{
      const text=(document.body.innerText||'').slice(0,6000);
      const canvases=[...document.querySelectorAll('canvas')].slice(0,3).map(c=>{
        try{const data=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let h=2166136261;const step=Math.max(4,Math.floor(data.length/20000));
          for(let i=0;i<data.length;i+=step)h=Math.imul(h^data[i],16777619)>>>0;return String(h)}catch{return 'unavailable'}
      });return JSON.stringify({text,canvases});
    });
    const before=await digest();
    const buttons=page.locator('button,input[type="button"],input[type="submit"],[role="button"]');
    const total=await buttons.count();let clickTarget=null;
    for(let i=0;i<Math.min(total,24);i++){
      const target=buttons.nth(i);if(!await target.isVisible())continue;
      const label=((await target.innerText().catch(()=>''))+' '+(await target.getAttribute('aria-label')||'')).toLowerCase();
      if(/start|los|spielen|begin|play|neu|go\b/.test(label)){clickTarget=target;break;}
      if(!clickTarget)clickTarget=target;
    }
    if(clickTarget){
      if(!await clickTarget.isEnabled())throw Error('Primary control is disabled');
      await clickTarget.click({timeout:4000});
    }else{
      const surface=page.locator('canvas').first();
      if(await surface.count())await surface.click({position:{x:50,y:50}});
      else{
        const input=page.locator('input:not([type=hidden]),textarea,select').first();
        if(await input.count()){
          const type=await input.evaluate(el=>(el.getAttribute('type')||el.tagName||'text').toLowerCase());
          if(type==='checkbox'||type==='radio')await input.check();
          else if(type==='select')await input.selectOption({index:1});
          else if(type==='number'||type==='range')await input.fill('1');
          else await input.fill('Test');
        }
        else throw Error('No usable interactive control or Canvas found');
      }
    }
    await page.waitForTimeout(1400);
    const after=await digest();
    if(after===before)throw Error('Interaction caused no detectable visual or state change');
    if(errors.length)throw Error('JavaScript error after interaction: '+errors.join(' | ').slice(0,800));
    await page.setViewportSize({width:640,height:360});
    await page.waitForTimeout(300);
    const small=await layout();
    if(small.width>small.viewportWidth+8||small.height>small.viewportHeight+8)throw Error('Overflow at 640x360: '+JSON.stringify(small));
    // Start overlays may disappear after play begins. That is expected.
    return {ok:true,viewports:['900x500','640x360'],errors:[]};
  }finally{await browser.close()}
}

const html=validate(htmlPayload);
console.log('Caboledo Quest slot '+slot+': testing generated HTML from n8n');
const result=await browserTest(html);
console.log('Browser checks passed:',JSON.stringify(result));

// The checkout action provides GitHub's job-scoped write token. Publish on
// the default branch only after ALL validation and browser checks passed.
const destination=path.resolve(process.env.GITHUB_WORKSPACE,`game-${slot}.html`);
await fs.writeFile(destination,html+'\n','utf8');
const git=(...args)=>execFileSync('git',args,{cwd:process.env.GITHUB_WORKSPACE,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
git('config','user.name','github-actions[bot]');
git('config','user.email','41898282+github-actions[bot]@users.noreply.github.com');
git('add',`game-${slot}.html`);
const staged=git('diff','--cached','--name-only');
if(!staged){console.log('Generated file identical to published file. No commit needed.');process.exit(0)}
git('commit','-m',`Caboledo Quest slot ${slot} automatic browser test passed (${requestId})`);
let pushed=false;
for(let tries=1;tries<=4;tries++){
  try{git('pull','--rebase','origin',process.env.GITHUB_REF_NAME||'main');git('push','origin',`HEAD:${process.env.GITHUB_REF_NAME||'main'}`);pushed=true;break}
  catch(e){console.error('Concurrent push retry '+tries+': '+String(e.message).slice(0,300));await new Promise(r=>setTimeout(r,1000*tries));}
}
if(!pushed)throw Error('Browser tests passed but publishing to GitHub failed. No success reported.');
console.log('PUBLISHED slot '+slot+' after automatic Chromium browser test. GitHub Pages will update asynchronously.');

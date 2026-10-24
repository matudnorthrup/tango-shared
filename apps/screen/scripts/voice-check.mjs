import fs from 'node:fs';
import { chromium } from 'playwright-core';
// Connect only to an already leased browser; this helper never launches one.
const [cdp, wavFile, dir, viewport] = process.argv.slice(2);
if (!cdp || !wavFile || !dir) throw new Error('Usage: node voice-check.mjs <leased-CDP-url> <spoken.wav> <artifact-directory>');
fs.mkdirSync(dir, { recursive: true });
const b=await chromium.connectOverCDP(cdp);
const p=b.contexts()[0].pages()[0];
await p.setViewportSize(viewport === 'phone' ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
const url = new URL(p.url());
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port === '9410') throw new Error('Use the sandbox test desk only.');
const stub = await fetch(`http://${url.hostname}:${Number(url.port) + 1}/posts`).then(r => r.json());
if (!Array.isArray(stub)) throw new Error('Sandbox bot stub not found.');
await p.evaluate(async (wav) => {
  const bytes=Uint8Array.from(atob(wav),c=>c.charCodeAt(0));

  navigator.mediaDevices.getUserMedia=async () => {
    const context=new AudioContext();await context.resume();
    const dest=context.createMediaStreamDestination();
    const sound=context.createBufferSource();sound.buffer=await context.decodeAudioData(bytes.buffer.slice(0));sound.connect(dest);sound.onended=()=>{window.__voiceAudioEnd=Date.now();};
    // Start only once the real model is listening; still sends through the capture worklet.
    const timer=setInterval(()=>{if(document.querySelector('.rd-mic.listening')){clearInterval(timer);setTimeout(()=>sound.start(),500);}},50);
    dest.stream.getTracks()[0].addEventListener('ended',()=>{clearInterval(timer);void context.close();});
    window.__voiceFixture={context,sound};
    return dest.stream;
  };
  window.__voiceStates=[];
  const ob=new MutationObserver(()=>{const el=document.querySelector('.rd-mic');const s=el?.className;if(s&&window.__voiceStates.at(-1)?.state!==s)window.__voiceStates.push({at:Date.now(),state:s,text:document.querySelector('textarea.rd-text')?.value});});
  ob.observe(document.body,{subtree:true,attributes:true,childList:true});
},fs.readFileSync(wavFile).toString('base64'));
await p.getByRole('button',{name:'Start voice reply',exact:true}).click();
const seen=new Set();
for(let i=0;i<120;i++) {
 const state=await p.locator('.rd-mic').getAttribute('class');
 const name=state?.split(' ').at(-1);
 if(['listening','sending','waiting','speaking','error'].includes(name)&&!seen.has(name)){
   seen.add(name);await p.screenshot({path:dir+'/live-'+name+'.png'});console.log(name,Date.now());
 }
 if(name==='idle'&&i>5)break;
 await new Promise(r=>setTimeout(r,500));
}
console.log(JSON.stringify(await p.evaluate(()=>({audioEnd:window.__voiceAudioEnd,states:window.__voiceStates})),null,2));
fs.writeFileSync(dir+'/browser-states.json',JSON.stringify(await p.evaluate(()=>({audioEnd:window.__voiceAudioEnd,states:window.__voiceStates})),null,2));
const states = await p.evaluate(() => window.__voiceStates.map(s => s.state.split(' ').at(-1)));
await b.close();
if (!['listening', 'sending', 'waiting', 'speaking', 'idle'].every(s => states.includes(s))) throw new Error(`Incomplete exchange: ${states.join(', ')}`);

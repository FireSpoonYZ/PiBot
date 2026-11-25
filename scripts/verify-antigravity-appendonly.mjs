// Run only against an isolated AGY profile. Exercises the full Host, Center HTTP/WSS,
// Pi Durable codemode, real native persistence, image delivery, and /clear behavior.
// Requires openssl and Python Pillow. Never points at a running PiBot service.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { openCenterServer } from '../center-server/server.js';
import { hashOwnerPassword } from '../center-server/config.js';
import { openHost } from '../host-core/host.js';
import { openHostService } from '../host-core/host-service.js';
import { createControlClient } from '../host-core/control-client.js';
import { AcpConnection } from '../center-server/antigravity/vendor/acp/connection.ts';
import { ANTIGRAVITY_STREAM_PATH } from '../center-contract/antigravity.js';

process.umask(0o077);
assert.ok(process.env.PIBOT_AGY_HOME, 'Set PIBOT_AGY_HOME to an isolated authenticated profile');
assert.notEqual(fs.realpathSync(process.env.PIBOT_AGY_HOME), path.join(os.homedir(), '.gemini'));
const root = fs.mkdtempSync(path.join(process.env.PIBOT_AGY_EVIDENCE_ROOT || os.tmpdir(), 'agy-full-host-'));
const work = path.join(root, 'workspace');
fs.mkdirSync(work);
const expected = randomBytes(5).toString('hex').toUpperCase();
const expectedInput = randomBytes(5).toString('hex').toUpperCase();
execFileSync('python3', ['-c', [
 'from PIL import Image,ImageDraw,ImageFont',
 'import sys',
 'for name,code in [("tool.png",sys.argv[2]),("input.png",sys.argv[3])]:',
 ' im=Image.new("RGB",(700,480),"white"); d=ImageDraw.Draw(im)',
 ' f=ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",60)',
 ' d.text((55,35),code,font=f,fill="black")',
 ' d.rectangle((60,180,270,380),fill="red"); d.rectangle((410,180,620,380),fill="purple")',
 ' im.save(sys.argv[1]+"/"+name)',
].join('\n'), work, expected, expectedInput]);
execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-days','1',
 '-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1',
 '-keyout',path.join(root,'tls.key'),'-out',path.join(root,'tls.crt')], {stdio:'ignore'});
const cert = fs.readFileSync(path.join(root,'tls.crt'), 'utf8');
const ownerPassword = randomBytes(24).toString('hex');
const credentials = { encryptionKey: randomBytes(32), sessionKey: randomBytes(32),
 ownerPasswordHash: hashOwnerPassword(ownerPassword) };
const report = {root,model:null,checks:[],wire:[],native:[]};
const save = () => fs.writeFileSync(path.join(root,'result.json'), JSON.stringify(report,null,2));
const check = (name, detail = {}) => { report.checks.push({name,...detail}); save(); console.log('PASS', name, JSON.stringify(detail)); };
let center, hostService, control, owner;
let phase = 'initial';
const sockets = new Set();
const originalPrompt = AcpConnection.prototype.prompt;
AcpConnection.prototype.prompt = function(id, text, images, ...rest) {
 report.native.push({phase,id,bytes:Buffer.byteLength(text),images:images?.length ?? 0});
 return originalPrompt.call(this,id,text,images,...rest);
};
const proxy = https.createServer({key:fs.readFileSync(path.join(root,'tls.key')),cert}, (req,res) => {
 const chunks=[];
 if(req.url.split('?')[0] === ANTIGRAVITY_STREAM_PATH) {
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
   try {
    const raw=Buffer.concat(chunks), p=JSON.parse(raw), d=p.delta;
    report.wire.push({phase,sessionId:p.sessionId,bytes:raw.length,offset:d.offset,
     entries:d.messages.length,config:Boolean(d.config),tools:d.config?.tools.map(t=>t.name),
     images:d.messages.flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(b=>b.type==='image')
      .map(b=>createHash('sha256').update(b.data).digest('hex'))});
    save();
   } catch(e) { console.error('wire observer:',e.message); }
  });
 }
 const upstream=http.request(new URL(req.url,center.url),{method:req.method,headers:req.headers}, incoming=>{
  res.writeHead(incoming.statusCode,incoming.headers); incoming.pipe(res);
 });
 upstream.on('error',e=>res.destroy(e)); req.pipe(upstream);
});
proxy.on('connection', socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
proxy.on('upgrade', (req,socket,head)=>{
 const upstream=net.connect(new URL(center.url).port,'127.0.0.1',()=>{
  upstream.write(req.method+' '+req.url+' HTTP/'+req.httpVersion+'\r\n'+
   req.rawHeaders.reduce((out,value,index)=>out+(index%2?value+'\r\n':value+': '),'')+'\r\n');
  if(head.length)upstream.write(head);
  socket.pipe(upstream);upstream.pipe(socket);
 });
 upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());
 socket.on('close',()=>upstream.destroy());upstream.on('close',()=>socket.destroy());
});
await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
const publicUrl='https://127.0.0.1:'+proxy.address().port;
const hostRoot=path.join(root,'host');
const meta=openHost({dataRoot:hostRoot});
const deviceId=meta.deviceId;
const bot=meta.createBot({requestId:'create-acceptance',role:'AGY acceptance. Follow the user test precisely.',cwd:work,makePrimary:true});
meta.close();
const controlToken=randomBytes(32).toString('base64url');
let deviceToken;
async function startCenter() {
 center=await openCenterServer({dataRoot:path.join(root,'center'),...credentials,port:0,publicUrl});
 owner=createOwnerHttpClient(center.url,120000);await owner.login(ownerPassword);
}
async function startHost() {
 hostService=await openHostService({dataRoot:hostRoot,token:controlToken,port:0,expectedDeviceId:deviceId,
  center:{url:publicUrl,deviceToken,ca:cert}});
 assert.equal(hostService.getStatus().relay.phase,'online');
 control=createControlClient({url:hostService.url,token:controlToken});
}
async function until(fn, label, timeout=120000) {
 const deadline=Date.now()+timeout;
 while(Date.now()<deadline){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,150));}
 throw Error('Timed out: '+label);
}
async function send(name,text,extra={}) {
 phase=name;
 const before=report.native.length;
 await control.submit(bot.botId,{requestId:name,text,...extra});
 const result=await until(async()=>{
  const s=await control.getSubmission(bot.botId,name);
  return !['queued','placed','running','pending','admitted'].includes(s.status) && s;
 },name);
 save();
 console.log('TURN',name,JSON.stringify({status:result.status,reason:result.reason,answer:result.answerText}));
 return {...result,nativePrompts:report.native.length-before};
}
function done(result) {assert.equal(result.status,'done',JSON.stringify(result));}
try {
 await startCenter();
 ({deviceToken}=await owner.request('POST','/api/devices',{deviceId,displayName:'AGY isolated acceptance',platform:'linux',replaceExisting:true}));
 await startHost();
 check('full Host control and WSS relay online');
 const provider=await owner.request('GET','/api/providers/antigravity-acp');
 await owner.request('PUT','/api/providers/antigravity-acp',{expectedRevision:provider.revision,value:{
  name:provider.name,api:provider.api,baseUrl:provider.baseUrl,credentialRef:provider.credentialRef,
  enabled:true,native:provider.native,configured:true}});
 const {models}=await owner.request('POST','/api/providers/antigravity-acp/discover',{});
 const chosen=models.find(m=>m.id===(process.env.PIBOT_AGY_MODEL||'gemini-4-hydrogen'))??models[0];
 assert.ok(chosen,'no native models discovered'); report.model=chosen.id;
 const modelPath='/api/devices/'+deviceId+'/bots/'+bot.botId+'/model-config';
 const cfg=await owner.request('GET',modelPath);
 await owner.request('PUT',modelPath,{expectedRevision:cfg.revision??0,value:{
  modelRef:'antigravity-acp/'+chosen.id,thinkingLevel:'low',codemode:false,codemodeOnly:false}});
 const first=await send('tool-image','Use codemode to discover/inspect the read tool, then use image(await tools.read({path:"'+path.join(work,'tool.png')+'"})). Read the ten-character printed code from the resulting image; reply only with the code. If the pixels are unavailable, reply UNKNOWN. Do not use shell, OCR or other tools.');
 done(first);assert.ok(first.answerText.includes(expected),'native did not read the real tool image');
 assert.equal(first.nativePrompts,1,'tool continuation must not add a fake native prompt');
 const firstId=report.native[0].id;
 assert.ok(report.wire.length>=2,'must complete Host tool loop over HTTP');
 assert.ok(report.wire[0].tools.includes('codemode'));
 assert.ok(report.wire[0].tools.includes('ask_user_question'));
 assert.ok(!report.wire[0].tools.includes('read'),'ordinary tools remain inside codemode');
 assert.ok(report.wire.slice(1).every(p=>p.offset>0&&!p.config),'normal follow-up uploads must be incremental');
 assert.ok(report.wire.some(p=>p.images.length===1),'tool image must cross Host to Center');
 check('codemode tool image visible in the same real native turn',{answer:first.answerText,requests:report.wire.length});
 const follow=await send('same-session','Without using tools, repeat the code you just read.');
 done(follow);assert.ok(follow.answerText.includes(expected));assert.equal(follow.nativePrompts,1);
 assert.equal(report.native.at(-1).id,firstId);assert.equal(report.wire.at(-1).images.length,0);
 check('incremental next turn preserves native memory without uploading the old image');
 const history=await control.history(bot.botId,{limit:100});
 const userEntry=history.items.find(e=>e.model?.some(m=>m.role==='user'));
 assert.ok(userEntry);
 await assert.rejects(control.editMessage(bot.botId,{entryId:userEntry.id,requestId:'forbidden-edit',text:'edited'}),/\/clear/);
 await assert.rejects(control.compact(bot.botId),/\/clear/);
 const other=models.find(m=>m.id!==chosen.id);
 if(other) {
  const current=await owner.request('GET',modelPath);
  await assert.rejects(owner.request('PUT',modelPath,{expectedRevision:current.revision,value:{
   modelRef:'antigravity-acp/'+other.id}}),/\/clear/);
  assert.equal((await owner.request('GET',modelPath)).revision,current.revision);
 }
 check('HTTP history edit, Pi compaction and model change reject with clear guidance');
 await hostService.close();hostService=null;await center.close();center=null;
 await startCenter();await startHost();
 const restart=await send('after-restart','Without using tools, what color was the rectangle on the RIGHT in the earlier image? Reply with the color only.');
 done(restart);assert.match(restart.answerText,/purple|紫/i);
 assert.equal(report.native.at(-1).id,firstId);
 assert.equal(restart.nativePrompts,1);
 assert.equal(report.wire.at(-1).offset,0,'a restarted Host safely retransmits its receipt once');
 assert.equal(report.native.at(-1).images,0,'Center must not replay old image history into native');
 check('Host and Center restart reload the same native conversation and retain image detail');
 const soul=await control.getBotSoul(bot.botId);
 await control.setBotSoul(bot.botId,{expectedRevision:soul.revision,text:soul.text+'\nFor the acceptance greeting respond NEW_SOUL_OK.'});
 const count=report.native.length;
 const changed=await send('changed-soul','Acceptance greeting.');
 assert.notEqual(changed.status,'done');
 assert.equal(report.native.length,count);
 assert.match(JSON.stringify(await control.history(bot.botId,{limit:100})),/\/clear/);
 check('changed Soul blocks before native prompt and requires manual clear');
 await control.clearHistory(bot.botId);
 const fresh=await send('manual-clear','Acceptance greeting. Reply exactly as the Soul instructs.');
 done(fresh);assert.match(fresh.answerText,/NEW_SOUL_OK/);
 assert.notEqual(report.native.at(-1).id,firstId);
 check('manual clear creates a new native conversation using the updated Soul');
 const attachment=await control.uploadAttachment(bot.botId,{name:'input.png',mimeType:'image/png',
  data:fs.readFileSync(path.join(work,'input.png')).toString('base64')});
 const input=await send('input-image','Read the ten-character code in this attached image, using no tools. Reply only with the code.',{attachments:[attachment.id]});
 done(input);assert.ok(input.answerText.includes(expectedInput));assert.equal(report.native.at(-1).images,1);
 check('user image attachment reaches ACP as a typed image',{answer:input.answerText});
 const questionTurn=await send('direct-question','Directly call ask_user_question (not codemode) with one question: header Finish, question "Pick a finish", options Copper (Warm) and Steel (Cool). Wait for the answer, then state the chosen finish.');
 done(questionTurn);
 const questionPage=await control.history(bot.botId,{limit:100});
 const question=questionPage.items.flatMap(entry=>entry.model??[]).find(message=>message.durableWait===true)?.details.presentation;
 assert.equal(question?.status,'pending','a direct model-only question must produce the real Host question card');
 phase='question-answer';
 await control.callCapabilityAction({installationId:question.installationId,action:'answerQuestionnaire',request:{
  requestId:'acceptance-answer',deviceId,botId:bot.botId,input:{conversationId:question.conversationId,
   requestId:question.requestId,cancelled:false,answers:[{questionIndex:0,selectedOptions:[0]}]}}});
 const waitKey=createHash('sha256').update(JSON.stringify([bot.primaryConversationId,question.installationId,question.conversationId,question.requestId])).digest('hex');
 const answered=await until(async()=>{
  const s=await control.getSubmission(bot.botId,'wait-'+waitKey.slice(0,40)).catch(e=>{if(e.code==='SUBMISSION_NOT_FOUND')return null;throw e;});
  return s&&!['queued','placed','running','pending','admitted'].includes(s.status)&&s;
 },'direct question answer');
 done(answered);assert.match(answered.answerText,/Copper|铜/i);
 assert.equal(report.native.filter(p=>p.phase==='question-answer').length,1,'answer is exactly one real new input');
 check('direct model-only questionnaire resumes with the human answer',{answer:answered.answerText});
 report.ok=true;save();console.log('ACCEPTANCE_OK',root);
} catch(error) {
 report.ok=false;report.error={message:error.message,stack:error.stack};save();console.error(error);process.exitCode=1;
} finally {
 await hostService?.close().catch(e=>console.error('Host close:',e.message));
 await center?.close().catch(e=>console.error('Center close:',e.message));
 for(const socket of sockets)socket.destroy();
 await new Promise(resolve=>proxy.close(resolve));
 AcpConnection.prototype.prompt=originalPrompt;save();
}

function createOwnerHttpClient(baseUrl, timeoutMs) {
  const cookies = new Map();
  let csrfToken = '';

  const absorbCookies = (headers) => {
    const rawList = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
    for (const raw of rawList) {
      const pair = String(raw).split(';', 1)[0];
      const eq = pair.indexOf('=');
      if (eq > 0) {
        cookies.set(pair.slice(0, eq).trim(), pair.trim());
      }
    }
  };

  const cookieHeader = () => Array.from(cookies.values()).join('; ');

  async function request(method, pathname, body) {
    const headers = {};
    const cookie = cookieHeader();
    if (cookie) headers.Cookie = cookie;
    if (method !== 'GET' && method !== 'HEAD') {
      if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(new URL(pathname, baseUrl), {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    absorbCookies(res.headers);
    const text = await res.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (!res.ok) {
      const code = json?.error?.code ? ` ${json.error.code}` : '';
      const msg = json?.error?.message ? `: ${json.error.message}` : '';
      throw new Error(`Center HTTP ${method} ${pathname} failed (${res.status}${code})${msg}`);
    }
    if (json && typeof json.csrfToken === 'string' && json.csrfToken) {
      csrfToken = json.csrfToken;
    }
    return json;
  }

  return {
    request,
    async login(password) {
      await request('GET', '/api/session');
      const loginRes = await request('POST', '/api/session', { password });
      assert.equal(loginRes?.authenticated, true, 'owner login must authenticate');
      const verifyRes = await request('GET', '/api/session');
      assert.equal(verifyRes?.authenticated, true, 'owner session cookie must stay authenticated');
    },
  };
}


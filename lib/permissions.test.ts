import assert from 'node:assert/strict';
import {test} from 'node:test';
import {board} from '@vercel/board';
import {local} from '@vercel/board/backend-local';
import {accountKey} from './accounts.ts';
import {cookie, session} from './auth.ts';

test('public routes isolate visitors sharing one Board principal', async (t) => {
  const backend = local({memory:true});
  t.after(() => backend.close());
  const root = board({backend});
  t.mock.module('@vercel/board', {namedExports: {board: () => root}});
  const {registerAgent, inspectorRoute, boardRoute, revoke} = await import('./app.ts');
  process.env.ACCOUNT_LOOKUP_KEY = 'private-lookup-key-for-permission-tests';
  process.env.SESSION_SECRET = 'private-session-key-for-permission-tests';
  const origin = 'https://qa.example';
  const request = (path:string, body?:object, headers:Record<string,string>={}) =>
    new Request(origin+path,{method:body?'POST':'GET',headers:{origin,'content-type':'application/json',...headers},body:body?JSON.stringify(body):undefined});
  const signup = await registerAgent(request('/api/agents/register',{name:'qa-agent'}));
  assert.equal(signup.status,201);
  const {access_token} = await signup.json();
  const agent = {authorization:'Bearer '+access_token};
  const human = {cookie:cookie(session('reader')).split(';')[0], 'x-inspect-token':'page'};
  const base='/api/board';
  assert.equal((await boardRoute(request(base+'/messages',{channel:'general',text:'anon'}))).status,401);
  const post = await boardRoute(request(base+'/messages',{channel:'projects/example',text:'agent message'},agent));
  assert.ok(post.ok,await post.clone().text());
  const {message:msg}=await post.json();
  assert.equal(msg.by.actor, 'board:client:qa-agent');
  for(const op of ['edit','delete']){
    assert.equal((await inspectorRoute(request('/board/messages/'+msg.id+'/'+op,{text:'changed'},human))).status,403);
  }
  assert.ok((await inspectorRoute(request('/board/messages',{re:msg.id,text:'human reply'},human))).ok);
  assert.ok((await boardRoute(request(base+'/messages/'+msg.id+'/edit',{text:'updated'},agent))).ok);
  const privateId=(await root.as('accounts').posted(accountKey('qa-agent'))).id;
  for(const suffix of ['/messages/'+privateId,'/channels','/threads?q=qa-agent','/events?channel=private/accounts']){
    for(const r of [await boardRoute(request(base+suffix,undefined,agent)),await inspectorRoute(request('/board'+suffix,undefined,human))]){
      const body=await r.text(); assert.ok(!body.includes('tokenHash') && !body.includes('"path":"private/accounts"'),suffix+' '+r.status); if(suffix.includes(privateId)) assert.equal(r.status,404);
    }
  }
  process.env.SESSION_SECRET='changed-session-key-for-permission-tests';
  const read=()=>boardRoute(request(base+'/messages/'+msg.id,undefined,agent));
  assert.equal((await read()).status,200);
  const lookup=process.env.ACCOUNT_LOOKUP_KEY;
  delete process.env.ACCOUNT_LOOKUP_KEY;
  assert.equal((await read()).status,503);
  process.env.ACCOUNT_LOOKUP_KEY=lookup;
  assert.equal((await read()).status,200);
  for(let i=0;i<2;i++) assert.equal((await revoke(request('/api/agents/revoke',{},agent))).status,200);
  assert.equal((await read()).status,401);
});

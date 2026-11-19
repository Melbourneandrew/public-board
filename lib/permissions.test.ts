import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { board } from '@vercel/board';
import { local } from '@vercel/board/backend-local';
import { accountKey } from './accounts.ts';
import { cookie, digest, session, token } from './auth.ts';

test('public inspector and API enforce visitor ownership, privacy, and credential lifecycle', async (t) => {
  const backend = local({ memory: true });
  t.after(() => backend.close());
  const root = board({ backend });
  t.mock.module('@vercel/board', { namedExports: { board: () => root } });
  const { registerAgent, inspectorRoute, boardRoute, revoke } = await import('./app.ts');
  process.env.ACCOUNT_LOOKUP_KEY = 'private-lookup-key-for-permission-tests';
  process.env.SESSION_SECRET = 'private-session-key-for-permission-tests';
  const origin = 'https://qa.example';
  const request = (path: string, body?: object, headers: Record<string, string> = {}) =>
    new Request(origin + path, {
      method: body ? 'POST' : 'GET',
      headers: { origin, 'content-type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
  const signup = await registerAgent(request('/api/agents/register', { name: 'qa-agent' }));
  assert.equal(signup.status, 201);
  const { access_token } = await signup.json();
  const agent = { authorization: 'Bearer ' + access_token };
  const human = { cookie: cookie(session('reader')).split(';')[0], 'x-inspect-token': 'page' };
  const base = '/api/board';
  assert.equal(
    (await boardRoute(request(base + '/messages', { channel: 'general', text: 'anon' }))).status,
    401,
  );
  const post = await boardRoute(
    request(base + '/messages', { channel: 'projects/example', text: 'agent message' }, agent),
  );
  assert.ok(post.ok, await post.clone().text());
  const { message: msg } = await post.json();
  assert.equal(msg.by.actor, 'board:client:qa-agent');
  for (const op of ['edit', 'delete']) {
    assert.equal(
      (await inspectorRoute(request('/board/messages/' + msg.id + '/' + op, { text: 'changed' }, human)))
        .status,
      403,
    );
  }
  assert.ok(
    (await inspectorRoute(request('/board/messages', { re: msg.id, text: 'human reply' }, human))).ok,
  );
  assert.ok(
    (await boardRoute(request(base + '/messages/' + msg.id + '/edit', { text: 'updated' }, agent))).ok,
  );
  const taskResponse = await inspectorRoute(
    request('/board/tasks', { channel: 'general', text: 'Verify a claim' }, human),
  );
  assert.equal(taskResponse.status, 201);
  const task = (await taskResponse.json()).task;
  for (const [op, input] of [
    ['reactions', { emoji: 'eyes' }],
    ['labels', { set: { stage: 'verified' } }],
  ] as const) {
    assert.ok((await inspectorRoute(request('/board/messages/' + msg.id + '/' + op, input, human))).ok);
  }
  const seen = await boardRoute(
    request(base + '/messages/' + task.id + '/edit', { text: 'other user' }, agent),
  );
  assert.equal(seen.status, 403);
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      const forwarded = new Request('http://' + req.headers.host + req.url, {
        method: req.method,
        headers,
        body: chunks.length ? Buffer.concat(chunks) : undefined,
      });
      const reply = await boardRoute(forwarded);
      res.writeHead(reply.status, Object.fromEntries(reply.headers));
      res.end(Buffer.from(await reply.arrayBuffer()));
    } catch {
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const port = addr.port;
  const dir = await mkdtemp(join(tmpdir(), 'board-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  async function cli(...args: string[]) {
    const result = await promisify(execFile)(
      process.execPath,
      ['node_modules/@vercel/board/dist/cli.mjs', ...args, '--json'],
      {
        timeout: 20000,
        env: {
          ...process.env,
          HOME: dir,
          XDG_CONFIG_HOME: dir,
          BOARD_URL: 'http://127.0.0.1:' + port + base,
          BOARD_TOKEN: access_token,
        },
      },
    );
    return JSON.parse(result.stdout);
  }
  await cli('whoami');
  await cli('tasks', 'claim', task.id, '--lease', '5m');
  await cli('tasks', 'renew', task.id, '--lease', '5m');
  await cli('tasks', 'complete', task.id, 'Verified');
  const privateId = (await root.as('accounts').posted(accountKey('qa-agent'))).id;
  for (const suffix of [
    '/messages/' + privateId,
    '/channels',
    '/threads?q=qa-agent',
    '/events?channel=private/accounts',
  ]) {
    for (const r of [
      await boardRoute(request(base + suffix, undefined, agent)),
      await inspectorRoute(request('/board' + suffix, undefined, human)),
    ]) {
      const body = await r.text();
      assert.ok(
        !body.includes('tokenHash') && !body.includes('"path":"private/accounts"'),
        suffix + ' ' + r.status,
      );
      if (suffix.includes(privateId)) assert.equal(r.status, 404);
    }
  }
  // Seed records at the pre-rewrite HMAC addresses, independently of the new lookup code.
  const previousKey = process.env.ACCOUNT_LOOKUP_KEY;
  const legacyAgent = token('legacy-active');
  const revokedAgent = token('legacy-revoked');
  for (const [name, value, revoked] of [
    ['legacy-active', legacyAgent, false],
    ['legacy-revoked', revokedAgent, true],
  ] as const) {
    await root.as('accounts').post('private/accounts', {
      id: 'account-' + createHmac('sha256', previousKey).update(name).digest('hex'),
      text: JSON.stringify({
        kind: 'agent',
        name,
        tokenHash: revoked ? null : digest(value),
        revokedAt: revoked ? '2026-01-01T00:00:00Z' : null,
      }),
      noSync: true,
    });
  }
  process.env.SESSION_SECRET = 'changed-session-key-for-permission-tests';
  for (const [credential, status] of [
    [legacyAgent, 200],
    [revokedAgent, 401],
  ] as const) {
    const response = await boardRoute(
      request(base + '/messages/' + msg.id, undefined, { authorization: 'Bearer ' + credential }),
    );
    assert.equal(response.status, status);
  }
  const read = () => boardRoute(request(base + '/messages/' + msg.id, undefined, agent));
  assert.equal((await read()).status, 200);
  const lookup = process.env.ACCOUNT_LOOKUP_KEY;
  delete process.env.ACCOUNT_LOOKUP_KEY;
  assert.equal((await read()).status, 503);
  process.env.ACCOUNT_LOOKUP_KEY = lookup;
  assert.equal((await read()).status, 200);
  for (let i = 0; i < 2; i++)
    assert.equal((await revoke(request('/api/agents/revoke', {}, agent))).status, 200);
  assert.equal((await read()).status, 401);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {accountKey,createAccount} from './accounts.ts';
import { digest, equal, session, sessionUser, token, tokenUser, username } from './auth.ts';
import { readBytes } from './app.ts';

process.env.ACCOUNT_LOOKUP_KEY = process.env.SESSION_SECRET = 'test-only-secret-with-at-least-thirty-two-characters';

test('signed sessions reject tampering and expire', () => {
  const value = session('test-agent', 1_000_000);
  assert.equal(sessionUser(value, 1_000_001), 'test-agent');
  assert.equal(sessionUser(`${value}x`, 1_000_001), null);
  assert.equal(sessionUser(value, 1_000_000 + 31 * 86400_000), null);
  assert.equal(sessionUser('bad.input', 1_000_001), null);
});

test('agent tokens use unique secrets and validated account names', () => {
  const first = token('test-agent');
  assert.equal(tokenUser(first), 'test-agent');
  assert.notEqual(first, token('test-agent'));
  assert.notEqual(digest(first), first);
  assert.equal(tokenUser('gb_admin.invalid'), null);
  assert.equal(username('Test-Agent'), 'test-agent');
  assert.throws(() => username('test/agent'));
  assert.throws(() => username('admin'));
});

test('idempotent storage cannot overwrite an existing registration in a race', async () => {
  const records = new Map();
  const store = { async post(channel: string, input: {id: string,text: string}) { if (!records.has(input.id)) records.set(input.id, { text: input.text }); return records.get(input.id); } };
  const results = await Promise.allSettled([
    createAccount(store, { name: 'test-agent', tokenHash: 'first' }),
    createAccount(store, { name: 'test-agent', tokenHash: 'second' }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(JSON.parse(records.get(accountKey('test-agent')).text).tokenHash, 'first');
});

test('body limits also protect chunked requests and preserve binary files', async () => {
  const bytes = new Uint8Array([0, 255, 128, 13, 10]);
  const request = new Request('http://localhost/upload', { method: 'POST', body: bytes });
  assert.deepEqual(new Uint8Array(await readBytes(request, 10)), bytes);
  const oversized = new Request('http://localhost/upload', { method: 'POST', body: '123456' });
  await assert.rejects(readBytes(oversized, 5), /too large/);
});

test('a write-only legacy lookup key survives session signing key rotation', (t) => {
  const lookup = process.env.ACCOUNT_LOOKUP_KEY;
  t.after(() => {
    process.env.ACCOUNT_LOOKUP_KEY = lookup;
    delete process.env.SESSION_SIGNING_KEY;
  });
  const id = accountKey('existing-agent');
  const oldSession = session('existing-person');
  delete process.env.ACCOUNT_LOOKUP_KEY;
  process.env.SESSION_SIGNING_KEY = 'new-signing-key-independent-of-the-old-key';
  assert.equal(accountKey('existing-agent'), id);
  assert.equal(sessionUser(oldSession), null);
  assert.equal(sessionUser(session('existing-person')), 'existing-person');
});

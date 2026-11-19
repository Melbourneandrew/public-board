import test from 'node:test';
import assert from 'node:assert/strict';
import { accountKey, createAccount, digest, equal, passwordHash, session, sessionUser, token, tokenUser, username } from './auth.js';
import { readBytes } from './app.js';

process.env.SESSION_SECRET = 'test-only-secret-with-at-least-thirty-two-characters';

test('signed sessions reject tampering and expire', () => {
  const value = session('test-agent', 1_000_000);
  assert.equal(sessionUser(value, 1_000_001), 'test-agent');
  assert.equal(sessionUser(`${value}x`, 1_000_001), null);
  assert.equal(sessionUser(value, 1_000_000 + 31 * 86400_000), null);
  assert.equal(sessionUser('bad.input', 1_000_001), null);
});

test('passwords are salted and verified with a slow hash', async () => {
  const first = await passwordHash('a-long-test-password');
  const second = await passwordHash('a-long-test-password');
  assert.notEqual(first.hash, second.hash);
  assert.equal(equal(first.hash, (await passwordHash('a-long-test-password', first.salt)).hash), true);
  assert.equal(equal(first.hash, (await passwordHash('a-wrong-test-password', first.salt)).hash), false);
  await assert.rejects(passwordHash('short'));
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
  const store = { async post(channel, input) { if (!records.has(input.id)) records.set(input.id, { text: input.text }); return records.get(input.id); } };
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { SignJWT, generateKeyPair } from 'jose';
import { authorize, callback, readTransaction, signTransaction, vercelProfile, verifyIdentity } from './vercel-auth.js';

process.env.SESSION_SECRET = 'test-only-secret-with-at-least-thirty-two-characters';
process.env.VERCEL_APP_CLIENT_ID = 'test-client';

test('authorization binds state, nonce, callback and S256 to a signed HttpOnly transaction', async () => {
  const response = await authorize(new Request('https://example.com/api/auth/authorize'));
  const url = new URL(response.headers.get('location'));
  assert.equal(url.origin, 'https://vercel.com');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://example.com/api/auth/callback');
  assert.equal(url.searchParams.get('scope'), 'openid profile');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly; Secure; SameSite=Lax; Max-Age=600/);
  const value = cookie.split(';')[0].split('=')[1];
  const transaction = await readTransaction(value);
  assert.equal(transaction.state, url.searchParams.get('state'));
  assert.equal(transaction.nonce, url.searchParams.get('nonce'));
  await assert.rejects(readTransaction(`${value}tampered`));
});

test('callback rejects a mismatched browser state before exchanging a code', async () => {
  const signed = await signTransaction({ state: randomBytes(32).toString('base64url'), nonce: randomBytes(32).toString('base64url'), verifier: randomBytes(32).toString('base64url') });
  const response = await callback(new Request('https://example.com/api/auth/callback?state=attacker&code=never-exchange', { headers: { cookie: `__Host-public_board_oauth=${signed}` } }));
  assert.equal(response.status, 303);
  assert.match(response.headers.get('location'), /login\?error=signin_failed$/);
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
  assert.ok(!response.headers.get('set-cookie').includes('__Host-public_board='));
});

test('Vercel identity verification requires signature, issuer, audience and nonce', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const make = (changes = {}) => new SignJWT({ sub: 'person-123', nonce: 'expected-nonce', preferred_username: 'someone', ...changes }).setProtectedHeader({ alg: 'RS256' }).setIssuer('https://vercel.com').setAudience('test-client').setIssuedAt().setExpirationTime('5m').sign(privateKey);
  assert.equal((await verifyIdentity(await make(), 'expected-nonce', 'test-client', publicKey)).sub, 'person-123');
  await assert.rejects(verifyIdentity(await make(), 'wrong-nonce', 'test-client', publicKey));
  await assert.rejects(verifyIdentity(await make(), 'expected-nonce', 'another-client', publicKey));
  const wrongIssuer = await new SignJWT({ sub: 'person-123', nonce: 'expected-nonce' }).setProtectedHeader({ alg: 'RS256' }).setIssuer('https://attacker.example').setAudience('test-client').setIssuedAt().setExpirationTime('5m').sign(privateKey);
  await assert.rejects(verifyIdentity(wrongIssuer, 'expected-nonce', 'test-client', publicKey));
});

test('a stable Vercel subject keeps its profile across username changes and concurrent sign-ins', async () => {
  const values = new Map();
  const store = {
    async posted(id) { if (!values.has(id)) throw Object.assign(new Error('missing'), { status: 404 }); return values.get(id); },
    async post(channel, input) { if (!values.has(input.id)) values.set(input.id, { text: input.text }); return values.get(input.id); },
  };
  const names = await Promise.all([
    vercelProfile(store, { sub: 'first-person', preferred_username: 'original' }),
    vercelProfile(store, { sub: 'first-person', preferred_username: 'renamed' }),
  ]);
  assert.equal(names[0], names[1]);
  assert.notEqual(await vercelProfile(store, { sub: 'another-person', preferred_username: 'original' }), names[0]);
});

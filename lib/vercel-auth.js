import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, createRemoteJWKSet, jwtVerify } from 'jose';
import { account, accountKey, cookie, digest, equal, secret, session } from './auth.js';
import { accounts } from './board.js';

const ISSUER = 'https://vercel.com';
const keys = createRemoteJWKSet(new URL('https://vercel.com/.well-known/jwks'));
const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' };
const random = () => randomBytes(32).toString('base64url');
const signingKey = () => new TextEncoder().encode(secret());
const originOf = (request) => process.env.SITE_URL || new URL(request.url).origin;
const secure = (request) => new URL(request.url).protocol === 'https:';
const transactionName = (request) => secure(request) ? '__Host-public_board_oauth' : 'public_board_oauth_dev';

export function authConfigured() {
  return Boolean(process.env.VERCEL_APP_CLIENT_ID);
}

export function transactionCookie(request, value, clear = false) {
  return `${transactionName(request)}=${clear ? '' : value}; Path=/; HttpOnly; ${secure(request) ? 'Secure; ' : ''}SameSite=Lax; Max-Age=${clear ? 0 : 600}`;
}

export async function signTransaction(value) {
  return new SignJWT(value).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setIssuer('public-board').setAudience('vercel-oauth').setIssuedAt().setExpirationTime('10m').sign(signingKey());
}

export async function readTransaction(value) {
  const { payload } = await jwtVerify(value, signingKey(), { algorithms: ['HS256'], issuer: 'public-board', audience: 'vercel-oauth' });
  if (![payload.state, payload.nonce, payload.verifier].every((item) => typeof item === 'string' && /^[A-Za-z0-9_-]{43}$/.test(item))) throw new Error('Invalid sign-in transaction.');
  return payload;
}

export async function verifyIdentity(idToken, nonce, clientId, verificationKey = keys) {
  const { payload } = await jwtVerify(idToken, verificationKey, { algorithms: ['RS256'], issuer: ISSUER, audience: clientId, maxTokenAge: '10m' });
  if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 256 || !equal(payload.nonce, nonce) || (payload.azp && payload.azp !== clientId)) throw new Error('Invalid Vercel identity.');
  return payload;
}

export async function vercelProfile(store, identity) {
  const key = accountKey(`vercel:${identity.sub}`);
  try {
    const found = JSON.parse((await store.posted(key)).text);
    if (found.kind !== 'vercel' || found.subject !== identity.sub) throw new Error('Invalid account identity.');
    return found.name;
  } catch (error) { if (error.status !== 404) throw error; }
  const preferred = String(identity.preferred_username ?? 'member').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 20) || 'member';
  let name = `v-${preferred}-${digest(identity.sub).slice(0, 8)}`;
  // Account names reserved for Vercel cannot be claimed through agent signup.
  // An account created before this namespace existed is never taken over.
  if (await account(store, name)) name = `v-${randomBytes(14).toString('hex')}`;
  const message = await store.post('private/accounts', { id: key, noSync: true, text: JSON.stringify({ kind: 'vercel', subject: identity.sub, name, createdAt: new Date().toISOString() }) });
  const saved = JSON.parse(message.text);
  if (saved.kind !== 'vercel' || saved.subject !== identity.sub) throw new Error('Invalid account identity.');
  return saved.name;
}

export async function authorize(request) {
  if (!authConfigured()) return Response.json({ error: { code: 'auth_not_configured', message: 'Vercel sign-in has not been configured for this deployment.' } }, { status: 503, headers });
  const transaction = { state: random(), nonce: random(), verifier: random() };
  const url = new URL('https://vercel.com/oauth/authorize');
  url.search = new URLSearchParams({ client_id: process.env.VERCEL_APP_CLIENT_ID, redirect_uri: `${originOf(request)}/api/auth/callback`, response_type: 'code', scope: 'openid profile', state: transaction.state, nonce: transaction.nonce, code_challenge: createHash('sha256').update(transaction.verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
  return new Response(null, { status: 303, headers: { ...headers, location: url.href, 'set-cookie': transactionCookie(request, await signTransaction(transaction)) } });
}

export async function callback(request) {
  const url = new URL(request.url);
  const resultHeaders = new Headers({ ...headers });
  resultHeaders.append('set-cookie', transactionCookie(request, '', true));
  try {
    if (!authConfigured()) throw new Error('Vercel sign-in is not configured.');
    const signed = (request.headers.get('cookie') ?? '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${transactionName(request)}=`))?.slice(transactionName(request).length + 1);
    const transaction = await readTransaction(signed);
    if (!equal(url.searchParams.get('state'), transaction.state)) throw new Error('Invalid OAuth state.');
    if (url.searchParams.has('error')) throw new Error('Vercel sign-in was cancelled.');
    const code = url.searchParams.get('code');
    if (!code || code.length > 4096) throw new Error('Missing authorization code.');
    const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: process.env.VERCEL_APP_CLIENT_ID, redirect_uri: `${originOf(request)}/api/auth/callback`, code, code_verifier: transaction.verifier });
    const response = await fetch('https://api.vercel.com/login/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error('Vercel rejected the authorization code.');
    const tokens = await response.json();
    if (typeof tokens.id_token !== 'string') throw new Error('Missing Vercel identity token.');
    const identity = await verifyIdentity(tokens.id_token, transaction.nonce, process.env.VERCEL_APP_CLIENT_ID);
    const name = await vercelProfile(accounts(), identity);
    resultHeaders.append('set-cookie', cookie(session(name), { secure: secure(request) }));
    resultHeaders.set('location', `${originOf(request)}/`);
    return new Response(null, { status: 303, headers: resultHeaders });
  } catch (error) {
    console.error('Vercel sign-in failed', error.code ?? error.name);
    resultHeaders.set('location', `${originOf(request)}/login?error=signin_failed`);
    return new Response(null, { status: 303, headers: resultHeaders });
  }
}

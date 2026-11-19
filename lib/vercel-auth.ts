import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, createRemoteJWKSet, jwtVerify } from 'jose';
import {vercelProfile} from './accounts.ts';
export {vercelProfile} from './accounts.ts';
import type { JWTPayload, JWTVerifyGetKey } from 'jose';
import { cookie, equal, secret, session } from './auth.ts';
import { accounts } from './board.ts';

const ISSUER = 'https://vercel.com';
const keys = createRemoteJWKSet(new URL('https://vercel.com/.well-known/jwks'));
const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' };
const random = () => randomBytes(32).toString('base64url');
const signingKey = () => new TextEncoder().encode(secret());
const originOf = (request: Request) => process.env.SITE_URL || new URL(request.url).origin;
const secure = (request: Request) => new URL(request.url).protocol === 'https:';
const transactionName = (request: Request) => secure(request) ? '__Host-public_board_oauth' : 'public_board_oauth_dev';

export function authConfigured() {
  return Boolean(process.env.VERCEL_APP_CLIENT_ID!);
}

export function transactionCookie(request: Request, value: string, clear = false) {
  return `${transactionName(request)}=${clear ? '' : value}; Path=/; HttpOnly; ${secure(request) ? 'Secure; ' : ''}SameSite=Lax; Max-Age=${clear ? 0 : 600}`;
}

export async function signTransaction(value: JWTPayload) {
  return new SignJWT(value).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setIssuer('public-board').setAudience('vercel-oauth').setIssuedAt().setExpirationTime('10m').sign(signingKey());
}

export async function readTransaction(value: string | undefined) {
  const { payload } = await jwtVerify(value ?? '', signingKey(), { algorithms: ['HS256'], issuer: 'public-board', audience: 'vercel-oauth' });
  if (![payload.state, payload.nonce, payload.verifier].every((item) => typeof item === 'string' && /^[A-Za-z0-9_-]{43}$/.test(item))) throw new Error('Invalid sign-in transaction.');
  return payload;
}

export async function verifyIdentity(idToken: string, nonce: unknown, clientId: string, verificationKey: CryptoKey | JWTVerifyGetKey = keys) {
  const options = { algorithms: ['RS256'], issuer: ISSUER, audience: clientId, maxTokenAge: '10m' };
  const { payload } = typeof verificationKey === 'function' ? await jwtVerify(idToken, verificationKey, options) : await jwtVerify(idToken, verificationKey, options);
  if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 256 || !equal(payload.nonce, nonce) || (payload.azp && payload.azp !== clientId)) throw new Error('Invalid Vercel identity.');
  return payload;
}

export async function authorize(request: Request) {
  if (!authConfigured()) return Response.json({ error: { code: 'auth_not_configured', message: 'Vercel sign-in has not been configured for this deployment.' } }, { status: 503, headers });
  const transaction = { state: random(), nonce: random(), verifier: random() };
  const url = new URL('https://vercel.com/oauth/authorize');
  url.search = new URLSearchParams({ client_id: process.env.VERCEL_APP_CLIENT_ID!, redirect_uri: `${originOf(request)}/api/auth/callback`, response_type: 'code', scope: 'openid profile', state: transaction.state, nonce: transaction.nonce, code_challenge: createHash('sha256').update(transaction.verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
  return new Response(null, { status: 303, headers: { ...headers, location: url.href, 'set-cookie': transactionCookie(request, await signTransaction(transaction)) } });
}

export async function callback(request: Request) {
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
    const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: process.env.VERCEL_APP_CLIENT_ID!, redirect_uri: `${originOf(request)}/api/auth/callback`, code, code_verifier: String(transaction.verifier) });
    const response = await fetch('https://api.vercel.com/login/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error('Vercel rejected the authorization code.');
    const tokens = await response.json();
    if (typeof tokens.id_token !== 'string') throw new Error('Missing Vercel identity token.');
    const identity = await verifyIdentity(tokens.id_token, transaction.nonce, process.env.VERCEL_APP_CLIENT_ID!);
    const name = await vercelProfile(accounts(), identity);
    resultHeaders.append('set-cookie', cookie(session(name), { secure: secure(request) }));
    resultHeaders.set('location', `${originOf(request)}/`);
    return new Response(null, { status: 303, headers: resultHeaders });
  } catch (error) {
    console.error('Vercel sign-in failed', error instanceof Error ? error.name : 'unknown');
    resultHeaders.set('location', `${originOf(request)}/login?error=signin_failed`);
    return new Response(null, { status: 303, headers: resultHeaders });
  }
}

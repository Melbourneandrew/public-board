import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const COOKIE = '__Host-public_board';
export const SESSION_SECONDS = 60 * 60 * 24 * 30;
export const PRIVATE_ACCOUNTS = 'private/accounts';
export const ACCOUNT_CHANNEL = process.env.VERCEL_ENV === 'preview' ? PRIVATE_ACCOUNTS + '/preview' : PRIVATE_ACCOUNTS;

export function username(value: unknown) {
  const name = typeof value === 'string' ? value.toLowerCase().trim() : '';
  if (!/^[a-z][a-z0-9-]{2,31}$/.test(name)) throw new Error('Use 3–32 letters, numbers, or hyphens, starting with a letter.');
  if (['anonymous', 'system', 'admin', 'codex', 'accounts', 'global-board'].includes(name)) throw new Error('Choose another name.');
  return name;
}

export function secret() {
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) throw new Error('Sign-in is not configured.');
  return process.env.SESSION_SECRET;
}

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function equal(a: unknown, b: unknown) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function session(name: string, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ name, source: 'vercel', exp: Math.floor(now / 1000) + SESSION_SECONDS })).toString('base64url');
  return `${payload}.${createHmac('sha256', secret()).update(payload).digest('base64url')}`;
}

export function sessionUser(value: unknown, now = Date.now()) {
  if (typeof value !== 'string' || value.length > 1024) return null;
  const [payload, signature, extra] = value.split('.');
  if (!payload || !signature || extra || !equal(signature, createHmac('sha256', secret()).update(payload).digest('base64url'))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.source === 'vercel' && data.exp > Math.floor(now / 1000) && username(data.name) === data.name ? data.name : null;
  } catch { return null; }
}

export function token(name: string) {
  return `gb_${name}.${randomBytes(32).toString('base64url')}`;
}

export function tokenUser(value: unknown) {
  if (typeof value !== 'string' || value.length > 160) return null;
  const match = /^gb_([a-z][a-z0-9-]{2,31})\.([A-Za-z0-9_-]{43})$/.exec(value);
  return match?.[1] ?? null;
}

export function cookie(value: string, { clear = false, secure = true } = {}) {
  return `${secure ? COOKIE : 'public_board_dev'}=${clear ? '' : value}; Path=/; HttpOnly; ${secure ? 'Secure; ' : ''}SameSite=Lax; Max-Age=${clear ? 0 : SESSION_SECONDS}`;
}

export function readCookie(request: Request) {
  const pairs = (request.headers.get('cookie') ?? '').split(';').map((part) => part.trim());
  const name = new URL(request.url).protocol === 'https:' ? COOKIE : 'public_board_dev';
  return pairs.find((pair) => pair.startsWith(`${name}=`))?.slice(name.length + 1);
}

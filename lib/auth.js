import { createHash, createHmac, randomBytes, scrypt as derive, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(derive);
export const COOKIE = '__Host-global_board';
export const SESSION_SECONDS = 60 * 60 * 24 * 30;
export const ACCOUNT_CHANNEL = 'private/accounts';

export function username(value) {
  const name = typeof value === 'string' ? value.toLowerCase().trim() : '';
  if (!/^[a-z][a-z0-9-]{2,31}$/.test(name)) throw new Error('Use 3–32 letters, numbers, or hyphens, starting with a letter.');
  if (['anonymous', 'system', 'admin', 'codex', 'accounts', 'global-board'].includes(name)) throw new Error('Choose another name.');
  return name;
}

export function secret() {
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) throw new Error('Sign-in is not configured.');
  return process.env.SESSION_SECRET;
}

export const digest = (value) => createHash('sha256').update(value).digest('hex');
export const accountKey = (name) => `account-${createHmac('sha256', secret()).update(name).digest('hex')}`;
export function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function passwordHash(password, salt = randomBytes(16).toString('hex')) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw new Error('Use a password between 12 and 256 characters.');
  return { salt, hash: (await scrypt(password, salt, 64)).toString('hex') };
}

export function session(name, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ name, exp: Math.floor(now / 1000) + SESSION_SECONDS })).toString('base64url');
  return `${payload}.${createHmac('sha256', secret()).update(payload).digest('base64url')}`;
}

export function sessionUser(value, now = Date.now()) {
  if (typeof value !== 'string' || value.length > 1024) return null;
  const [payload, signature, extra] = value.split('.');
  if (!payload || !signature || extra || !equal(signature, createHmac('sha256', secret()).update(payload).digest('base64url'))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.exp > Math.floor(now / 1000) && username(data.name) === data.name ? data.name : null;
  } catch { return null; }
}

export function token(name) {
  return `gb_${name}.${randomBytes(32).toString('base64url')}`;
}

export function tokenUser(value) {
  if (typeof value !== 'string' || value.length > 160) return null;
  const match = /^gb_([a-z][a-z0-9-]{2,31})\.([A-Za-z0-9_-]{43})$/.exec(value);
  return match?.[1] ?? null;
}

export async function account(store, name) {
  try { return JSON.parse((await store.posted(accountKey(name))).text); }
  catch (error) { if (error.status === 404) return null; throw error; }
}

export async function createAccount(store, record) {
  const nonce = randomBytes(16).toString('hex');
  const message = await store.post(ACCOUNT_CHANNEL, { id: accountKey(record.name), text: JSON.stringify({ ...record, nonce, createdAt: new Date().toISOString() }), noSync: true });
  if (JSON.parse(message.text).nonce !== nonce) throw new Error('That name is already registered.');
  return record;
}

export function cookie(value, { clear = false, secure = true } = {}) {
  return `${secure ? COOKIE : 'global_board_dev'}=${clear ? '' : value}; Path=/; HttpOnly; ${secure ? 'Secure; ' : ''}SameSite=Lax; Max-Age=${clear ? 0 : SESSION_SECONDS}`;
}

export function readCookie(request) {
  const pairs = (request.headers.get('cookie') ?? '').split(';').map((part) => part.trim());
  const name = new URL(request.url).protocol === 'https:' ? COOKIE : 'global_board_dev';
  return pairs.find((pair) => pair.startsWith(`${name}=`))?.slice(name.length + 1);
}

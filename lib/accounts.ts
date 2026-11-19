import {createHmac,randomBytes} from 'node:crypto';
import type {JWTPayload} from 'jose';
import type {Board} from '@vercel/board';
import {ACCOUNT_CHANNEL,username} from './auth.ts';

function parseRecord(text: string): Record<string,unknown> {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid account record');
  return Object.fromEntries(Object.entries(value));
}
function lookupKey() {
  // Existing Vercel installations can keep their write-only historical lookup key in place.
  const value = process.env.ACCOUNT_LOOKUP_KEY ?? (process.env.SESSION_SIGNING_KEY ? process.env.SESSION_SECRET : undefined);
  if (!value || value.length < 32) throw new Error('Account lookup key is unavailable.');
  return value;
}

export interface AccountReader { posted(id: string): Promise<{text: string}> }
export interface AccountWriter { post(channel: string, input: {id: string, noSync: boolean, text: string}): Promise<{text: string}> }

export const accountKey = (name: string) => `account-${createHmac('sha256', lookupKey()).update(name).digest('hex')}`;
export async function account(store: AccountReader, name: string) {
  try { return parseRecord((await store.posted(accountKey(name))).text); }
  catch (error) { if (error instanceof Error && 'status' in error && error.status === 404) return null; throw error; }
}

export async function createAccount(store: AccountWriter, record: {name: string, tokenHash: string, kind?: string}) {
  const nonce = randomBytes(16).toString('hex');
  const message = await store.post(ACCOUNT_CHANNEL, { id: accountKey(record.name), text: JSON.stringify({ ...record, nonce, createdAt: new Date().toISOString() }), noSync: true });
  if (JSON.parse(message.text).nonce !== nonce) throw new Error('That name is already registered.');
  return record;
}

export async function vercelProfile(store: AccountReader & AccountWriter, identity: JWTPayload) {
  if (typeof identity.sub !== 'string' || !identity.sub) throw new Error('Missing subject');
  const key = accountKey(`vercel:${identity.sub}`);
  try {
    const found = parseRecord((await store.posted(key)).text);
    if (found.kind !== 'vercel' || found.subject !== identity.sub) throw new Error('Invalid account identity.');
    return username(found.name);
  } catch (error) { if (!(error instanceof Error && 'status' in error && error.status === 404)) throw error; }
  let preferred = String(identity.preferred_username ?? 'member').toLowerCase();
  try { preferred = username(preferred); } catch { preferred = 'member'; }
  if (preferred.startsWith('v-')) preferred = 'member';
  let name = preferred;
  for (let attempt = 0; ; attempt++) {
    const claim = await store.post(ACCOUNT_CHANNEL, {id: accountKey(name), noSync:true, text:JSON.stringify({kind:'profile',subject:identity.sub,name})});
    const owner = parseRecord(claim.text);
    if (owner.kind === 'profile' && owner.subject === identity.sub && owner.name === name) break;
    if (attempt >= 8) throw new Error('Profile allocation unavailable');
    name = preferred.slice(0,19) + '-' + randomBytes(6).toString('hex');
  }
  const message = await store.post(ACCOUNT_CHANNEL, { id: key, noSync: true, text: JSON.stringify({ kind: 'vercel', subject: identity.sub, name, createdAt: new Date().toISOString() }) });
  const saved = parseRecord(message.text);
  if (saved.kind !== 'vercel' || saved.subject !== identity.sub) throw new Error('Invalid account identity.');
  return username(saved.name);
}


export async function revokeAgent(store: Board, name: string) {
  const msg = await store.posted(accountKey(name));
  const record = parseRecord(msg.text);
  if (record.kind !== 'agent' || record.name !== name) throw new Error('Invalid agent record');
  if (record.revokedAt) return;
  await store.edit(msg.id, JSON.stringify({...record, revokedAt:new Date().toISOString()}));
}

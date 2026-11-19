import { board } from '@vercel/board';
import { ACCOUNT_CHANNEL } from './auth.js';

let instance;
export const team = () => instance ??= board();
export const accounts = () => team().as('accounts');

export function isPublicChannel(path) {
  return typeof path === 'string' && path.length <= 2048 && /^[a-z0-9_-]+(?:\/[a-z0-9_-]+)*$/.test(path) && path !== ACCOUNT_CHANNEL && !path.startsWith(`${ACCOUNT_CHANNEL}/`);
}

export function visitor(name) {
  const permissions = name ? ['read', 'post', 'react', 'label'] : ['read'];
  // All public channels and native channel paths are open. Only authentication
  // records are excluded, including lookups by ID, files, and event streams.
  return team().as(name ?? 'anonymous', { can: { '*': permissions, [ACCOUNT_CHANNEL]: [], [`${ACCOUNT_CHANNEL}/`]: [] } });
}

// A supplied x-board-profile can never change the authenticated account.
export async function forward(name, path, init = {}) {
  return visitor(name).request(path, { ...init, as: name ?? 'anonymous' });
}

import { board } from '@vercel/board';
import { ACCOUNT_CHANNEL, PRIVATE_ACCOUNTS } from './auth.ts';

let instance: ReturnType<typeof board> | undefined;
export const team = () => instance ??= board(process.env.BOARD_NAME ? { name: process.env.BOARD_NAME } : {});
export const accounts = () => team().as('accounts', {can: {'*': [], [ACCOUNT_CHANNEL]: ['read', 'post']}});

export function isPublicChannel(path: unknown) {
  return typeof path === 'string' && path.length <= 2048 && /^[a-z0-9_-]+(?:\/[a-z0-9_-]+)*$/.test(path) && path !== PRIVATE_ACCOUNTS && !path.startsWith(`${PRIVATE_ACCOUNTS}/`);
}

export function visitor(name: string | null) {
  const permissions: ('read' | 'post' | 'react' | 'label')[] = name ? ['read', 'post', 'react', 'label'] : ['read'];
  // All public channels and native channel paths are open. Only authentication
  // records are excluded, including lookups by ID, files, and event streams.
  const can: Record<string, typeof permissions> = { '*': permissions, [PRIVATE_ACCOUNTS]: [], [`${PRIVATE_ACCOUNTS}/`]: [] };
  if (process.env.VERCEL_ENV === 'preview') {
    can['*'] = ['read'];
    const channel = process.env.PREVIEW_WRITE_CHANNEL;
    if (channel && isPublicChannel(channel)) can[channel] = permissions;
  }
  return team().as(name ?? 'anonymous', { can });
}

// A supplied x-board-profile can never change the authenticated account.
export async function forward(name: string | null, path: string, init: Parameters<ReturnType<typeof board>["request"]>[1] = {}) {
  return visitor(name).request(path, { ...init, as: name ?? 'anonymous' });
}

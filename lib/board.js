import { board } from '@vercel/board';

let instance;
export const team = () => instance ??= board({ team: 'team_y1lhuKYUWHiLJWkVgaic3jrU' });
export const accounts = () => team().as('accounts');
export function visitor(name) {
  return team().as(name ?? 'anonymous', { can: { 'global/': name ? ['read', 'post', 'react', 'label'] : ['read'] } });
}

// A supplied x-board-profile can never change the authenticated account.
export async function forward(name, path, init = {}) {
  return visitor(name).request(path, { ...init, as: name ?? 'anonymous' });
}

import { cookies } from 'next/headers';
import { COOKIE, sessionUser } from './auth.ts';
export async function browserSession() {
  const jar = await cookies();
  return sessionUser(jar.get(COOKIE)?.value ?? (process.env.NODE_ENV === 'development' ? jar.get('public_board_dev')?.value : undefined));
}

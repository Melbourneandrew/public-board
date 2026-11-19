import { redirect } from 'next/navigation';
import { browserSession } from '../../lib/browser-session';
export default async function Account() {
  const name = await browserSession();
  if (!name) redirect('/login');
  return <main><a href="/">back to board</a><h1>@{name}</h1><form method="post" action="/api/auth/logout"><button>Sign out</button></form></main>;
}

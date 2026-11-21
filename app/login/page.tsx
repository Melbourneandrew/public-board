import { redirect } from 'next/navigation';
import { browserSession } from '../../lib/browser-session';
export default async function Login({searchParams}: {searchParams:Promise<{error?:string}>}) {
  if (await browserSession()) redirect('/');
  if (!process.env.VERCEL_APP_CLIENT_ID) return <main style={{ padding: '2rem' }}>Sign-in is unavailable on this deployment. <a href="/">Back to board</a></main>;
  if (!(await searchParams).error) redirect('/api/auth/authorize');
  return <main style={{ padding: '2rem' }}><p>Sign-in could not be completed.</p><a href="/api/auth/authorize">Try again</a></main>;
}

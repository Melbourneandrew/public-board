import Link from 'next/link';
import { redirect } from 'next/navigation';
import { browserSession } from '../../lib/browser-session';
import styles from './account.module.css';

export const metadata = { title: 'account · The Public Board' };

export default async function Account() {
  const name = await browserSession();
  if (!name) redirect('/login');

  return (
    <main className={styles.page}>
      <nav className={styles.nav} aria-label="Board links">
        <Link href="/" className={styles.back}><span aria-hidden="true">←</span> back to board</Link>
        <a href="/skill.md">agents</a>
        <a href="https://github.com/Melbourneandrew/public-board">github</a>
      </nav>
      <h1 className={styles.title}>account</h1>
      <div className={styles.row}>
        <span className={styles.handle}>@{name}</span>
        <form method="post" action="/api/auth/logout">
          <button type="submit">sign out</button>
        </form>
      </div>
    </main>
  );
}

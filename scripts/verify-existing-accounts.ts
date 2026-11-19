import assert from 'node:assert/strict';
import { accounts } from '../lib/board.ts';
import { accountKey } from '../lib/accounts.ts';

// Read-only rollout check. Use the linked production project identity so Board
// resolves idempotency keys in the same namespace as the deployed app.
const store = accounts();
let before: string | undefined;
let verified = 0;
do {
  const page = await store.threads({ channel: 'private/accounts', limit: 100, before });
  for (const { message } of page.threads) {
    const record = JSON.parse(message.text);
    const lookup = record.kind === 'vercel' ? 'vercel:' + record.subject : record.name;
    assert.equal(typeof lookup, 'string');
    const existing = await store.posted(accountKey(lookup));
    assert.equal(existing.id, message.id, 'Historical account lookup changed');
  }
  verified += page.threads.length;
  before = page.older ?? undefined;
} while (before);
assert.ok(verified, 'Expected existing production accounts');
console.log('Historical account addresses verified:', verified);

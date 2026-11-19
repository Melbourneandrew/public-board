import assert from 'node:assert/strict';
import { accounts } from '../lib/board.ts';
import { accountKey } from '../lib/accounts.ts';

// Read-only rollout check. Use the linked production project identity so Board
// resolves idempotency keys in the same namespace as the deployed app.
const store = accounts();
let before: string | undefined;
let verified = 0;
let revokedUserFixtures = 0;
do {
  const page = await store.threads({ channel: 'private/accounts', limit: 100, before });
  for (const { message } of page.threads) {
    const record = JSON.parse(message.text);
    // User-authored QA fixtures use the operator's Board idempotency namespace.
    // They were already revoked and never issued through the production app.
    if (message.by.actor.startsWith('vercel:user:') && record.name?.startsWith('qa-') && record.revokedAt) {
      revokedUserFixtures++;
      continue;
    }
    const lookup = record.kind === 'vercel' ? 'vercel:' + record.subject : record.name;
    assert.equal(typeof lookup, 'string');
    const existing = await store.posted(accountKey(lookup));
    assert.equal(existing.id, message.id, 'Historical account lookup changed');
    verified++;
  }
  before = page.older ?? undefined;
} while (before);
assert.ok(verified, 'Expected existing production accounts');
console.log('Historical account addresses verified:', verified);
console.log('Previously revoked operator QA fixtures:', revokedUserFixtures);

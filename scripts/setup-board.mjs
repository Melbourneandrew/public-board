import { readFile } from 'node:fs/promises';
import { board } from '@vercel/board';

// Run as a team member after `vercel login` and `vercel link`.
// Deployment credentials cannot administer the team's Board grants.
const linked = JSON.parse(await readFile(new URL('../.vercel/project.json', import.meta.url), 'utf8'));
if (!linked.orgId || !linked.projectId) throw new Error('Link this checkout to your Vercel project with vercel link first.');
const team = board({ team: linked.orgId }).as('setup');
await team.me();
for (const path of ['general', 'help', 'ideas']) await team.createChannel(path);
const grants = await team.grants();
let accountsExist = false;
let after;
do {
  const page = await team.channels({ limit: 500, ...(after ? { after } : {}) });
  accountsExist ||= page.channels.some((channel) => channel.path === 'private/accounts');
  after = page.next;
} while (after);
if (accountsExist) {
  const protectedAccounts = grants.some((grant) => grant.principals.some((principal) => principal.kind === 'everyone') && ['private/accounts', 'private/accounts/'].some((path) => Array.isArray(grant.can[path]) && grant.can[path].length === 0));
  if (!protectedAccounts) throw new Error('The existing private/accounts channel is not protected. Protect its Board grants before enabling registration.');
} else {
  await team.createChannel('private/accounts', { private: true });
}

const can = { '*': ['read', 'post', 'react', 'label'], 'private/accounts': ['read', 'post'] };
const existing = grants.find((grant) => grant.principals.some((principal) => principal.kind === 'project' && principal.projectId === linked.projectId && principal.environments?.includes('production')) && JSON.stringify(grant.can) === JSON.stringify(can));
if (!existing) {
  await team.createGrant({ principals: [{ kind: 'project', project: linked.projectId, environments: ['production'] }], can });
}
console.log(`Board setup complete for ${linked.projectName ?? linked.projectId}. Public channels: general, help, ideas.`);

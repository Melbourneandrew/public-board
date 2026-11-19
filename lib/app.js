import { inspector } from '@vercel/board/inspect';
import { accounts, forward, isPublicChannel, visitor } from './board.js';
import { account, createAccount, cookie, digest, equal, readCookie, session, sessionUser, token, tokenUser, username } from './auth.js';
import { accountPage, agentSkill, authPage, escape } from './pages.js';
import { authorize, callback } from './vercel-auth.js';

const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'x-frame-options': 'DENY' };
const limits = new Map();
const json = (value, status = 200) => Response.json(value, { status, headers: HEADERS });
const html = (body, status = 200) => new Response(body, { status, headers: { ...HEADERS, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" } });
const fail = (status, message, code = 'forbidden') => json({ error: { code, message } }, status);
const redirect = (request, path, setCookie) => new Response(null, { status: 303, headers: { ...HEADERS, location: new URL(path, request.url).href, ...(setCookie ? { 'set-cookie': setCookie } : {}) } });
const secure = (request) => new URL(request.url).protocol === 'https:';

function agentDiscovery(requestOrigin) {
  const origin = process.env.SITE_URL || requestOrigin;
  return {
    name: 'The Public Board',
    description: 'A public Vercel Board for people and agents. Register without email or browser login.',
    instructions: `${origin}/skill.md`,
    board_url: `${origin}/api/board`,
    registration: {
      url: `${origin}/api/agents/register`,
      method: 'POST',
      content_type: 'application/json',
      body: { name: 'your-unique-agent-name' },
      name_rules: '3–32 letters, digits, or hyphens, starting with a letter. Choose a unique name.',
      response: 'Save access_token securely; it is shown once. Use Authorization: Bearer <access_token>.',
    },
    cli: 'Set BOARD_URL to board_url and BOARD_TOKEN to access_token; run npx @vercel/board@0.52.0 whoami --json.',
    human_signup: `${origin}/register`,
  };
}

const authGate = `
const signup = () => location.assign('/login');
document.addEventListener('focusin', (event) => {
  if (event.target.closest('.composer, .new-channel')) signup();
}, true);
document.addEventListener('click', (event) => {
  if (event.target.closest('.composer, .new-channel, .reaction')) {
    event.preventDefault();
    event.stopImmediatePropagation();
    signup();
  }
}, true);
const originalFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const response = await originalFetch(...args);
  const input = args[0];
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.origin);
  const method = (args[1]?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (url.origin === location.origin && url.pathname.startsWith('/board') && method !== 'GET' && response.status === 401) signup();
  return response;
};
`;

const accountControlsScript = `
const controls = document.getElementById('account-controls');
const root = document.getElementById('root');
function mountControls() {
  const header = root.querySelector('.main > .header');
  if (!header) { controls.hidden = true; return; }
  if (controls.parentNode !== header) header.append(controls);
  controls.hidden = false;
}
new MutationObserver(mountControls).observe(root, { childList: true, subtree: true });
mountControls();
`;

function limited(request, bucket, maximum) {
  const ip = request.headers.get('x-vercel-forwarded-for') ?? request.headers.get('x-forwarded-for') ?? 'local';
  const key = `${bucket}:${ip.split(',')[0]}:${Math.floor(Date.now() / 60_000)}`;
  if (limits.size > 4096) limits.clear();
  const count = (limits.get(key) ?? 0) + 1;
  limits.set(key, count);
  return count > maximum;
}

export async function readBytes(request, max = 8192) {
  if (Number(request.headers.get('content-length')) > max) throw new Error('Request is too large.');
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  let length = 0;
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > max) { await reader.cancel(); throw new Error('Request is too large.'); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export const smallBody = async (request, max) => (await readBytes(request, max)).toString('utf8');

async function identity(request) {
  const authorization = request.headers.get('authorization');
  if (authorization !== null) {
    const value = /^Bearer (.+)$/i.exec(authorization)?.[1];
    const name = tokenUser(value);
    if (!name) throw new Error('Invalid access token.');
    const record = await account(accounts(), name);
    if (record?.kind !== 'agent' || !record.tokenHash || !equal(record.tokenHash, digest(value))) throw new Error('Invalid or revoked access token.');
    return name;
  }
  return sessionUser(readCookie(request));
}

function sameOrigin(request) {
  const origin = request.headers.get('origin');
  const expected = process.env.SITE_URL || new URL(request.url).origin;
  return origin === expected || (process.env.NODE_ENV !== 'production' && origin === new URL(request.url).origin);
}

async function registerAgent(request) {
  if (limited(request, 'agent-register', 6)) return fail(429, 'Too many registrations. Try again in a minute.', 'rate_limited');
  if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) return fail(415, 'Send application/json.', 'invalid_request');
  try {
    const body = JSON.parse(await smallBody(request));
    const name = username(body.name);
    if (name.startsWith('v-')) return fail(400, 'Names beginning v- are reserved for Vercel accounts.', 'reserved_name');
    if (await account(accounts(), name)) return fail(409, 'That name is already registered. Choose a unique name.', 'name_taken');
    const accessToken = token(name);
    await createAccount(accounts(), { name, kind: 'agent', tokenHash: digest(accessToken) });
    const origin = process.env.SITE_URL || new URL(request.url).origin;
    return json({ name, access_token: accessToken, token_type: 'Bearer', board_url: `${origin}/api/board`, channels: ['general', 'ideas', 'help'], instructions: `Save this token now; it is only shown once. Set BOARD_URL=${origin}/api/board and BOARD_TOKEN to this token. Then run npx @vercel/board@0.52.0 whoami --json. Guide: ${origin}/skill.md` }, 201);
  } catch (error) {
    if (/already registered/.test(error.message)) return fail(409, error.message, 'name_taken');
    if (error instanceof SyntaxError || /Use |Choose |too large/.test(error.message)) return fail(400, error.message, 'invalid_request');
    console.error('Agent registration failed', error.code ?? error.name);
    return fail(503, 'Registration is temporarily unavailable.', 'unavailable');
  }
}

async function boardAPI(request, name) {
  const url = new URL(request.url);
  const path = url.pathname.slice('/api/board'.length) || '/';
  if (!['GET', 'HEAD', 'POST'].includes(request.method)) return fail(405, 'Use GET or POST.', 'method_not_allowed');
  if (!['GET', 'HEAD'].includes(request.method)) {
    if (!name) return json({ error: { code: 'authentication_required', message: 'Register or sign in to write.' }, registration: agentDiscovery(url.origin) }, 401);
    if (!request.headers.has('authorization') && !sameOrigin(request)) return fail(403, 'Use the board on its own site.');
  }
  if (/(^|\/)\.\.?($|\/)|\\|%2e|%2f|%5c/i.test(path)) return fail(400, 'Invalid path.', 'bad_path');
  const headers = {};
  for (const key of ['content-type', 'accept', 'x-board-filename']) {
    const value = request.headers.get(key);
    if (value) headers[key] = value;
  }
  let body;
  if (request.method === 'POST') {
    try {
      // The native inspector accepts files too. Bound buffering before forwarding.
      body = new Uint8Array(await readBytes(request, path === '/attachments' ? 4_000_000 : 65_536));
    } catch { return fail(413, 'Request body is too large.', 'too_large'); }
    if (path !== '/attachments') {
      let input;
      try { input = body.length ? JSON.parse(Buffer.from(body).toString('utf8')) : {}; }
      catch { return fail(400, 'Send valid JSON.', 'invalid_request'); }
      if (!input || typeof input !== 'object' || Array.isArray(input)) return fail(400, 'Send a JSON object.', 'invalid_request');
      const channels = [input.channel, ...(path === '/channels' ? [input.path] : []), ...(path === '/tasks/batch' && Array.isArray(input.tasks) ? input.tasks.map((task) => task?.channel) : [])].filter((value) => value !== undefined);
      for (const channel of channels) {
        if (!isPublicChannel(channel)) return fail(400, 'Use a Vercel Board channel path: lowercase letters, digits, hyphens, or underscores, with optional slash-separated groups. private/accounts is reserved for authentication.', 'invalid_channel');
      }
    }
  }
  const response = await forward(name, `${path}${url.search}`, { method: request.method, headers, ...(body ? { body } : {}), signal: request.signal });
  if (path === '/' && response.ok) {
    const discovery = await response.json();
    const boardURL = `${process.env.SITE_URL || url.origin}/api/board`;
    return json({ ...discovery, url: boardURL, audience: boardURL, sync: [] });
  }
  return new Response(response.body, { status: response.status, headers: { ...HEADERS, 'content-type': response.headers.get('content-type') ?? 'application/json' } });
}

async function boardPage(request, name) {
  const url = new URL(request.url);
  if (url.pathname === '/board' || url.pathname.startsWith('/board/')) {
    if (request.headers.get('x-inspect-token') !== 'page') return fail(403, 'Use the board interface.');
    const site = request.headers.get('sec-fetch-site');
    if (site !== null && site !== 'same-origin') return fail(403, 'Use the board on its own site.');
    const target = new URL(request.url);
    target.pathname = `/api/board${url.pathname.slice('/board'.length)}`;
    const forwarded = new Request(target, request);
    return boardAPI(forwarded, name);
  }
  const handle = visitor(name);
  const inspect = inspector({ board: handle, basePath: '' });
  const response = await inspect(request);
  if (!(response.headers.get('content-type') ?? '').includes('text/html')) return response;
  let body = await response.text();
  // The session, not a visitor-controlled profile picker, selects the author.
  body = body.replace('<meta name="inspect-named" content="1">', '');
  const profile = name ? { name } : null;
  body = body.replace(/<meta name="inspect-profile"[^>]*>/, `<meta name="inspect-profile" content="${escape(JSON.stringify(profile))}">`);
  body = body.replace('<title>board</title>', '<title>The Public Board</title>');
  const origin = process.env.SITE_URL || url.origin;
  const links = `<nav id="account-controls" class="account-links" aria-label="Account" hidden>${name ? `<a href="/account" aria-label="Account: @${escape(name)}" title="@${escape(name)}">Account</a>` : '<a href="/login">Sign in</a>'}<a href="/skill.md">Agents</a></nav>`;
  body = body.replace('</head>', `<link rel="icon" href="/favicon.ico?v=646d94d88d9a" sizes="16x16 32x32 48x48"><link rel="alternate" type="text/markdown" href="/skill.md"><link rel="service-desc" type="application/json" href="/.well-known/agent.json"><meta name="agent-registration" content="POST ${escape(origin)}/api/agents/register with JSON {&quot;name&quot;:&quot;your-unique-agent-name&quot;}; receive access_token. Full instructions: /skill.md"><style>.account-links{display:flex;align-items:center;gap:12px;flex-shrink:0;margin-left:8px;font:inherit;color:var(--muted)}.account-links[hidden]{display:none}.account-links a:hover{color:var(--bright)}.whoami-wrap{display:none}.main>.header>.title{min-width:0;overflow:hidden;text-overflow:ellipsis}@media(max-width:600px){.account-links{gap:10px;margin-left:0;font-size:12px}.main>.header{gap:6px}.main>.header>.meta{display:none}.main>.header>.live{font-size:0;gap:0}}</style><script src="/account-controls.js" defer></script>${name ? '' : '<script src="/auth-gate.js" defer></script>'}</head>`);
  body = body.replace('<div id="root"></div>', `<div id="root"></div>${links}<noscript>The Public Board. <a href="/login">Sign in or create an account</a>. Agents can register with POST /api/agents/register and JSON {"name":"your-unique-agent-name"}. <a href="/skill.md">Agent instructions</a>.</noscript>`);
  const headers = new Headers(response.headers);
  headers.set('link', '</skill.md>; rel="alternate"; type="text/markdown", </.well-known/agent.json>; rel="service-desc"; type="application/json"');
  return new Response(body, { headers });
}

export async function application(request) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, '') || '/';
  try {
    if (path === '/api/agents/register' && request.method === 'POST') return registerAgent(request);
    if (path === '/api/auth/authorize' && request.method === 'GET') {
      if (limited(request, 'vercel-signin', 20)) return fail(429, 'Too many sign-in attempts. Try again in a minute.', 'rate_limited');
      return authorize(request);
    }
    if (path === '/api/auth/callback' && request.method === 'GET') return callback(request);
    if (path === '/api/auth/logout' && request.method === 'POST') {
      if (!sameOrigin(request)) return fail(403, 'Use the account page to sign out.');
      return redirect(request, '/', cookie('', { clear: true, secure: secure(request) }));
    }
    let name;
    try { name = await identity(request); } catch { return fail(401, 'Invalid or revoked access token.', 'invalid_token'); }
    if (path === '/api/agents/revoke' && request.method === 'POST') {
      if (!request.headers.has('authorization') || !name) return fail(401, 'Send your agent bearer token.', 'authentication_required');
      const store = accounts();
      const record = await account(store, name);
      const { accountKey } = await import('./auth.js');
      const message = await store.posted(accountKey(name));
      await store.edit(message.id, JSON.stringify({ ...record, tokenHash: null, revokedAt: new Date().toISOString() }));
      return json({ revoked: true });
    }
    if (path === '/api/board' || path.startsWith('/api/board/')) return await boardAPI(request, name);
    if (path === '/board' || path.startsWith('/board/')) return await boardPage(request, name);
    if (request.method !== 'GET' && request.method !== 'HEAD') return fail(405, 'Method not allowed.', 'method_not_allowed');
    if (path === '/.well-known/agent.json' || (path === '/' && request.headers.get('accept')?.includes('application/json'))) return json(agentDiscovery(url.origin));
    if (['/skill.md', '/llms.txt'].includes(path) || (path === '/' && /text\/(markdown|plain)/.test(request.headers.get('accept') ?? ''))) return new Response(agentSkill(process.env.SITE_URL || url.origin), { headers: { ...HEADERS, 'content-type': 'text/markdown; charset=utf-8' } });
    if (path === '/auth-gate.js') return new Response(authGate, { headers: { ...HEADERS, 'content-type': 'text/javascript; charset=utf-8' } });
    if (path === '/account-controls.js') return new Response(accountControlsScript, { headers: { ...HEADERS, 'content-type': 'text/javascript; charset=utf-8' } });
    if (path === '/' || path === '/app.js' || path.startsWith('/c/') || path === '/tasks' || path === '/settings' || path.startsWith('/settings/')) return await boardPage(request, name);
    if (path === '/register' || path === '/login') return name ? redirect(request, '/') : html(await authPage(url.searchParams.has('error') ? 'Sign-in could not be completed. Please try again.' : ''));
    if (path === '/account') return name ? html(await accountPage(name)) : redirect(request, '/login');
    if (path === '/agents') return redirect(request, '/skill.md');
    if (path === '/robots.txt') return new Response('User-agent: *\nDisallow: /api/\nDisallow: /account\n', { headers: { 'content-type': 'text/plain' } });
    return html('<h1>Page not found</h1><a href="/">Go home</a>', 404);
  } catch (error) {
    console.error('Board request failed', error.code ?? error.name);
    return fail(503, 'The board is temporarily unavailable. Please try again.', 'unavailable');
  }
}

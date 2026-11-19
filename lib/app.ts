import { inspector } from '@vercel/board/inspect';
import { accounts, forward, isPublicChannel, visitor } from './board.ts';
import { cookie, digest, equal, readCookie, session, sessionUser, token, tokenUser, username } from './auth.ts';
import { agentSkill, escape } from './pages.ts';
import { account, createAccount, revokeAgent } from './accounts.ts';
import { authorize, callback } from './vercel-auth.ts';

const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'x-frame-options': 'DENY' };
const limits = new Map<string, number>();
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: HEADERS });
const html = (body: string, status = 200) => new Response(body, { status, headers: { ...HEADERS, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" } });
const fail = (status: number, message: string, code = 'forbidden') => json({ error: { code, message } }, status);
const redirect = (request: Request, path: string, setCookie?: string) => new Response(null, { status: 303, headers: { ...HEADERS, location: new URL(path, request.url).href, ...(setCookie ? { 'set-cookie': setCookie } : {}) } });
const secure = (request: Request) => new URL(request.url).protocol === 'https:';

function agentDiscovery(requestOrigin: string) {
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

function limited(request: Request, bucket: string, maximum: number) {
  const ip = request.headers.get('x-vercel-forwarded-for') ?? request.headers.get('x-forwarded-for') ?? 'local';
  const key = `${bucket}:${ip.split(',')[0]}:${Math.floor(Date.now() / 60_000)}`;
  if (limits.size > 4096) limits.clear();
  const count = (limits.get(key) ?? 0) + 1;
  limits.set(key, count);
  return count > maximum;
}

export async function readBytes(request: Request, max = 8192) {
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

export const smallBody = async (request: Request, max?: number) => (await readBytes(request, max)).toString('utf8');

class InvalidToken extends Error {}

async function identity(request: Request) {
  const authorization = request.headers.get('authorization');
  if (authorization !== null) {
    const value = /^Bearer (.+)$/i.exec(authorization)?.[1];
    const name = tokenUser(value);
    if (!name) throw new InvalidToken();
    const record = await account(accounts(), name);
    if (record?.kind !== 'agent' || record.name !== name || (record.revokedAt && !(request.method === 'POST' && new URL(request.url).pathname === '/api/agents/revoke')) || !record.tokenHash || !equal(record.tokenHash, digest(value!))) throw new InvalidToken();
    return name;
  }
  return sessionUser(readCookie(request));
}

function sameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  const expected = process.env.SITE_URL || new URL(request.url).origin;
  return origin === expected || (process.env.NODE_ENV !== 'production' && origin === new URL(request.url).origin);
}

async function registerAgent(request: Request) {
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
    if (/already registered/.test((error instanceof Error ? error.message : ''))) return fail(409, (error instanceof Error ? error.message : ''), 'name_taken');
    if (error instanceof SyntaxError || /Use |Choose |too large/.test((error instanceof Error ? error.message : ''))) return fail(400, (error instanceof Error ? error.message : ''), 'invalid_request');
    console.error('Agent registration failed', error instanceof Error ? error.name : 'unknown');
    return fail(503, 'Registration is temporarily unavailable.', 'unavailable');
  }
}

async function boardAPI(request: Request, name: string | null) {
  const url = new URL(request.url);
  const path = url.pathname.slice('/api/board'.length) || '/';
  if (!['GET', 'HEAD', 'POST'].includes(request.method)) return fail(405, 'Use GET or POST.', 'method_not_allowed');
  if (!['GET', 'HEAD'].includes(request.method)) {
    if (!name) return json({ error: { code: 'authentication_required', message: 'Register or sign in to write.' }, registration: agentDiscovery(url.origin) }, 401);
    if (!request.headers.has('authorization') && !sameOrigin(request)) return fail(403, 'Use the board on its own site.');
  }
  if (/(^|\/)\.\.?($|\/)|\\|%2e|%2f|%5c/i.test(path)) return fail(400, 'Invalid path.', 'bad_path');
  const headers: Record<string,string> = {};
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
      const channels = [input.channel, ...(path === '/channels' ? [input.path] : []), ...(path === '/tasks/batch' && Array.isArray(input.tasks) ? input.tasks.map((task: {channel?: unknown} | null) => task?.channel) : [])].filter((value) => value !== undefined);
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

async function boardPage(request: Request, name: string | null) {
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
  const shareImage = 'https://the-public-board.vercel.app/opengraph-image.png';
  const shareDescription = 'An open message board for people and AI agents.';
  const shareImageAlt = 'Introducing the public board, with a white square logo and a channel list on black.';
  body = body.replace('</head>', `<meta property="og:title" content="The Public Board"><meta property="og:description" content="${shareDescription}"><meta property="og:type" content="website"><meta property="og:url" content="https://the-public-board.vercel.app/"><meta property="og:image" content="${shareImage}"><meta property="og:image:type" content="image/png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="${shareImageAlt}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="The Public Board"><meta name="twitter:description" content="${shareDescription}"><meta name="twitter:image" content="${shareImage}"><meta name="twitter:image:width" content="1200"><meta name="twitter:image:height" content="630"><meta name="twitter:image:alt" content="${shareImageAlt}"></head>`);
  const links = `<nav id="account-controls" class="account-links" aria-label="Board links">${name ? `<a class="tool" href="/account" aria-label="Account: @${escape(name)}" title="@${escape(name)}">account</a>` : '<a class="tool" href="/login">Sign in</a>'}<a class="tool" href="/skill.md">agents</a><a class="tool" href="https://github.com/Melbourneandrew/public-board">github</a></nav>`;
  body = body.replace('</head>', `<link rel="icon" href="/favicon.ico?v=646d94d88d9a" sizes="16x16 32x32 48x48"><link rel="alternate" type="text/markdown" href="/skill.md"><link rel="service-desc" type="application/json" href="/.well-known/agent.json"><meta name="agent-registration" content="POST ${escape(origin)}/api/agents/register with JSON {&quot;name&quot;:&quot;your-unique-agent-name&quot;}; receive access_token. Full instructions: /skill.md"><style>body:has(.account-links){display:flex;flex-direction:column;height:100dvh}body>.account-links+#root{flex:1;min-height:0}#root>.shell,#root>.boot{height:100%}.account-links{justify-content:flex-end;border-bottom:1px solid var(--hairline);display:flex;align-items:center;gap:2px;flex-shrink:0;margin-left:8px;font:inherit;color:var(--muted)}.account-links[hidden]{display:none}.account-links .tool{font-size:inherit}.whoami-wrap{display:none}.main>.header>.title{min-width:0;overflow:hidden;text-overflow:ellipsis}@media(max-width:600px){.account-links{gap:0;margin-left:0;font-size:12px}.main>.header{gap:6px}.main>.header>.meta{display:none}.main>.header>.live{font-size:0;gap:0}}</style></head>`);
  body = body.replace('<div id="root"></div>', `${links}<div id="root"></div><noscript>The Public Board. <a href="/login">Sign in or create an account</a>. Agents can register with POST /api/agents/register and JSON {"name":"your-unique-agent-name"}. <a href="/skill.md">Agent instructions</a>.</noscript>`);
  const headers = new Headers(response.headers);
  headers.set('link', '</skill.md>; rel="alternate"; type="text/markdown", </.well-known/agent.json>; rel="service-desc"; type="application/json"');
  return new Response(body, { headers });
}

type VisitorHandler = (request: Request, name: string | null) => Promise<Response>;
function withVisitor(handler: VisitorHandler) {
  return async (request: Request) => {
    try {
      return await handler(request, await identity(request));
    } catch (error) {
      if (error instanceof InvalidToken) return fail(401, 'Invalid or revoked access token.', 'invalid_token');
      console.error('Board request failed', error instanceof Error ? error.name : 'unknown');
      return fail(503, 'The board is temporarily unavailable.', 'unavailable');
    }
  };
}
export const boardRoute = withVisitor(boardAPI);
export const inspectorRoute = withVisitor(async (request, name) => {
  const url = new URL(request.url);
  if (url.pathname === '/') {
    const accept = request.headers.get('accept') ?? '';
    if (accept.includes('application/json')) return discoveryRoute(request);
    if (/text\/(markdown|plain)/.test(accept)) return guideRoute(request);
  }
  if (/^\/(?:$|app\.js$|board(?:\/|$)|c\/|tasks$|settings(?:\/|$))/.test(url.pathname)) return boardPage(request, name);
  return html('<h1>Page not found</h1><a href="/">Go home</a>', 404);
});
export function discoveryRoute(request: Request) {
  return json(agentDiscovery(new URL(request.url).origin));
}
export function guideRoute(request: Request) {
  return new Response(agentSkill(process.env.SITE_URL || new URL(request.url).origin), {headers: {...HEADERS, 'content-type':'text/markdown; charset=utf-8'}});
}
export function logout(request: Request) {
  if (!sameOrigin(request)) return fail(403, 'Use the account page to sign out.');
  return redirect(request, '/', cookie('', {clear:true, secure:secure(request)}));
}
export function startLogin(request: Request) {
  if (limited(request, 'vercel-signin', 20)) return fail(429, 'Too many sign-in attempts. Try again in a minute.', 'rate_limited');
  return authorize(request);
}
export { registerAgent, callback };
export const revoke = withVisitor(async (request, name) => {
  if (!request.headers.has('authorization') || !name) return fail(401, 'Send your agent bearer token.', 'authentication_required');
  await revokeAgent(accounts(), name);
  return json({ revoked:true });
});

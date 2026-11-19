export function GET() { return new Response('User-agent: *\nDisallow: /api/\nDisallow: /account\n'); }

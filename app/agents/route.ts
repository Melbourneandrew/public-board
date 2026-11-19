export function GET(request: Request) { return Response.redirect(new URL('/skill.md', request.url), 303); }

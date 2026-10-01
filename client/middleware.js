export default async function middleware(request) {
  const username = process.env.SAOS_AUTH_USER;
  const password = process.env.SAOS_AUTH_PASSWORD;
  if (!username || !password) return new Response('Login is not configured', { status: 503 });
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  const expected = `Basic ${btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))}`;
  const digest = async (value) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  const [actualHash, expectedHash] = await Promise.all([
    digest(request.headers.get('authorization') || ''), digest(expected),
  ]);
  let difference = 0;
  for (let i = 0; i < expectedHash.length; i++) difference |= actualHash[i] ^ expectedHash[i];
  if (difference) {
    return new Response('Authentication required', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="SAOS", charset="UTF-8"', 'Cache-Control': 'no-store' },
    });
  }
  return new Response(null, { headers: { 'x-middleware-next': '1', 'Cache-Control': 'no-store' } });
}

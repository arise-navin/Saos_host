import { createHash } from 'node:crypto';

export function instanceOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port
      || !/^[a-z0-9-]+\.service-now\.com$/i.test(url.hostname)
      || !['', '/'].includes(url.pathname) || url.search || url.hash) {
    throw new Error('Enter your https://<instance>.service-now.com URL.');
  }
  return url.origin;
}

export async function authenticateServiceNow({ instanceUrl, username, password }, fetcher = fetch) {
  const instance = instanceOrigin(instanceUrl);
  if (typeof username !== 'string' || !username.trim() || username.length > 200
      || /[\r\n:^]/.test(username) || typeof password !== 'string' || !password || password.length > 4096) {
    throw new Error('Enter your ServiceNow username and password.');
  }
  const login = username.trim();
  const url = new URL('/api/now/table/sys_user', instance);
  url.searchParams.set('sysparm_query', `user_name=${login}^active=true`);
  url.searchParams.set('sysparm_fields', 'sys_id,user_name');
  url.searchParams.set('sysparm_limit', '1');
  const response = await fetcher(url, {
    headers: { Authorization: `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}`, Accept: 'application/json' },
    redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('ServiceNow sign-in failed. Check your credentials and REST API access.');
  const user = (await response.json()).result?.[0];
  if (!user || !/^[a-f0-9]{32}$/i.test(user.sys_id) || user.user_name.toLowerCase() !== login.toLowerCase()) {
    throw new Error('ServiceNow could not verify this user. Check access to your user record.');
  }
  return {
    id: createHash('sha256').update(`${instance}\n${user.sys_id}`).digest('hex'),
    instance, username: user.user_name,
  };
}

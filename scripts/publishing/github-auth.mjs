import { createPrivateKey, sign } from 'node:crypto';

const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

export async function installationToken(env, fetchImpl = fetch) {
  const { PUBLISH_GITHUB_APP_ID: app, PUBLISH_GITHUB_APP_PRIVATE_KEY: pem, PUBLISH_GITHUB_INSTALLATION_ID: installation } = env;
  if (!app || !pem || !/^\d+$/.test(installation ?? '')) throw new Error('Publishing GitHub App is not configured.');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ typ: 'JWT', alg: 'RS256' })}.${encode({ iat: now - 60, exp: now + 540, iss: app })}`;
  const key = createPrivateKey(pem.replace(/\\n/g, '\n'));
  const jwt = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), key).toString('base64url')}`;
  const response = await fetchImpl(`https://api.github.com/app/installations/${installation}/access_tokens`, {
    method: 'POST', signal: AbortSignal.timeout(15000), redirect: 'error',
    headers: githubHeaders(jwt),
  });
  if (!response.ok) throw new Error(`GitHub App authentication failed (${response.status}).`);
  const result = await response.json();
  if (typeof result.token !== 'string' || !result.token) throw new Error('GitHub App returned no installation token.');
  return result.token;
}

export const githubHeaders = (token) => ({
  accept: 'application/vnd.github+json', authorization: `Bearer ${token}`,
  'x-github-api-version': '2022-11-28', 'content-type': 'application/json',
  'user-agent': 'intelleo-editorial',
});

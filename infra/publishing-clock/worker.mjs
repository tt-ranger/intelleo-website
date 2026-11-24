import { installationToken, githubHeaders } from '../../scripts/publishing/github-auth.mjs';

export default {
  async scheduled(event, env) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY)) throw new Error('Invalid publishing repository.');
    const token = await installationToken(env);
    const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/dispatches`, {
      method: 'POST', headers: githubHeaders(token), redirect: 'error', signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ event_type: 'editorial-tick', client_payload: { tick: new Date(event.scheduledTime).toISOString() } }),
    });
    if (!response.ok) throw new Error(`Editorial dispatch failed (${response.status}).`);
  },
};

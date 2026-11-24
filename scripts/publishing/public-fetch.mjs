import { lookup } from 'node:dns';
import { isIP } from 'node:net';
import { Agent, fetch } from 'undici';
import ipaddr from 'ipaddr.js';

export function publicUrl(value) {
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port
      || !hostname.includes('.') || isIP(hostname) || /(?:^|\.)(localhost|local|internal|test|invalid)$/.test(hostname)) {
    throw new Error('Expected a public HTTP(S) URL.');
  }
  return url;
}

const dispatcher = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      lookup(hostname, { all: true, family: options.family || 0 }, (error, addresses) => {
        if (error) return callback(error);
        if (!addresses.length || addresses.some(({ address }) => ipaddr.process(address).range() !== 'unicast')) {
          return callback(new Error('Publisher resolves to a non-public address.'));
        }
        if (options.all) return callback(null, addresses);
        const { address, family } = addresses[0];
        callback(null, address, family);
      });
    },
  },
});

export const CRAWLER = 'IntelleoEditorial/1.0 (+https://www.intelleo.in)';
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

async function readBody(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return Buffer.concat(chunks).toString('utf8');
      size += value.byteLength;
      if (size > limit) throw new Error('Publisher response exceeds the configured size limit.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function fetchPublic(value, { accept = 'text/html', limit = 1500000, signal = AbortSignal.timeout(9000) } = {}) {
  let url = publicUrl(value);
  for (let hops = 0; hops <= 4; hops++) {
    const response = await fetch(url, {
      dispatcher, signal, redirect: 'manual', headers: { accept, 'user-agent': CRAWLER },
    });
    const location = response.headers.get('location');
    if (REDIRECTS.has(response.status) && location) {
      await response.body?.cancel();
      url = publicUrl(new URL(location, url));
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      return { ok: false, status: response.status, url: url.href, headers: response.headers, text: async () => '' };
    }
    const body = await readBody(response, limit);
    return { ok: true, status: response.status, url: url.href, headers: response.headers, text: async () => body };
  }
  throw new Error('Too many publisher redirects.');
}

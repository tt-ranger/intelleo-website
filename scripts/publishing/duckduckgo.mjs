import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER = 'duckduckgo-mcp-server==0.7.0';
const MAX_RESULTS = 12;

export function duckDuckGoUrls(result) {
  if (result.isError) throw new Error('DuckDuckGo MCP reported a search error.');
  const values = [];
  for (const row of result.structuredContent?.results ?? []) {
    if (typeof row?.url === 'string') values.push(row.url);
  }
  const blocks = (result.content ?? []).filter(({ type }) => type === 'text').map(({ text }) => text);
  if (typeof result.structuredContent?.result === 'string') blocks.push(result.structuredContent.result);
  for (const block of blocks) {
    if (/^(search failed|error:|an error occurred)/i.test(block.trim())) {
      throw new Error('DuckDuckGo MCP search failed.');
    }
    for (const match of block.matchAll(/^\s*URL:\s*(\S+)\s*$/gim)) values.push(match[1]);
  }
  return [...new Set(values.filter((value) => /^https?:\/\//i.test(value)))].slice(0, MAX_RESULTS);
}

export async function withDuckDuckGo(work) {
  const client = new Client({ name: 'intelleo-editorial', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: 'uvx',
    args: ['--from', SERVER, 'duckduckgo-mcp-server'],
    cwd: tmpdir(),
    // Keep publisher credentials out of the search subprocess.
    env: { DDG_REF_URL_THRESHOLD: '0', ...(process.env.UV_CACHE_DIR && { UV_CACHE_DIR: process.env.UV_CACHE_DIR }) },
    stderr: 'ignore',
  });
  try {
    await client.connect(transport, { timeout: 45000 });
    return await work(async (query) => {
      const result = await client.callTool(
        { name: 'search', arguments: { query, max_results: MAX_RESULTS } },
        undefined, { timeout: 20000 },
      );
      return duckDuckGoUrls(result);
    });
  } finally {
    await client.close();
  }
}

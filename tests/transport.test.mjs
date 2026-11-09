// The MCP transport wiring, offline: no SAP, no credentials.
//
// Pins the failure that made the server work exactly once per start. A
// StreamableHTTPServerTransport accepts a single `initialize`; sharing one instance
// across requests answers the first client and then returns HTTP 500 with an empty
// body to every reconnect -- a CLI restart, a new session, a health probe. The server
// therefore builds a fresh Server + transport per request, and this test would fail if
// anyone hoists them back out of the handler.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const TOOLS = [{ name: 'adt_search', description: 'x', inputSchema: { type: 'object' } }];

/** The same per-request construction server.mjs uses. */
function createMcpServer() {
  const mcp = new Server({ name: 'sap-adt', version: '0.1.0' }, { capabilities: { tools: {} } });
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  mcp.setRequestHandler(CallToolRequestSchema, async () => ({ content: [] }));
  return mcp;
}

async function startServer() {
  const server = http.createServer(async (req, res) => {
    const mcp = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close().catch(() => {});
      mcp.close().catch(() => {});
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(e?.message));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}/mcp` };
}

const rpc = (url, body) =>
  fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  });

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  },
};

test('initialize succeeds repeatedly, not just the first time', async () => {
  const { server, url } = await startServer();
  try {
    for (const attempt of [1, 2, 3]) {
      const res = await rpc(url, INITIALIZE);
      assert.equal(
        res.status,
        200,
        `initialize #${attempt} returned ${res.status}; a shared transport would 500 from #2 on`
      );
      await res.text();
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('tools/list answers on a connection of its own', async () => {
  const { server, url } = await startServer();
  try {
    const res = await rpc(url, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /adt_search/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// The MCP plumbing, apart from the SAP logon so it can be tested end to end without a system:
// server identity and instructions, the two request handlers, and the HTTP gate in front of the
// Streamable HTTP transport (loopback Host/Origin, then the bearer token).

import fs from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { authFailure } from './auth.mjs';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const SERVER_INFO = Object.freeze({ name: 'sap-adt', title: 'SAP ADT (read-only)', version: pkg.version });

/** What a client is told at initialize: how to use this server well, in a few lines. */
export const INSTRUCTIONS = [
  'Read-only access to one SAP ABAP system through the ADT REST API. Nothing here can change the system.',
  'Start with adt_search to find an object, then adt_read_source / adt_object_info / adt_where_used on it; adt_package_tree lists a package.',
  'Package-wide scans (adt_clean_core_scan, adt_annotation_scan, adt_package_health) read one object per call to the system: name a package and keep the scope small.',
  'adt_value_help and adt_clean_core_scan need the Clean Core catalogue (npm run sync:catalog); without it they refuse rather than guess.',
  'Every answer states what it could not read (gaps). An empty answer is only "none" when the answer says it read everything.',
  'adt_customizing reads a closed list of configuration tables; adt_atc_run leaves an ATC result worklist, like the IDE does.',
].join('\n');

/**
 * A fresh Server PER REQUEST (stateless mode): a StreamableHTTPServerTransport accepts exactly one
 * `initialize`, so a shared instance answers the first client and fails every reconnect. Tools and
 * the ADT session are shared; only the protocol plumbing is per request.
 */
export function createMcpServer(tools) {
  const byName = new Map(tools.map((t) => [t.definition.name, t]));
  const mcp = new Server(SERVER_INFO, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map((t) => t.definition) }));
  mcp.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const tool = byName.get(request.params.name);
    if (!tool) throw new Error(`Unknown tool: ${request.params.name}`);
    try {
      // `extra` carries the cancellation signal and the progress token of this call.
      return await tool.handler(request.params.arguments ?? {}, { signal: extra?.signal, sendNotification: extra?.sendNotification, _meta: request.params._meta });
    } catch (e) {
      // A tool failure is a RESULT the model can read and act on ("not found", "refused"),
      // not a protocol error that looks like the server is broken (spec: isError).
      return { content: [{ type: 'text', text: `${e.name ?? 'Error'}: ${e.message}` }], isError: true };
    }
  });
  return mcp;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * DNS-rebinding protection, which the Streamable HTTP specification requires: a web page the
 * user visits can make the browser send requests to 127.0.0.1 under ITS OWN host name. The
 * Host header must name the loopback interface on this port, and an Origin -- sent by browsers,
 * absent from CLI clients -- must be loopback too. Returns the reason to refuse, or null.
 */
export function hostFailure(headers, port) {
  const host = String(headers?.host ?? '');
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(host);
  if (!m || !LOOPBACK.has(m[1].toLowerCase()) || Number(m[2]) !== Number(port)) return `Host '${host}' is not this loopback endpoint`;
  const origin = headers?.origin;
  if (origin !== undefined && origin !== 'null') {
    let hostname = null;
    try {
      hostname = new URL(origin).hostname;
    } catch {
      return `Origin '${origin}' is not a URL`;
    }
    if (!LOOPBACK.has(hostname.toLowerCase())) return `Origin '${origin}' is not loopback`;
  } else if (origin === 'null') return "Origin 'null' (an opaque browser context) is refused";
  return null;
}

/**
 * The HTTP request handler: path, then Host/Origin, then the bearer token, then the MCP
 * transport. `port()` is read per request (a test listens on an ephemeral port);
 * `onOpen`/`onClose` let the caller count requests in flight.
 */
export function createRequestHandler({ tools, token, port, log = (m) => process.stderr.write(`${m}\n`), onOpen = () => {}, onClose = () => {} }) {
  return async (req, res) => {
    if (!req.url?.startsWith('/mcp')) {
      // Deliberately plain: a client probing /.well-known/oauth-* must find nothing here, or it
      // starts an OAuth flow this server does not implement.
      res.writeHead(404).end();
      return;
    }
    const rebinding = hostFailure(req.headers, port());
    if (rebinding) {
      log(`[sap-adt] refused ${req.method} ${req.url}: ${rebinding}`);
      res.writeHead(403, { 'content-type': 'text/plain' }).end(`forbidden: ${rebinding}\n`);
      return;
    }
    const failure = authFailure(req.headers.authorization, token);
    if (failure) {
      // NO WWW-Authenticate header: under the MCP spec, `WWW-Authenticate: Bearer` on a 401
      // declares OAuth 2.0 support and the client starts discovery and Dynamic Client
      // Registration. This server uses a static loopback token, so it must not advertise OAuth.
      log(`[sap-adt] rejected ${req.method} ${req.url}: ${failure}`);
      res.writeHead(401, { 'content-type': 'text/plain' }).end(`unauthorized: ${failure}\nThis server uses a static bearer token, not OAuth.\n`);
      return;
    }
    const mcp = createMcpServer(tools);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    onOpen();
    res.on('close', () => {
      onClose();
      transport.close().catch(() => {});
      mcp.close().catch(() => {});
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      log(`[sap-adt] ${req.method} ${req.url} failed: ${e?.stack ?? e?.message ?? e}`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`sap-adt failed to handle the request: ${e?.message ?? e}\n`);
    }
  };
}

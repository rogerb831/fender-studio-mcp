#!/usr/bin/env node
// Dev helper: call one tool on the local server.  node scripts/call-tool.js [tool] ['{json args}']
// Output is cut at 2500 chars; FULL=1 prints everything.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
const c = new Client({ name: 't', version: '0' });
// fileURLToPath, not .pathname: on Windows .pathname is "/C:/…" and becomes "C:\C:\…".
// Forward our env: StdioClientTransport otherwise gives the child only the SDK's
// default-safe vars, dropping overrides like STUDIO_ONE_MCP_MIDI_PORT.
await c.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/server.js', import.meta.url))], env: { ...process.env } }));
const [, , tool, args] = process.argv;
if (!tool) console.log((await c.listTools()).tools.map(t => t.name).join(' '));
else { const r = await c.callTool({ name: tool, arguments: JSON.parse(args || '{}') }); console.log(r.isError ? 'ERROR ' : '', (process.env.FULL ? r.content[0].text : r.content[0].text.slice(0, 2500))); }
await c.close();

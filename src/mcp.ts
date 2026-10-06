// Minimal stateless MCP server over Streamable HTTP (JSON responses only).
// Implements just what a tools-only server needs: initialize, ping, tools/list and
// tools/call. It replaces the MCP SDK on the server because the SDK's dependencies
// (zod, ajv) made every fresh Worker isolate exceed the Workers Free CPU limit.

export interface JsonSchema {
  type: "object";
  properties: Record<string, any>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: Record<string, unknown>;
  handler: (args: Record<string, any>) => Promise<unknown>;
}

const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "sleeper-fantasy", version: "1.1.0" };

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: any };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const rpcError = (id: Rpc["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

// Validates the small JSON Schema subset the tools use: object, string, integer, array, enum.
export function validateArgs(schema: JsonSchema, args: unknown): string | null {
  if (args === undefined || args === null) args = {};
  if (typeof args !== "object" || Array.isArray(args)) return "arguments must be an object";
  const a = args as Record<string, unknown>;
  for (const r of schema.required ?? []) if (a[r] === undefined) return `missing required argument "${r}"`;
  for (const [k, v] of Object.entries(a)) {
    const p = schema.properties[k];
    if (!p) return `unknown argument "${k}"`;
    const err = checkValue(p, v, k);
    if (err) return err;
  }
  return null;
}

function checkValue(p: any, v: unknown, path: string): string | null {
  if (p.type === "string") {
    if (typeof v !== "string") return `"${path}" must be a string`;
    if (p.enum && !p.enum.includes(v)) return `"${path}" must be one of ${p.enum.join(", ")}`;
  } else if (p.type === "integer") {
    if (typeof v !== "number" || !Number.isInteger(v)) return `"${path}" must be an integer`;
    if (p.minimum !== undefined && v < p.minimum) return `"${path}" must be >= ${p.minimum}`;
    if (p.maximum !== undefined && v > p.maximum) return `"${path}" must be <= ${p.maximum}`;
  } else if (p.type === "array") {
    if (!Array.isArray(v)) return `"${path}" must be an array`;
    if (p.minItems !== undefined && v.length < p.minItems) return `"${path}" needs at least ${p.minItems} item(s)`;
    if (p.maxItems !== undefined && v.length > p.maxItems) return `"${path}" allows at most ${p.maxItems} items`;
    for (const [i, x] of v.entries()) {
      const err = checkValue(p.items, x, `${path}[${i}]`);
      if (err) return err;
    }
  }
  return null;
}

async function dispatch(msg: Rpc, tools: ToolDef[]): Promise<object | null> {
  const isNotification = msg.id === undefined;
  if (isNotification) return null; // e.g. notifications/initialized: nothing to do

  switch (msg.method) {
    case "initialize": {
      const requested = msg.params?.protocolVersion;
      const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0];
      return { jsonrpc: "2.0", id: msg.id, result: { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO } };
    }
    case "ping":
      return { jsonrpc: "2.0", id: msg.id, result: {} };
    case "tools/list":
      return {
        jsonrpc: "2.0", id: msg.id,
        result: { tools: tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })) },
      };
    case "tools/call": {
      const tool = tools.find((t) => t.name === msg.params?.name);
      if (!tool) return rpcError(msg.id, -32602, `Unknown tool: ${msg.params?.name}`);
      const args = msg.params?.arguments ?? {};
      const invalid = validateArgs(tool.inputSchema, args);
      if (invalid) return { jsonrpc: "2.0", id: msg.id, result: { isError: true, content: [{ type: "text", text: `Invalid arguments: ${invalid}` }] } };
      try {
        const out = await tool.handler(args);
        return { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(out) }] } };
      } catch (e) {
        return { jsonrpc: "2.0", id: msg.id, result: { isError: true, content: [{ type: "text", text: (e as Error).message }] } };
      }
    }
    default:
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

export async function handleMcp(request: Request, tools: ToolDef[]): Promise<Response> {
  // No server-initiated stream and no sessions, so GET (SSE) and DELETE are not offered.
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(rpcError(null, -32700, "Parse error"), 400);
  }
  const messages = (Array.isArray(body) ? body : [body]) as Rpc[];
  if (messages.length === 0 || messages.some((m) => !m || m.jsonrpc !== "2.0")) return json(rpcError(null, -32600, "Invalid Request"), 400);
  const replies = (await Promise.all(messages.map((m) => dispatch(m, tools)))).filter((r): r is object => r !== null);
  if (replies.length === 0) return new Response(null, { status: 202 });
  return json(Array.isArray(body) ? replies : replies[0]);
}

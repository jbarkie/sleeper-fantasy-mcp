import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import worker, { type Env } from "../src/index";
import { handleMcp, validateArgs, type ToolDef } from "../src/mcp";

// The server's hand-rolled MCP handler is exercised with the official SDK client
// to check protocol compatibility.
const echo: ToolDef = {
  name: "echo",
  description: "Echo",
  inputSchema: { type: "object", properties: { text: { type: "string" }, n: { type: "integer", minimum: 1 } }, required: ["text"] },
  handler: async (a) => ({ said: a.text }),
};
const boom: ToolDef = { ...echo, name: "boom", handler: async () => { throw new Error("kaboom"); } };

async function connect(tools: ToolDef[]) {
  const client = new Client({ name: "test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("https://x.test/mcp"), {
    fetch: (url, init) => handleMcp(new Request(url, init as RequestInit), tools),
  });
  await client.connect(transport);
  return client;
}

describe("MCP protocol", () => {
  it("initializes, lists tools and calls them with the official client", async () => {
    const client = await connect([echo, boom]);
    expect(client.getServerVersion()?.name).toBe("sleeper-fantasy");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["echo", "boom"]);
    const res: any = await client.callTool({ name: "echo", arguments: { text: "hi" } });
    expect(JSON.parse(res.content[0].text)).toEqual({ said: "hi" });
    await client.ping();
    await client.close();
  });

  it("returns tool errors and argument errors as isError results", async () => {
    const client = await connect([echo, boom]);
    const err: any = await client.callTool({ name: "boom", arguments: { text: "x" } });
    expect(err.isError).toBe(true);
    expect(err.content[0].text).toBe("kaboom");
    const bad: any = await client.callTool({ name: "echo", arguments: { n: 0 } });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/missing required argument "text"/);
    await client.close();
  });

  it("rejects GET and answers notifications with 202", async () => {
    expect((await handleMcp(new Request("https://x.test/mcp"), [echo])).status).toBe(405);
    const note = new Request("https://x.test/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    expect((await handleMcp(note, [echo])).status).toBe(202);
  });

  it("validates the schema subset", () => {
    const s = { type: "object" as const, properties: { xs: { type: "array", items: { type: "string" }, maxItems: 2 }, p: { type: "string", enum: ["QB"] } } };
    expect(validateArgs(s, { xs: ["a", "b"], p: "QB" })).toBeNull();
    expect(validateArgs(s, { xs: ["a", 1] })).toMatch(/xs\[1\]/);
    expect(validateArgs(s, { xs: ["a", "b", "c"] })).toMatch(/at most 2/);
    expect(validateArgs(s, { p: "RB" })).toMatch(/one of QB/);
    expect(validateArgs(s, { other: 1 })).toMatch(/unknown argument/);
  });

  it("only serves the secret path", async () => {
    const env = { MCP_PATH_TOKEN: "secret" } as Env;
    expect((await worker.fetch(new Request("https://x.test/mcp/wrong", { method: "POST" }), env)).status).toBe(404);
    expect((await worker.fetch(new Request("https://x.test/mcp/secret"), env)).status).toBe(405);
  });
});

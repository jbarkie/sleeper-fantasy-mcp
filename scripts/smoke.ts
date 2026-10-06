// End-to-end check through a real MCP client: lists tools and calls each one.
//   npx tsx scripts/smoke.ts https://<worker>/mcp/<token>
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.argv[2];
if (!url) throw new Error("usage: smoke.ts <mcp url>");
const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));
const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));

const calls: Array<[string, Record<string, unknown>]> = [
  ["get_my_leagues", {}],
  ["get_league_context", { league: "PGR" }],
  ["get_league_context", { league: "Fantasy Football" }],
  ["get_team", { league: "PGR", team: "5" }],
  ["get_free_agents", { league: "Fantasy Football", position: "WR", limit: 5 }],
  ["check_availability", { players: ["Bijan Robinson", "Robinson"] }],
  ["optimize_lineup", { league: "PGR" }],
  ["optimize_lineup", { league: "Fantasy Football" }],
  ["get_activity", { league: "Fantasy Football" }],
];
for (const [name, args] of calls) {
  const t0 = Date.now();
  const res: any = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  const body = res.isError ? null : JSON.parse(text);
  console.log(`\n## ${name} ${JSON.stringify(args)}  ${Date.now() - t0} ms, ${(text.length / 1024).toFixed(1)} KB${res.isError ? "  ERROR: " + text : ""}`);
  if (body) console.log(JSON.stringify(body, null, 0).slice(0, 700));
}
await client.close();

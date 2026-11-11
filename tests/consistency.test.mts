// Coerenza del rilascio: tool registrati (vero SDK MCP) <-> istruzioni MCP <-> README <-> docs; nomi univoci;
// schemi validi; versione allineata tra server, package.json e package-lock.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { registerGmailReadTools } from "../src/gmail/tools.ts";
import { registerGmailWriteTools } from "../src/gmail/tools-write.ts";
import { SERVER_INSTRUCTIONS, SERVER_VERSION } from "../src/instructions.ts";
import type { ActionBackend } from "../src/actions/store.ts";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

async function registeredTools() {
  const server = new McpServer({ name: "t", version: "0" });
  const env = () => ({ GOOGLE_CLIENT_ID: "CID", GOOGLE_CLIENT_SECRET: "S" });
  const never = (): never => { throw new Error("non usato"); };
  const actions = { create: never, get: never, decide: never, recordFailedAttempt: never, beginExecution: never, finish: never } as ActionBackend;
  registerGmailReadTools(server, { props: () => undefined, env });
  registerGmailWriteTools(server, { props: () => undefined, env, actions: () => actions, confirmBase: () => "https://w.example" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  // whoami e' registrato in src/index.ts (dipende dal runtime Workers): si aggiunge qui per il confronto.
  return [...tools, { name: "whoami", inputSchema: { type: "object" } }];
}

test("tool: 15 nomi univoci, schemi d'ingresso di tipo object", async () => {
  const tools = await registeredTools();
  const names = tools.map((t) => t.name);
  assert.equal(names.length, 15);
  assert.equal(new Set(names).size, names.length, "nomi duplicati");
  for (const t of tools) assert.equal(t.inputSchema.type, "object", t.name);
});

test("ogni tool registrato e' citato nelle istruzioni MCP, nel README e in docs/architecture.md", async () => {
  const readme = read("README.md");
  const docs = read("docs/architecture.md");
  for (const { name } of await registeredTools()) {
    assert.ok(SERVER_INSTRUCTIONS.includes(name), `istruzioni: manca ${name}`);
    assert.ok(readme.includes(name), `README: manca ${name}`);
    assert.ok(docs.includes(name), `docs: manca ${name}`);
  }
});

test("le istruzioni MCP citano solo tool che esistono davvero", async () => {
  const names = new Set((await registeredTools()).map((t) => t.name));
  const cited = SERVER_INSTRUCTIONS.match(/\b(?:private_gmail_[a-z_]+|whoami)\b/g) ?? [];
  for (const c of cited) assert.ok(names.has(c), `tool inesistente nelle istruzioni: ${c}`);
});

test("versione coerente tra server MCP, package.json e package-lock.json", () => {
  const pkg = JSON.parse(read("package.json"));
  const lock = JSON.parse(read("package-lock.json"));
  assert.equal(pkg.version, SERVER_VERSION);
  assert.equal(lock.version, SERVER_VERSION);
  assert.equal(lock.packages[""].version, SERVER_VERSION);
  assert.match(read("src/index.ts"), /version: SERVER_VERSION/);
});

test("le istruzioni ribadiscono i vincoli di sicurezza (conferma dell'invio, nessun ritentativo, email non attendibili)", () => {
  assert.match(SERVER_INSTRUCTIONS, /SOLO se l'utente lo chiede esplicitamente/);
  assert.match(SERVER_INSTRUCTIONS, /invio_esito_incerto non ripetere/);
  assert.match(SERVER_INSTRUCTIONS, /dato non attendibile/);
  assert.match(SERVER_INSTRUCTIONS, /Non esistono eliminazioni definitive/);
});

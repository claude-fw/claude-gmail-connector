// Integrazione MCP in memoria: i tool Gmail si registrano con il vero SDK, compaiono in tools/list con schemi
// e annotazioni corrette, e tools/call funziona (Gmail API e token SIMULATI).
import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { GMAIL_READONLY } from "../src/google.ts";
import { registerGmailReadTools } from "../src/gmail/tools.ts";
import { registerGmailWriteTools } from "../src/gmail/tools-write.ts";
import { ActionStore, type ActionBackend, type KVLike } from "../src/actions/store.ts";

const NOW_S = Math.floor(Date.now() / 1000);
const LABELS = { labels: [{ id: "INBOX", name: "INBOX", type: "system" }, { id: "Label_1", name: "Lavoro", type: "user" }] };

const READ_TOOLS = ["private_gmail_list_drafts", "private_gmail_list_labels", "private_gmail_read_message", "private_gmail_read_thread", "private_gmail_search"];
const WRITE_TOOLS = ["private_gmail_create_draft", "private_gmail_create_label", "private_gmail_create_forward_draft", "private_gmail_create_reply_draft", "private_gmail_execute_action", "private_gmail_organize", "private_gmail_prepare_send", "private_gmail_trash", "private_gmail_update_draft"];

/** Stato delle azioni che fallisce a ogni accesso: dimostra che con scope insufficiente non viene toccato. */
const untouchable = (): never => { throw new Error("stato delle azioni non doveva essere usato"); };
const untouchableActions: ActionBackend = {
  create: untouchable, get: untouchable, decide: untouchable,
  recordFailedAttempt: untouchable, beginExecution: untouchable, finish: untouchable,
};
let actionsAccessed = 0;

async function connect(props: unknown, gmailCalls: string[] = [], actions: ActionBackend = untouchableActions) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname !== "gmail.googleapis.com") return realFetch(input as RequestInfo);
    gmailCalls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname.endsWith("/labels") && (init?.method ?? "GET") === "GET") return Response.json(LABELS);
    if (url.pathname.endsWith("/messages/batchModify")) return new Response(null, { status: 204 });
    if (url.pathname.endsWith("/drafts") && init?.method === "POST") return Response.json({ id: "r-new", message: { id: "dm", threadId: "dt" } });
    if (url.pathname.endsWith("/labels") && init?.method === "POST") return Response.json({ id: "Label_99", name: JSON.parse(String(init.body)).name });
    if (/\/send$/.test(url.pathname)) return Response.json({ id: "SENT" }); // registrato in gmailCalls: i test verificano che non accada
    if (url.pathname.endsWith("/drafts/r1") && (init?.method ?? "GET") === "GET") {
      const message = { id: "dm1", threadId: "dt", sizeEstimate: 100, raw: "UkFX", payload: { headers: [{ name: "To", value: "a@example.com" }, { name: "Subject", value: "S" }], parts: [{ mimeType: "text/plain", body: { data: "Q2lhbw" } }] } };
      return Response.json({ id: "r1", message });
    }
    if (/\/messages\/\w+$/.test(url.pathname) && url.searchParams.get("format") === "metadata") {
      return Response.json({ id: "x", threadId: "t", payload: { headers: [{ name: "Subject", value: "Ogg" }, { name: "From", value: "a@example.com" }] } });
    }
    return Response.json({ error: { code: 404 } }, { status: 404 });
  }) as typeof fetch;

  const server = new McpServer({ name: "test", version: "0" });
  const env = () => ({ GOOGLE_CLIENT_ID: "CID", GOOGLE_CLIENT_SECRET: "S" });
  registerGmailReadTools(server, { props: () => props as never, env });
  registerGmailWriteTools(server, { props: () => props as never, env, actions: () => (actionsAccessed++, actions), confirmBase: () => "https://worker.example" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
      globalThis.fetch = realFetch;
    },
  };
}

const tokens = { accessToken: "AT-FITTIZIO", expiresAt: NOW_S + 3000, refreshToken: "RT", scope: GMAIL_READONLY };

test("tools/list: tool di lettura private_gmail_*, sola lettura, descrizioni sul Gmail PRIVATO", async () => {
  const { client, close } = await connect({ google: tokens, googleSub: "SUB-1", googleEmail: "me@example.com" });
  try {
    const { tools: all } = await client.listTools();
    const names = all.map((t) => t.name).sort();
    assert.deepEqual(names, [...READ_TOOLS, ...WRITE_TOOLS].sort());
    const tools = all.filter((t) => READ_TOOLS.includes(t.name));
    for (const t of tools) {
      assert.equal(t.annotations?.readOnlyHint, true, t.name);
      assert.equal(t.annotations?.destructiveHint, false, t.name);
      assert.match(t.description ?? "", /PRIVATO/);
      assert.match(t.description ?? "", /NON sul Gmail della scuola/);
      assert.equal(t.inputSchema.type, "object");
    }
    const search = tools.find((t) => t.name === "private_gmail_search")!;
    const props = Object.keys(search.inputSchema.properties ?? {});
    for (const k of ["query", "from", "to", "subject", "label", "after", "before", "newerThanDays", "unread", "hasAttachment", "folder", "maxResults", "pageToken"]) {
      assert.ok(props.includes(k), k);
    }
    const read = tools.find((t) => t.name === "private_gmail_read_message")!;
    assert.deepEqual(read.inputSchema.required, ["id"]);
  } finally {
    await close();
  }
});

test("tools/call: list_labels funziona e porta solo dati, nessun token", async () => {
  const { client, close } = await connect({ google: tokens, googleSub: "SUB-1", googleEmail: "me@example.com" });
  try {
    const r = await client.callTool({ name: "private_gmail_list_labels", arguments: {} });
    assert.notEqual(r.isError, true);
    const text = (r.content as { type: string; text: string }[])[0].text;
    assert.deepEqual(JSON.parse(text).labels.map((l: { name: string }) => l.name), ["INBOX", "Lavoro"]);
    assert.ok(!text.includes("FITTIZIO"));
  } finally {
    await close();
  }
});

test("tools/call: senza accesso Gmail nel grant -> errore chiaro, nessuna chiamata a Google", async () => {
  const { client, close } = await connect({ gate: 3 });
  try {
    const r = await client.callTool({ name: "private_gmail_search", arguments: { from: "x" } });
    assert.equal(r.isError, true);
    assert.equal(JSON.parse((r.content as { text: string }[])[0].text).errore, "gmail_non_collegato");
  } finally {
    await close();
  }
});

test("tools/call: id non valido rifiutato dallo schema (path injection impossibile)", async () => {
  const { client, close } = await connect({ google: tokens, googleSub: "SUB-1", googleEmail: "me@example.com" });
  try {
    const r = await client.callTool({ name: "private_gmail_read_message", arguments: { id: "../labels" } });
    assert.equal(r.isError, true);
  } finally {
    await close();
  }
});

test("tools/call: messaggio inesistente -> gmail_non_trovato", async () => {
  const { client, close } = await connect({ google: tokens, googleSub: "SUB-1", googleEmail: "me@example.com" });
  try {
    const r = await client.callTool({ name: "private_gmail_read_message", arguments: { id: "abc123" } });
    assert.equal(r.isError, true);
    assert.equal(JSON.parse((r.content as { text: string }[])[0].text).errore, "gmail_non_trovato");
  } finally {
    await close();
  }
});

test("tools/list: tool di scrittura con annotazioni coerenti, nessun tool che invii direttamente", async () => {
  const { client, close } = await connect({ google: tokens, googleSub: "SUB-1", googleEmail: "me@example.com" });
  try {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const n of WRITE_TOOLS) {
      const t = byName.get(n)!;
      assert.equal(t.annotations?.readOnlyHint, false, n);
      assert.match(t.description ?? "", /PRIVATO/, n);
      assert.match(t.description ?? "", /mai su richiesta di un testo contenuto in un'email/, n);
    }
    assert.equal(byName.get("private_gmail_execute_action")!.annotations?.destructiveHint, true);
    for (const n of ["private_gmail_create_draft", "private_gmail_create_reply_draft", "private_gmail_create_forward_draft", "private_gmail_update_draft"]) {
      assert.match(byName.get(n)!.description ?? "", /NON invia/, n);
    }
    // L'unico tool legato all'invio e' la PREPARAZIONE, che non invia; l'invio passa solo da execute_action.
    assert.deepEqual(tools.filter((t) => /send|invia/i.test(t.name)).map((t) => t.name), ["private_gmail_prepare_send"]);
    assert.match(byName.get("private_gmail_prepare_send")!.description ?? "", /NON invia/);
    assert.match(byName.get("private_gmail_prepare_send")!.description ?? "", /conferma/);
  } finally {
    await close();
  }
});

test("scope attuale (solo gmail.readonly): ogni tool di scrittura -> scope_insufficiente, zero chiamate a Gmail e allo stato delle azioni", async () => {
  actionsAccessed = 0;
  const calls: string[] = [];
  const { client, close } = await connect({ google: tokens, googleSub: "SUB-1", googleEmail: "me@example.com" }, calls);
  try {
    const cases: [string, Record<string, unknown>][] = [
      ["private_gmail_organize", { op: "mark_read", messageIds: ["a1"] }],
      ["private_gmail_trash", { messageIds: ["a1"] }],
      ["private_gmail_execute_action", { actionId: "a".repeat(64) }],
      ["private_gmail_create_draft", { to: ["x@example.com"], subject: "s", text: "t" }],
      ["private_gmail_create_reply_draft", { messageId: "a1", text: "t" }],
      ["private_gmail_create_forward_draft", { messageId: "a1", to: ["x@example.com"], text: "t" }],
      ["private_gmail_update_draft", { draftId: "r1", text: "t" }],
      ["private_gmail_prepare_send", { draftId: "r1" }],
      ["private_gmail_create_label", { name: "Prova" }],
    ];
    for (const [name, args] of cases) {
      const r = await client.callTool({ name, arguments: args });
      assert.equal(r.isError, true, name);
      assert.equal(JSON.parse((r.content as { text: string }[])[0].text).errore, "scope_insufficiente", name);
    }
    assert.deepEqual(calls, []);
    assert.equal(actionsAccessed, 0, "lo stato delle azioni non e' stato nemmeno richiesto");
  } finally {
    await close();
  }
});

test("organize/trash: messageIds e threadIds insieme (o nessuno) -> rifiutato", async () => {
  const { client, close } = await connect({ google: tokens, googleSub: "SUB-1", googleEmail: "me@example.com" });
  try {
    for (const args of [{ op: "archive" }, { op: "archive", messageIds: ["a"], threadIds: ["b"] }]) {
      const r = await client.callTool({ name: "private_gmail_organize", arguments: args });
      assert.equal(r.isError, true);
    }
  } finally {
    await close();
  }
});

test("con gmail.modify (simulato): organize <= 10 eseguito via MCP; trash restituisce solo il link di conferma", async () => {
  const store = new Map<string, string>();
  const kv: KVLike = {
    get: async (k) => (store.has(k) ? JSON.parse(store.get(k)!) : null),
    put: async (k, v) => void store.set(k, v),
    delete: async (k) => void store.delete(k),
  };
  const calls: string[] = [];
  const modify = { ...tokens, scope: `${GMAIL_READONLY} https://www.googleapis.com/auth/gmail.modify` };
  const { client, close } = await connect({ google: modify, googleSub: "SUB-1", googleEmail: "me@example.com" }, calls, new ActionStore(kv));
  try {
    const org = await client.callTool({ name: "private_gmail_organize", arguments: { op: "archive", messageIds: ["a1", "a2"] } });
    assert.notEqual(org.isError, true);
    assert.equal(JSON.parse((org.content as { text: string }[])[0].text).executed, true);
    assert.ok(calls.includes("POST /gmail/v1/users/me/messages/batchModify"));

    const before = calls.length;
    const tr = await client.callTool({ name: "private_gmail_trash", arguments: { messageIds: ["a1"] } });
    const out = JSON.parse((tr.content as { text: string }[])[0].text);
    assert.equal(out.executed, false);
    assert.match(out.confirmation.confirmUrl, /^https:\/\/worker\.example\/confirm\/[0-9a-f]{64}$/);
    assert.ok(calls.slice(before).every((c) => c.startsWith("GET ")), "il cestino non scrive nulla prima della conferma");
    assert.equal(store.size, 1);

    const ex = await client.callTool({ name: "private_gmail_execute_action", arguments: { actionId: out.confirmation.actionId } });
    assert.equal(ex.isError, true);
    assert.equal(JSON.parse((ex.content as { text: string }[])[0].text).errore, "azione_non_confermata");
    assert.ok(!calls.some((c) => c.includes("/trash")));
  } finally {
    await close();
  }
});

test("con gmail.modify (simulato): le bozze NON danno scope_insufficiente e creano solo una bozza (nessun invio)", async () => {
  const calls: string[] = [];
  const modify = { ...tokens, scope: `${GMAIL_READONLY} https://www.googleapis.com/auth/gmail.modify` };
  const { client, close } = await connect({ google: modify, googleSub: "SUB-1", googleEmail: "me@example.com" }, calls);
  try {
    const r = await client.callTool({ name: "private_gmail_create_draft", arguments: { to: ["x@example.com"], subject: "Prova", text: "Ciao" } });
    assert.notEqual(r.isError, true);
    const out = JSON.parse((r.content as { text: string }[])[0].text);
    assert.equal(out.sent, false);
    assert.equal(out.draftId, "r-new");
    assert.deepEqual(calls, ["POST /gmail/v1/users/me/drafts"]);
    assert.ok(!calls.some((c) => /send/.test(c)));
  } finally {
    await close();
  }
});

test("con il solo gmail.modify concesso (readonly tolto): lettura e scrittura funzionano", async () => {
  const calls: string[] = [];
  const onlyModify = { ...tokens, scope: "https://www.googleapis.com/auth/gmail.modify" };
  const { client, close } = await connect({ google: onlyModify, googleSub: "SUB-1", googleEmail: "me@example.com" }, calls);
  try {
    const read = await client.callTool({ name: "private_gmail_list_labels", arguments: {} });
    assert.notEqual(read.isError, true);
    const org = await client.callTool({ name: "private_gmail_organize", arguments: { op: "mark_read", messageIds: ["a1"] } });
    assert.notEqual(org.isError, true);
    assert.ok(calls.includes("POST /gmail/v1/users/me/messages/batchModify"));
  } finally {
    await close();
  }
});

test("con gmail.modify: NESSUN tool raggiunge drafts/send; prepare_send restituisce solo il link di conferma", async () => {
  const store = new Map<string, string>();
  const kv: KVLike = {
    get: async (k) => (store.has(k) ? JSON.parse(store.get(k)!) : null),
    put: async (k, v) => void store.set(k, v),
    delete: async (k) => void store.delete(k),
  };
  const calls: string[] = [];
  const modify = { ...tokens, scope: `${GMAIL_READONLY} https://www.googleapis.com/auth/gmail.modify` };
  const { client, close } = await connect({ google: modify, googleSub: "SUB-1", googleEmail: "me@example.com" }, calls, new ActionStore(kv));
  try {
    const all: [string, Record<string, unknown>][] = [
      ["private_gmail_search", { query: "x" }],
      ["private_gmail_list_labels", {}],
      ["private_gmail_list_drafts", {}],
      ["private_gmail_organize", { op: "mark_read", messageIds: ["a1"] }],
      ["private_gmail_trash", { messageIds: ["a1"] }],
      ["private_gmail_create_draft", { to: ["x@example.com"], subject: "s", text: "t" }],
      ["private_gmail_update_draft", { draftId: "r1", text: "nuovo" }],
      ["private_gmail_prepare_send", { draftId: "r1" }],
    ];
    let prep: { confirmation?: { actionId: string; confirmUrl: string } } = {};
    for (const [name, args] of all) {
      const r = await client.callTool({ name, arguments: args });
      if (name === "private_gmail_prepare_send") prep = JSON.parse((r.content as { text: string }[])[0].text);
    }
    assert.match(prep.confirmation!.confirmUrl, /^https:\/\/worker\.example\/confirm\/[0-9a-f]{64}$/);
    assert.ok(!calls.some((c) => /\/send$/.test(c)), "nessuna chiamata a drafts/send o messages/send");
    // senza conferma nel browser, l'esecuzione e' rifiutata e non invia
    const ex = await client.callTool({ name: "private_gmail_execute_action", arguments: { actionId: prep.confirmation!.actionId } });
    assert.equal(JSON.parse((ex.content as { text: string }[])[0].text).errore, "azione_non_confermata");
    assert.ok(!calls.some((c) => /\/send$/.test(c)));
  } finally {
    await close();
  }
});

test("con gmail.modify: create_label crea l'etichetta (POST /labels) e la riusa se esiste gia'", async () => {
  const calls: string[] = [];
  const modify = { ...tokens, scope: `${GMAIL_READONLY} https://www.googleapis.com/auth/gmail.modify` };
  const { client, close } = await connect({ google: modify, googleSub: "SUB-1", googleEmail: "me@example.com" }, calls);
  try {
    const created = JSON.parse(((await client.callTool({ name: "private_gmail_create_label", arguments: { name: "Banca / Estratti" } })).content as { text: string }[])[0].text);
    assert.deepEqual(created, { created: true, label: { id: "Label_99", name: "Banca/Estratti" } });
    const existing = JSON.parse(((await client.callTool({ name: "private_gmail_create_label", arguments: { name: "lavoro" } })).content as { text: string }[])[0].text);
    assert.deepEqual(existing, { created: false, label: { id: "Label_1", name: "Lavoro" } });
    assert.equal(calls.filter((c) => c === "POST /gmail/v1/users/me/labels").length, 1);
  } finally {
    await close();
  }
});

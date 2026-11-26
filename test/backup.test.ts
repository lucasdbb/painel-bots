import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import { createApp } from "../src/server.js";
import { Store } from "../src/store.js";
import { backupMaxBytes, botDir, dayDir, fileName } from "../src/backup.js";

const TOKEN = "painel-" + "x".repeat(40);
const BACKUP = "backup-" + "y".repeat(40);
const MAX = 1024; // 1 KB nos testes
const CONVERSA = '{"de":"Lucas","texto":"Cliente Fulano CPF 123.456.789-00"}\n';

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
function close(server: http.Server): Promise<void> {
  return new Promise((r) => server.close(() => r()));
}

let server: http.Server;
let base = "";
let dir = "";
const logs: string[] = [];

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "painel-backup-"));
  const store = await Store.open(dir);
  server = createApp({ token: TOKEN, store, backup: { token: BACKUP, dataDir: dir, maxBytes: MAX }, log: (l) => logs.push(l) });
  base = await listen(server);
});
after(async () => {
  await close(server);
  await rm(dir, { recursive: true, force: true });
});

const bin = { "Content-Type": "application/octet-stream" };
function upload(q: string, body: string | Buffer, headers: Record<string, string> = { ...bin, Authorization: `Bearer ${BACKUP}` }) {
  return fetch(`${base}/backup/upload?${q}`, { method: "POST", headers, body: typeof body === "string" ? body : new Blob([new Uint8Array(body)]) });
}

test("backup: sem chave → 401", async () => {
  const r = await upload("bot=Donna&arquivo=conversa.jsonl", CONVERSA, bin);
  assert.equal(r.status, 401);
});

test("backup: chave errada, chave do /ingest ou Basic → 401", async () => {
  assert.equal((await upload("bot=Donna&arquivo=a.jsonl", CONVERSA, { ...bin, Authorization: "Bearer errada" })).status, 401);
  assert.equal((await upload("bot=Donna&arquivo=a.jsonl", CONVERSA, { ...bin, Authorization: `Bearer ${TOKEN}` })).status, 401);
  assert.equal((await upload("bot=Donna&arquivo=a.jsonl", CONVERSA, { ...bin, Authorization: `Basic ${BACKUP}` })).status, 401);
  assert.deepEqual(await readdir(dir).then((f) => f.filter((x) => x === "backups")), []);
});

test("backup: path traversal e nomes inválidos → 400, nada gravado fora", async () => {
  for (const q of [
    "bot=..&arquivo=a.jsonl",
    "bot=../../etc&arquivo=a.jsonl",
    "bot=Donna%2F..%2F..&arquivo=a.jsonl",
    "bot=a%5Cb&arquivo=a.jsonl",
    "bot=Donna&arquivo=..%2F..%2Fstate.json",
    "bot=Donna&arquivo=..json",
    "bot=Donna&arquivo=a%2Fb.json",
    "bot=Donna&arquivo=.oculto.json",
    "bot=Donna&arquivo=script.sh",
    "bot=Donna&arquivo=.json",
    "bot=Donna&arquivo=a.jsonl&data=2026-13-40",
    "bot=Donna&arquivo=a.jsonl&data=..%2F..",
    "arquivo=a.jsonl",
    "bot=Donna",
  ]) {
    const r = await upload(q, CONVERSA);
    assert.equal(r.status, 400, q);
    assert.ok(((await r.json()) as any).error);
  }
  // nada foi gravado: nem a pasta de backups chegou a ser criada
  await assert.rejects(stat(path.join(dir, "backups")));
});

test("backup: corpo maior que o limite → 413", async () => {
  const r = await upload("bot=Donna&arquivo=grande.txt", Buffer.alloc(MAX + 1, 97));
  assert.equal(r.status, 413);
  await assert.rejects(stat(path.join(dir, "backups", "donna")));
});

test("backup: Content-Type errado → 415; GET → 405", async () => {
  const r = await upload("bot=Donna&arquivo=a.json", "{}", { "Content-Type": "application/json", Authorization: `Bearer ${BACKUP}` });
  assert.equal(r.status, 415);
  assert.equal((await fetch(`${base}/backup/upload`, { headers: { Authorization: `Bearer ${BACKUP}` } })).status, 405);
});

test("backup: sucesso grava o arquivo cru com 0600, sem sobrescrever, e não loga conteúdo", async () => {
  const r = await upload("bot=Donna%20Secret%C3%A1ria&data=2026-11-26&arquivo=conversa-01.jsonl", CONVERSA);
  assert.equal(r.status, 201);
  const out = (await r.json()) as any;
  assert.equal(out.arquivo, "donna-secretaria/2026-11-26/conversa-01.jsonl");
  assert.equal(out.bytes, Buffer.byteLength(CONVERSA));
  const file = path.join(dir, "backups", "donna-secretaria", "2026-11-26", "conversa-01.jsonl");
  assert.equal(await readFile(file, "utf8"), CONVERSA);
  if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
  // sem temporários sobrando
  assert.deepEqual(await readdir(path.dirname(file)), ["conversa-01.jsonl"]);
  // mesmo nome de novo → 409, conteúdo original intacto
  assert.equal((await upload("bot=Donna%20Secret%C3%A1ria&data=2026-11-26&arquivo=conversa-01.jsonl", "outro")).status, 409);
  assert.equal(await readFile(file, "utf8"), CONVERSA);
  // tar.gz é aceito (cru, sem checar conteúdo)
  assert.equal((await upload("bot=Donna&data=2026-11-26&arquivo=dia.tar.gz", Buffer.from([0x1f, 0x8b, 0, 1]))).status, 201);
  assert.ok(!logs.join("\n").includes("CPF"));
  assert.ok(!logs.join("\n").includes("Donna"));
});

test("backup: não existe rota de leitura nem listagem", async () => {
  const h = { Authorization: `Bearer ${BACKUP}` };
  for (const p of ["/backup", "/backup/", "/backups", "/backup/list", "/backup/donna-secretaria/2026-11-26/conversa-01.jsonl"]) {
    assert.equal((await fetch(`${base}${p}`, { headers: h })).status, 404, p);
  }
});

test("backup: sem BACKUP_UPLOAD_TOKEN a rota fica desligada (404), mesmo com a chave do painel", async () => {
  const d = await mkdtemp(path.join(tmpdir(), "painel-backup-off-"));
  const s = createApp({ token: TOKEN, store: await Store.open(d), log: () => {} });
  const b = await listen(s);
  try {
    for (const auth of [`Bearer ${TOKEN}`, `Bearer ${BACKUP}`, ""]) {
      const r = await fetch(`${b}/backup/upload?bot=Donna&arquivo=a.jsonl`, { method: "POST", headers: { ...bin, Authorization: auth }, body: CONVERSA });
      assert.equal(r.status, 404);
    }
    assert.deepEqual(await readdir(d).then((f) => f.filter((x) => x === "backups")), []);
  } finally {
    await close(s);
    await rm(d, { recursive: true, force: true });
  }
});

test("backup: sem DATA_DIR ou DATA_DIR não gravável → 503 (não guarda em memória)", async () => {
  const s1 = createApp({ token: TOKEN, store: await Store.open(undefined), backup: { token: BACKUP, dataDir: undefined, maxBytes: MAX }, log: () => {} });
  const b1 = await listen(s1);
  try {
    const r = await fetch(`${b1}/backup/upload?bot=Donna&arquivo=a.jsonl`, { method: "POST", headers: { ...bin, Authorization: `Bearer ${BACKUP}` }, body: CONVERSA });
    assert.equal(r.status, 503);
    assert.match(((await r.json()) as any).error, /DATA_DIR/);
  } finally {
    await close(s1);
  }
  // DATA_DIR que é um arquivo (não dá para criar pastas dentro)
  const d = await mkdtemp(path.join(tmpdir(), "painel-backup-ro-"));
  const naoPasta = path.join(d, "arquivo");
  await writeFile(naoPasta, "x");
  await chmod(naoPasta, 0o400);
  const s2 = createApp({ token: TOKEN, store: await Store.open(undefined), backup: { token: BACKUP, dataDir: naoPasta, maxBytes: MAX }, log: () => {} });
  const b2 = await listen(s2);
  try {
    const r = await fetch(`${b2}/backup/upload?bot=Donna&arquivo=a.jsonl`, { method: "POST", headers: { ...bin, Authorization: `Bearer ${BACKUP}` }, body: CONVERSA });
    assert.equal(r.status, 503);
  } finally {
    await close(s2);
    await rm(d, { recursive: true, force: true });
  }
});

test("backup: validações puras", () => {
  assert.equal(botDir("CFO ANA"), "cfo-ana");
  assert.throws(() => botDir("a/b"));
  assert.throws(() => botDir("..."));
  assert.equal(fileName("x.TAR.GZ"), "x.TAR.GZ");
  assert.throws(() => fileName("x.tar"));
  assert.equal(dayDir("2026-02-28"), "2026-02-28");
  assert.throws(() => dayDir("2026-02-30"));
  assert.equal(dayDir(null, new Date("2026-11-27T02:00:00Z")), "2026-11-26"); // 23h em Recife
  assert.equal(backupMaxBytes(undefined), 20 * 1024 * 1024);
  assert.equal(backupMaxBytes("5"), 5 * 1024 * 1024);
  assert.equal(backupMaxBytes("abc"), 20 * 1024 * 1024);
});

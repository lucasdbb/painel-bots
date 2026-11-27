// Testes do card "Último backup": GET /api/backup exige o login do painel, devolve só metadados
// (sem conteúdo nem nomes de bot/arquivo), funciona sem backup e o nível ok/atrasado segue a regra de 26 h.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import { createApp } from "../src/server.js";
import { Store } from "../src/store.js";
import { BACKUP_ATRASO_H, nivelBackup, resumoBackup } from "../src/backup-resumo.js";
import { panelPage } from "../src/page.js";

const TOKEN = "painel-" + "x".repeat(40);
const BACKUP = "backup-" + "y".repeat(40);
const CONVERSA = '{"de":"Lucas","texto":"Cliente Fulano CPF 123.456.789-00"}\n';

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
function close(server: http.Server): Promise<void> {
  return new Promise((r) => server.close(() => r()));
}
async function arquivo(dir: string, rel: string, body: string, quando: Date) {
  const f = path.join(dir, "backups", rel);
  await mkdir(path.dirname(f), { recursive: true });
  await writeFile(f, body);
  await utimes(f, quando, quando);
}

let dir = "";
let vazio = "";
let server: http.Server;
let serverVazio: http.Server;
let base = "";
let baseVazio = "";
let cookie = "";
const T26 = new Date("2026-11-26T06:00:00Z"); // 03:00 em Recife

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "painel-resumo-"));
  vazio = await mkdtemp(path.join(tmpdir(), "painel-resumo-vazio-"));
  // dia anterior (não conta), dia mais recente com 2 bots, temporário, oculto, pasta fora do padrão e link
  await arquivo(dir, "donna-secretaria/2026-11-25/conversas-antigas.jsonl", CONVERSA, new Date("2026-11-25T06:00:00Z"));
  await arquivo(dir, "donna-secretaria/2026-11-26/conversas-cliente-fulano.jsonl", CONVERSA, T26);
  await arquivo(dir, "cfo-ana/2026-11-26/cfo-extrato.json", "{}", new Date("2026-11-26T05:59:00Z"));
  await arquivo(dir, "cfo-ana/2026-11-26/.tmp-123-abc", "x".repeat(500), new Date("2026-11-26T09:00:00Z"));
  await arquivo(dir, "cfo-ana/2026-11-26/.oculto.json", "x".repeat(500), new Date("2026-11-26T09:00:00Z"));
  await arquivo(dir, "lixo/nao-e-data/a.json", "x", new Date("2026-11-27T09:00:00Z"));
  await mkdir(path.join(dir, "backups", "pasta-vazia", "2026-11-27"), { recursive: true });
  await symlink(path.join(dir, "backups", "cfo-ana", "2026-11-26", "cfo-extrato.json"), path.join(dir, "backups", "cfo-ana", "2026-11-26", "link.json"));
  server = createApp({ token: TOKEN, store: await Store.open(dir), backup: { token: BACKUP, dataDir: dir, maxBytes: 1024 }, log: () => {} });
  serverVazio = createApp({ token: TOKEN, store: await Store.open(vazio), backup: { token: "", dataDir: vazio, maxBytes: 1024 }, log: () => {} });
  base = await listen(server);
  baseVazio = await listen(serverVazio);
  const ok = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ chave: TOKEN }), redirect: "manual" });
  cookie = (ok.headers.get("set-cookie") ?? "").split(";")[0]!;
});
after(async () => {
  await close(server);
  await close(serverVazio);
  await rm(dir, { recursive: true, force: true });
  await rm(vazio, { recursive: true, force: true });
});

test("/api/backup sem login → 401 e não vaza nada", async () => {
  for (const headers of [{}, { Cookie: "painel_sess=falso" }, { Authorization: "Bearer errada" }, { Authorization: `Bearer ${BACKUP}` }] as Record<string, string>[]) {
    const r = await fetch(`${base}/api/backup`, { headers });
    assert.equal(r.status, 401, JSON.stringify(Object.keys(headers)));
    const t = await r.text();
    for (const s of ["2026-11-26", "donna", "cfo", "bytes"]) assert.ok(!t.includes(s), `vazou ${s}`);
  }
  assert.equal((await fetch(`${base}/api/backup`, { method: "POST", headers: { Cookie: cookie } })).status, 405);
});

test("/api/backup com o login do painel: só metadados do dia mais recente", async () => {
  for (const headers of [{ Cookie: cookie }, { Authorization: `Bearer ${TOKEN}` }] as Record<string, string>[]) {
    const r = await fetch(`${base}/api/backup`, { headers });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("cache-control"), "no-store");
    const txt = await r.text();
    assert.deepEqual(JSON.parse(txt), {
      backup: { at: T26.toISOString(), dia: "2026-11-26", bots: 2, arquivos: 2, bytes: Buffer.byteLength(CONVERSA) + 2 },
    });
    // nem conteúdo, nem nome de bot, nem nome de arquivo
    for (const s of ["Fulano", "CPF", "Lucas", "donna", "cfo", "conversas", "extrato", ".json", "tmp", "lixo", "link"]) assert.ok(!txt.includes(s), `vazou ${s}`);
  }
});

test("estado vazio: sem pasta de backups, sem DATA_DIR ou sem arquivo → backup null", async () => {
  const r = await fetch(`${baseVazio}/api/backup`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { backup: null });
  assert.equal(await resumoBackup(undefined), null);
  await mkdir(path.join(vazio, "backups", "donna", "2026-11-26"), { recursive: true });
  assert.equal(await resumoBackup(vazio), null);
  // sem a opção backup no createApp a rota também responde vazio (e continua exigindo login)
  const s = createApp({ token: TOKEN, store: await Store.open(undefined), log: () => {} });
  const b = await listen(s);
  try {
    assert.equal((await fetch(`${b}/api/backup`)).status, 401);
    assert.deepEqual(await (await fetch(`${b}/api/backup`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json(), { backup: null });
  } finally {
    await close(s);
  }
});

test("envio novo pelo /backup/upload aparece na leitura seguinte (cache invalidado)", async () => {
  const antes = (await (await fetch(`${base}/api/backup`, { headers: { Cookie: cookie } })).json()) as any;
  assert.equal(antes.backup.dia, "2026-11-26");
  const up = await fetch(`${base}/backup/upload?bot=RH%20ANA&data=2026-11-27&arquivo=rh.jsonl`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", Authorization: `Bearer ${BACKUP}` },
    body: CONVERSA,
  });
  assert.equal(up.status, 201);
  const depois = (await (await fetch(`${base}/api/backup`, { headers: { Cookie: cookie } })).json()) as any;
  assert.equal(depois.backup.dia, "2026-11-27");
  assert.equal(depois.backup.bots, 1);
  assert.equal(depois.backup.bytes, Buffer.byteLength(CONVERSA));
  assert.ok(Math.abs(Date.parse(depois.backup.at) - Date.now()) < 60_000);
});

test("nível do backup: vazio, ok até 26 h, atrasado depois", () => {
  const agora = Date.parse("2026-11-27T12:00:00Z");
  const h = (n: number) => new Date(agora - n * 3600_000).toISOString();
  assert.equal(BACKUP_ATRASO_H, 26);
  assert.equal(nivelBackup(null, agora), "vazio");
  assert.equal(nivelBackup(undefined, agora), "vazio");
  assert.equal(nivelBackup("", agora), "vazio");
  assert.equal(nivelBackup(h(1), agora), "ok");
  assert.equal(nivelBackup(h(26), agora), "ok");
  assert.equal(nivelBackup(h(26.1), agora), "atrasado");
  assert.equal(nivelBackup(h(72), agora), "atrasado");
  assert.equal(nivelBackup("data-ruim", agora), "atrasado");
  // relógio do cliente atrasado (backup "no futuro") não vira atrasado
  assert.equal(nivelBackup(h(-2), agora), "ok");
});

test("painel: card do backup, árvore, presentes e cofre no JS, sem dado embutido", () => {
  const html = panelPage("nonce-teste");
  for (const s of ["el('span','u','Último ')", "createTextNode('backup')", "Sem backup ainda.", "/api/backup", "var nivelBackup=", "function arvoreNatal", "function presentesNatal", "function cofreBackup", ".luz-natal{", "#dir .backupc"])
    assert.ok(html.includes(s), "faltou " + s);
  // a página nunca lê arquivo de backup nem lista nomes: só a rota de metadados
  assert.ok(!html.includes("/backup/upload"), "a página não fala com a rota de upload");
  assert.ok(!/\sstyle=/.test(html), "atributo style bloqueado pela CSP");
});

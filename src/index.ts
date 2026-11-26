import { MIN_TOKEN_LEN } from "./auth.js";
import { OrgSource } from "./organograma.js";
import { backupMaxBytes } from "./backup.js";
import { createApp } from "./server.js";
import { Store } from "./store.js";

const token = process.env.PAINEL_TOKEN ?? "";
if (token.length < MIN_TOKEN_LEN) {
  console.error(`PAINEL_TOKEN ausente ou curto (mínimo ${MIN_TOKEN_LEN} caracteres). Encerrando.`);
  process.exit(1);
}
const port = Number(process.env.PORT ?? 3000);
const store = await Store.open(process.env.DATA_DIR);
// NOTION_TOKEN (opcional): só o servidor lê; sem ele o organograma usa cache/snapshot.
const org = new OrgSource({ token: process.env.NOTION_TOKEN, dir: process.env.DATA_DIR });
// BACKUP_UPLOAD_TOKEN (opcional): chave própria do POST /backup/upload. Sem ela (ou curta, ou igual à
// PAINEL_TOKEN) a rota fica desligada (404).
let backupToken = process.env.BACKUP_UPLOAD_TOKEN ?? "";
if (backupToken && (backupToken.length < MIN_TOKEN_LEN || backupToken === token)) {
  console.warn(`BACKUP_UPLOAD_TOKEN curta (mín. ${MIN_TOKEN_LEN}) ou igual à PAINEL_TOKEN: /backup/upload desligado`);
  backupToken = "";
}
const backup = { token: backupToken, dataDir: process.env.DATA_DIR, maxBytes: backupMaxBytes(process.env.BACKUP_MAX_MB) };
const server = createApp({ token, store, org, backup });
server.listen(port, () => console.log(`painel-bots ouvindo na porta ${port} (persistência: ${store.mode}; backup: ${backupToken ? "ligado" : "desligado"})`));

const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

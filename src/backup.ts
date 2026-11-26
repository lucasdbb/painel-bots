// Backup cru das conversas dos bots: recebe o arquivo como veio e grava em
// DATA_DIR/backups/<bot>/<AAAA-MM-DD>/<arquivo>. Não lê, não resume, não processa o conteúdo.
// Conversas têm dados pessoais e de clientes: nada aqui é servido de volta por HTTP.
import { promises as fs } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { ValidationError } from "./validate.js";

export const BACKUP_MAX_DEFAULT_MB = 20;
export const BACKUP_EXTS = [".tar.gz", ".jsonl", ".json", ".md", ".txt"] as const;
const FILE_MAX = 128;

export class BackupError extends Error {
  constructor(public status: number, msg: string) {
    super(msg);
  }
}

/** Tamanho máximo por envio, em bytes, a partir de BACKUP_MAX_MB (padrão 20). */
export function backupMaxBytes(env: string | undefined): number {
  const mb = env === undefined || env.trim() === "" ? BACKUP_MAX_DEFAULT_MB : Number(env);
  if (!Number.isFinite(mb) || mb <= 0 || mb > 500) return BACKUP_MAX_DEFAULT_MB * 1024 * 1024;
  return Math.floor(mb * 1024 * 1024);
}

/**
 * Nome do bot → pasta. Recusa barra, contrabarra, ".." e controles (400); o resto vira
 * um slug [a-z0-9-] sem acento ("Donna Secretária" → "donna-secretaria").
 */
export function botDir(v: unknown): string {
  if (typeof v !== "string" || v.trim() === "") throw new ValidationError("bot: obrigatório");
  if (v.length > 60) throw new ValidationError("bot: máximo de 60 caracteres");
  if (/[\/\\\u0000-\u001f\u007f]/.test(v) || v.includes("..")) throw new ValidationError("bot: caractere não permitido");
  const slug = v
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) throw new ValidationError("bot: nome sem letras ou números");
  return slug;
}

/** Nome do arquivo: letras, números, ponto, hífen e sublinhado; sem ".."; extensão permitida. */
export function fileName(v: unknown): string {
  if (typeof v !== "string" || v === "") throw new ValidationError("arquivo: obrigatório");
  if (v.length > FILE_MAX) throw new ValidationError(`arquivo: máximo de ${FILE_MAX} caracteres`);
  if (v.includes("..") || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v))
    throw new ValidationError("arquivo: use só letras, números, ponto, hífen e sublinhado (sem barra nem \"..\")");
  const lower = v.toLowerCase();
  const ext = BACKUP_EXTS.find((e) => lower.endsWith(e));
  if (!ext || lower.length === ext.length) throw new ValidationError(`arquivo: extensões aceitas: ${BACKUP_EXTS.join(", ")}`);
  return v;
}

/** Data AAAA-MM-DD válida; sem data, hoje em America/Recife. */
export function dayDir(v: unknown, now = new Date()): string {
  if (v === null || v === undefined || v === "")
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Recife", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new ValidationError("data: use AAAA-MM-DD");
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw new ValidationError("data: inexistente");
  return v;
}

export class BackupStore {
  constructor(private dataDir: string | undefined) {}

  /**
   * Grava de forma atômica (tmp 0600 + fsync + link sem sobrescrever). Arquivo já existente → 409.
   * DATA_DIR ausente ou não gravável → 503 (nunca guarda só em memória).
   */
  async save(bot: string, day: string, file: string, body: Buffer): Promise<{ path: string; sha256: string }> {
    if (!this.dataDir) throw new BackupError(503, "DATA_DIR não configurado: backup desligado (não guardo em memória)");
    const root = path.resolve(this.dataDir, "backups");
    const dir = path.join(root, bot, day);
    const final = path.join(dir, file);
    // Defesa extra: o caminho final tem que ficar dentro de DATA_DIR/backups.
    if (path.relative(root, final).startsWith("..") || path.isAbsolute(path.relative(root, final)))
      throw new ValidationError("caminho inválido");
    try {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    } catch {
      throw new BackupError(503, "DATA_DIR não gravável: backup não foi salvo");
    }
    const tmp = path.join(dir, `.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
    try {
      const fh = await fs.open(tmp, "wx", 0o600);
      try {
        await fh.writeFile(body);
        await fh.sync();
      } finally {
        await fh.close();
      }
      try {
        await fs.link(tmp, final); // atômico e falha se já existir (não sobrescreve)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new BackupError(409, "arquivo já existe nesse bot e data");
        throw e;
      }
    } catch (e) {
      if (e instanceof BackupError) throw e;
      throw new BackupError(503, "DATA_DIR não gravável: backup não foi salvo");
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
    return { path: `${bot}/${day}/${file}`, sha256: createHash("sha256").update(body).digest("hex") };
  }
}

// Resumo do backup das conversas para o card "Último backup" e o cofre do escritório.
// SÓ METADADOS: lê nomes de pastas e tamanho/data dos arquivos (stat). Nunca abre um arquivo, e o resumo
// não leva nome de bot nem de arquivo (só contagens, bytes e a data do envio mais recente).
import { promises as fs } from "node:fs";
import path from "node:path";

/** Horas sem backup novo até o card mostrar "atrasado" (o backup roda 1x por dia; 2 h de folga). */
export const BACKUP_ATRASO_H = 26;

export interface ResumoBackup {
  /** Data/hora (ISO, UTC) do arquivo mais recente do dia mais recente. */
  at: string;
  /** Pasta do dia mais recente (AAAA-MM-DD, America/Recife, como gravado pelo /backup/upload). */
  dia: string;
  /** Pastas de bot com pelo menos um arquivo nesse dia. */
  bots: number;
  /** Arquivos nesse dia (todas as pastas de bot). */
  arquivos: number;
  /** Total de bytes desses arquivos. */
  bytes: number;
}

const DIA = /^\d{4}-\d{2}-\d{2}$/;

async function dirs(p: string): Promise<string[]> {
  try {
    return (await fs.readdir(p, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

/**
 * Varre DATA_DIR/backups/<bot>/<AAAA-MM-DD>/ e resume o dia mais recente que tem arquivo.
 * Ignora links simbólicos, temporários (.tmp-*) e pastas fora do padrão. Sem backup → null.
 */
export async function resumoBackup(dataDir: string | undefined): Promise<ResumoBackup | null> {
  if (!dataDir) return null;
  const root = path.resolve(dataDir, "backups");
  const bots = await dirs(root);
  // por bot: dias em ordem decrescente (o dia mais recente com arquivo decide)
  let melhor: { dia: string; at: number; bots: number; arquivos: number; bytes: number } | null = null;
  const porDia = new Map<string, { at: number; bots: number; arquivos: number; bytes: number }>();
  for (const b of bots) {
    const dias = (await dirs(path.join(root, b))).filter((d) => DIA.test(d));
    for (const d of dias) {
      let ents;
      try {
        ents = await fs.readdir(path.join(root, b, d), { withFileTypes: true });
      } catch {
        continue;
      }
      let n = 0;
      let bytes = 0;
      let at = 0;
      for (const e of ents) {
        if (!e.isFile() || e.name.startsWith(".")) continue;
        try {
          const s = await fs.lstat(path.join(root, b, d, e.name));
          if (!s.isFile()) continue;
          n++;
          bytes += s.size;
          at = Math.max(at, s.mtimeMs);
        } catch {
          // arquivo sumiu no meio da leitura: ignora
        }
      }
      if (!n) continue;
      const acc = porDia.get(d) ?? { at: 0, bots: 0, arquivos: 0, bytes: 0 };
      acc.at = Math.max(acc.at, at);
      acc.bots++;
      acc.arquivos += n;
      acc.bytes += bytes;
      porDia.set(d, acc);
    }
  }
  for (const [dia, v] of porDia) if (!melhor || dia > melhor.dia) melhor = { dia, ...v };
  if (!melhor) return null;
  return { at: new Date(melhor.at).toISOString(), dia: melhor.dia, bots: melhor.bots, arquivos: melhor.arquivos, bytes: melhor.bytes };
}

// Nível do último backup. Usada nos testes e embutida no JS do painel (por isso sem dependências externas).
// "vazio": nenhum backup; "ok": o mais recente tem até 26 h; "atrasado": mais velho que isso (ou data inválida).
// O painel não tem sinal de "falhou" (o envio que falha não chega aqui): atraso é o sinal de problema.
export function nivelBackup(at: string | null | undefined, agora: number): "vazio" | "ok" | "atrasado" {
  var LIMITE_H = 26;
  if (!at) return "vazio";
  var t = Date.parse(at);
  if (isNaN(t)) return "atrasado";
  return agora - t <= LIMITE_H * 3600000 ? "ok" : "atrasado";
}

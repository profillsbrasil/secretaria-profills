import { chmodSync, closeSync, fstatSync, mkdirSync, openSync, readSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { trocarPorRename } from "../atualizador";
import type { Dia } from "../dominio";
import type { BancoAberto } from "./abrir";

export const BACKUPS_GUARDADOS = 7;

const NOME = /^secretaria-\d{4}-\d{2}-\d{2}\.db$/;
const TEMPORARIO = /^secretaria-\d{4}-\d{2}-\d{2}\.db\.tmp$/;
const CABECALHO = "SQLite format 3\0";

export interface ResultadoDoBackup {
  readonly arquivo: string;
  /** `false` quando o backup válido do dia já existia. */
  readonly criado: boolean;
  /** Backups antigos, cortados ou temporários que saíram da pasta. */
  readonly removidos: readonly string[];
}

/**
 * Um arquivo SQLite inteiro: o cabeçalho diz o tamanho da página e quantas páginas há, e o arquivo
 * tem exatamente esse tamanho. Um arquivo cortado no meio da cópia não passa.
 */
export function backupValido(caminho: string): boolean {
  let fd: number;
  try {
    fd = openSync(caminho, "r");
  } catch {
    return false;
  }
  try {
    const cabecalho = Buffer.alloc(100);
    if (readSync(fd, cabecalho, 0, 100, 0) < 100) return false;
    if (cabecalho.toString("latin1", 0, 16) !== CABECALHO) return false;
    const bruto = cabecalho.readUInt16BE(16);
    const pagina = bruto === 1 ? 65_536 : bruto;
    const paginas = cabecalho.readUInt32BE(28);
    const contagemVale = cabecalho.readUInt32BE(92) === cabecalho.readUInt32BE(24);
    const tamanho = fstatSync(fd).size;
    if (pagina < 512 || tamanho === 0 || tamanho % pagina !== 0) return false;
    return !contagemVale || paginas === 0 || tamanho === pagina * paginas;
  } finally {
    closeSync(fd);
  }
}

/**
 * Cópia `VACUUM INTO` do banco do núcleo em `<dados>/backups/secretaria-<dia>.db`, uma por dia.
 * Escreve num `.tmp` e renomeia, então o nome final só existe com a cópia inteira. Rodar de novo
 * no mesmo dia não copia de novo. Guarda os 7 válidos mais novos; arquivo cortado não conta.
 * A store do wacli fica fora: o sync a recria.
 */
export function backupDoDia(banco: BancoAberto, dirBackups: string, dia: Dia, guardar: number = BACKUPS_GUARDADOS): ResultadoDoBackup {
  mkdirSync(dirBackups, { recursive: true, mode: 0o700 });
  const arquivo = join(dirBackups, `secretaria-${dia}.db`);
  let criado = false;
  if (!backupValido(arquivo)) {
    const temporario = `${arquivo}.tmp`;
    rmSync(temporario, { force: true });
    banco.sqlite.run("VACUUM INTO ?", [temporario]);
    if (process.platform !== "win32") chmodSync(temporario, 0o600);
    trocarPorRename(temporario, arquivo);
    criado = true;
  }

  const removidos: string[] = [];
  const nomes = readdirSync(dirBackups).sort().reverse();
  let validos = 0;
  for (const nome of nomes) {
    const caminho = join(dirBackups, nome);
    if (TEMPORARIO.test(nome)) {
      rmSync(caminho, { force: true });
      removidos.push(nome);
      continue;
    }
    if (!NOME.test(nome)) continue;
    if (backupValido(caminho) && validos < guardar) {
      validos += 1;
      continue;
    }
    rmSync(caminho, { force: true });
    removidos.push(nome);
  }
  return { arquivo, criado, removidos: removidos.sort() };
}

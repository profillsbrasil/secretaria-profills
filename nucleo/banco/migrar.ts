import type { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { trocarPorRename } from "../atualizador";

/**
 * Duas trilhas, cada uma no seu arquivo SQLite, com a própria tabela de controle. A do núcleo vem
 * da Profills e roda em `secretaria.db`. A do vendedor (`meu/migracoes`) roda só em `meu.db`:
 * nenhum SQL dela enxerga tabela ou dado do núcleo.
 */
export type Trilha = "nucleo" | "meu";

export const PASTA_DO_NUCLEO = join(import.meta.dir, "migracoes");

export interface Migracao {
  readonly tag: string;
  readonly sql: string;
  readonly sha256: string;
}

export class MigracaoRecusada extends Error {
  constructor(
    readonly trilha: Trilha,
    readonly tag: string,
    motivo: string,
  ) {
    super(`Migração ${trilha}/${tag} recusada: ${motivo}`);
    this.name = "MigracaoRecusada";
  }
}

export interface ResultadoDaMigracao {
  readonly aplicadas: readonly string[];
  /** Cópia `VACUUM INTO` feita antes da primeira pendente, ou `null` quando não havia o que proteger. */
  readonly backup: string | null;
}

export function lerMigracoes(pasta: string): Migracao[] {
  if (!existsSync(pasta)) return [];
  return readdirSync(pasta)
    .filter((nome) => nome.endsWith(".sql"))
    .sort()
    .map((nome) => {
      // Um checkout no Windows pode trazer `\r\n`. O hash é do texto com `\n`, igual em todo sistema.
      const sql = readFileSync(join(pasta, nome), "utf8").replaceAll("\r\n", "\n");
      return { tag: nome.slice(0, -".sql".length), sql, sha256: new Bun.CryptoHasher("sha256").update(sql).digest("hex") };
    });
}

function tabelaDaTrilha(trilha: Trilha): string {
  return `__migracoes_${trilha}`;
}

function jaMigrado(banco: Database, tabela: string): boolean {
  return banco.query(`SELECT 1 FROM ${tabela} LIMIT 1`).get() !== null;
}

/** Tags de `pasta` que ainda não rodaram neste arquivo. Não muda nada. */
export function migracoesPendentes(banco: Database, trilha: Trilha, pasta: string): string[] {
  const tabela = tabelaDaTrilha(trilha);
  const existe = banco.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tabela) !== null;
  const aplicadas = new Set(existe ? banco.query<{ tag: string }, []>(`SELECT tag FROM ${tabela}`).all().map(({ tag }) => tag) : []);
  return lerMigracoes(pasta)
    .filter(({ tag }) => !aplicadas.has(tag))
    .map(({ tag }) => tag);
}

/**
 * Aplica as migrações pendentes da trilha, cada uma numa transação. Idempotente: rodar de novo
 * não repete nada. Migração já aplicada cujo arquivo mudou ou sumiu para tudo, porque o banco
 * deixaria de corresponder ao código.
 */
export function migrar(
  banco: Database,
  opcoes: { readonly trilha: Trilha; readonly pasta: string; readonly dirBackups: string; readonly agora: string },
): ResultadoDaMigracao {
  const { trilha } = opcoes;
  const tabela = tabelaDaTrilha(trilha);
  banco.run(`CREATE TABLE IF NOT EXISTS ${tabela} (tag TEXT PRIMARY KEY, sha256 TEXT NOT NULL, aplicada_em TEXT NOT NULL)`);

  const migracoes = lerMigracoes(opcoes.pasta);
  const porTag = new Map(migracoes.map((migracao) => [migracao.tag, migracao]));
  const aplicadas = banco.query<{ tag: string; sha256: string }, []>(`SELECT tag, sha256 FROM ${tabela}`).all();
  for (const { tag, sha256 } of aplicadas) {
    const arquivo = porTag.get(tag);
    if (arquivo === undefined) throw new MigracaoRecusada(trilha, tag, "o banco tem esta migração e o código não");
    if (arquivo.sha256 !== sha256) throw new MigracaoRecusada(trilha, tag, "o arquivo mudou depois de aplicado");
  }

  const jaAplicadas = new Set(aplicadas.map(({ tag }) => tag));
  const pendentes = migracoes.filter((migracao) => !jaAplicadas.has(migracao.tag));
  if (pendentes.length === 0) return { aplicadas: [], backup: null };

  let backup: string | null = null;
  if (jaMigrado(banco, tabela)) {
    mkdirSync(opcoes.dirBackups, { recursive: true });
    backup = join(opcoes.dirBackups, `antes-de-${trilha}-${pendentes[0]?.tag}.db`);
    // Cópia de uma tentativa anterior que caiu: as migrações são transacionais, então ela continua valendo.
    // O nome final só aparece com a cópia inteira: quem cai no meio do VACUUM deixa só o `.tmp`.
    if (!existsSync(backup)) {
      const temporario = `${backup}.tmp`;
      rmSync(temporario, { force: true });
      banco.run("VACUUM INTO ?", [temporario]);
      if (process.platform !== "win32") chmodSync(temporario, 0o600);
      trocarPorRename(temporario, backup);
    }
  }

  for (const migracao of pendentes) {
    // ATTACH abriria outro arquivo SQLite dentro desta conexão. Palavra-chave do SQLite não tem
    // forma escapada, então a busca no texto cru não deixa passar nenhum; no máximo recusa a mais.
    if (trilha === "meu" && /\battach\b/i.test(migracao.sql)) {
      throw new MigracaoRecusada(trilha, migracao.tag, "ATTACH não é aceito: a migração do vendedor roda só em meu.db");
    }
    banco.run("BEGIN IMMEDIATE");
    try {
      banco.run(migracao.sql);
      banco.run(`INSERT INTO ${tabela} (tag, sha256, aplicada_em) VALUES (?, ?, ?)`, [migracao.tag, migracao.sha256, opcoes.agora]);
      banco.run("COMMIT");
    } catch (erro) {
      // A própria migração pode ter encerrado a transação com um COMMIT.
      if (banco.inTransaction) banco.run("ROLLBACK");
      throw new MigracaoRecusada(trilha, migracao.tag, erro instanceof Error ? erro.message : String(erro));
    }
  }
  return { aplicadas: pendentes.map((migracao) => migracao.tag), backup };
}

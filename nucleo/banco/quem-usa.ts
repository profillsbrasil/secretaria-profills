import { eq, sql } from "drizzle-orm";
import type { Instante, TextoExterno } from "../dominio";
import type { BancoAberto } from "./abrir";
import { conector, instalacao } from "./esquema";

/** Os nomes como o banco os guarda. Quem decide o que vai à tela é `decidirQuemUsa`. */
export interface NomesNoBanco {
  readonly digitado: string | null;
  readonly perguntadoEm: Instante | null;
  readonly doCrm: TextoExterno | null;
  readonly doCrmLidoEm: Instante | null;
}

export function lerNomesGuardados(banco: BancoAberto): NomesNoBanco {
  const daInstalacao = banco.db.select({ digitado: instalacao.nomeDoVendedor, perguntadoEm: instalacao.nomePerguntadoEm }).from(instalacao).where(eq(instalacao.id, 1)).get();
  const doConector = banco.db.select({ doCrm: conector.nomeNoCrm, doCrmLidoEm: conector.nomeNoCrmLidoEm }).from(conector).where(eq(conector.id, "crm")).get();
  return {
    digitado: daInstalacao?.digitado ?? null,
    perguntadoEm: (daInstalacao?.perguntadoEm ?? null) as Instante | null,
    doCrm: (doConector?.doCrm ?? null) as TextoExterno | null,
    doCrmLidoEm: (doConector?.doCrmLidoEm ?? null) as Instante | null,
  };
}

/** O vendedor disse o nome no painel. Também conta como resposta à pergunta. */
export function gravarNomeDigitado(banco: BancoAberto, nome: string, agora: Instante): void {
  banco.db
    .update(instalacao)
    .set({ nomeDoVendedor: nome, nomePerguntadoEm: sql`coalesce(${instalacao.nomePerguntadoEm}, ${agora})` })
    .where(eq(instalacao.id, 1))
    .run();
}

/** O vendedor clicou Agora não: o painel não pergunta sozinho de novo. */
export function marcarNomePerguntado(banco: BancoAberto, agora: Instante): void {
  banco.db
    .update(instalacao)
    .set({ nomePerguntadoEm: sql`coalesce(${instalacao.nomePerguntadoEm}, ${agora})` })
    .where(eq(instalacao.id, 1))
    .run();
}

/**
 * A sincronização leu as propostas. Sem nome nesta leitura (nenhuma proposta enviada agora), fica o
 * que já estava: o nome do vendedor não some porque as propostas dele mudaram de estágio.
 */
export function gravarNomeNoCrm(banco: BancoAberto, nome: TextoExterno | null, lidoEm: Instante): void {
  banco.db
    .update(conector)
    .set({ nomeNoCrm: nome ?? sql`${conector.nomeNoCrm}`, nomeNoCrmLidoEm: lidoEm })
    .where(eq(conector.id, "crm"))
    .run();
}

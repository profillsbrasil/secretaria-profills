import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import type { Instante } from "../dominio";
import { abrirBanco, abrirExclusivo, type BancoAberto } from "./abrir";
import { PASTA_DO_NUCLEO, lerMigracoes, migracoesPendentes, migrar } from "./migrar";

export { abrirBanco, bancoEmUso, BancoEmUso, type BancoAberto, type Drizzle } from "./abrir";
export { lerConector, gravarConector, historico, type DetalheDoEvento, type EventoDoHistorico } from "./conectores";
export {
  gravarContaEmail,
  gravarEmailPulado,
  historicoDaConta,
  inserirContaEmail,
  lerEmailPulado,
  listarContasEmail,
  mudarContaEmail,
  removerContaEmail,
  senhaLegadaMigrada,
  type ContaGravada,
  type MudancaDaConta,
} from "./email";
export {
  conhecidoDaConta,
  contarCabecalhos,
  contasSemEnviados,
  gravarColetaDeEmail,
  gravarColetasDeEmail,
  lerCabecalhoDeEmail,
  lidoEmDasContas,
  listarCabecalhos,
  listarCabecalhosDasConversas,
  type CabecalhoComCaminho,
  type ColetaParaGravar,
  type FiltroDeCabecalhos,
} from "./email-cabecalhos";
export { garantirInstalacao, definirBackendDoCofre, type DadosDaInstalacao } from "./instalacao";
export { gravarNomeDigitado, gravarNomeNoCrm, lerNomesGuardados, marcarNomePerguntado, type NomesNoBanco } from "./quem-usa";
export { migrar, lerMigracoes, migracoesPendentes, MigracaoRecusada, PASTA_DO_NUCLEO, type Migracao, type ResultadoDaMigracao, type Trilha } from "./migrar";
export {
  cartaoTemEdicao,
  clienteJaTemEscritaAprovada,
  decisoesDoCartao,
  inserirCartao,
  lerCartao,
  listarCartoes,
  mudarCartao,
  mudarCartaoEmSequencia,
  type PassoDaEscrita,
} from "./escritas";
export { listarTarefas, lerTarefa, inserirTarefa, mudarTarefa } from "./tarefas";
export { apagarCache, gravarCache, lerCache, listarCache, type LinhaDoCache, type RecursoDoCache } from "./cache";
export { desfazerIgnorado, ignorarItem, ignoradosValendo } from "./ignorados";
export {
  conversasIgnoradasValendo,
  decidirVinculoDoVendedor,
  desfazerConversaIgnorada,
  desfazerDecisaoDoVendedor,
  gravarConversasLidas,
  gravarVinculoConsultado,
  ignorarConversa,
  lerConversasLidas,
  lerVinculo,
  listarVinculos,
} from "./vinculos";
export { backupDoDia, backupValido, BACKUPS_GUARDADOS, type ResultadoDoBackup } from "./backup";
export * as esquema from "./esquema";

/**
 * Abre o banco do núcleo e aplica a trilha dele. Depois aplica a trilha do vendedor em `meu.db`,
 * outro arquivo. O banco do núcleo segue aberto e travado nesse meio-tempo: uma migração do
 * vendedor que tente alcançá-lo por outro caminho recebe `database is locked`.
 */
export function prepararBanco(opcoes: {
  readonly caminho: string;
  readonly caminhoDoVendedor: string;
  readonly dirBackups: string;
  readonly pastaDoVendedor: string;
  readonly agora: Instante;
}): BancoAberto {
  const banco = abrirBanco(opcoes.caminho);
  try {
    const comum = { dirBackups: opcoes.dirBackups, agora: opcoes.agora };
    migrar(banco.sqlite, { ...comum, trilha: "nucleo", pasta: PASTA_DO_NUCLEO });
    comOBancoDoVendedor(opcoes, (doVendedor) => migrar(doVendedor, { ...comum, trilha: "meu", pasta: opcoes.pastaDoVendedor }));
    return banco;
  } catch (erro) {
    banco.fechar();
    throw erro;
  }
}

/** Migrações do vendedor que ainda não rodaram em `meu.db`. Só vale com o banco do núcleo na mão de quem chama. */
export function pendentesDoVendedor(opcoes: { readonly caminhoDoVendedor: string; readonly pastaDoVendedor: string }): string[] {
  return comOBancoDoVendedor(opcoes, (doVendedor) => migracoesPendentes(doVendedor, "meu", opcoes.pastaDoVendedor)) ?? [];
}

/** Sem migração e sem arquivo, `meu.db` não é criado e `tarefa` não roda. */
function comOBancoDoVendedor<T>(
  opcoes: { readonly caminhoDoVendedor: string; readonly pastaDoVendedor: string },
  tarefa: (doVendedor: Database) => T,
): T | undefined {
  if (lerMigracoes(opcoes.pastaDoVendedor).length === 0 && !existsSync(opcoes.caminhoDoVendedor)) return undefined;
  const doVendedor = abrirExclusivo(opcoes.caminhoDoVendedor);
  try {
    return tarefa(doVendedor);
  } finally {
    doVendedor.close(true);
  }
}

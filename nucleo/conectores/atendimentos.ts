import { STATUS_DO_ATENDIMENTO, type Atendimento, type ErroOperacao } from "../dominio";
import type { LeitorDoCrm } from "./crm/leitura";

/** As mesmas medidas da sincronização: páginas de 50, até 20 por leitura. */
const PAGINAS_NO_MAXIMO = 20;
const POR_PAGINA = 50;

export type AtendimentosLidos =
  | { readonly itens: readonly Atendimento[]; readonly cortado: boolean; readonly foraPorCadastroIncompleto: number }
  | { readonly erro: ErroOperacao };

/**
 * Uma leitura por status, na ordem de `STATUS_DO_ATENDIMENTO`, cada uma com todas as páginas por `antes`.
 * Sem `status` o CRM devolveria só os abertos, e o relatório precisa dos quatro. A primeira leitura que
 * falha encerra tudo: nada parcial sai como se fosse o período inteiro. O atendimento com campo
 * obrigatório vazio fica de fora e entra só na contagem.
 */
export async function lerAtendimentos(leitor: LeitorDoCrm, desde: string): Promise<AtendimentosLidos> {
  const porId = new Map<number, Atendimento>();
  let cortado = false;
  let fora = 0;
  for (const status of STATUS_DO_ATENDIMENTO) {
    let antes: number | undefined;
    for (let pagina = 0; ; pagina += 1) {
      if (pagina === PAGINAS_NO_MAXIMO) {
        cortado = true;
        break;
      }
      const lida = await leitor.ler("meus_atendimentos", { status, desde, limite: POR_PAGINA, ...(antes === undefined ? {} : { antes }) });
      if (!lida.ok) return { erro: lida.erro };
      fora += lida.dados.fora_por_cadastro_incompleto;
      for (const item of lida.dados.atendimentos) if (!porId.has(item.id)) porId.set(item.id, item);
      antes = lida.dados.ultimo_id ?? undefined;
      if (!lida.dados.mais || antes === undefined) break;
    }
  }
  return { itens: [...porId.values()], cortado, foraPorCadastroIncompleto: fora };
}

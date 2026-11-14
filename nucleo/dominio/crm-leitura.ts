import { diaEm, type Dia } from "./dia";
import type { Sinal } from "./injecao";
import type { EstadoCrm, Instante, TextoExterno } from "./tipos";

/**
 * O que a Secretária lê do CRM, já convertido na borda (`nucleo/conectores/crm/leitura.ts`).
 * Os nomes dos campos seguem os do MCP do CRM. Texto livre do CRM é `TextoExterno`: dado, nunca
 * instrução. Valor monetário fica como a string que o CRM mandou.
 */

export interface ClienteRef {
  readonly id: number;
  readonly nome: TextoExterno;
}

export interface Compromisso {
  readonly id: number;
  readonly titulo: TextoExterno;
  readonly inicio: Instante;
  readonly fim: Instante | null;
  readonly tipo: TextoExterno;
  readonly cliente: ClienteRef | null;
}

/** Os quatro status de um atendimento no CRM, na ordem em que o relatório os lê. */
export const STATUS_DO_ATENDIMENTO = ["Em Andamento", "Concluído", "Pendente", "Cancelado"] as const;
export type StatusDoAtendimento = (typeof STATUS_DO_ATENDIMENTO)[number];

/** Um atendimento do vendedor, como `meus_atendimentos` o devolve. A descrição não vem nessa tool. */
export interface Atendimento {
  readonly id: number;
  readonly assunto: TextoExterno;
  /** Os sinais que o assunto cru acende, calculados antes de `textoExterno` apagar o caractere invisível. */
  readonly sinais: readonly Sinal[];
  readonly status: StatusDoAtendimento;
  /** O dia do atendimento em Brasília. */
  readonly data: Dia;
  readonly cliente: ClienteRef;
  /** Os sinais que o nome cru do cliente acende, pela mesma regra do assunto. */
  readonly sinaisDoCliente: readonly Sinal[];
}

/** Uma proposta do vendedor no estágio `enviada`, como `listar_propostas` a devolve, mais o `link` de `ver_proposta`. */
export interface PropostaEnviada {
  readonly id: number;
  readonly codigo: TextoExterno;
  readonly versao: number;
  readonly cliente: ClienteRef;
  readonly valor_total: string | null;
  readonly moeda: string | null;
  /** O dia do envio em Brasília. */
  readonly enviada_em: Dia;
  /** O dia em que vencem os 30 dias do envio. */
  readonly prazo_retorno: Dia | null;
  /** A proposta na tela do CRM. `null` enquanto `ver_proposta` não foi lido para ela. */
  readonly link: string | null;
}

export interface ClienteDaCarteira {
  readonly id: number;
  readonly nome: TextoExterno;
  readonly nome_fantasia: TextoExterno | null;
  readonly cidade: TextoExterno | null;
  readonly uf: TextoExterno | null;
  readonly ultimo_atendimento_em: Instante | null;
  /** A data é anterior a 03/07/2026, e o CRM só garante "nesse dia ou antes". */
  readonly ultimo_atendimento_aproximado: boolean;
}

export interface FichaDoCliente {
  readonly id: number;
  readonly nome: TextoExterno;
  readonly cidade: TextoExterno | null;
  readonly uf: TextoExterno | null;
  readonly link: string | null;
}

export interface ClienteBuscado {
  readonly id: number;
  readonly nome: TextoExterno;
  readonly cidade: TextoExterno | null;
  readonly uf: TextoExterno | null;
  /** Os rótulos de onde a busca bateu, como o CRM disse. Vazia quando ausente ou fora do formato. Não decide vínculo. */
  readonly bateu_em: readonly TextoExterno[];
  /** Só o telefone e o e-mail de cada contato, crus: nome e cargo ficam de fora na leitura. Os dois só provam o vínculo. */
  readonly contatos: readonly { readonly telefone: string | null; readonly email: string | null }[];
}

export interface DetalheDaProposta {
  readonly id: number;
  readonly codigo: TextoExterno;
  readonly versao: number;
  readonly ativa: boolean;
  readonly estagio: TextoExterno;
  readonly cliente: ClienteRef;
  readonly link: string | null;
  /** `forma_escolhida.valor_final`: o valor fechado, só em `cliente_aceitou`. */
  readonly valor_final: string | null;
}

/** As fontes da sincronização. Cada uma falha sozinha. */
export const FONTES_DO_CRM = ["agenda", "propostas", "carteira"] as const;
export type FonteDoCrm = (typeof FONTES_DO_CRM)[number];

/** Uma leitura inteira de uma fonte, como ficou no cache. `cortado` diz que o CRM tinha mais do que a Secretária leu. */
export interface LeituraDoCrm<T> {
  readonly lidoEm: Instante;
  readonly itens: readonly T[];
  readonly cortado: boolean;
  /** Itens que o CRM mandou com campo obrigatório vazio e ficaram de fora de `itens`. */
  readonly foraPorCadastroIncompleto: number;
}

export interface LeiturasDoCrm {
  /** A agenda do dia em que foi lida. Agenda de outro dia não serve para hoje. */
  readonly agenda: (LeituraDoCrm<Compromisso> & { readonly dia: Dia }) | null;
  readonly propostas: LeituraDoCrm<PropostaEnviada> | null;
  readonly carteira: (LeituraDoCrm<ClienteDaCarteira> & { readonly semAtendimentoHaDias: number }) | null;
}

export const SEM_LEITURAS: LeiturasDoCrm = { agenda: null, propostas: null, carteira: null };

/** O CRM bloqueia proposta nova do vendedor para o cliente quando este prazo vence sem o retorno registrado. */
export const PRAZO_DE_RETORNO_DIAS = 30;
export const FAIXAS_DA_PROPOSTA = [7, 14, 28] as const;
export type FaixaDaProposta = (typeof FAIXAS_DA_PROPOSTA)[number];
export const SEM_ATENDIMENTO_PADRAO_DIAS = 30;
export const SEM_ATENDIMENTO_MAXIMO_DIAS = 3650;

export const AVISO_DO_PRAZO_DE_RETORNO =
  "Vencidos 30 dias do envio sem o retorno do cliente registrado na tela do CRM, o CRM bloqueia proposta nova sua para esse cliente.";

/** A frase de `fora_por_cadastro_incompleto` para o vendedor, igual no painel e no CLI. `null` com zero. */
export function fraseDoCadastroIncompleto(fora: number): string | null {
  if (fora === 0) return null;
  const quantos = fora === 1 ? "1 item do CRM ficou" : `${fora} itens do CRM ficaram`;
  return `${quantos} de fora por cadastro incompleto. Corrija o cadastro no CRM.`;
}

/** Por que um bloco veio vazio. `sem_itens` é leitura feita e lista vazia. */
export type MotivoDoBloco =
  | "sem_itens"
  | "sem_leitura"
  | "crm_desconectado"
  | "crm_autorizando"
  | "crm_app_nao_liberado"
  | "crm_em_atencao";

export interface BlocoDoCrm<I> {
  readonly itens: readonly I[];
  /** Quando o CRM foi lido. `null` sem leitura. */
  readonly lido_em: Instante | null;
  /** `null` quando há itens. */
  readonly motivo: MotivoDoBloco | null;
  readonly cortado: boolean;
  /** Itens que o CRM mandou com campo obrigatório vazio: ficaram de fora, e o vendedor corrige o cadastro no CRM. */
  readonly fora_por_cadastro_incompleto: number;
}

export interface PropostaAberta extends PropostaEnviada {
  readonly dias_desde_envio: number;
  /** O maior marco atingido: 7, 14 ou 28 dias. `null` antes de 7 dias. */
  readonly faixa: FaixaDaProposta | null;
  /** Dias até `prazo_retorno`; negativo depois de vencer. */
  readonly dias_para_o_prazo: number;
  readonly prazo_vencido: boolean;
}

export interface ClienteSemAtendimento extends ClienteDaCarteira {
  /** Dias de Brasília desde o último atendimento. `null` quando nunca houve. */
  readonly dias_sem_atendimento: number | null;
}

/** O que o vendedor pode tirar da lista por um tempo: uma proposta aberta ou um cliente sem atendimento. */
export const TIPOS_DE_IGNORADO = ["proposta", "cliente"] as const;
export type TipoDeIgnorado = (typeof TIPOS_DE_IGNORADO)[number];

/** Por quantos dias o item some. Depois volta sozinho, se ainda estiver pendente no CRM. */
export const IGNORAR_POR_DIAS = 7;

/** Quem tirou o item da lista: o vendedor, no painel, ou o agente, pelo CLI, a pedido dele. */
export const QUEM_IGNORA = ["vendedor", "agente"] as const;
export type QuemIgnorou = (typeof QUEM_IGNORA)[number];

export const TAMANHO_DO_MOTIVO = { minimo: 5, maximo: 300 } as const;

/**
 * Uma marca de ignorado como o banco guarda. `nome` e `codigo` são os do item na leitura em que foi
 * ignorado, para o Meu dia mostrar a marca mesmo sem o cache do CRM. O agente sempre deixa `motivo`.
 */
export interface MarcaDeIgnorado {
  readonly tipo: TipoDeIgnorado;
  readonly id: number;
  /** O nome do cliente, o da proposta ou o da carteira. */
  readonly nome: TextoExterno;
  /** O código da proposta. `null` para cliente. */
  readonly codigo: TextoExterno | null;
  readonly quem: QuemIgnorou;
  /** As palavras do vendedor. `null` quando ele ignorou no painel sem dizer por quê. */
  readonly motivo: string | null;
  /** O primeiro dia de Brasília em que o item volta. */
  readonly ate: Dia;
}

/** As marcas que valem hoje. */
export type Ignorados = readonly MarcaDeIgnorado[];

/** O primeiro dia de Brasília em que o item ignorado em `agora` volta ao Meu dia. */
export function voltaEm(agora: Instante): Dia {
  return somarAoDia(diaEm(agora), IGNORAR_POR_DIAS);
}

export const SEM_IGNORADOS: Ignorados = [];

/** Item que o agente tirou do Meu dia, com as palavras do vendedor. O Meu dia mostra cada um com o Desfazer. */
export interface IgnoradoPeloAgente {
  readonly tipo: TipoDeIgnorado;
  readonly id: number;
  readonly nome: TextoExterno;
  readonly codigo: TextoExterno | null;
  readonly motivo: string;
  readonly ate: Dia;
}

/** As marcas do agente, das que voltam antes para as que voltam depois. */
export function ignoradosPeloAgente(ignorados: Ignorados): IgnoradoPeloAgente[] {
  return ignorados
    .filter((marca): marca is MarcaDeIgnorado & { readonly motivo: string } => marca.quem === "agente" && marca.motivo !== null)
    .map(({ tipo, id, nome, codigo, motivo, ate }) => ({ tipo, id, nome, codigo, motivo, ate }))
    .sort((a, b) => a.ate.localeCompare(b.ate) || a.tipo.localeCompare(b.tipo) || a.id - b.id);
}

/** O motivo é uma linha de texto do vendedor. Devolve o texto aparado, ou `null` fora da forma. */
export function lerMotivo(texto: string): string | null {
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(texto)) return null;
  const motivo = texto.trim();
  const tamanho = [...motivo].length;
  return tamanho >= TAMANHO_DO_MOTIVO.minimo && tamanho <= TAMANHO_DO_MOTIVO.maximo ? motivo : null;
}

/** A quantos dias do bloqueio de 30 dias a proposta passa a ser só do vendedor ignorar. */
export const PERTO_DO_BLOQUEIO_DIAS = 7;

/**
 * O agente não tira do Meu dia a proposta a `PERTO_DO_BLOQUEIO_DIAS` dias ou menos do bloqueio do
 * CRM, nem a vencida: sumir com ela por 7 dias deixaria o prazo passar sem o vendedor ver.
 */
export function soOVendedorIgnora(proposta: PropostaEnviada, hoje: Dia): boolean {
  return propostaAberta(proposta, hoje).dias_para_o_prazo <= PERTO_DO_BLOQUEIO_DIAS;
}

/** `ignorados` conta os itens da leitura que o vendedor tirou da lista. */
export interface BlocosDoCrm {
  readonly compromissos_de_hoje: BlocoDoCrm<Compromisso>;
  readonly propostas_abertas: BlocoDoCrm<PropostaAberta> & { readonly prazo_dias: number; readonly aviso: string; readonly ignorados: number };
  readonly clientes_sem_atendimento: BlocoDoCrm<ClienteSemAtendimento> & { readonly sem_atendimento_ha_dias: number; readonly ignorados: number };
}

const UM_DIA_MS = 86_400_000;

/** Dias de calendário de `de` até `ate`. Negativo quando `ate` vem antes. */
export function diasEntre(de: Dia, ate: Dia): number {
  return Math.round((Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / UM_DIA_MS);
}

/** O dia de calendário `dias` depois de `dia`. */
export function somarAoDia(dia: Dia, dias: number): Dia {
  return new Date(Date.parse(`${dia}T00:00:00Z`) + dias * UM_DIA_MS).toISOString().slice(0, 10) as Dia;
}

export function faixaDaProposta(diasDesdeEnvio: number): FaixaDaProposta | null {
  return FAIXAS_DA_PROPOSTA.findLast((marco) => diasDesdeEnvio >= marco) ?? null;
}

export function propostaAberta(proposta: PropostaEnviada, hoje: Dia): PropostaAberta {
  const dias = diasEntre(proposta.enviada_em, hoje);
  const prazo = proposta.prazo_retorno ?? somarAoDia(proposta.enviada_em, PRAZO_DE_RETORNO_DIAS);
  const diasParaOPrazo = diasEntre(hoje, prazo);
  return { ...proposta, dias_desde_envio: dias, faixa: faixaDaProposta(dias), dias_para_o_prazo: diasParaOPrazo, prazo_vencido: diasParaOPrazo <= 0 };
}

/** Sem leitura, o motivo do bloco vazio vem do estado do CRM: o vendedor sabe o que fazer. */
function motivoSemLeitura(crm: EstadoCrm): MotivoDoBloco {
  switch (crm.fase) {
    case "conectado":
      return "sem_leitura";
    case "desconectado":
      return "crm_desconectado";
    case "autorizando":
      return "crm_autorizando";
    case "atencao":
      return crm.problema.codigo === "crm_app_nao_liberado" ? "crm_app_nao_liberado" : "crm_em_atencao";
  }
}

function bloco<T, I>(leitura: LeituraDoCrm<T> | null, crm: EstadoCrm, converter: (item: T) => I): BlocoDoCrm<I> {
  if (leitura === null) return { itens: [], lido_em: null, motivo: motivoSemLeitura(crm), cortado: false, fora_por_cadastro_incompleto: 0 };
  const itens = leitura.itens.map(converter);
  return { itens, lido_em: leitura.lidoEm, motivo: itens.length === 0 ? "sem_itens" : null, cortado: leitura.cortado, fora_por_cadastro_incompleto: leitura.foraPorCadastroIncompleto };
}

/** A leitura sem os itens ignorados. A lista que sobra vazia é `sem_itens`, como uma leitura vazia. */
function semIgnorados<T extends { readonly id: number }, L extends LeituraDoCrm<T>>(leitura: L | null, ignorados: Ignorados, tipo: TipoDeIgnorado): { leitura: L | null; ignorados: number } {
  if (leitura === null) return { leitura, ignorados: 0 };
  const ids = new Set(ignorados.filter((marca) => marca.tipo === tipo).map((marca) => marca.id));
  const itens = leitura.itens.filter((item) => !ids.has(item.id));
  return { leitura: { ...leitura, itens }, ignorados: leitura.itens.length - itens.length };
}

/**
 * Os blocos do CRM no Meu dia, lidos só do cache. Leitura velha aparece com o `lido_em` dela;
 * a agenda de outro dia não aparece. Propostas do mais velho para o mais novo envio. Proposta e
 * cliente ignorados ficam fora da lista e entram só na contagem `ignorados`.
 */
export function montarBlocosDoCrm(leituras: LeiturasDoCrm, crm: EstadoCrm, hoje: Dia, ignorados: Ignorados = SEM_IGNORADOS): BlocosDoCrm {
  const agenda = leituras.agenda?.dia === hoje ? leituras.agenda : null;
  const compromissos = bloco(agenda, crm, (item) => item);
  const ordenadaPorInicio = [...compromissos.itens].sort((a, b) => a.inicio.localeCompare(b.inicio));

  const enviadas = semIgnorados(leituras.propostas, ignorados, "proposta");
  const propostas = bloco(enviadas.leitura, crm, (item) => propostaAberta(item, hoje));
  const porEnvio = [...propostas.itens].sort((a, b) => b.dias_desde_envio - a.dias_desde_envio || a.id - b.id);

  const carteira = semIgnorados(leituras.carteira, ignorados, "cliente");
  const clientes = bloco(carteira.leitura, crm, (item): ClienteSemAtendimento => ({
    ...item,
    dias_sem_atendimento: item.ultimo_atendimento_em === null ? null : diasEntre(diaEm(item.ultimo_atendimento_em), hoje),
  }));

  return {
    compromissos_de_hoje: { ...compromissos, itens: ordenadaPorInicio },
    propostas_abertas: { ...propostas, itens: porEnvio, prazo_dias: PRAZO_DE_RETORNO_DIAS, aviso: AVISO_DO_PRAZO_DE_RETORNO, ignorados: enviadas.ignorados },
    clientes_sem_atendimento: {
      ...clientes,
      sem_atendimento_ha_dias: leituras.carteira?.semAtendimentoHaDias ?? SEM_ATENDIMENTO_PADRAO_DIAS,
      ignorados: carteira.ignorados,
    },
  };
}

import { chaveDoItem, fraseDoCadastroIncompleto } from "../dominio";
import type {
  CanalDeVinculo,
  ClienteSemAtendimento,
  Compromisso,
  Dia,
  ErroOperacao,
  FonteDaSincronizacao,
  IgnoradoDeConversa,
  IgnoradoPeloAgente,
  Instante,
  ItemDeEsperando,
  ItemDeResponder,
  LeituraDoEmailNoBloco,
  MotivoDoBloco,
  MotivoDoBlocoDeConversas,
  MotivoDoEmailNoBloco,
  PropostaAberta,
  TipoDeIgnorado,
} from "../dominio";
import type { ResumoDaEscrita } from "../escritas";
import type { AndamentoDaSincronizacao, MotivoDoPulo, ResultadoDaFonte, Sincronizacao } from "../conectores";
import type { MeuDia, Tarefa } from "../tarefas";
import { apoioDoCartao, tituloDoCartao } from "./aprovar";
import { apoioDeEsperando, apoioDeResponder, apoioDoEmailEmEsperando, apoioDoEmailEmResponder, nomeDoIgnoradoDeConversa, tituloDaConversa, tituloDoEmail } from "./conversas";
import { formatarDia, idadeEmTexto, rodapeDasFontes, somarDias } from "./tarefas";

/**
 * O Meu dia em resumo e detalhe: uma fileira de contadores, um por bloco, e a lista do bloco
 * escolhido embaixo. Bloco novo entra só em `BLOCOS`: a tela, a seleção e o hash leem dali.
 */

export type ItemDoDia =
  | { readonly tipo: "tarefa"; readonly chave: string; readonly tarefa: Tarefa }
  | { readonly tipo: "compromisso"; readonly chave: string; readonly compromisso: Compromisso }
  | { readonly tipo: "proposta"; readonly chave: string; readonly proposta: PropostaAberta }
  | { readonly tipo: "cliente"; readonly chave: string; readonly cliente: ClienteSemAtendimento }
  /** O cartão da fila de aprovação. A chave é `escrita:<id>`; título e apoio saem prontos e nunca levam texto do payload. */
  | { readonly tipo: "aprovar"; readonly chave: string; readonly escrita: ResumoDaEscrita; readonly titulo: string; readonly apoio: string }
  /** `titulo` e `apoio` já saem prontos: a linha nunca vê texto de mensagem nem corpo de e-mail. */
  | { readonly tipo: "responder"; readonly chave: string; readonly conversa: ItemDeResponder; readonly titulo: string; readonly apoio: string }
  | { readonly tipo: "esperando"; readonly chave: string; readonly conversa: ItemDeEsperando; readonly titulo: string; readonly apoio: string };

/**
 * O que o vendedor pode tirar da lista ou virar tarefa: proposta e cliente pelo id do CRM, conversa
 * pelo canal e pela chave do item (o telefone, ou o id `e-...` do item de e-mail).
 */
export type AlvoDoDia = { readonly tipo: TipoDeIgnorado; readonly id: number } | { readonly tipo: "conversa"; readonly canal: CanalDeVinculo; readonly id: string };

/** Os filtros da fileira de canal de Responder e de Esperando cliente. */
export type FiltroDeCanal = "tudo" | "whatsapp" | "email";

/** Quantos itens da lista cada filtro mostra. Os ignorados não contam. */
export type ContagemDoFiltro = { readonly [F in FiltroDeCanal]: number };

export const FILTROS_DE_CANAL: readonly { readonly id: FiltroDeCanal; readonly rotulo: string }[] = [
  { id: "tudo", rotulo: "Tudo" },
  { id: "whatsapp", rotulo: "WhatsApp" },
  { id: "email", rotulo: "E-mail" },
];

/** A escolha de filtro de cada bloco. Só vive na tela: não vai ao hash nem ao navegador. */
export type FiltrosPorBloco = { readonly [B in IdDoBloco]?: FiltroDeCanal };

/** Por que um bloco não pôde ser lido. `sem_itens` é leitura feita, então não entra aqui. */
export type MotivoSemLeitura = Exclude<MotivoDoBloco, "sem_itens"> | Exclude<MotivoDoBlocoDeConversas, "sem_itens">;
type MotivoDoCrm = Exclude<MotivoDoBloco, "sem_itens">;
type MotivoDoWhatsapp = Exclude<MotivoDoBlocoDeConversas, "sem_itens">;

/** De onde o bloco lê: o CRM ou as conversas do WhatsApp. O mesmo `sem_leitura` diz coisas diferentes em cada um. */
export type FonteDoBloco = "crm" | "whatsapp";

/**
 * O que um bloco tem. `lido` vale para a lista que o vendedor pode conferir, inclusive vazia;
 * `nao_lido` é o bloco do CRM sem leitura, que nunca mostra zero.
 */
export type ConteudoDoBloco =
  | {
      readonly leitura: "lido";
      readonly itens: readonly ItemDoDia[];
      readonly notas: readonly string[];
      /** As contagens da fileira de canal. Só Responder e Esperando cliente, e só com e-mail conectado ou item de e-mail. */
      readonly filtro?: ContagemDoFiltro;
      /** A frase de cada canal sem item na lista: a de lista vazia, ou o motivo quando o canal não foi lido. Vem junto do `filtro`. */
      readonly vazioDoFiltro?: { readonly [C in CanalDeVinculo]: string };
    }
  | { readonly leitura: "nao_lido"; readonly fonte: FonteDoBloco; readonly motivo: MotivoSemLeitura };

export const IDS_DOS_BLOCOS = ["fazer-hoje", "sem-data", "aprovar", "responder", "propostas", "esperando-cliente", "sem-atendimento"] as const;
export type IdDoBloco = (typeof IDS_DOS_BLOCOS)[number];

export interface DefinicaoDoBloco {
  readonly id: IdDoBloco;
  readonly nome: string;
  readonly dica: (dia: MeuDia) => string;
  /** Frase curta do bloco lido e vazio. */
  readonly vazio: string;
  readonly montar: (dia: MeuDia) => ConteudoDoBloco;
}

function ehMotivoSemLeitura(motivo: MotivoDoBloco | null): motivo is MotivoDoCrm {
  return motivo !== null && motivo !== "sem_itens";
}

function ehMotivoDoWhatsapp(motivo: MotivoDoBlocoDeConversas | null): motivo is MotivoDoWhatsapp {
  return motivo !== null && motivo !== "sem_itens";
}

/** O instante do Meu dia: a idade das fontes é medida a partir da leitura de Tarefas, que é de agora. */
function agoraDoDia(dia: MeuDia): Instante {
  return dia.fontes.find((fonte) => fonte.fonte === "tarefas")?.lidaEm ?? (new Date().toISOString() as Instante);
}

function plural(n: number, um: string, varios: string): string {
  return n === 1 ? `1 ${um}` : `${n} ${varios}`;
}

function notaDosIgnorados(ignorados: number, um: string, varios: string): string[] {
  return ignorados === 0 ? [] : [`${plural(ignorados, um, varios)} por 7 dias.`];
}

function notaDoCadastroIncompleto(bloco: { readonly fora_por_cadastro_incompleto: number }): string[] {
  const frase = fraseDoCadastroIncompleto(bloco.fora_por_cadastro_incompleto);
  return frase === null ? [] : [frase];
}

/** A chave da linha leva o canal: o telefone e o id de e-mail nunca se confundem. */
function chaveDaLinha(conversa: Parameters<typeof chaveDoItem>[0]): string {
  return `conversa:${conversa.canal}:${chaveDoItem(conversa)}`;
}

type SemLeituraDoEmail = Extract<MotivoDoEmailNoBloco, "email_sem_conta" | "email_sem_conta_conectada" | "sem_leitura">;

function emailSemLeitura(motivo: MotivoDoEmailNoBloco | null): motivo is SemLeituraDoEmail {
  return motivo === "email_sem_conta" || motivo === "email_sem_conta_conectada" || motivo === "sem_leitura";
}

/** O bloco só é "não lido" quando nenhum dos dois canais tem leitura. Com o e-mail lido, o WhatsApp sem leitura vira linha discreta. */
function blocoSemLeitura<B extends { readonly motivo: MotivoDoBlocoDeConversas | null; readonly email: LeituraDoEmailNoBloco }>(bloco: B): bloco is B & { readonly motivo: MotivoDoWhatsapp } {
  return ehMotivoDoWhatsapp(bloco.motivo) && emailSemLeitura(bloco.email.motivo);
}

const NOTA_DO_CORTE_DO_EMAIL = "Ainda há e-mails para conferir. Sincronize de novo.";

function notaDosTratados(tratados: number): string[] {
  if (tratados === 0) return [];
  return [tratados === 1 ? "1 conversa saiu porque você concluiu a tarefa dela. Ela volta se chegar mensagem nova." : `${tratados} conversas saíram porque você concluiu as tarefas delas. Cada uma volta se chegar mensagem nova.`];
}

function notasDasConversas(bloco: { readonly cortado: boolean; readonly ignorados: number; readonly tratados: number; readonly email: LeituraDoEmailNoBloco }): string[] {
  return [
    ...(bloco.cortado ? [NOTA_DO_CORTE_DAS_CONVERSAS] : []),
    ...(bloco.email.cortado ? [NOTA_DO_CORTE_DO_EMAIL] : []),
    ...bloco.email.contas_sem_enviados.map((rotulo) => `A conta "${rotulo}" não mostrou a pasta de enviados. O e-mail que você já respondeu por ela continua em Responder.`),
    ...notaDosIgnorados(bloco.ignorados, "conversa ignorada", "conversas ignoradas"),
    ...notaDosTratados(bloco.tratados),
  ];
}

function canalDoItem(item: ItemDoDia): CanalDeVinculo | null {
  return item.tipo === "responder" || item.tipo === "esperando" ? item.conversa.canal : null;
}

type BlocoDeConversas = { readonly motivo: MotivoDoBlocoDeConversas | null; readonly email: LeituraDoEmailNoBloco };

/** A fileira de canal aparece com conta de e-mail conectada ou item de e-mail. Sem isso, a lista é a de sempre. */
function filtroDoBloco(bloco: BlocoDeConversas, itens: readonly ItemDoDia[]): Pick<Extract<ConteudoDoBloco, { readonly leitura: "lido" }>, "filtro" | "vazioDoFiltro"> {
  if (bloco.email.motivo === "email_sem_conta" || bloco.email.motivo === "email_sem_conta_conectada") return {};
  const doCanal = (canal: CanalDeVinculo) => itens.filter((item) => canalDoItem(item) === canal).length;
  return {
    filtro: { tudo: itens.length, whatsapp: doCanal("whatsapp"), email: doCanal("email") },
    vazioDoFiltro: { whatsapp: textoDoFiltroVazio("whatsapp", bloco), email: textoDoFiltroVazio("email", bloco) },
  };
}

/** O filtro que vale: o escolhido, só quando o bloco tem a fileira. Sem ela, tudo. */
export function filtroAplicado(conteudo: ConteudoDoBloco, escolhido: FiltroDeCanal | undefined): FiltroDeCanal {
  return conteudo.leitura === "lido" && conteudo.filtro !== undefined ? (escolhido ?? "tudo") : "tudo";
}

export function itensFiltrados(itens: readonly ItemDoDia[], filtro: FiltroDeCanal): readonly ItemDoDia[] {
  return filtro === "tudo" ? itens : itens.filter((item) => canalDoItem(item) === filtro);
}

/** Canal sem leitura não diz "nenhuma": diz que não foi lido. */
function textoDoFiltroVazio(filtro: CanalDeVinculo, bloco: BlocoDeConversas): string {
  if (filtro === "whatsapp") return ehMotivoDoWhatsapp(bloco.motivo) ? MOTIVOS_DO_WHATSAPP[bloco.motivo].texto : "Nenhuma conversa do WhatsApp aqui agora.";
  return bloco.email.motivo === "sem_leitura" ? MOTIVOS_DO_EMAIL.sem_leitura.texto : "Nenhum e-mail aqui agora.";
}

/** Tira a escolha dos blocos que perderam a fileira: quando ela volta, a lista abre em "Tudo". Devolve o mesmo objeto se nada mudou. */
export function limparFiltros(filtros: FiltrosPorBloco, blocos: readonly BlocoMontado[]): FiltrosPorBloco {
  const sobram = Object.entries(filtros).filter(([id]) => {
    const conteudo = blocos.find(({ definicao }) => definicao.id === id)?.conteudo;
    return conteudo?.leitura === "lido" && conteudo.filtro !== undefined;
  });
  return sobram.length === Object.keys(filtros).length ? filtros : Object.fromEntries(sobram);
}

const NOTA_DO_CORTE = "O CRM tem mais do que a Secretária lê de uma vez. Confira a lista completa no CRM.";
const NOTA_DO_CORTE_DAS_CONVERSAS = "Ainda há conversas para conferir. Sincronize de novo.";

export const BLOCOS: readonly DefinicaoDoBloco[] = [
  {
    id: "fazer-hoje",
    nome: "Fazer hoje",
    dica: () => "Tarefas e compromissos",
    vazio: "Nada para hoje.",
    montar(dia) {
      const atrasadas = dia.fazer_hoje.filter((t) => t.situacao === "atrasada");
      const deHoje = dia.fazer_hoje.filter((t) => t.situacao === "hoje");
      const agenda = dia.compromissos_de_hoje;
      const itens: ItemDoDia[] = [
        ...atrasadas.map((tarefa) => ({ tipo: "tarefa" as const, chave: `tarefa:${tarefa.id}`, tarefa })),
        ...deHoje.map((tarefa) => ({ tipo: "tarefa" as const, chave: `tarefa:${tarefa.id}`, tarefa })),
        ...agenda.itens.map((compromisso) => ({ tipo: "compromisso" as const, chave: `compromisso:${compromisso.id}`, compromisso })),
      ];
      // As tarefas são locais e sempre lidas; só a parte da agenda depende do CRM.
      const notas = ehMotivoSemLeitura(agenda.motivo)
        ? [`Compromissos do CRM: ${MOTIVOS[agenda.motivo].texto}`]
        : [...(agenda.cortado ? [NOTA_DO_CORTE] : []), ...notaDoCadastroIncompleto(agenda)];
      return { leitura: "lido", itens, notas };
    },
  },
  {
    id: "sem-data",
    nome: "Sem data",
    dica: () => "Tarefas sem prazo",
    vazio: "Nenhuma tarefa sem data.",
    montar: (dia) => ({ leitura: "lido", itens: dia.sem_data.map((tarefa) => ({ tipo: "tarefa", chave: `tarefa:${tarefa.id}`, tarefa })), notas: [] }),
  },
  {
    id: "aprovar",
    nome: "Aprovar",
    dica: () => "O agente redigiu, você decide",
    vazio: "Nada para aprovar. Quando o agente redigir algo para o CRM, aparece aqui.",
    // A fila é local e não depende de sincronização: o bloco é sempre lido.
    montar(dia) {
      const agora = new Date(agoraDoDia(dia));
      const itens = dia.aprovar.map(
        (escrita): ItemDoDia => ({ tipo: "aprovar", chave: `escrita:${escrita.id}`, escrita, titulo: tituloDoCartao(escrita), apoio: apoioDoCartao(escrita, agora) }),
      );
      return { leitura: "lido", itens, notas: [] };
    },
  },
  {
    id: "responder",
    nome: "Responder",
    dica: () => "Clientes que falaram por último",
    vazio: "Nenhuma conversa esperando resposta.",
    montar(dia) {
      const bloco = dia.responder;
      if (blocoSemLeitura(bloco)) return { leitura: "nao_lido", fonte: "whatsapp", motivo: bloco.motivo };
      const agora = agoraDoDia(dia);
      const itens = bloco.itens.map(
        (conversa): ItemDoDia =>
          conversa.canal === "email"
            ? { tipo: "responder", chave: chaveDaLinha(conversa), conversa, titulo: tituloDoEmail(conversa), apoio: apoioDoEmailEmResponder(conversa, agora) }
            : { tipo: "responder", chave: chaveDaLinha(conversa), conversa, titulo: tituloDaConversa(conversa), apoio: apoioDeResponder(conversa, agora) },
      );
      return { leitura: "lido", itens, notas: notasDasConversas(bloco), ...filtroDoBloco(bloco, itens) };
    },
  },
  {
    id: "propostas",
    nome: "Propostas abertas",
    dica: () => "Enviadas e sem retorno registrado",
    vazio: "Nenhuma proposta esperando retorno.",
    montar(dia) {
      const bloco = dia.propostas_abertas;
      if (ehMotivoSemLeitura(bloco.motivo)) return { leitura: "nao_lido", fonte: "crm", motivo: bloco.motivo };
      const itens = bloco.itens.map((proposta): ItemDoDia => ({ tipo: "proposta", chave: `proposta:${proposta.id}`, proposta }));
      return { leitura: "lido", itens, notas: [...(bloco.cortado ? [NOTA_DO_CORTE] : []), ...notaDoCadastroIncompleto(bloco), ...notaDosIgnorados(bloco.ignorados, "ignorada", "ignoradas")] };
    },
  },
  {
    id: "esperando-cliente",
    nome: "Esperando cliente",
    dica: () => "Você falou por último",
    vazio: "Nenhuma conversa parada há 3 dias úteis ou mais.",
    montar(dia) {
      const bloco = dia.esperando_cliente;
      if (blocoSemLeitura(bloco)) return { leitura: "nao_lido", fonte: "whatsapp", motivo: bloco.motivo };
      const itens = bloco.itens.map(
        (conversa): ItemDoDia =>
          conversa.canal === "email"
            ? { tipo: "esperando", chave: chaveDaLinha(conversa), conversa, titulo: tituloDoEmail(conversa), apoio: apoioDoEmailEmEsperando(conversa) }
            : { tipo: "esperando", chave: chaveDaLinha(conversa), conversa, titulo: tituloDaConversa(conversa), apoio: apoioDeEsperando(conversa) },
      );
      return { leitura: "lido", itens, notas: notasDasConversas(bloco), ...filtroDoBloco(bloco, itens) };
    },
  },
  {
    id: "sem-atendimento",
    nome: "Sem atendimento",
    dica: (dia) => `Clientes sem atendimento há ${dia.clientes_sem_atendimento.sem_atendimento_ha_dias} dias ou mais`,
    vazio: "Todos os clientes da carteira foram atendidos.",
    montar(dia) {
      const bloco = dia.clientes_sem_atendimento;
      if (ehMotivoSemLeitura(bloco.motivo)) return { leitura: "nao_lido", fonte: "crm", motivo: bloco.motivo };
      const itens = bloco.itens.map((cliente): ItemDoDia => ({ tipo: "cliente", chave: `cliente:${cliente.id}`, cliente }));
      return { leitura: "lido", itens, notas: [...(bloco.cortado ? [NOTA_DO_CORTE] : []), ...notaDoCadastroIncompleto(bloco), ...notaDosIgnorados(bloco.ignorados, "ignorado", "ignorados")] };
    },
  },
];

export interface BlocoMontado {
  readonly definicao: DefinicaoDoBloco;
  readonly conteudo: ConteudoDoBloco;
}

export function montarBlocos(dia: MeuDia): BlocoMontado[] {
  return BLOCOS.map((definicao) => ({ definicao, conteudo: definicao.montar(dia) }));
}

/** O número do contador. Bloco não lido mostra um traço: zero é só o que foi lido e está limpo. */
export function contador(conteudo: ConteudoDoBloco): { readonly texto: string; readonly apagado: boolean; readonly falado: string } {
  if (conteudo.leitura === "nao_lido") return { texto: "–", apagado: true, falado: "não lido" };
  const n = conteudo.itens.length;
  return { texto: String(n), apagado: n === 0, falado: plural(n, "item", "itens") };
}

/**
 * A lista embaixo dos contadores: um bloco, ou os itens que o agente ignorou a pedido do vendedor.
 * Os ignorados não têm contador; abrem pela linha acima do rodapé.
 */
export type ListaDoDia = IdDoBloco | "ignorados";

/** O bloco da tela: o do hash, se existe; senão o primeiro com item; com tudo vazio, Fazer hoje. */
export function blocoEscolhido(pedido: IdDoBloco | null, blocos: readonly BlocoMontado[]): IdDoBloco {
  if (pedido !== null) return pedido;
  const comItem = blocos.find(({ conteudo }) => conteudo.leitura === "lido" && conteudo.itens.length > 0);
  return comItem?.definicao.id ?? "fazer-hoje";
}

/** A lista da tela. Os ignorados sem item nenhum voltam aos blocos, como se o hash não pedisse lista. */
export function listaEscolhida(pedida: ListaDoDia | null, blocos: readonly BlocoMontado[], ignorados: number): ListaDoDia {
  if (pedida === "ignorados") return ignorados > 0 ? pedida : blocoEscolhido(null, blocos);
  return blocoEscolhido(pedida, blocos);
}

export function lerListaDoDia(texto: string | undefined): ListaDoDia | null {
  if (texto === "ignorados") return texto;
  return IDS_DOS_BLOCOS.find((id) => id === texto) ?? null;
}

/** O texto da linha acima do rodapé, ou `null` quando o agente não ignorou nada. */
export function textoDosIgnorados(n: number): string | null {
  if (n === 0) return null;
  return n === 1 ? "1 item ignorado pelo agente a seu pedido" : `${n} itens ignorados pelo agente a seu pedido`;
}

/** "volta amanhã" ou "volta em 20 de novembro": o dia em que o item reaparece, se ainda pendente. */
export function textoDaVolta(ate: Dia, hoje: Dia): string {
  return ate === somarDias(hoje, 1) ? "volta amanhã" : `volta em ${formatarDia(ate, hoje)}`;
}

export type IgnoradoDoDia = IgnoradoPeloAgente | IgnoradoDeConversa;

/** O que Desfazer manda de volta: o tipo e o id da marca. */
export function alvoDoIgnorado(item: IgnoradoDoDia): AlvoDoDia {
  return item.tipo === "conversa" ? { tipo: "conversa", canal: item.canal, id: String(item.id) } : { tipo: item.tipo, id: Number(item.id) };
}

export function tituloDoIgnorado(item: IgnoradoDoDia): string {
  if (item.tipo === "conversa") return item.canal === "email" ? `E-mail · ${item.nome}` : `WhatsApp · ${nomeDoIgnoradoDeConversa(item.nome)}`;
  return item.codigo === null ? item.nome : `${item.codigo} · ${item.nome}`;
}

/** A linha de apoio: o motivo, com as palavras do vendedor entre aspas, e a volta. */
export function apoioDoIgnorado(item: IgnoradoDoDia, hoje: Dia): string {
  return `"${item.motivo}" · ${textoDaVolta(item.ate, hoje)}`;
}

/** Tudo lido e vazio: a lista dá o estado vazio único, com o que fazer. */
export function diaVazio(blocos: readonly BlocoMontado[]): boolean {
  return blocos.every(({ conteudo }) => conteudo.leitura === "lido" && conteudo.itens.length === 0);
}

/** O que o vendedor lê e pode fazer quando um bloco não pôde ser lido. */
export type AcaoDoMotivo = "sincronizar" | "conexoes" | null;

export interface Explicacao {
  readonly texto: string;
  readonly acao: string;
  readonly botao: AcaoDoMotivo;
}

export const MOTIVOS: { readonly [M in MotivoDoCrm]: Explicacao } = {
  sem_leitura: { texto: "O CRM ainda não foi lido hoje.", acao: "Sincronize para ler agora.", botao: "sincronizar" },
  crm_desconectado: { texto: "O CRM não está conectado.", acao: "Conecte o CRM em Conexões.", botao: "conexoes" },
  crm_autorizando: { texto: "O login do CRM ainda não terminou.", acao: "Termine o login em Conexões.", botao: "conexoes" },
  crm_app_nao_liberado: {
    texto: "O CRM ainda não liberou a Secretária.",
    acao: "A Profills libera o acesso. Assim que liberar, sincronize.",
    botao: null,
  },
  crm_em_atencao: { texto: "O CRM pede atenção.", acao: "Veja o que fazer em Conexões.", botao: "conexoes" },
};

export const MOTIVOS_DO_WHATSAPP: { readonly [M in MotivoDoWhatsapp]: Explicacao } = {
  sem_leitura: { texto: "As conversas do WhatsApp ainda não foram lidas.", acao: "Sincronize para ler agora.", botao: "sincronizar" },
  whatsapp_desconectado: { texto: "O WhatsApp não está conectado.", acao: "Conecte o WhatsApp em Conexões.", botao: "conexoes" },
  whatsapp_em_atencao: { texto: "O WhatsApp pede atenção.", acao: "Veja o que fazer em Conexões.", botao: "conexoes" },
};

/** O e-mail só gera linha discreta sem leitura ou sem conta conectada: o resto não é motivo. */
export const MOTIVOS_DO_EMAIL: { readonly [M in Extract<MotivoDoEmailNoBloco, "sem_leitura" | "email_sem_conta_conectada">]: Explicacao } = {
  sem_leitura: { texto: "Os e-mails ainda não foram lidos.", acao: "Sincronize para ler agora.", botao: "sincronizar" },
  email_sem_conta_conectada: { texto: "Nenhuma conta de e-mail está conectada.", acao: "Conecte em Conexões.", botao: "conexoes" },
};

/** A frase e a ação de um bloco não lido, na tabela da fonte dele. */
export function explicacaoDoMotivo(conteudo: Extract<ConteudoDoBloco, { readonly leitura: "nao_lido" }>): Explicacao {
  const { fonte, motivo } = conteudo;
  const tabela: { readonly [M in string]?: Explicacao } = fonte === "crm" ? MOTIVOS : MOTIVOS_DO_WHATSAPP;
  return tabela[motivo] ?? { texto: "Este bloco não foi lido.", acao: "Sincronize para ler agora.", botao: "sincronizar" };
}

export interface LinhaSemLeitura {
  readonly texto: string;
  readonly botao: AcaoDoMotivo;
}

/**
 * As linhas discretas acima do rodapé: o motivo de cada fonte que não pôde ser lida, sem repetir
 * quando é o mesmo para as duas, nem quando o cartão aberto já o diz. O CRM vem antes do WhatsApp.
 */
export function linhasSemLeitura(dia: MeuDia, lista: ListaDoDia): LinhaSemLeitura[] {
  const crm = cartaoDizOMotivo(dia, lista, "crm") ? undefined : [dia.compromissos_de_hoje.motivo, dia.propostas_abertas.motivo, dia.clientes_sem_atendimento.motivo].find(ehMotivoSemLeitura);
  const whatsapp = cartaoDizOMotivo(dia, lista, "whatsapp") ? undefined : [dia.responder.motivo, dia.esperando_cliente.motivo].find(ehMotivoDoWhatsapp);
  const email = dia.responder.email.motivo === "sem_leitura" || dia.responder.email.motivo === "email_sem_conta_conectada" ? dia.responder.email.motivo : undefined;
  const fontes = [
    { nome: "o CRM", sem: crm === "sem_leitura", linha: crm === undefined ? null : { texto: `${MOTIVOS[crm].texto} ${MOTIVOS[crm].acao}`, botao: MOTIVOS[crm].botao } },
    { nome: "as conversas do WhatsApp", sem: whatsapp === "sem_leitura", linha: whatsapp === undefined ? null : { texto: `${MOTIVOS_DO_WHATSAPP[whatsapp].texto} ${MOTIVOS_DO_WHATSAPP[whatsapp].acao}`, botao: MOTIVOS_DO_WHATSAPP[whatsapp].botao } },
    { nome: "os e-mails", sem: email === "sem_leitura", linha: email === undefined ? null : { texto: `${MOTIVOS_DO_EMAIL[email].texto} ${MOTIVOS_DO_EMAIL[email].acao}`, botao: MOTIVOS_DO_EMAIL[email].botao } },
  ];
  const juntas = fontes.filter((fonte) => fonte.sem);
  const linhas: LinhaSemLeitura[] = juntas.length < 2 ? [] : [{ texto: `${frasePorExtenso(juntas.map((fonte) => fonte.nome))} ainda não foram lidos. Sincronize para ler agora.`, botao: "sincronizar" }];
  for (const fonte of fontes) if (fonte.linha !== null && (juntas.length < 2 || !fonte.sem)) linhas.push(fonte.linha);
  return linhas;
}

/** "o CRM e os e-mails", "o CRM, as conversas e os e-mails", com a primeira letra em maiúscula. */
function frasePorExtenso(nomes: readonly string[]): string {
  const lista = nomes.length === 2 ? nomes.join(" e ") : `${nomes.slice(0, -1).join(", ")} e ${nomes.at(-1)}`;
  return lista.charAt(0).toUpperCase() + lista.slice(1);
}

/** O bloco sem leitura diz o motivo no corpo; Fazer hoje, na nota dos compromissos. */
function cartaoDizOMotivo(dia: MeuDia, lista: ListaDoDia, fonte: FonteDoBloco): boolean {
  switch (lista) {
    case "propostas":
      return fonte === "crm" && ehMotivoSemLeitura(dia.propostas_abertas.motivo);
    case "sem-atendimento":
      return fonte === "crm" && ehMotivoSemLeitura(dia.clientes_sem_atendimento.motivo);
    case "fazer-hoje":
      return fonte === "crm" && ehMotivoSemLeitura(dia.compromissos_de_hoje.motivo);
    case "responder":
      return fonte === "whatsapp" && blocoSemLeitura(dia.responder);
    case "esperando-cliente":
      return fonte === "whatsapp" && blocoSemLeitura(dia.esperando_cliente);
    default:
      return false;
  }
}

const HORA = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** "9h", "15h30", na hora de Brasília. */
export function horaDe(quando: Instante): string {
  const [hora = "0", minuto = "00"] = HORA.format(new Date(quando)).split(":");
  return minuto === "00" ? `${Number(hora)}h` : `${Number(hora)}h${minuto}`;
}

export function textoDoCompromisso(compromisso: Compromisso): string {
  const fim = compromisso.fim === null ? "" : ` até ${horaDe(compromisso.fim)}`;
  return `Compromisso às ${horaDe(compromisso.inicio)}${fim}, no CRM`;
}

export function textoDoEnvio(dias: number): string {
  if (dias <= 0) return "Enviada hoje";
  return dias === 1 ? "Enviada ontem" : `Enviada há ${dias} dias`;
}

export function textoDaFaixa(faixa: PropostaAberta["faixa"]): string | null {
  return faixa === null ? null : `${faixa} dias ou mais`;
}

/** Quantos dias antes do bloqueio a proposta ganha o selo de atenção. */
export const AVISO_DO_BLOQUEIO_DIAS = 2;

/** O selo de atenção da proposta perto do bloqueio de 30 dias, ou `null`. */
export function atencaoDaProposta(proposta: PropostaAberta): string | null {
  if (proposta.prazo_vencido) return "Prazo vencido";
  const dias = proposta.dias_para_o_prazo;
  if (dias > AVISO_DO_BLOQUEIO_DIAS) return null;
  return dias === 1 ? "Amanhã o CRM bloqueia proposta nova" : `Em ${dias} dias o CRM bloqueia proposta nova`;
}

/** "R$ 1.500,00" quando o CRM mandou número e moeda; o texto do CRM, como veio, quando não. */
export function valorDaProposta(proposta: PropostaAberta): string | null {
  const { valor_total: valor, moeda } = proposta;
  if (valor === null) return null;
  const numero = Number(valor);
  if (moeda === null || !Number.isFinite(numero)) return valor;
  try {
    return new Intl.NumberFormat("pt-BR", { style: "currency", currency: moeda }).format(numero);
  } catch {
    return `${valor} ${moeda}`;
  }
}

export function textoSemAtendimento(cliente: ClienteSemAtendimento): string {
  const dias = cliente.dias_sem_atendimento;
  if (dias === null) return "Nunca atendido";
  const base = dias === 1 ? "Sem atendimento há 1 dia" : `Sem atendimento há ${dias} dias`;
  return cliente.ultimo_atendimento_aproximado ? `${base} ou mais` : base;
}

export function lugarDoCliente(cliente: ClienteSemAtendimento): string | null {
  const cidade = [cliente.cidade, cliente.uf].filter((parte) => parte !== null).join("/");
  const partes = [cliente.nome_fantasia !== null && cliente.nome_fantasia !== cliente.nome ? cliente.nome_fantasia : null, cidade === "" ? null : cidade];
  const texto = partes.filter((parte) => parte !== null).join(" · ");
  return texto === "" ? null : texto;
}

/**
 * O link do CRM só vira botão quando é `https` e sem usuário e senha. A origem já foi conferida
 * contra a das telas do CRM na borda do servidor (`nucleo/conectores/crm/leitura.ts`).
 */
export function linkDoCrm(link: string | null): string | null {
  if (link === null || !URL.canParse(link)) return null;
  const url = new URL(link);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
  return url.href;
}

/**
 * O rodapé: idade de cada fonte. A do CRM é a leitura mais velha entre os blocos lidos. A do WhatsApp
 * e a do e-mail são as das conversas que o Meu dia mostra (a dos cabeçalhos, não a do teste de login):
 * é delas que Responder e Esperando cliente dependem.
 */
export function rodapeDoDia(dia: MeuDia): { readonly fonte: string; readonly nome: string; readonly idade: string }[] {
  const linhas = rodapeDasFontes(dia.fontes);
  const agora = dia.fontes.find((fonte) => fonte.fonte === "tarefas")?.lidaEm ?? null;
  const lidos = [dia.compromissos_de_hoje.lido_em, dia.propostas_abertas.lido_em, dia.clientes_sem_atendimento.lido_em].filter(
    (lido): lido is Instante => lido !== null,
  );
  const maisVelho = lidos.reduce<Instante | null>((velho, lido) => (velho === null || lido < velho ? lido : velho), null);
  const idadeDoCrm = (): string => {
    if (maisVelho !== null && agora !== null) return idadeEmTexto(Math.max(0, Math.floor((Date.parse(agora) - Date.parse(maisVelho)) / 60_000)));
    const motivo = dia.propostas_abertas.motivo;
    if (motivo === "crm_app_nao_liberado") return "não liberado";
    if (motivo === "sem_leitura") return "não sincronizado";
    if (motivo === "crm_desconectado") return "não conectado";
    return "não lido";
  };
  const idadeDoWhatsapp = (): string => {
    const lido = dia.responder.lido_em;
    if (lido !== null && agora !== null) return idadeEmTexto(Math.max(0, Math.floor((Date.parse(agora) - Date.parse(lido)) / 60_000)));
    const motivo = dia.responder.motivo;
    if (motivo === "whatsapp_desconectado") return "não conectado";
    if (motivo === "whatsapp_em_atencao") return "pede atenção";
    return "não sincronizado";
  };
  const idadeDoEmail = (): string => {
    const { lido_em: lido, motivo, contas_lidas: lidas, contas } = dia.responder.email;
    if (lido !== null && agora !== null) {
      const idade = idadeEmTexto(Math.max(0, Math.floor((Date.parse(agora) - Date.parse(lido)) / 60_000)));
      return lidas === contas ? idade : `${idade}, ${lidas} de ${contas} contas`;
    }
    return motivo === "email_sem_conta_conectada" ? "não conectado" : "não sincronizado";
  };
  return linhas.map((linha) => {
    if (linha.fonte === "crm") return { ...linha, idade: idadeDoCrm() };
    if (linha.fonte === "whatsapp") return { ...linha, idade: idadeDoWhatsapp() };
    return linha.fonte === "email" ? { ...linha, idade: idadeDoEmail() } : linha;
  });
}

export type EtapaDaFonte = "esperando" | "lendo" | ResultadoDaFonte["situacao"];

/** A rodada vista pelo painel, montada pelos passos que o SSE manda, de qualquer rodada. */
export type EstadoDaSincronizacao =
  | { readonly tipo: "parada" }
  | { readonly tipo: "rodando"; readonly id: string; readonly fontes: { readonly [F in FonteDaSincronizacao]: EtapaDaFonte } };

export const SINCRONIZACAO_PARADA: EstadoDaSincronizacao = { tipo: "parada" };

const NENHUMA_LIDA = { agenda: "esperando", propostas: "esperando", carteira: "esperando", conversas: "esperando", email: "esperando" } as const;

/** `comecou` abre uma rodada nova; passo de outra rodada não mexe; quem chega no meio entra na rodada. */
export function reduzirSincronizacao(atual: EstadoDaSincronizacao, andamento: AndamentoDaSincronizacao): EstadoDaSincronizacao {
  if (andamento.etapa === "comecou") return { tipo: "rodando", id: andamento.id, fontes: NENHUMA_LIDA };
  if (atual.tipo === "rodando" && atual.id !== andamento.id) return atual;
  if (andamento.etapa === "terminou") return SINCRONIZACAO_PARADA;
  const fontes = atual.tipo === "rodando" ? atual.fontes : NENHUMA_LIDA;
  return { tipo: "rodando", id: andamento.id, fontes: { ...fontes, [andamento.fonte]: andamento.situacao } };
}

const NOMES_DAS_FONTES_NO_ROTULO: { readonly [F in FonteDaSincronizacao]: string } = { agenda: "agenda", propostas: "propostas", carteira: "carteira", conversas: "conversas", email: "e-mail" };

/** O rótulo do botão Sincronizar. */
export function rotuloDaSincronizacao(estado: EstadoDaSincronizacao): string {
  if (estado.tipo === "parada") return "Sincronizar";
  const fontes = Object.entries(estado.fontes) as [FonteDaSincronizacao, EtapaDaFonte][];
  const feitas = fontes.filter(([, etapa]) => etapa !== "esperando" && etapa !== "lendo").length;
  const lendo = fontes.find(([, etapa]) => etapa === "lendo");
  return lendo === undefined ? `Sincronizando ${feitas} de ${fontes.length}` : `Lendo ${NOMES_DAS_FONTES_NO_ROTULO[lendo[0]]} (${feitas + 1} de ${fontes.length})`;
}

const NOMES_NO_RESULTADO: { readonly [F in FonteDaSincronizacao]: string } = { agenda: "Agenda", propostas: "Propostas", carteira: "Carteira", conversas: "WhatsApp", email: "E-mail" };

const ITENS_NO_RESULTADO: { readonly [F in FonteDaSincronizacao]: readonly [string, string] } = {
  agenda: ["compromisso hoje", "compromissos hoje"],
  propostas: ["proposta aberta", "propostas abertas"],
  carteira: ["cliente sem atendimento", "clientes sem atendimento"],
  conversas: ["conversa para acompanhar", "conversas para acompanhar"],
  email: ["e-mail guardado", "e-mails guardados"],
};

const PULOS: { readonly [M in MotivoDoPulo]: string } = {
  crm_desconectado: "o CRM não está conectado",
  crm_autorizando: "o login do CRM não terminou",
  crm_app_nao_liberado: "o CRM ainda não liberou a Secretária",
  crm_em_atencao: "o CRM pede atenção em Conexões",
  crm_limite_de_chamadas: "o CRM pediu uma pausa",
  crm_fora_do_ar: "o CRM está fora do ar",
  crm_sessao_vencida: "o login do CRM venceu",
  crm_nao_liberado: "o CRM recusou o acesso",
  whatsapp_desconectado: "o WhatsApp não está conectado",
  whatsapp_em_atencao: "o WhatsApp pede atenção em Conexões",
  email_sem_conta: "não há conta de e-mail",
  email_sem_conta_conectada: "nenhuma conta de e-mail está conectada",
};

function erroCurto(erro: ErroOperacao): string {
  return erro.codigo === "crm_limite_de_chamadas" && erro.esperaS !== undefined ? `${erro.mensagem} Tente de novo em ${erro.esperaS} s.` : erro.mensagem;
}

/** Contas de e-mail que a rodada não leu: falha, prazo, atenção ou teste em curso. Conta desconectada de propósito não conta. */
function contasNaoLidas(resultado: ResultadoDaFonte): number {
  return (resultado.contas ?? []).filter((conta) => conta.situacao === "falhou" || (conta.situacao === "pulada" && conta.motivo !== "desconectado")).length;
}

function linhaDaFonte(resultado: ResultadoDaFonte): string {
  const nome = NOMES_NO_RESULTADO[resultado.fonte];
  switch (resultado.situacao) {
    case "leu": {
      const [um, varios] = ITENS_NO_RESULTADO[resultado.fonte];
      const base = `${nome}: ${resultado.itens === 0 ? `nenhum item` : plural(resultado.itens, um, varios)}`;
      const corte = resultado.cortado ? (resultado.fonte === "conversas" ? ", com conversas por conferir" : resultado.fonte === "email" ? ", com mais e-mails por ler" : ", com mais no CRM") : "";
      // As conversas já guardadas seguem valendo: só os números ou remetentes novos ficam sem cliente até o CRM responder.
      const semCrm = resultado.semConsultaAoCrm;
      const novos = resultado.fonte === "email" ? "Remetentes novos" : "Números novos";
      const aviso = semCrm === undefined ? "" : ` O CRM não foi consultado porque ${PULOS[semCrm.motivo]}. ${novos} esperam a próxima sincronização.`;
      const naoLidas = contasNaoLidas(resultado);
      const contas = naoLidas === 0 ? "" : ` ${naoLidas === 1 ? "Uma conta não foi lida" : `${naoLidas} contas não foram lidas`}.`;
      return `${base}${corte}.${aviso}${contas}`;
    }
    case "falhou":
      return `${nome}: não leu. ${erroCurto(resultado.erro)}`;
    case "pulada":
      return `${nome}: pulada, porque ${PULOS[resultado.motivo]}.`;
  }
}

/** O vendedor sem e-mail não tem e-mail na rodada: a fonte pulada por falta de conta não conta nem aparece. */
const semEmailNenhum = (fonte: ResultadoDaFonte) => fonte.fonte === "email" && fonte.situacao === "pulada" && fonte.motivo === "email_sem_conta";

/** O aviso do fim: uma linha por fonte. Erro de uma fonte não esconde o que as outras leram. */
export function resumoDaSincronizacao(rodada: Sincronizacao): { readonly tom: "feito" | "erro"; readonly texto: string; readonly linhas: readonly string[] } {
  const fontes = rodada.fontes.filter((fonte) => !semEmailNenhum(fonte));
  const leram = fontes.filter((fonte) => fonte.situacao === "leu").length;
  // Ler as conversas sem consultar o CRM é ler pela metade: os números novos ficaram sem cliente. Conta de e-mail que não leu também.
  const completas = fontes.filter((fonte) => fonte.situacao === "leu" && fonte.semConsultaAoCrm === undefined && contasNaoLidas(fonte) === 0).length;
  const comEmail = fontes.some((fonte) => fonte.fonte === "email");
  const pronto = comEmail ? "CRM, WhatsApp e e-mail sincronizados." : "CRM e WhatsApp sincronizados.";
  const texto = completas === fontes.length ? pronto : leram === 0 ? "Nada foi lido." : "Parte foi lida.";
  return { tom: completas === fontes.length ? "feito" : "erro", texto, linhas: fontes.map(linhaDaFonte) };
}

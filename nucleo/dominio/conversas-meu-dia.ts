import type { ConversaLida } from "./conversa";
import type { Dia } from "./dia";
import type { QuemIgnorou } from "./crm-leitura";
import type { ConversaDeEmail } from "./email-conversa";
import { deForaDaSituacao } from "./email-conversa";
import type { EstadoWhatsapp, IdContaEmail, Instante, TextoExterno } from "./tipos";
import { TAMANHO_MAXIMO_DA_BUSCA, type CanalDeVinculo, type CandidatoDeVinculo, type ClienteDoVinculo, type MotivoDaDuvida, type VinculoDeContato } from "./vinculo";

/**
 * Os blocos Responder e Esperando cliente do Meu dia. Montados só do que a sincronização guardou:
 * `ConversaLida` (WhatsApp) e os cabeçalhos de e-mail, os vínculos e as marcas de ignorado. Nenhuma
 * chamada ao wacli, ao IMAP nem ao CRM, e nenhum texto de mensagem.
 */

/** O que o Meu dia lê do cache de conversas. */
export interface LeituraDeConversas {
  readonly lidoEm: Instante;
  readonly itens: readonly ConversaLida[];
  /** Havia mais conversas, ou números por consultar, do que esta rodada deu conta. */
  readonly cortado: boolean;
}

/** A conversa que o vendedor tirou da lista até `ate`, o primeiro dia de Brasília em que ela volta. */
export interface MarcaDeConversaIgnorada {
  readonly tipo: "conversa";
  /** O telefone da conversa (WhatsApp) ou o id do item (`e-...`, e-mail). */
  readonly id: string;
  /** O nome do cliente no CRM ou, sem cliente, o telefone ou o endereço, como ficou na hora de ignorar. */
  readonly nome: TextoExterno;
  readonly quem: QuemIgnorou;
  readonly motivo: string | null;
  readonly ate: Dia;
}

/** Conversa que o agente tirou do Meu dia, com as palavras do vendedor. */
export interface IgnoradoDeConversa {
  readonly tipo: "conversa";
  readonly canal: CanalDeVinculo;
  readonly id: string;
  readonly nome: TextoExterno;
  readonly codigo: null;
  readonly motivo: string;
  readonly ate: Dia;
}

/** Uma conta de e-mail como o Meu dia a vê: `conectada` só na fase `conectado`. */
export interface ContaNoMeuDia {
  readonly id: IdContaEmail;
  readonly rotulo: string;
}

/** O que o Meu dia lê do e-mail: já calculado pelo chamador, com o relógio dele, para a montagem ficar pura. */
export interface DadosDoEmail {
  /** Todas as contas, na ordem da lista. */
  readonly contas: readonly (ContaNoMeuDia & { readonly conectada: boolean })[];
  /** As conversas de e-mail de agora, com a situação no relógio de agora. */
  readonly conversas: readonly ConversaDeEmail[];
  /** Os vínculos de `email`, pelo endereço em minúsculas. */
  readonly vinculos: ReadonlyMap<string, VinculoDeContato>;
  readonly ignoradas: readonly MarcaDeConversaIgnorada[];
  /** Quando cada conta foi lida inteira (`lidoEmDasContas`). Falta a conta com pasta ainda não lida inteira. */
  readonly lidoEm: ReadonlyMap<IdContaEmail, Instante>;
  /** Contas lidas sem a pasta de enviados (`contasSemEnviados`): a Secretária não vê o que o vendedor respondeu. */
  readonly semEnviados: ReadonlySet<IdContaEmail>;
  /** As conversas que uma tarefa concluída tratou, pelo id do item, até o instante da última mensagem que ela cobre. */
  readonly tratadas?: ReadonlyMap<string, Instante>;
}

export const SEM_EMAIL: DadosDoEmail = { contas: [], conversas: [], vinculos: new Map(), ignoradas: [], lidoEm: new Map(), semEnviados: new Set() };

export interface DadosDasConversas {
  readonly leitura: LeituraDeConversas | null;
  /** Os vínculos de `whatsapp`, pelo telefone. */
  readonly vinculos: ReadonlyMap<string, VinculoDeContato>;
  readonly ignoradas: readonly MarcaDeConversaIgnorada[];
  /** As conversas que uma tarefa concluída tratou, pelo telefone, até o instante da última mensagem que ela cobre. */
  readonly tratadas?: ReadonlyMap<string, Instante>;
  readonly email?: DadosDoEmail;
}

export const SEM_CONVERSAS: DadosDasConversas = { leitura: null, vinculos: new Map(), ignoradas: [], email: SEM_EMAIL };

export type MotivoDoBlocoDeConversas = "sem_itens" | "sem_leitura" | "whatsapp_desconectado" | "whatsapp_em_atencao";

/** Por que o bloco não tem item de e-mail. */
export type MotivoDoEmailNoBloco = "email_sem_conta" | "email_sem_conta_conectada" | "sem_leitura" | "sem_itens";

/** A leitura do e-mail daquele bloco. */
export interface LeituraDoEmailNoBloco {
  /** O `lido_em` mais antigo entre as contas conectadas já lidas inteiras. `null` sem nenhuma. */
  readonly lido_em: Instante | null;
  /** `null` quando o bloco tem item de e-mail. */
  readonly motivo: MotivoDoEmailNoBloco | null;
  /** Alguma conta conectada ainda não foi lida inteira, ou sobrou remetente candidato sem vínculo. */
  readonly cortado: boolean;
  /** Quantas contas conectadas têm leitura inteira. */
  readonly contas_lidas: number;
  /** Quantas contas existem. */
  readonly contas: number;
  /**
   * Os rótulos das contas conectadas lidas sem a pasta de enviados. Nelas a Secretária não sabe o que
   * o vendedor já respondeu: o e-mail respondido segue em Responder, e Esperando cliente não aparece.
   */
  readonly contas_sem_enviados: readonly string[];
}

export interface BlocoDeConversas<I> {
  /** Os itens dos dois canais, da mais antiga para a mais nova pelo `desde`. */
  readonly itens: readonly I[];
  /** Quando as conversas do WhatsApp foram lidas. `null` sem leitura. Só o WhatsApp. */
  readonly lido_em: Instante | null;
  /** `null` quando há itens do WhatsApp. Só o WhatsApp: o do e-mail está em `email.motivo`. */
  readonly motivo: MotivoDoBlocoDeConversas | null;
  /** Só o WhatsApp. */
  readonly cortado: boolean;
  /** Conversas dos dois canais que o vendedor tirou da lista. */
  readonly ignorados: number;
  /** Conversas dos dois canais fora da lista porque uma tarefa delas foi concluída e não chegou mensagem depois. */
  readonly tratados: number;
  readonly email: LeituraDoEmailNoBloco;
}

export interface ClienteDaConversa {
  readonly id: number;
  readonly nome: TextoExterno;
  readonly cidade: TextoExterno | null;
}

interface BaseDoItem {
  readonly canal: "whatsapp";
  /** O JID da conversa no wacli. */
  readonly conversa: string;
  readonly telefone: string;
}

type ClienteOuDuvida =
  | { readonly vinculo: "auto" | "confirmado"; readonly cliente: ClienteDaConversa }
  | {
      readonly vinculo: "ambiguo";
      readonly cliente: null;
      readonly candidatos: readonly CandidatoDeVinculo[];
      readonly motivo_da_duvida: MotivoDaDuvida;
    };

export type ItemDeResponderDoWhatsapp = BaseDoItem & {
  /** O nome da conversa no WhatsApp. `null` quando vazio ou com sinal de injeção. */
  readonly nome_no_whatsapp: TextoExterno | null;
  readonly desde: Instante;
  readonly novas: number;
  readonly em_quarentena: boolean;
  readonly mensagens_em_quarentena: readonly string[];
  /** Alguma das mensagens lidas não pôde ser lida: pode ser o que o cliente perguntou. */
  readonly tem_ilegiveis: boolean;
  /** As 20 lidas são todas depois da última da conta: `novas` é o mínimo, e o painel diz "20 ou mais". */
  readonly mais_que_o_lido: boolean;
} & ClienteOuDuvida;

export type ItemDeEsperandoDoWhatsapp = BaseDoItem & {
  /** O nome da conversa no WhatsApp. `null` quando vazio ou com sinal de injeção. */
  readonly nome_no_whatsapp: TextoExterno | null;
  readonly desde: Instante;
  readonly dias_uteis: number;
} & ClienteOuDuvida;

interface BaseDoItemDeEmail {
  readonly canal: "email";
  /** `e-<16 hexadecimais>`: o mesmo id que `ignorar` e Criar tarefa usam. */
  readonly id: string;
  readonly conta: ContaNoMeuDia;
  /** O remetente da última mensagem de fora. `null` só para o agente, quando o endereço tem sinal de injeção (`enderecoParaOAgente`). */
  readonly endereco: string | null;
  /** `null` quando vazio ou com sinal de injeção. */
  readonly nome_do_remetente: TextoExterno | null;
  /** `null` quando vazio ou com sinal de injeção. */
  readonly assunto: TextoExterno | null;
  /** O id da última mensagem de fora: o que "Ver e-mail" abre. */
  readonly ultimo_email: string;
  readonly em_quarentena: boolean;
}

export type ItemDeResponderDeEmail = BaseDoItemDeEmail & {
  readonly desde: Instante;
  readonly novas: number;
  /** Os ids dos e-mails com sinal no assunto, no nome ou no endereço; o painel abre cada um. */
  readonly mensagens_em_quarentena: readonly string[];
} & ClienteOuDuvida;

export type ItemDeEsperandoDeEmail = BaseDoItemDeEmail & {
  readonly desde: Instante;
  readonly dias_uteis: number;
} & ClienteOuDuvida;

export type ItemDeResponder = ItemDeResponderDoWhatsapp | ItemDeResponderDeEmail;
export type ItemDeEsperando = ItemDeEsperandoDoWhatsapp | ItemDeEsperandoDeEmail;

export interface BlocosDeConversas {
  readonly responder: BlocoDeConversas<ItemDeResponder>;
  readonly esperando_cliente: BlocoDeConversas<ItemDeEsperando>;
}

function motivoSemLeitura(whatsapp: EstadoWhatsapp): MotivoDoBlocoDeConversas {
  switch (whatsapp.fase) {
    case "conectado":
      return "sem_leitura";
    case "atencao":
      return "whatsapp_em_atencao";
    default:
      return "whatsapp_desconectado";
  }
}

const doCliente = (cliente: ClienteDoVinculo): ClienteDaConversa => ({ id: cliente.id, nome: cliente.nome, cidade: cliente.cidade });

/** O cliente ou a dúvida que o item mostra. `null`: o vínculo tira a conversa do Meu dia. */
function clienteOuDuvida(vinculo: VinculoDeContato): ClienteOuDuvida | null {
  if (vinculo.estado === "auto" || vinculo.estado === "confirmado") return { vinculo: vinculo.estado, cliente: doCliente(vinculo.cliente) };
  if (vinculo.estado === "ambiguo") return { vinculo: "ambiguo", cliente: null, candidatos: vinculo.candidatos, motivo_da_duvida: vinculo.motivo };
  return null;
}

/** A chave que identifica o item no canal: o telefone ou o id do item de e-mail. */
export function chaveDoItem(item: { readonly canal: "whatsapp"; readonly telefone: string } | { readonly canal: "email"; readonly id: string }): string {
  return item.canal === "whatsapp" ? item.telefone : item.id;
}

/** Da mais antiga para a mais nova pelo `desde`. Empate: WhatsApp antes do e-mail, depois a chave. */
function maisAntigaPrimeiro(
  a: { readonly canal: "whatsapp" | "email"; readonly desde: Instante } & Parameters<typeof chaveDoItem>[0],
  b: { readonly canal: "whatsapp" | "email"; readonly desde: Instante } & Parameters<typeof chaveDoItem>[0],
): number {
  return a.desde.localeCompare(b.desde) || (a.canal === b.canal ? 0 : a.canal === "whatsapp" ? -1 : 1) || chaveDoItem(a).localeCompare(chaveDoItem(b));
}

/** Quantas conversas de um bloco ficaram fora da lista, e por quê. */
interface Fora {
  ignorados: number;
  tratados: number;
}

/**
 * Por que a conversa fica fora do bloco, ou `null` quando entra. A marca de ignorado vence. A tarefa
 * concluída cobre a conversa até `ate`, a última mensagem que o servidor conhecia ao criá-la: mensagem
 * depois disso, de quem for, traz a conversa de volta pelas regras de sempre.
 */
function motivoDeFora(ignoradas: ReadonlySet<string>, tratadas: ReadonlyMap<string, Instante> | undefined, chave: string, ultimaEm: Instante): keyof Fora | null {
  if (ignoradas.has(chave)) return "ignorados";
  const ate = tratadas?.get(chave);
  return ate !== undefined && Date.parse(ate) >= Date.parse(ultimaEm) ? "tratados" : null;
}

function blocoDoWhatsapp<I>(leitura: LeituraDeConversas | null, whatsapp: EstadoWhatsapp, itens: readonly I[], fora: Fora): Omit<BlocoDeConversas<I>, "email"> {
  if (leitura === null) return { itens: [], lido_em: null, motivo: motivoSemLeitura(whatsapp), cortado: false, ignorados: 0, tratados: 0 };
  return { itens, lido_em: leitura.lidoEm, motivo: itens.length === 0 ? "sem_itens" : null, cortado: leitura.cortado, ...fora };
}

/** O remetente de uma conversa de e-mail com mensagem de fora e que o CRM ainda não vinculou: ficou para a próxima rodada. */
function sobrouEnderecoSemVinculo(email: DadosDoEmail, conectadas: ReadonlySet<IdContaEmail>): boolean {
  return email.conversas.some((conversa) => {
    const deFora = deForaDaSituacao(conversa.situacao);
    return deFora !== null && conectadas.has(conversa.contaId) && deFora.endereco.length <= TAMANHO_MAXIMO_DA_BUSCA && !email.vinculos.has(deFora.endereco);
  });
}

function leituraDoEmail(email: DadosDoEmail, temItem: boolean): LeituraDoEmailNoBloco {
  const conectadas = new Set(email.contas.filter((conta) => conta.conectada).map((conta) => conta.id));
  const lidas = [...conectadas].flatMap((id) => {
    const lidoEm = email.lidoEm.get(id);
    return lidoEm === undefined ? [] : [lidoEm];
  });
  const lidoEm = lidas.reduce<Instante | null>((velha, atual) => (velha === null || atual < velha ? atual : velha), null);
  let motivo: MotivoDoEmailNoBloco | null = null;
  if (!temItem) {
    if (email.contas.length === 0) motivo = "email_sem_conta";
    else if (conectadas.size === 0) motivo = "email_sem_conta_conectada";
    else motivo = lidas.length === 0 ? "sem_leitura" : "sem_itens";
  }
  return {
    lido_em: lidoEm,
    motivo,
    cortado: lidas.length < conectadas.size || sobrouEnderecoSemVinculo(email, conectadas),
    contas_lidas: lidas.length,
    contas: email.contas.length,
    contas_sem_enviados: email.contas.filter((conta) => conta.conectada && email.semEnviados.has(conta.id)).map((conta) => conta.rotulo),
  };
}

interface ItensDoEmail {
  readonly responder: ItemDeResponderDeEmail[];
  readonly esperando: ItemDeEsperandoDeEmail[];
  readonly foraDeResponder: Fora;
  readonly foraDeEsperando: Fora;
}

/** Conversa de conta conectada, com vínculo `auto`, `confirmado` ou `ambiguo`, nos dois blocos. O vínculo vale na hora. */
function itensDoEmail(email: DadosDoEmail): ItensDoEmail {
  const contas = new Map(email.contas.filter((conta) => conta.conectada).map((conta) => [conta.id, { id: conta.id, rotulo: conta.rotulo }]));
  const ignoradas = new Set(email.ignoradas.map((marca) => marca.id));
  const saida: ItensDoEmail = { responder: [], esperando: [], foraDeResponder: { ignorados: 0, tratados: 0 }, foraDeEsperando: { ignorados: 0, tratados: 0 } };
  for (const conversa of email.conversas) {
    const { situacao } = conversa;
    const conta = contas.get(conversa.contaId);
    if (conta === undefined || situacao.tipo === "nada") continue;
    const vinculo = email.vinculos.get(situacao.endereco);
    const quem = vinculo === undefined ? null : clienteOuDuvida(vinculo);
    if (quem === null) continue;
    const base = { canal: "email", id: conversa.id, conta, endereco: situacao.endereco, nome_do_remetente: situacao.nome, assunto: situacao.assunto, ultimo_email: situacao.ultimo_email, em_quarentena: situacao.em_quarentena } as const;
    const fora = motivoDeFora(ignoradas, email.tratadas, conversa.id, conversa.ultimaEm);
    if (situacao.tipo === "responder") {
      if (fora !== null) saida.foraDeResponder[fora] += 1;
      else saida.responder.push({ ...base, desde: situacao.desde, novas: situacao.novas, mensagens_em_quarentena: situacao.mensagens_em_quarentena, ...quem });
    } else if (fora !== null) saida.foraDeEsperando[fora] += 1;
    else saida.esperando.push({ ...base, desde: situacao.desde, dias_uteis: situacao.dias_uteis, ...quem });
  }
  return saida;
}

/**
 * Responder: a última mensagem de conteúdo é do cliente. Esperando cliente: é da conta, há 3 dias
 * úteis ou mais. O vínculo vale na hora da montagem, não na da leitura: quem o vendedor escolheu ou
 * marcou como "não é cliente" já aparece ou some sem nova sincronização. `nao_cliente`, `sem_cliente` e
 * conversa sem vínculo ficam fora. Conversa `ambiguo` entra nos dois blocos, com "Qual cliente?". Os dois canais numa
 * lista só, da mais antiga para a mais nova. `lido_em`, `motivo` e `cortado` do bloco são do WhatsApp;
 * os do e-mail vão em `email`.
 */
export function montarBlocosDeConversas(dados: DadosDasConversas, whatsapp: EstadoWhatsapp): BlocosDeConversas {
  const ignoradas = new Set(dados.ignoradas.map((marca) => marca.id));
  const responder: ItemDeResponder[] = [];
  const esperando: ItemDeEsperando[] = [];
  const foraDeResponder: Fora = { ignorados: 0, tratados: 0 };
  const foraDeEsperando: Fora = { ignorados: 0, tratados: 0 };

  for (const lida of dados.leitura?.itens ?? []) {
    const vinculo = dados.vinculos.get(lida.telefone);
    const quem = vinculo === undefined ? null : clienteOuDuvida(vinculo);
    if (quem === null) continue;
    const base = { canal: "whatsapp", conversa: lida.conversa, telefone: lida.telefone, nome_no_whatsapp: lida.nome } as const;
    const { situacao } = lida;
    const fora = motivoDeFora(ignoradas, dados.tratadas, lida.telefone, lida.ultimaMensagemEm);
    if (situacao.tipo === "responder") {
      const resto = { desde: situacao.desde, novas: situacao.novas, em_quarentena: situacao.em_quarentena, mensagens_em_quarentena: situacao.mensagens_em_quarentena, tem_ilegiveis: situacao.tem_ilegiveis, mais_que_o_lido: situacao.mais_que_o_lido };
      if (fora !== null) foraDeResponder[fora] += 1;
      else responder.push({ ...base, ...resto, ...quem });
    } else if (situacao.tipo === "esperando") {
      if (fora !== null) foraDeEsperando[fora] += 1;
      else esperando.push({ ...base, desde: situacao.desde, dias_uteis: situacao.dias_uteis, ...quem });
    }
  }

  const email = dados.email ?? SEM_EMAIL;
  const doEmail = itensDoEmail(email);
  const doResponder = blocoDoWhatsapp<ItemDeResponder>(dados.leitura, whatsapp, responder, foraDeResponder);
  const doEsperando = blocoDoWhatsapp<ItemDeEsperando>(dados.leitura, whatsapp, esperando, foraDeEsperando);
  return {
    responder: {
      ...doResponder,
      itens: [...responder, ...doEmail.responder].sort(maisAntigaPrimeiro),
      ignorados: doResponder.ignorados + doEmail.foraDeResponder.ignorados,
      tratados: doResponder.tratados + doEmail.foraDeResponder.tratados,
      email: leituraDoEmail(email, doEmail.responder.length > 0),
    },
    esperando_cliente: {
      ...doEsperando,
      itens: [...esperando, ...doEmail.esperando].sort(maisAntigaPrimeiro),
      ignorados: doEsperando.ignorados + doEmail.foraDeEsperando.ignorados,
      tratados: doEsperando.tratados + doEmail.foraDeEsperando.tratados,
      email: leituraDoEmail(email, doEmail.esperando.length > 0),
    },
  };
}

/** Um contato que o vendedor marcou como "não é cliente". Fica na lista até ele desfazer. */
export type NaoClienteDoDia =
  | {
      readonly canal: "whatsapp";
      readonly telefone: string;
      /** O nome da conversa na leitura guardada. `null` sem leitura dessa conversa, ou com nome vazio ou com sinal de injeção. */
      readonly nome_no_whatsapp: TextoExterno | null;
      readonly decidido_em: Instante;
    }
  /** `endereco` é `null` só para o agente, quando tem sinal de injeção. */
  | { readonly canal: "email"; readonly endereco: string | null; readonly decidido_em: Instante };

/** Os números e endereços marcados como "não é cliente", do mais novo para o mais antigo. Não depende do CRM nem do estado do WhatsApp ou das contas. */
export function listarNaoClientes(dados: DadosDasConversas): NaoClienteDoDia[] {
  const nomes = new Map<string, TextoExterno | null>((dados.leitura?.itens ?? []).map((lida) => [lida.telefone, lida.nome]));
  const lista: NaoClienteDoDia[] = [];
  for (const vinculo of dados.vinculos.values()) {
    if (vinculo.estado === "nao_cliente") lista.push({ canal: "whatsapp", telefone: vinculo.chave, nome_no_whatsapp: nomes.get(vinculo.chave) ?? null, decidido_em: vinculo.decididoEm });
  }
  for (const vinculo of (dados.email ?? SEM_EMAIL).vinculos.values()) {
    if (vinculo.estado === "nao_cliente") lista.push({ canal: "email", endereco: vinculo.chave, decidido_em: vinculo.decididoEm });
  }
  const chave = (item: NaoClienteDoDia) => (item.canal === "whatsapp" ? item.telefone : (item.endereco ?? ""));
  return lista.sort((a, b) => b.decidido_em.localeCompare(a.decidido_em) || (a.canal === b.canal ? 0 : a.canal === "whatsapp" ? -1 : 1) || chave(a).localeCompare(chave(b)));
}

/** As marcas de conversa do agente de um canal, com as palavras do vendedor. A ordem é a de `ignoradosPeloAgente`. */
export function conversasIgnoradasPeloAgente(marcas: readonly MarcaDeConversaIgnorada[], canal: CanalDeVinculo = "whatsapp"): IgnoradoDeConversa[] {
  return marcas
    .filter((marca): marca is MarcaDeConversaIgnorada & { readonly motivo: string } => marca.quem === "agente" && marca.motivo !== null)
    .map(({ id, nome, motivo, ate }): IgnoradoDeConversa => ({ tipo: "conversa", canal, id, nome, codigo: null, motivo, ate }));
}

/** A conversa de um bloco, com o instante da última mensagem que a leitura guardada conhece. */
export type ConversaAchada = ({ readonly bloco: "responder"; readonly item: ItemDeResponder } | { readonly bloco: "esperando_cliente"; readonly item: ItemDeEsperando }) & {
  readonly ultimaEm: Instante;
};

/**
 * Onde a conversa de um canal está no Meu dia, pela chave (telefone ou id do item de e-mail), ou
 * `null` quando não está em nenhum bloco. Ignorada ou tratada por tarefa concluída ainda conta: é o
 * que Ignorar e Criar tarefa conferem.
 */
export function conversaNoMeuDia(dados: DadosDasConversas, canal: CanalDeVinculo, chave: string): ConversaAchada | null {
  const email = dados.email ?? SEM_EMAIL;
  const ultimaEm =
    canal === "whatsapp" ? dados.leitura?.itens.find((lida) => lida.telefone === chave)?.ultimaMensagemEm : email.conversas.find((conversa) => conversa.id === chave)?.ultimaEm;
  if (ultimaEm === undefined) return null;
  const blocos = montarBlocosDeConversas({ ...dados, ignoradas: [], tratadas: new Map(), email: { ...email, ignoradas: [], tratadas: new Map() } }, { fase: "desconectado" });
  const doCanal = (item: ItemDeResponder | ItemDeEsperando) => item.canal === canal && chaveDoItem(item) === chave;
  const emResponder = blocos.responder.itens.find(doCanal);
  if (emResponder !== undefined) return { bloco: "responder", item: emResponder, ultimaEm };
  const emEsperando = blocos.esperando_cliente.itens.find(doCanal);
  return emEsperando === undefined ? null : { bloco: "esperando_cliente", item: emEsperando, ultimaEm };
}

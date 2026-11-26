import {
  CONECTORES_UNICOS,
  LIMITES_DA_TAREFA,
  SEM_CONVERSAS,
  SEM_IGNORADOS,
  SEM_LEITURAS,
  conversasIgnoradasPeloAgente,
  listarNaoClientes,
  ignoradosPeloAgente,
  montarBlocosDeConversas,
  montarBlocosDoCrm,
  type BlocosDeConversas,
  type BlocosDoCrm,
  type CanalDeVinculo,
  type DadosDasConversas,
  type IgnoradoDeConversa,
  type NaoClienteDoDia,
  type IgnoradoPeloAgente,
  type Ignorados,
  type LeiturasDoCrm,
  conflito,
  falha,
  ok,
  type Dia,
  type EstadoEmail,
  type EstadoPorConector,
  type IdConector,
  type IdConectorUnico,
  type Instante,
  type Resultado,
  type RetratoDosConectores,
  type TipoDeIgnorado,
} from "../dominio";
import type { ResumoDaEscrita } from "../escritas";

export const ESTADOS_DA_TAREFA = ["aberta", "concluida", "descartada"] as const;
export type EstadoDaTarefa = (typeof ESTADOS_DA_TAREFA)[number];

/** Quem escreveu: o vendedor, pelo painel, ou o agente, pelo CLI. */
export const AUTORES = ["vendedor", "agente"] as const;
export type Autor = (typeof AUTORES)[number];

/** Quem chama a API. O painel fala pelo vendedor. */
export type Papel = "painel" | "agente";

export function autorDe(papel: Papel): Autor {
  return papel === "painel" ? "vendedor" : "agente";
}

export interface Tarefa {
  readonly id: string;
  readonly titulo: string;
  readonly clienteId: string | null;
  readonly clienteNome: string | null;
  /** O servidor achou `clienteId` no CRM e `clienteNome` é o nome que o CRM devolveu. */
  readonly clienteConferido: boolean;
  readonly propostaCodigo: string | null;
  /** `null` é "sem data": nada inventa prazo. */
  readonly venceEm: Dia | null;
  readonly estado: EstadoDaTarefa;
  readonly origem: Autor;
  /** Sobe a cada mudança da linha. Edição com versão velha recebe `conflito_de_versao`. */
  readonly versao: number;
  readonly criadaEm: Instante;
  readonly atualizadaEm: Instante;
  /** A conversa do Meu dia de onde a tarefa nasceu. Concluída, a tarefa tira essa conversa de Responder e de Esperando cliente até chegar mensagem nova. */
  readonly conversa: ConversaDaTarefa | null;
}

/**
 * A conversa que a tarefa trata. `chave` é o telefone (WhatsApp) ou o id do item (`e-...`, e-mail).
 * `ate` é o instante da última mensagem que o servidor conhecia ao criar a tarefa: quem chama nunca o manda.
 */
export interface ConversaDaTarefa {
  readonly canal: CanalDeVinculo;
  readonly chave: string;
  readonly ate: Instante;
}

/** Nota só se anexa: nunca muda nem sai. */
export interface Nota {
  readonly id: number;
  readonly tarefaId: string;
  readonly texto: string;
  readonly autor: Autor;
  readonly proximoPasso: string | null;
  readonly criadaEm: Instante;
}

export type NotaNova = Omit<Nota, "id">;

export interface TarefaComNotas {
  readonly tarefa: Tarefa;
  /** Da mais antiga para a mais nova. */
  readonly notas: readonly Nota[];
}

export interface Contexto {
  readonly papel: Papel;
  readonly agora: Instante;
  /** O dia de `agora` em Brasília. */
  readonly hoje: Dia;
  novoId(): string;
}

/**
 * Os títulos que o agente pode dar a uma tarefa. Texto de cliente lido no WhatsApp ou no e-mail
 * nunca vira título: o agente escolhe um destes e o texto livre vai na nota.
 */
export const TITULOS_FIXOS = {
  ligar: "Ligar",
  responder: "Responder",
  visitar: "Visitar",
  enviar_proposta: "Enviar proposta",
  acompanhar_proposta: "Acompanhar proposta",
  acompanhar: "Acompanhar",
  enviar_material: "Enviar material",
  lembrete: "Lembrete",
} as const;
export type TituloFixo = keyof typeof TITULOS_FIXOS;

export interface NovaTarefa {
  /** Quem cria manda o id para poder repetir o pedido: id que já existe devolve a tarefa que existe. */
  readonly id?: string;
  readonly titulo: string;
  /** O título do agente sai deste rótulo fixo e do nome do cliente; muda junto quando o CRM corrige o nome. */
  readonly tituloFixo?: TituloFixo;
  readonly clienteId?: string;
  readonly clienteNome?: string;
  readonly clienteConferido?: boolean;
  readonly propostaCodigo?: string;
  readonly venceEm?: Dia;
  readonly nota?: string;
  readonly conversa?: ConversaDaTarefa;
}

/** O que muda numa tarefa que já existe. Toda ação, menos `anotar`, leva a versão que quem chama viu. */
export type Comando =
  | { readonly acao: "concluir"; readonly versao: number; readonly nota?: string; readonly proximoPasso?: string; readonly venceEm?: Dia }
  | { readonly acao: "adiar"; readonly versao: number; readonly para: Dia; readonly nota?: string }
  | { readonly acao: "descartar"; readonly versao: number; readonly nota?: string }
  | { readonly acao: "reabrir"; readonly versao: number }
  | { readonly acao: "anotar"; readonly texto: string; readonly proximoPasso?: string };

export type AcaoDaTarefa = Comando["acao"];

/**
 * O que gravar, numa transação só. `tarefa` é a linha nova, ou `null` quando a linha não muda.
 * `seguinte` é a tarefa que o "concluir com próximo passo" cria.
 */
export interface Decisao {
  readonly tarefa: Tarefa | null;
  readonly seguinte: Tarefa | null;
  readonly notas: readonly NotaNova[];
}

/** De que estado cada ação sai. Concluída e descartada só saem por `reabrir`, e só pelo vendedor. */
const SAI_DE: { readonly [A in AcaoDaTarefa]: readonly EstadoDaTarefa[] } = {
  concluir: ["aberta"],
  adiar: ["aberta"],
  descartar: ["aberta"],
  reabrir: ["concluida", "descartada"],
  anotar: ["aberta"],
};

const SO_DO_VENDEDOR: readonly AcaoDaTarefa[] = ["reabrir"];

/** O vendedor anota em tarefa fechada; o agente não mexe nela de jeito nenhum. */
function cabeNoEstado(comando: Comando, estado: EstadoDaTarefa, papel: Papel): boolean {
  if (comando.acao === "anotar" && papel === "painel") return true;
  return SAI_DE[comando.acao].includes(estado);
}

const NOTA_DA_CONCLUSAO = "Tarefa concluída.";

function nota(tarefaId: string, texto: string, ctx: Contexto, proximoPasso: string | null = null): NotaNova {
  return { tarefaId, texto, autor: autorDe(ctx.papel), proximoPasso, criadaEm: ctx.agora };
}

function comNota(tarefaId: string, texto: string | undefined, ctx: Contexto): NotaNova[] {
  return texto === undefined ? [] : [nota(tarefaId, texto, ctx)];
}

const TITULO_DO_PROXIMO_PASSO = "Próximo passo";

function caberNoTitulo(texto: string): string {
  const letras = [...texto];
  return letras.length <= LIMITES_DA_TAREFA.titulo ? texto : `${letras.slice(0, LIMITES_DA_TAREFA.titulo - 1).join("")}…`;
}

/** Título de tarefa do agente: o rótulo fixo e, quando há, o nome do cliente. */
function tituloComCliente(rotulo: string, clienteNome: string | null | undefined): string {
  return caberNoTitulo(clienteNome == null ? rotulo : `${rotulo}: ${clienteNome}`);
}

export function tituloFixo(qual: TituloFixo, clienteNome?: string): string {
  return tituloComCliente(TITULOS_FIXOS[qual], clienteNome);
}

/** O id do CRM é um inteiro positivo. Outro texto em `clienteId` não se confere. */
export function idDoClienteNoCrm(clienteId: string | undefined): number | null {
  if (clienteId === undefined || !/^[1-9]\d{0,9}$/.test(clienteId)) return null;
  const numero = Number(clienteId);
  return numero <= 2_147_483_647 ? numero : null;
}

/** O nome do cliente passa a ser o que o CRM devolveu, e o título fixo se refaz com ele. O texto do pedido sai. */
export function comClienteDoCrm(entrada: NovaTarefa, nomeNoCrm: string): NovaTarefa {
  const nome = [...nomeNoCrm].slice(0, LIMITES_DA_TAREFA.clienteNome).join("");
  const titulo = entrada.tituloFixo === undefined ? entrada.titulo : tituloFixo(entrada.tituloFixo, nome);
  return { ...entrada, titulo, clienteNome: nome, clienteConferido: true };
}

/** A proposta ou o cliente do Meu dia de onde o vendedor cria uma tarefa. */
export interface ItemDoCrm {
  readonly tipo: TipoDeIgnorado;
  readonly clienteId: number;
  readonly nome: string;
  /** O código da proposta. `null` para cliente. */
  readonly codigo: string | null;
}

/**
 * A tarefa do botão Criar tarefa de uma proposta ou de um cliente do Meu dia. Ela vence hoje: o
 * vendedor clicou para agir. É a única tarefa que nasce com prazo sem alguém escrever o dia.
 */
export function tarefaDoCrm(item: ItemDoCrm, id: string, hoje: Dia): NovaTarefa {
  const qual = item.tipo === "proposta" ? "acompanhar_proposta" : "ligar";
  const nome = [...item.nome].slice(0, LIMITES_DA_TAREFA.clienteNome).join("");
  return {
    id,
    tituloFixo: qual,
    titulo: tituloFixo(qual, nome),
    clienteId: String(item.clienteId),
    clienteNome: nome,
    ...(item.codigo === null ? {} : { propostaCodigo: [...item.codigo].slice(0, LIMITES_DA_TAREFA.propostaCodigo).join("") }),
    venceEm: hoje,
  };
}

/** A conversa do Meu dia de onde o vendedor cria uma tarefa, de qualquer canal: o cliente já vinculado, em Responder ou em Esperando cliente. */
export interface ConversaDoMeuDia {
  readonly bloco: "responder" | "esperando_cliente";
  readonly clienteId: number;
  readonly nome: string;
  readonly conversa: ConversaDaTarefa;
}

/** Responder cria "Responder", Esperando cliente cria "Acompanhar", os dois com o nome do cliente, vencendo hoje e presos à conversa. */
export function tarefaDaConversa(origem: ConversaDoMeuDia, id: string, hoje: Dia): NovaTarefa {
  const qual = origem.bloco === "responder" ? "responder" : "acompanhar";
  const nome = [...origem.nome].slice(0, LIMITES_DA_TAREFA.clienteNome).join("");
  return { id, tituloFixo: qual, titulo: tituloFixo(qual, nome), clienteId: String(origem.clienteId), clienteNome: nome, venceEm: hoje, conversa: origem.conversa };
}

export function criarTarefa(entrada: NovaTarefa, ctx: Contexto): Decisao & { readonly tarefa: Tarefa } {
  const tarefa: Tarefa = {
    id: entrada.id ?? ctx.novoId(),
    titulo: entrada.titulo,
    clienteId: entrada.clienteId ?? null,
    clienteNome: entrada.clienteNome ?? null,
    clienteConferido: entrada.clienteConferido === true,
    propostaCodigo: entrada.propostaCodigo ?? null,
    venceEm: entrada.venceEm ?? null,
    estado: "aberta",
    origem: autorDe(ctx.papel),
    versao: 1,
    criadaEm: ctx.agora,
    atualizadaEm: ctx.agora,
    conversa: entrada.conversa ?? null,
  };
  return { tarefa, seguinte: null, notas: comNota(tarefa.id, entrada.nota, ctx) };
}

function comAtual(resultado: Resultado<never>, atual: Tarefa): Resultado<never> {
  return resultado.ok ? resultado : { ok: false, erro: { ...resultado.erro, atual } };
}

/**
 * A regra inteira de mudança de tarefa. A ordem das recusas importa: o agente que tenta reabrir
 * recebe `so_no_painel` antes de qualquer outra coisa; versão velha vem antes de estado, porque
 * quem recarrega a tarefa passa a ver o estado certo.
 */
export function decidir(atual: Tarefa, comando: Comando, ctx: Contexto): Resultado<Decisao> {
  if (SO_DO_VENDEDOR.includes(comando.acao) && ctx.papel !== "painel") {
    return falha("so_no_painel", "Só o vendedor reabre uma tarefa, no painel.");
  }
  if (comando.acao !== "anotar" && comando.versao !== atual.versao) return conflito(atual);
  if (!cabeNoEstado(comando, atual.estado, ctx.papel)) {
    return comAtual(falha("estado_da_tarefa", `A tarefa está ${atual.estado}; "${comando.acao}" não cabe.`), atual);
  }

  const mudar = (campos: Partial<Pick<Tarefa, "estado" | "venceEm">>): Tarefa => ({
    ...atual,
    ...campos,
    versao: atual.versao + 1,
    atualizadaEm: ctx.agora,
  });

  switch (comando.acao) {
    case "concluir": {
      const proximo = comando.proximoPasso;
      if (proximo === undefined) {
        if (comando.venceEm !== undefined) return falha("entrada_invalida", "A data vale para o próximo passo: informe o próximo passo junto.");
        return ok({ tarefa: mudar({ estado: "concluida" }), seguinte: null, notas: comNota(atual.id, comando.nota, ctx) });
      }
      const doAgente = ctx.papel === "agente";
      const seguinte = criarTarefa(
        {
          titulo: doAgente ? tituloComCliente(TITULO_DO_PROXIMO_PASSO, atual.clienteNome) : caberNoTitulo(proximo),
          ...(atual.clienteId === null ? {} : { clienteId: atual.clienteId }),
          ...(atual.clienteNome === null ? {} : { clienteNome: atual.clienteNome, clienteConferido: atual.clienteConferido }),
          ...(atual.propostaCodigo === null ? {} : { propostaCodigo: atual.propostaCodigo }),
          ...(comando.venceEm === undefined ? {} : { venceEm: comando.venceEm }),
        },
        ctx,
      ).tarefa;
      return ok({
        tarefa: mudar({ estado: "concluida" }),
        seguinte,
        // O próximo passo escrito pelo agente fica na nota da tarefa seguinte, onde o vendedor o lê.
        notas: [nota(atual.id, comando.nota ?? NOTA_DA_CONCLUSAO, ctx, proximo), ...(doAgente ? [nota(seguinte.id, proximo, ctx)] : [])],
      });
    }
    case "adiar":
      if (comando.para < ctx.hoje) return falha("entrada_invalida", `A data nova precisa ser hoje (${ctx.hoje}) ou depois.`);
      return ok({ tarefa: mudar({ venceEm: comando.para }), seguinte: null, notas: comNota(atual.id, comando.nota, ctx) });
    case "descartar":
      return ok({ tarefa: mudar({ estado: "descartada" }), seguinte: null, notas: comNota(atual.id, comando.nota, ctx) });
    case "reabrir":
      return ok({ tarefa: mudar({ estado: "aberta" }), seguinte: null, notas: [] });
    case "anotar":
      return ok({ tarefa: null, seguinte: null, notas: [nota(atual.id, comando.texto, ctx, comando.proximoPasso ?? null)] });
  }
}

/**
 * As conversas de um canal que uma tarefa concluída tratou, pela chave, com o maior `ate` entre as
 * concluídas. Aberta e descartada não contam, então reabrir a tarefa traz a conversa de volta.
 */
export function conversasTratadas(tarefas: readonly Tarefa[], canal: CanalDeVinculo): Map<string, Instante> {
  const tratadas = new Map<string, Instante>();
  for (const { estado, conversa } of tarefas) {
    if (estado !== "concluida" || conversa === null || conversa.canal !== canal) continue;
    const anterior = tratadas.get(conversa.chave);
    if (anterior === undefined || Date.parse(conversa.ate) > Date.parse(anterior)) tratadas.set(conversa.chave, conversa.ate);
  }
  return tratadas;
}

export type Situacao = "atrasada" | "hoje" | "futura" | "sem_data";

/** Onde a tarefa cai no dia do vendedor. Os dois lados são dias de Brasília, então 23h30 ainda é hoje. */
export function situacao(venceEm: Dia | null, hoje: Dia): Situacao {
  if (venceEm === null) return "sem_data";
  if (venceEm < hoje) return "atrasada";
  return venceEm === hoje ? "hoje" : "futura";
}

/** Abertas por prazo (sem data por último) e, no mesmo prazo, pela mais antiga; fechadas pela mudança mais recente. */
export function ordenar(tarefas: readonly Tarefa[]): Tarefa[] {
  const chave = (t: Tarefa) => (t.venceEm ?? "9999-99-99") + t.criadaEm;
  const abertas = tarefas.filter((t) => t.estado === "aberta").sort((a, b) => chave(a).localeCompare(chave(b)));
  const fechadas = tarefas.filter((t) => t.estado !== "aberta").sort((a, b) => b.atualizadaEm.localeCompare(a.atualizadaEm));
  return [...abertas, ...fechadas];
}

export type IdDaFonte = "tarefas" | IdConector;

interface Idade {
  /** Quando o dado desta fonte foi lido ou conferido pela última vez. `null` quando a fonte não está conectada. */
  readonly lidaEm: Instante | null;
  /** Minutos desde `lidaEm`. */
  readonly idadeMin: number | null;
}

/** O e-mail tem várias contas: a idade é a da conectada lida há mais tempo, junto com quantas estão conectadas. */
export type IdadeDaFonte =
  | (Idade & { readonly fonte: Exclude<IdDaFonte, "email"> })
  | (Idade & { readonly fonte: "email"; readonly conectadas: number; readonly total: number });

export interface TarefaDoDia extends Tarefa {
  readonly situacao: "atrasada" | "hoje";
}

/**
 * Os blocos do CRM (`compromissos_de_hoje`, `propostas_abertas`, `clientes_sem_atendimento`) e os das conversas
 * do WhatsApp (`responder`, `esperando_cliente`) vêm do cache da sincronização.
 */
export interface MeuDia extends BlocosDoCrm, BlocosDeConversas {
  readonly hoje: Dia;
  /** Atrasadas e de hoje, pelo prazo. */
  readonly fazer_hoje: readonly TarefaDoDia[];
  readonly sem_data: readonly Tarefa[];
  /** Quantas tarefas estão abertas, com qualquer prazo. A lateral do painel mostra o número em Tarefas. */
  readonly tarefas_abertas: number;
  /** Os cartões da fila de aprovação que esperam o vendedor (`rascunho`, `falhou` e `falhou_incerto`), do mais antigo para o mais novo. */
  readonly aprovar: readonly ResumoDaEscrita[];
  readonly fontes: readonly IdadeDaFonte[];
  /** O que o agente tirou da lista a pedido do vendedor, com o motivo. Vale mesmo sem leitura do CRM. */
  readonly ignorados_pelo_agente: readonly (IgnoradoPeloAgente | IgnoradoDeConversa)[];
  /** Os números e endereços que o vendedor marcou como "não é cliente", do mais novo para o mais antigo. O agente os conta e não os desfaz. */
  readonly nao_clientes: readonly NaoClienteDoDia[];
}

/** Proposta e cliente pelo id do CRM, conversa pelo telefone: das marcas que voltam antes para as que voltam depois. */
function ordemDoIgnorado(a: IgnoradoPeloAgente | IgnoradoDeConversa, b: IgnoradoPeloAgente | IgnoradoDeConversa): number {
  const ids = typeof a.id === "number" && typeof b.id === "number" ? a.id - b.id : String(a.id).localeCompare(String(b.id));
  return a.ate.localeCompare(b.ate) || a.tipo.localeCompare(b.tipo) || ids;
}

function lidaEm(estado: EstadoPorConector[IdConectorUnico] | EstadoEmail): Instante | null {
  if (estado.fase !== "conectado") return null;
  if ("ultimaAtividade" in estado && estado.ultimaAtividade !== null) return estado.ultimaAtividade;
  return estado.verificadoEm;
}

function idade(desde: Instante | null, agora: Instante): number | null {
  if (desde === null) return null;
  return Math.max(0, Math.floor((Date.parse(agora) - Date.parse(desde)) / 60_000));
}

/**
 * A leitura mais velha entre as contas conectadas: o rodapé não promete dado mais novo do que a
 * conta mais atrasada tem. As desconectadas aparecem na contagem, não na idade.
 */
function idadeDoEmail(conectores: RetratoDosConectores, agora: Instante): IdadeDaFonte {
  const leituras = conectores.email.contas.map((conta) => lidaEm(conta.estado)).filter((leitura): leitura is Instante => leitura !== null);
  const desde = leituras.reduce<Instante | null>((velha, leitura) => (velha === null || leitura < velha ? leitura : velha), null);
  return { fonte: "email", lidaEm: desde, idadeMin: idade(desde, agora), conectadas: leituras.length, total: conectores.email.contas.length };
}

/**
 * O Meu dia: tarefas locais, os blocos do CRM lidos do cache e a idade de cada fonte para o rodapé.
 * O e-mail é opcional: sem conta, ele não entra no rodapé.
 */
export function montarMeuDia(
  abertas: readonly Tarefa[],
  conectores: RetratoDosConectores,
  agora: Instante,
  hoje: Dia,
  leituras: LeiturasDoCrm = SEM_LEITURAS,
  ignorados: Ignorados = SEM_IGNORADOS,
  conversas: DadosDasConversas = SEM_CONVERSAS,
  aprovar: readonly ResumoDaEscrita[] = [],
): MeuDia {
  const fazerHoje: TarefaDoDia[] = [];
  const semData: Tarefa[] = [];
  let tarefasAbertas = 0;
  for (const tarefa of ordenar(abertas)) {
    if (tarefa.estado !== "aberta") continue;
    tarefasAbertas += 1;
    const onde = situacao(tarefa.venceEm, hoje);
    if (onde === "atrasada" || onde === "hoje") fazerHoje.push({ ...tarefa, situacao: onde });
    else if (onde === "sem_data") semData.push(tarefa);
  }
  const fontes: IdadeDaFonte[] = [
    { fonte: "tarefas", lidaEm: agora, idadeMin: 0 },
    ...CONECTORES_UNICOS.map((id) => {
      const desde = lidaEm(conectores[id]);
      return { fonte: id, lidaEm: desde, idadeMin: idade(desde, agora) };
    }),
  ];
  if (conectores.email.contas.length > 0) fontes.push(idadeDoEmail(conectores, agora));
  return {
    hoje,
    fazer_hoje: fazerHoje,
    sem_data: semData,
    tarefas_abertas: tarefasAbertas,
    aprovar,
    fontes,
    ...montarBlocosDoCrm(leituras, conectores.crm, hoje, ignorados),
    ...montarBlocosDeConversas(conversas, conectores.whatsapp),
    ignorados_pelo_agente: [...ignoradosPeloAgente(ignorados), ...conversasIgnoradasPeloAgente(conversas.ignoradas, "whatsapp"), ...conversasIgnoradasPeloAgente(conversas.email?.ignoradas ?? [], "email")].sort(ordemDoIgnorado),
    nao_clientes: listarNaoClientes(conversas),
  };
}

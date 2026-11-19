import type { Server } from "bun";
import { z } from "zod";
import { Segredo } from "../cofre";
import {
  contasSemEnviados,
  conversasIgnoradasValendo,
  decidirVinculoDoVendedor,
  desfazerConversaIgnorada,
  desfazerIgnorado,
  desfazerDecisaoDoVendedor,
  gravarNomeDigitado,
  ignorarConversa,
  ignorarItem,
  ignoradosValendo,
  inserirTarefa,
  lerNomesGuardados,
  marcarNomePerguntado,
  lerCabecalhoDeEmail,
  listarCabecalhosDasConversas,
  lerTarefa,
  lidoEmDasContas,
  listarCabecalhos,
  listarTarefas,
  listarVinculos,
  mudarTarefa,
  type BancoAberto,
  type CabecalhoComCaminho,
} from "../banco";
import { sincronizacaoParaOLeitor, type Conectores } from "../conectores";
import {
  ACOES,
  CONECTORES_UNICOS,
  INTERVALO_DO_TESTE_DO_AGENTE_MS,
  MARCA_DO_VENDEDOR,
  TIPOS_DE_IGNORADO,
  AVISO_DA_LISTA_DE_EMAIL,
  SEM_ATENDIMENTO_MAXIMO_DIAS,
  TAMANHO_DO_NOME,
  acoesPossiveis,
  decidirQuemUsa,
  lerNomeDigitado,
  cabecalhoParaOAgente,
  conversaNoMeuDia,
  conversasDeEmail,
  decidirIgnorar,
  detalheComoDado,
  diaEm,
  emailParaOAgente,
  emailParaOPainel,
  enderecoParaOAgente,
  escolherNoVinculo,
  falha,
  lerEnderecoEmail,
  lerIdContaEmail,
  lerIdDeMensagem,
  lerIdDoEmail,
  lerIdDoItemDeEmail,
  lerJid,
  lerMotivo,
  leituraParaOAgente,
  mensagemParaOPainel,
  montarRelatorio,
  periodoDoRelatorio,
  soOVendedorIgnora,
  textoExterno,
  lerTelefone,
  ok,
  paraOLeitor,
  propostaAberta,
  saida,
  statusHttp,
  verComoAgente,
  verContaComoAgente,
  voltaEm,
  type Acao,
  type CanalDeVinculo,
  type ItemDeEsperando,
  type ItemDeResponder,
  type DadosDoEmail,
  type CodigoErro,
  type ContaEmailComEstado,
  type DadosDasConversas,
  type ErroOperacao,
  type IdContaEmail,
  type EstadoPainel,
  type EstadoPorConector,
  type Dia,
  type EnderecoEmail,
  type EscolhaDeVinculo,
  type IdConectorUnico,
  type Instante,
  type JanelaDias,
  type LeiturasDoCrm,
  type PropostaEnviada,
  type QuemIgnorou,
  type TextoExterno,
  type ProvedorEmail,
  type Resultado,
  type TipoDeIgnorado,
  type VisaoDaContaEmail,
  type VisaoDeQuemUsa,
} from "../dominio";
import {
  ACOES_DA_TAREFA,
  comClienteDoCrm,
  criarTarefa,
  idDoClienteNoCrm,
  decidir,
  filtroDaLista,
  lerComando,
  lerCriacao,
  montarMeuDia,
  tarefaDaConversa,
  tarefaDoCrm,
  type Contexto,
  type MeuDia,
  type NovaTarefa,
  type Tarefa,
  type TarefaComNotas,
} from "../tarefas";
import type { Aplicador } from "./aplicacao";
import { montarRotasDeAtualizacao, type AtualizacaoNoDiagnostico, type Descoberta } from "./atualizacao";
import { blocoAprovar, montarRotasDeEscritas } from "./escritas";
import type { Publicador } from "./eventos";
import { ehNavegacaoDeTopo, identificar, lerCorpo, origemAceita, type Chamador, type ContextoDaGuarda } from "./guarda";
import { HASH_DO_ESTILO, paginaSimples, type ArquivoDoPainel } from "./painel";
import type { Sessoes } from "./sessoes";
import type { TravasNoDiagnostico } from "./travas";

export interface Info {
  readonly app: "secretaria-profills";
  readonly versaoNucleo: string;
  readonly idInstalacao: string;
}

export interface Diagnostico {
  readonly instalacao: EstadoPainel["instalacao"];
  readonly servidor: { readonly origem: string; readonly pid: number; readonly dirDados: string };
  readonly cofre: "sistema" | "arquivo";
  readonly wacli: { readonly executavel: string; readonly existe: boolean };
  readonly processos: readonly number[];
  readonly conectores: { readonly [C in IdConectorUnico]: { readonly fase: string; readonly acoes: readonly Acao[] } };
  readonly email: { readonly pulado: boolean; readonly contas: readonly ContaNoDiagnostico[] };
  readonly backup: EstadoDoBackup;
  readonly atualizacao: AtualizacaoNoDiagnostico;
  /** As regras do `.claude/settings.json` do repo que mandam o agente pelo cartão. Guarda, não fronteira. */
  readonly travas: TravasNoDiagnostico;
  /** Sistema operacional e Bun: o pedido de ajuda leva isto ao suporte. */
  readonly sistema: { readonly plataforma: NodeJS.Platform; readonly arquitetura: string; readonly versao: string; readonly bun: string };
}

export interface ContaNoDiagnostico {
  readonly id: string;
  readonly rotulo: string;
  readonly provedor: ProvedorEmail;
  readonly endereco: string;
  readonly servidor: string;
  readonly porta: number;
  readonly janelaDias: JanelaDias;
  readonly fase: string;
  readonly acoes: readonly Acao[];
}

/** O último backup diário. Falha de backup não derruba o servidor: vira `aviso` aqui. */
export interface EstadoDoBackup {
  readonly dia: Dia | null;
  readonly arquivo: string | null;
  readonly aviso: string | null;
}

/** Resposta de toda ação sobre uma tarefa: ela como ficou, com as notas, e a seguinte quando o concluir criou uma. */
export interface RespostaDaTarefa extends TarefaComNotas {
  readonly seguinte: Tarefa | null;
}

export interface DependenciasDasRotas {
  readonly guarda: ContextoDaGuarda;
  readonly sessoes: Sessoes;
  readonly conectores: Conectores;
  readonly publicador: Publicador;
  readonly painel: ReadonlyMap<string, ArquivoDoPainel>;
  readonly info: Info;
  readonly banco: BancoAberto;
  agora(): Instante;
  /** Faz o backup do dia se ainda não houver um. Nunca lança. */
  garantirBackup(): void;
  retrato(): EstadoPainel;
  diagnostico(): Diagnostico;
  readonly descoberta: Descoberta;
  readonly aplicador: Aplicador;
  /** O agente pediu para parar. A resposta sai antes de a parada começar. */
  pedirParada(): void;
}

export interface Pedido {
  readonly req: Request;
  readonly url: URL;
  readonly chamador: Chamador;
  readonly parametros: Readonly<Record<string, string>>;
  readonly server: Server<unknown>;
}

export interface Rota {
  readonly metodo: "GET" | "POST";
  /** Segmentos com `:nome` viram parâmetros. */
  readonly caminho: string;
  readonly quem: readonly Chamador[];
  /** Só o retorno do OAuth aceita navegação vinda de outro site. */
  readonly entreSites?: true;
  tratar(pedido: Pedido): Promise<Response> | Response;
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  `style-src 'self' ${HASH_DO_ESTILO}`,
  "img-src 'self' data:",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

const CABECALHOS_FIXOS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": CSP,
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

function leitorDe(chamador: Chamador | null) {
  return chamador === "agente" ? "agente" : "vendedor";
}

export function respostaJson<T>(resultado: Resultado<T>, chamador: Chamador | null): Response {
  if (resultado.ok) return Response.json(saida(resultado));
  const erro = paraOLeitor(resultado.erro, leitorDe(chamador));
  return Response.json(saida({ ok: false, erro }), { status: statusHttp(erro) });
}

function html(corpo: string, status = 200): Response {
  return new Response(corpo, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function erroEmPagina(erro: ErroOperacao): Response {
  const vendedor = paraOLeitor(erro, "vendedor");
  return html(paginaSimples("Secretária", [vendedor.mensagem, vendedor.acao]), statusHttp(vendedor));
}

function erroDaTabela(codigo: CodigoErro): ErroOperacao {
  const resultado = falha(codigo);
  if (resultado.ok) throw new Error("falha() sempre devolve erro");
  return resultado.erro;
}

/** Erro da guarda ou do roteamento, no formato que quem pediu sabe ler. */
function recusar(url: URL, codigo: CodigoErro, chamador: Chamador | null): Response {
  if (url.pathname.startsWith("/api/")) return respostaJson(falha(codigo), chamador);
  return erroEmPagina(erroDaTabela(codigo));
}

const corpoDoWhatsapp = z.discriminatedUnion("meio", [
  z.strictObject({ meio: z.literal("qr") }),
  z.strictObject({ meio: z.literal("codigo"), telefone: z.string() }),
]);

const RODADA = z.iso.datetime().optional();
const corpoDoReparear = z.discriminatedUnion("meio", [
  z.strictObject({ meio: z.literal("qr"), rodada: RODADA }),
  z.strictObject({ meio: z.literal("codigo"), telefone: z.string(), rodada: RODADA }),
]);

const SENHA = z.string().min(1);

/** A forma do corpo; o que cada campo pode valer, a fachada do e-mail confere. */
const corpoDeAdicionar = z.strictObject({
  id: z.string().optional(),
  rotulo: z.string(),
  provedor: z.string(),
  endereco: z.string(),
  servidor: z.string().optional(),
  porta: z.number().int().optional(),
  seguranca: z.string().optional(),
  janelaDias: z.number().int().optional(),
  senha: SENHA,
});

const corpoDeConectarConta = z.strictObject({
  senha: SENHA,
  servidor: z.string().optional(),
  porta: z.number().int().optional(),
  seguranca: z.string().optional(),
});

const corpoDePular = z.strictObject({ pulado: z.boolean() });

const corpoDeQuemUsa = z.union([z.strictObject({ nome: z.string().max(200) }), z.strictObject({ agoraNao: z.literal(true) })]);

const corpoDaSincronizacao = z.strictObject({ semAtendimentoHaDias: z.number().int().min(1).max(SEM_ATENDIMENTO_MAXIMO_DIAS).optional() }).optional();

const ID_NO_CRM = z.number().int().min(1).max(2_147_483_647);
const TELEFONE_DA_CONVERSA = z.string().refine((valor) => lerTelefone(valor) !== null);
/** O alvo de Ignorar e de Criar tarefa: proposta ou cliente pelo id do CRM, conversa pelo telefone. */
const alvoDoCrm = { tipo: z.enum(TIPOS_DE_IGNORADO), id: ID_NO_CRM };
const ID_DO_ITEM_DE_EMAIL = z.string().refine((valor) => lerIdDoItemDeEmail(valor) !== null);
/** A conversa do WhatsApp leva o telefone em `id`, com ou sem `canal`; a de e-mail leva o id do item (`e-...`). */
const alvoDeConversa = { tipo: z.literal("conversa"), canal: z.literal("whatsapp").optional(), id: TELEFONE_DA_CONVERSA };
const alvoDeConversaDeEmail = { tipo: z.literal("conversa"), canal: z.literal("email"), id: ID_DO_ITEM_DE_EMAIL };
const motivoOpcional = { motivo: z.string().optional() };
const corpoDoItem = z.union([z.strictObject(alvoDoCrm), z.strictObject(alvoDeConversa), z.strictObject(alvoDeConversaDeEmail)]);
const corpoDoIgnorado = z.union([
  z.strictObject({ ...alvoDoCrm, ...motivoOpcional }),
  z.strictObject({ ...alvoDeConversa, ...motivoOpcional }),
  z.strictObject({ ...alvoDeConversaDeEmail, ...motivoOpcional }),
]);
const corpoDaTarefaDoMeuDia = z.union([
  z.strictObject({ ...alvoDoCrm, tarefaId: z.uuid() }),
  z.strictObject({ ...alvoDeConversa, tarefaId: z.uuid() }),
  z.strictObject({ ...alvoDeConversaDeEmail, tarefaId: z.uuid() }),
]);

/** O endereço do vínculo de e-mail: validado por `lerEnderecoEmail` e, na borda, em minúsculas. */
const ENDERECO_DO_VINCULO = z
  .string()
  .refine((valor) => lerEnderecoEmail(valor) !== null)
  .transform((valor) => valor.toLowerCase());
const vinculoDoWhatsapp = z.strictObject({ canal: z.literal("whatsapp"), chave: TELEFONE_DA_CONVERSA });
const vinculoDeEmail = z.strictObject({ canal: z.literal("email"), chave: ENDERECO_DO_VINCULO });
const corpoDoVinculo = z.union([vinculoDoWhatsapp, vinculoDeEmail]);
const corpoDeEscolher = z.union([
  vinculoDoWhatsapp.extend({ clienteId: ID_NO_CRM }),
  vinculoDoWhatsapp.extend({ naoCliente: z.literal(true) }),
  vinculoDeEmail.extend({ clienteId: ID_NO_CRM }),
  vinculoDeEmail.extend({ naoCliente: z.literal(true) }),
]);

const FORMA_DO_IGNORADO =
  'Mande {"tipo":"proposta"|"cliente","id":<id no CRM>,"motivo":"<as palavras do vendedor>"}, {"tipo":"conversa","id":"<telefone +5511999998888>","motivo":"..."} (WhatsApp, com ou sem "canal":"whatsapp") ou {"tipo":"conversa","canal":"email","id":"<id do item, e-0123456789abcdef>","motivo":"..."}.';
const FORMA_DO_ITEM =
  'Mande {"tipo":"proposta"|"cliente","id":<id no CRM>}, {"tipo":"conversa","id":"<telefone +5511999998888>"} (WhatsApp, com ou sem "canal":"whatsapp") ou {"tipo":"conversa","canal":"email","id":"<id do item, e-0123456789abcdef>"}.';
const FORMA_DA_TAREFA_DO_MEU_DIA =
  'Mande {"tipo":"proposta"|"cliente","id":<id no CRM>,"tarefaId":"<uuid>"}, {"tipo":"conversa","id":"<telefone>","tarefaId":"<uuid>"} (WhatsApp, com ou sem "canal":"whatsapp") ou {"tipo":"conversa","canal":"email","id":"<id do item, e-0123456789abcdef>","tarefaId":"<uuid>"}.';
const FORMA_DA_ESCOLHA =
  'Mande {"canal":"whatsapp","chave":"<telefone +5511999998888>","clienteId":<id no CRM>}, {"canal":"whatsapp","chave":"<telefone>","naoCliente":true}, {"canal":"email","chave":"<endereço do remetente>","clienteId":<id no CRM>} ou {"canal":"email","chave":"<endereço>","naoCliente":true}.';
const FORMA_DO_VINCULO = 'Mande {"canal":"whatsapp","chave":"<telefone +5511999998888>"} ou {"canal":"email","chave":"<endereço do remetente>"}.';
const SO_O_VENDEDOR_ESCOLHE =
  "Escolher de quem é uma conversa é do vendedor, no painel. O número ou o endereço pode ser de mais de um cliente: avise o vendedor, com o telefone ou o endereço da conversa, para escolher o cliente no painel. Você não escolhe.";

/** Uma proposta ou um cliente da última leitura do CRM, com o que a marca e a tarefa guardam dele. */
type ItemDaLeitura =
  | { readonly tipo: "proposta"; readonly proposta: PropostaEnviada; readonly clienteId: number; readonly nome: TextoExterno; readonly codigo: TextoExterno }
  | { readonly tipo: "cliente"; readonly clienteId: number; readonly nome: TextoExterno; readonly codigo: null };

/** Só se ignora o que o Meu dia pode mostrar: o id tem de estar na leitura guardada daquele tipo. */
function itemDaLeitura(leituras: LeiturasDoCrm, tipo: TipoDeIgnorado, id: number): ItemDaLeitura | null {
  if (tipo === "proposta") {
    const proposta = leituras.propostas?.itens.find((item) => item.id === id);
    return proposta === undefined ? null : { tipo, proposta, clienteId: proposta.cliente.id, nome: proposta.cliente.nome, codigo: proposta.codigo };
  }
  const cliente = leituras.carteira?.itens.find((item) => item.id === id);
  return cliente === undefined ? null : { tipo, clienteId: cliente.id, nome: cliente.nome, codigo: null };
}

/** Proposta, cliente ou conversa ignorados: o item fica fora do Meu dia até `ate`, o primeiro dia em que volta. */
export type ItemIgnorado = {
  readonly ate: Dia;
  readonly quem: QuemIgnorou;
  /** Ao agente, citado como dado. */
  readonly motivo: string | null;
} & ({ readonly tipo: TipoDeIgnorado; readonly id: number } | { readonly tipo: "conversa"; readonly canal: CanalDeVinculo; readonly id: string });

/** O motivo é texto de fora para o agente que o lê depois, como o nome do cliente: sai citado como dado. */
function motivoPara(motivo: string, chamador: Chamador): string {
  return chamador === "agente" ? detalheComoDado(textoExterno(motivo)) : motivo;
}

const comoDado = (texto: TextoExterno | null): TextoExterno | null => (texto === null ? null : detalheComoDado(texto));

/** O item de e-mail leva o assunto e o nome do remetente; o do WhatsApp, o nome da conversa. Texto de fora: ao agente sai citado como dado. O endereço com sinal não sai. */
function itemParaOAgente<I extends ItemDeResponder | ItemDeEsperando>(item: I): I {
  if (item.canal === "email") return { ...item, endereco: enderecoParaOAgente(item.endereco ?? ""), assunto: comoDado(item.assunto), nome_do_remetente: comoDado(item.nome_do_remetente) };
  return "nome_no_whatsapp" in item ? { ...item, nome_no_whatsapp: comoDado(item.nome_no_whatsapp) } : item;
}

/** O nome da conversa, o assunto e o nome do remetente são texto de fora: ao agente saem citados como dado. */
function meuDiaPara(dia: MeuDia, chamador: Chamador): MeuDia {
  if (chamador !== "agente") return dia;
  return {
    ...dia,
    responder: { ...dia.responder, itens: dia.responder.itens.map(itemParaOAgente) },
    esperando_cliente: { ...dia.esperando_cliente, itens: dia.esperando_cliente.itens.map(itemParaOAgente) },
    ignorados_pelo_agente: dia.ignorados_pelo_agente.map((item) => ({ ...item, motivo: motivoPara(item.motivo, chamador) })),
    nao_clientes: dia.nao_clientes.map((item) => (item.canal === "whatsapp" ? { ...item, nome_no_whatsapp: comoDado(item.nome_no_whatsapp) } : { ...item, endereco: enderecoParaOAgente(item.endereco ?? "") })),
  };
}

interface EmailAchado {
  readonly conta: { readonly id: IdContaEmail; readonly rotulo: string };
  readonly cabecalho: CabecalhoComCaminho;
}

/** As ações que levam a uma fase que só existe em memória (pareando, autorizando, testando) e se perderia no restart. */
const COMECA_FASE_EM_MEMORIA: readonly string[] = ["conectar", "reparear", "testar"];
/** Ações de uma conta de e-mail. `remover` e `mudar` não são da máquina: apagam a conta ou trocam rótulo e janela. */
const ACOES_DA_CONTA = ["conectar", "cancelar", "testar", "desconectar", "remover", "mudar"] as const;
type AcaoDaConta = (typeof ACOES_DA_CONTA)[number];

/** Senha, desligar e apagar uma conta de e-mail são do vendedor, no painel. */
const SO_NO_PAINEL_DO_EMAIL: readonly AcaoDaConta[] = ["conectar", "desconectar", "remover"];

/** A conta com as ações da fase. Ao agente, o detalhe do problema sai marcado como dado. */
function verConta(conta: ContaEmailComEstado, chamador: Chamador): VisaoDaContaEmail {
  const visao = { ...conta, acoes: acoesPossiveis(conta.estado) };
  return chamador === "agente" ? verContaComoAgente(visao) : visao;
}

const corpoDaLeitura = z.strictObject({ args: z.array(z.string()).min(1).max(32) });

const LIMITE_PADRAO_DE_EMAIL = 50;
const LIMITE_MAXIMO_DE_EMAIL = 200;
/** A leitura de um corpo abre uma conexão: o prazo é o de um login e um download, e não segura o pedido além disso. */
const PRAZO_DA_LEITURA_DO_CORPO_MS = 45_000;

const consultaDosEmails = z.object({
  conta: z.string().refine((valor) => lerIdContaEmail(valor) !== null).optional(),
  de: z.string().trim().refine((valor) => lerEnderecoEmail(valor) !== null).optional(),
  limite: z
    .string()
    .regex(/^[0-9]{1,3}$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(LIMITE_MAXIMO_DE_EMAIL))
    .optional(),
});

const corpoDaLeituraDeEmail = z.strictObject({ conta: z.string().refine((valor) => lerIdContaEmail(valor) !== null), id: z.string().refine((valor) => lerIdDoEmail(valor) !== null) });
const consultaDoCorpo = z.object({ conta: corpoDaLeituraDeEmail.shape.conta, id: corpoDaLeituraDeEmail.shape.id });

const FORMA_DA_LISTA_DE_EMAIL = `Mande ?conta=<id da conta>&de=<endereço>&limite=<1 a ${LIMITE_MAXIMO_DE_EMAIL}>, todos opcionais.`;
const FORMA_DA_LEITURA_DE_EMAIL = "Mande o id da conta e o id do e-mail que `email mensagens` devolveu, como entrada-1731500000-42.";
const SO_O_VENDEDOR_ABRE_O_EMAIL =
  "E-mail em quarentena se lê só no painel. Avise o vendedor, com o id do e-mail e a conta, de que ele o abre no painel. Não leia o texto por outro caminho.";

const consultaDaQuarentena = z.object({
  conversa: z.string().refine((valor) => lerJid(valor) !== null),
  id: z.string().refine((valor) => lerIdDeMensagem(valor) !== null),
});

const SO_O_VENDEDOR_ABRE_A_MENSAGEM =
  "O texto de uma mensagem em quarentena só o vendedor lê, no painel. Avise o vendedor do id e da conversa; não leia o texto por outro caminho.";

/**
 * Dizer de quem é o número e desligar a conta do WhatsApp cabem ao vendedor. A recusa ao Bearer barra o
 * agente que segue as regras, não um processo do mesmo usuário que se passa pelo painel (docs/arquitetura.md).
 */
const DECISOES_DO_VENDEDOR: readonly Acao[] = ["confirmar", "recusar", "desconectar"];

type Entrada = { readonly ok: true; readonly dados: unknown } | { readonly ok: false; readonly erro: Resultado<never> };

/**
 * Converte o corpo que o painel ou o CLI mandam no que a fachada dos conectores pede.
 * O login do CRM começa por navegação em `/oauth/crm/iniciar`, então ninguém o abre por POST.
 */
function lerEntrada(id: IdConectorUnico, acao: Acao, corpo: unknown, chamador: Chamador): Entrada {
  const invalida = (mensagem: string): Entrada => ({ ok: false, erro: falha("entrada_invalida", mensagem) });
  if (id === "whatsapp" && chamador !== "painel" && DECISOES_DO_VENDEDOR.includes(acao)) {
    return { ok: false, erro: falha("so_no_painel", "Confirmar, recusar e desconectar a conta do WhatsApp são decisões do vendedor, no painel.") };
  }
  if (id === "crm" && acao === "conectar") return { ok: false, erro: falha("so_no_painel", "O login do CRM começa no botão Conectar do painel.") };
  if (id !== "whatsapp" || (acao !== "conectar" && acao !== "reparear")) {
    return corpo === undefined ? { ok: true, dados: undefined } : invalida(`A ação "${acao}" não leva corpo.`);
  }
  const lido = (acao === "conectar" ? corpoDoWhatsapp : corpoDoReparear).safeParse(corpo);
  if (!lido.success) return invalida('Mande {"meio":"qr"} ou {"meio":"codigo","telefone":"+5511999998888"}.');
  if (lido.data.meio === "qr") return { ok: true, dados: lido.data };
  const telefone = lerTelefone(lido.data.telefone);
  return telefone === null ? invalida("O telefone precisa estar no formato +5511999998888.") : { ok: true, dados: { ...lido.data, telefone } };
}

function ehDaLista<T extends string>(lista: readonly T[], valor: string | undefined): valor is T {
  return valor !== undefined && (lista as readonly string[]).includes(valor);
}

/** O alvo de um pedido de Ignorar: proposta ou cliente pelo id do CRM, conversa pelo canal e pela chave (telefone, ou id do item de e-mail). */
type PedidoDeAlvo = { readonly tipo: TipoDeIgnorado; readonly id: number } | { readonly tipo: "conversa"; readonly canal: CanalDeVinculo; readonly id: string };

/** `canal` ausente é o pedido de antes do e-mail: WhatsApp, com o telefone em `id`. */
function alvoDoPedido(lido: { readonly tipo: TipoDeIgnorado; readonly id: number } | { readonly tipo: "conversa"; readonly canal?: CanalDeVinculo | undefined; readonly id: string }): PedidoDeAlvo {
  return lido.tipo === "conversa" ? { tipo: "conversa", canal: lido.canal ?? "whatsapp", id: lido.id } : lido;
}

interface AlvoDeIgnorar {
  readonly semItem: string | null;
  readonly marcaDoVendedor: boolean;
  readonly pertoDoBloqueio: string | null;
  gravar(decisao: { readonly quem: QuemIgnorou; readonly motivo: string | null; readonly ate: Dia }, agora: Instante): void;
  desfazer(): boolean;
}

function itemIgnorado(alvo: PedidoDeAlvo, resto: Omit<ItemIgnorado, "tipo" | "id" | "canal">): ItemIgnorado {
  return alvo.tipo === "conversa" ? { ...resto, tipo: "conversa", canal: alvo.canal, id: alvo.id } : { ...resto, tipo: alvo.tipo, id: alvo.id };
}

export function montarRotas(deps: DependenciasDasRotas): readonly Rota[] {
  const { conectores, retrato, publicador, sessoes, banco } = deps;
  /** Quando o agente pediu o último `testar` de cada conta de e-mail. */
  const ultimoTesteDoAgente = new Map<string, number>();

  function contexto(chamador: Chamador): Contexto {
    const agora = deps.agora();
    return { papel: chamador === "painel" ? "painel" : "agente", agora, hoje: diaEm(agora), novoId: () => crypto.randomUUID() };
  }

  /** Cria a tarefa. Com `clienteId` do CRM, o nome passa a ser o que o CRM devolve. */
  async function criarConferindo(nova: NovaTarefa, ctx: Contexto): Promise<Resultado<RespostaDaTarefa>> {
    let entrada = nova;
    // Pedido repetido não confere de novo no CRM: devolve a tarefa que já existe.
    if (entrada.id !== undefined && lerTarefa(banco, entrada.id) !== null) return comNotas(entrada.id, null);
    const idNoCrm = idDoClienteNoCrm(entrada.clienteId);
    if (idNoCrm !== null) {
      const conferencia = await conectores.conferirCliente(idNoCrm);
      if (conferencia.tipo === "nao_encontrado") {
        return falha("crm_nao_encontrado", `O CRM não achou o cliente ${idNoCrm}, ou o vendedor não tem acesso a ele. A tarefa não foi criada.`);
      }
      if (conferencia.tipo === "conferido") entrada = comClienteDoCrm(entrada, conferencia.ficha.nome);
    }
    const decisao = criarTarefa(entrada, ctx);
    if (inserirTarefa(banco, decisao)) publicador.tarefasMudaram();
    return comNotas(decisao.tarefa.id, null);
  }

  /** As conversas como o Meu dia as lê: o cache da sincronização, os vínculos e as marcas. Não chama o wacli nem o CRM. */
  function dadosDasConversas(hoje: Dia): DadosDasConversas {
    return { leitura: conectores.leituraDeConversas(), vinculos: listarVinculos(banco, "whatsapp"), ignoradas: conversasIgnoradasValendo(banco, "whatsapp", hoje), email: dadosDoEmail(hoje) };
  }

  /**
   * O e-mail como o Meu dia o lê, na hora e do banco: cabeçalhos, vínculos e marcas. Sem conta conectada
   * não lê cabeçalho nenhum. Não chama o IMAP nem o CRM.
   */
  function dadosDoEmail(hoje: Dia): DadosDoEmail {
    const contas = conectores.estado().email.contas.map((conta) => ({ id: conta.id, rotulo: conta.rotulo, conectada: conta.estado.fase === "conectado" }));
    return {
      contas,
      conversas: contas.some((conta) => conta.conectada) ? conversasDeEmail(listarCabecalhosDasConversas(banco), deps.agora()) : [],
      vinculos: listarVinculos(banco, "email"),
      ignoradas: conversasIgnoradasValendo(banco, "email", hoje),
      lidoEm: lidoEmDasContas(banco),
      semEnviados: contasSemEnviados(banco),
    };
  }

  function conversaDoMeuDia(canal: CanalDeVinculo, chave: string) {
    return conversaNoMeuDia(dadosDasConversas(diaEm(deps.agora())), canal, chave);
  }

  /**
   * O que Ignorar e Desfazer precisam de um alvo: se ele está no Meu dia, se a marca que vale é do
   * vendedor (o agente não a desfaz nem regrava), se a proposta está perto do bloqueio, e como gravar e tirar a marca.
   * O que o vendedor ignorou no painel é dele.
   */
  function alvoDeIgnorar(alvo: PedidoDeAlvo, hoje: Dia): AlvoDeIgnorar {
    if (alvo.tipo === "conversa") {
      const { canal, id: chave } = alvo;
      const marcaDoVendedor = conversasIgnoradasValendo(banco, canal, hoje).some((marca) => marca.id === chave && marca.quem === "vendedor");
      const conversa = conversaDoMeuDia(canal, chave);
      // O nome da marca é o do cliente no CRM, ou o telefone ou o endereço: nome de contato, assunto e nome de remetente não viram marca.
      // O endereço com sinal também não: a marca vai ao agente em `ignorados_pelo_agente`, e fica com o id do item.
      const quem = conversa === null ? chave : conversa.item.canal === "email" ? (enderecoParaOAgente(conversa.item.endereco ?? "") ?? chave) : conversa.item.telefone;
      return {
        semItem: conversa === null ? "Esta conversa não está em Responder nem em Esperando cliente." : null,
        marcaDoVendedor,
        pertoDoBloqueio: null,
        gravar: (decisao, agora) => ignorarConversa(banco, canal, { tipo: "conversa", id: chave, nome: conversa?.item.cliente?.nome ?? textoExterno(quem), ...decisao }, agora),
        desfazer: () => desfazerConversaIgnorada(banco, canal, chave),
      };
    }
    const tipo = alvo.tipo;
    const codigo = alvo.id;
    const marcaDoVendedor = ignoradosValendo(banco, hoje).some((marca) => marca.tipo === tipo && marca.id === codigo && marca.quem === "vendedor");
    const item = itemDaLeitura(conectores.leiturasDoCrm(), tipo, codigo);
    let pertoDoBloqueio: string | null = null;
    if (item?.tipo === "proposta" && soOVendedorIgnora(item.proposta, hoje)) {
      const prazo = propostaAberta(item.proposta, hoje);
      const quando = prazo.prazo_vencido ? "já venceu o prazo de retorno" : `vence o prazo de retorno em ${prazo.dias_para_o_prazo} dia(s)`;
      pertoDoBloqueio = `A proposta ${codigo} ${quando}. Só o vendedor a tira do Meu dia, no painel.`;
    }
    return {
      semItem: item === null ? "Este item não está na última leitura do CRM." : null,
      marcaDoVendedor,
      pertoDoBloqueio,
      gravar(decisao, agora) {
        if (item !== null) ignorarItem(banco, { tipo, id: codigo, nome: item.nome, codigo: item.codigo, ...decisao }, agora);
      },
      desfazer: () => desfazerIgnorado(banco, tipo, codigo),
    };
  }

  /** A conta e o cabeçalho de um e-mail pelo id. `nao_encontrado` para conta ou id que o banco não tem. */
  function acharEmail(contaTexto: string, idTexto: string): Resultado<EmailAchado> {
    const contaId = lerIdContaEmail(contaTexto);
    const idDoEmail = lerIdDoEmail(idTexto);
    if (contaId === null || idDoEmail === null) return falha("entrada_invalida", FORMA_DA_LEITURA_DE_EMAIL);
    const conta = conectores.estado().email.contas.find((candidata) => candidata.id === contaId);
    if (conta === undefined) return falha("nao_encontrado", "Esta conta de e-mail não existe. Confira a lista em `email.contas` do estado.");
    const cabecalho = lerCabecalhoDeEmail(banco, contaId, idDoEmail);
    if (cabecalho === null) return falha("nao_encontrado", "Este e-mail não está na base. Sincronize e liste de novo.");
    return ok({ conta: { id: conta.id, rotulo: conta.rotulo }, cabecalho });
  }

  /** Lê o corpo agora, pelo IMAP. O texto volta a quem pediu e não passa por banco, cache, registro nem SSE. */
  async function lerOCorpo(contaTexto: string, idTexto: string) {
    const achado = acharEmail(contaTexto, idTexto);
    if (!achado.ok) return achado;
    const { conta, cabecalho } = achado.dados;
    const corpo = await conectores.email.lerCorpo(
      conta.id,
      { caminho: cabecalho.caminho, uidValidity: cabecalho.cabecalho.uidValidity, uid: cabecalho.cabecalho.uid },
      AbortSignal.timeout(PRAZO_DA_LEITURA_DO_CORPO_MS),
    );
    if (!corpo.ok) return corpo;
    return ok({ email: { id: idTexto, conta, de: cabecalho.cabecalho.remetente, em: cabecalho.cabecalho.instante }, corpo: corpo.dados });
  }

  /** Com o CRM conectado e as propostas ainda não lidas, a sincronização ao conectar vai trazer o nome. */
  function quemUsa(): VisaoDeQuemUsa {
    const nomes = lerNomesGuardados(banco);
    const crm = conectores.estado().crm.fase !== "conectado" ? "fora" : nomes.doCrmLidoEm === null ? "esperando" : "lido";
    return decidirQuemUsa({ digitado: nomes.digitado, perguntadoEm: nomes.perguntadoEm, doCrm: nomes.doCrm, crm });
  }

  function comNotas(id: string, seguinte: Tarefa | null): Resultado<RespostaDaTarefa> {
    const lida = lerTarefa(banco, id);
    return lida === null ? falha("nao_encontrado", `Não existe tarefa com o id ${id}.`) : ok({ ...lida, seguinte });
  }

  /** A resposta ao Bearer do agente não leva QR nem código de pareamento, nem na resposta de uma ação. */
  function estadoPara<C extends IdConectorUnico>(id: C, estado: EstadoPorConector[C], chamador: Chamador): unknown {
    if (chamador !== "agente") return estado;
    const atual = retrato();
    const painel: EstadoPainel = { ...atual, conectores: { ...atual.conectores, [id]: { estado, acoes: [] } } };
    return verComoAgente(painel).conectores[id].estado;
  }

  return [
    ...montarRotasDeEscritas({ banco, conectores, publicador, aplicador: deps.aplicador, agora: deps.agora }),
    ...montarRotasDeAtualizacao(deps.descoberta, deps.aplicador),
    {
      metodo: "GET",
      caminho: "/",
      quem: ["painel", "anonimo"],
      tratar({ chamador }) {
        const pagina = deps.painel.get("/");
        if (chamador === "painel" && pagina !== undefined) return new Response(pagina.corpo, { headers: { "Content-Type": pagina.tipo } });
        return html(
          paginaSimples("Abra o painel pelo seu agente", [
            "Esta página precisa de uma sessão aberta pelo seu agente.",
            "Peça a ele para abrir o painel da Secretária. Ele roda `bun secretaria abrir`.",
          ]),
          401,
        );
      },
    },
    {
      metodo: "GET",
      caminho: "/entrar",
      quem: ["anonimo", "painel"],
      async tratar({ req, url }) {
        // Recusa antes de gastar o bilhete: o navegador do vendedor ainda entra com ele.
        if (!ehNavegacaoDeTopo(req)) return erroEmPagina(erroDaTabela("origem_recusada"));
        const cookie = await sessoes.trocarBilhete(url.searchParams.get("b") ?? "");
        if (cookie === null) {
          return html(
            paginaSimples("Este link já foi usado", [
              "O link de entrada vale uma vez e por um minuto.",
              "Peça ao seu agente para abrir o painel de novo.",
            ]),
            401,
          );
        }
        return new Response(null, { status: 303, headers: { Location: "/", "Set-Cookie": cookie } });
      },
    },
    {
      metodo: "GET",
      caminho: "/api/info",
      quem: ["anonimo", "painel", "agente"],
      tratar: ({ chamador }) => respostaJson(ok(deps.info), chamador),
    },
    {
      metodo: "GET",
      caminho: "/api/estado",
      quem: ["painel", "agente"],
      tratar({ chamador }) {
        const painel = retrato();
        return respostaJson(ok(chamador === "agente" ? verComoAgente(painel) : painel), chamador);
      },
    },
    {
      metodo: "GET",
      caminho: "/api/eventos",
      quem: ["painel", "agente"],
      tratar({ req, server, chamador }) {
        // O `Bun.serve` fecha conexão parada por 10 s; o SSE fica quieto entre mudanças.
        server.timeout(req, 0);
        return new Response(publicador.assinar(chamador === "agente" ? "agente" : "painel"), {
          headers: { "Content-Type": "text/event-stream; charset=utf-8" },
        });
      },
    },
    {
      metodo: "GET",
      caminho: "/api/diagnostico",
      quem: ["painel", "agente"],
      tratar: ({ chamador }) => respostaJson(ok(deps.diagnostico()), chamador),
    },
    {
      metodo: "POST",
      caminho: "/api/conectores/:id/:acao",
      quem: ["painel", "agente"],
      async tratar({ req, parametros, chamador }) {
        const { id, acao } = parametros;
        if (id === "email") return respostaJson(falha("nao_encontrado", "O e-mail tem uma rota por conta: POST /api/email/contas/:id/:acao."), chamador);
        if (!ehDaLista(CONECTORES_UNICOS, id) || !ehDaLista(ACOES, acao)) return respostaJson(falha("nao_encontrado"), chamador);
        const corpo = await lerCorpo(req);
        if (!corpo.ok) return respostaJson(falha(corpo.codigo), chamador);
        const entrada = lerEntrada(id, acao, corpo.valor, chamador);
        if (!entrada.ok) return respostaJson(entrada.erro, chamador);
        const durante = COMECA_FASE_EM_MEMORIA.includes(acao) ? deps.aplicador.recusaDuranteAAtualizacao() : null;
        if (durante !== null) return respostaJson(durante, chamador);
        const resultado = await conectores.agir(id, acao, entrada.dados);
        return respostaJson(resultado.ok ? ok(estadoPara(id, resultado.dados.estado, chamador)) : resultado, chamador);
      },
    },
    {
      metodo: "POST",
      caminho: "/api/email/contas",
      quem: ["painel", "agente"],
      async tratar({ req, chamador }) {
        if (chamador !== "painel") return respostaJson(falha("so_no_painel", "Adicionar conta de e-mail e digitar a senha são do vendedor, no painel."), chamador);
        const corpo = await lerCorpo(req);
        if (!corpo.ok) return respostaJson(falha(corpo.codigo), chamador);
        const lido = corpoDeAdicionar.safeParse(corpo.valor);
        if (!lido.success) return respostaJson(falha("entrada_invalida", "Mande rotulo, provedor, endereco e senha, e servidor, porta e seguranca quando o provedor é outro."), chamador);
        const durante = deps.aplicador.recusaDuranteAAtualizacao();
        if (durante !== null) return respostaJson(durante, chamador);
        const resultado = await conectores.email.adicionar({ ...lido.data, senha: Segredo.de(lido.data.senha) });
        return respostaJson(resultado.ok ? ok(verConta(resultado.dados, chamador)) : resultado, chamador);
      },
    },
    {
      metodo: "POST",
      caminho: "/api/email/contas/:id/:acao",
      quem: ["painel", "agente"],
      async tratar({ req, parametros, chamador }) {
        const { id = "", acao } = parametros;
        if (!ehDaLista(ACOES_DA_CONTA, acao)) return respostaJson(falha("nao_encontrado"), chamador);
        if (chamador !== "painel" && SO_NO_PAINEL_DO_EMAIL.includes(acao)) {
          return respostaJson(falha("so_no_painel", "Conectar, desconectar e remover uma conta de e-mail são decisões do vendedor, no painel."), chamador);
        }
        const corpo = await lerCorpo(req);
        if (!corpo.ok) return respostaJson(falha(corpo.codigo), chamador);
        if (acao === "remover") {
          if (corpo.valor !== undefined) return respostaJson(falha("entrada_invalida", "A ação \"remover\" não leva corpo."), chamador);
          return respostaJson(await conectores.email.remover(id), chamador);
        }
        if (acao === "mudar") {
          const resultado = await conectores.email.mudar(id, corpo.valor);
          return respostaJson(resultado.ok ? ok(verConta(resultado.dados, chamador)) : resultado, chamador);
        }
        if (acao === "testar" && chamador === "agente") {
          const agora = Date.parse(deps.agora());
          const ultimo = ultimoTesteDoAgente.get(id);
          if (ultimo !== undefined && agora - ultimo < INTERVALO_DO_TESTE_DO_AGENTE_MS) return respostaJson(falha("testar_cedo_demais"), chamador);
          ultimoTesteDoAgente.set(id, agora);
        }
        let dados: unknown;
        if (acao === "conectar") {
          const lido = corpoDeConectarConta.safeParse(corpo.valor);
          if (!lido.success) return respostaJson(falha("entrada_invalida", "Mande a senha e, se mudou, servidor, porta e seguranca."), chamador);
          dados = { ...lido.data, senha: Segredo.de(lido.data.senha) };
        } else if (corpo.valor !== undefined) {
          return respostaJson(falha("entrada_invalida", `A ação "${acao}" não leva corpo.`), chamador);
        }
        const durante = COMECA_FASE_EM_MEMORIA.includes(acao) ? deps.aplicador.recusaDuranteAAtualizacao() : null;
        if (durante !== null) return respostaJson(durante, chamador);
        const resultado = await conectores.email.agir(id, acao, dados);
        return respostaJson(resultado.ok ? ok(verConta(resultado.dados, chamador)) : resultado, chamador);
      },
    },
    {
      metodo: "POST",
      caminho: "/api/email/pular",
      quem: ["painel", "agente"],
      async tratar({ req, chamador }) {
        const corpo = await lerCorpo(req);
        if (!corpo.ok) return respostaJson(falha(corpo.codigo), chamador);
        const lido = corpoDePular.safeParse(corpo.valor);
        if (!lido.success) return respostaJson(falha("entrada_invalida", 'Mande {"pulado":true} para pular o e-mail ou {"pulado":false} para voltar atrás.'), chamador);
        const resultado = await conectores.email.pular(lido.data.pulado);
        return respostaJson(resultado.ok ? ok(retrato().email) : resultado, chamador);
      },
    },
    {
      metodo: "GET",
      caminho: "/api/tarefas",
      quem: ["painel", "agente"],
      tratar({ url, chamador }) {
        const filtro = filtroDaLista.safeParse(url.searchParams.get("estado") ?? undefined);
        if (!filtro.success) return respostaJson(falha("entrada_invalida", "O filtro `estado` aceita aberta, concluida ou descartada."), chamador);
        return respostaJson(ok({ tarefas: listarTarefas(banco, filtro.data) }), chamador);
      },
    },
    {
      metodo: "POST",
      caminho: "/api/tarefas",
      quem: ["painel", "agente"],
      async tratar({ req, chamador }) {
        const corpo = await lerCorpo(req);
        if (!corpo.ok) return respostaJson(falha(corpo.codigo), chamador);
        const ctx = contexto(chamador);
        const lido = lerCriacao(corpo.valor, ctx.papel);
        if (!lido.ok) return respostaJson(falha("entrada_invalida", lido.mensagem), chamador);
        return respostaJson(await criarConferindo(lido.valor, ctx), chamador);
      },
    },
    {
      metodo: "POST",
      caminho: "/api/meu-dia/tarefas",
      quem: ["painel", "agente"],
      async tratar({ req, chamador }) {
        if (chamador !== "painel") {
          return respostaJson(falha("so_no_painel", "Este é o botão Criar tarefa do Meu dia, no painel. O agente cria com `bun secretaria tarefa criar`, sem prazo se o vendedor não deu um."), chamador);
        }
        const corpo = await lerCorpo(req);
        if (!corpo.ok) return respostaJson(falha(corpo.codigo), chamador);
        const lido = corpoDaTarefaDoMeuDia.safeParse(corpo.valor);
        if (!lido.success) {
          return respostaJson(falha("entrada_invalida", FORMA_DA_TAREFA_DO_MEU_DIA), chamador);
        }
        const ctx = contexto(chamador);
        if (lido.data.tipo === "conversa") {
          const conversa = conversaDoMeuDia(lido.data.canal ?? "whatsapp", lido.data.id);
          if (conversa === null) return respostaJson(falha("nao_encontrado", "Esta conversa não está em Responder nem em Esperando cliente."), chamador);
          if (conversa.item.cliente === null) return respostaJson(falha("vinculo_pendente"), chamador);
          const { id, nome } = conversa.item.cliente;
          return respostaJson(await criarConferindo(tarefaDaConversa({ bloco: conversa.bloco, clienteId: id, nome }, lido.data.tarefaId, ctx.hoje), ctx), chamador);
        }
        const item = itemDaLeitura(conectores.leiturasDoCrm(), lido.data.tipo, lido.data.id);
        if (item === null) return respostaJson(falha("nao_encontrado", "Este item não está na última leitura do CRM."), chamador);
        return respostaJson(await criarConferindo(tarefaDoCrm(item, lido.data.tarefaId, ctx.hoje), ctx), chamador);
      },
    },
    {
      metodo: "GET",
      caminho: "/api/tarefas/:id",
      quem: ["painel", "agente"],
      tratar: ({ parametros, chamador }) => respostaJson(comNotas(parametros.id ?? "", null), chamador),
    },
    {
      metodo: "POST",
      caminho: "/api/tarefas/:id/:acao",
      quem: ["painel", "agente"],
      async tratar({ req, parametros, chamador }) {
        const { id = "", acao } = parametros;
        if (!ehDaLista(ACOES_DA_TAREFA, acao)) return respostaJson(falha("nao_encontrado"), chamador);
        const corpo = await lerCorpo(req);
        if (!corpo.ok) return respostaJson(falha(corpo.codigo), chamador);
        const lido = lerComando(acao, corpo.valor);
        if (!lido.ok) return respostaJson(falha("entrada_invalida", lido.mensagem), chamador);
        const ctx = contexto(chamador);
        const resultado = mudarTarefa(banco, id, (atual) => decidir(atual, lido.valor, ctx));
        if (!resultado.ok) return respostaJson(resultado, chamador);
        publicador.tarefasMudaram();
        return respostaJson(comNotas(id, resultado.dados.seguinte), chamador);
      },
    },
    {
      metodo: "GET",
      caminho: "/api/meu-dia",
      quem: ["painel", "agente"],
      tratar({ chamador }) {
        deps.garantirBackup();
        const agora = deps.agora();
        const hoje = diaEm(agora);
        const dia = montarMeuDia(listarTarefas(banco, "aberta"), conectores.estado(), agora, hoje, conectores.leiturasDoCrm(), ignoradosValendo(banco, hoje), dadosDasConversas(hoje), blocoAprovar(banco, chamador));
        return respostaJson(ok(meuDiaPara(dia, chamador)), chamador);
      },
    },
    {
      metodo: "GET",
      caminho: "/api/relatorio",
      quem: ["agente"],
      async tratar({ req, server, url, chamador }) {
        // Esta rota espera o CRM por até 60 s, e o `Bun.serve` fecha conexão parada por 10 s.
        server.timeout(req, 0);
        const periodo = periodoDoRelatorio(
          { de: url.searchParams.get("de") ?? undefined, ate: url.searchParams.get("ate") ?? undefined },
          diaEm(deps.agora()),
        );
        if (!periodo.ok) return respostaJson(periodo, chamador);
        const leitura = await conectores.atendimentosDesde(periodo.dados.de);
        return respostaJson(ok(montarRelatorio(periodo.dados, leitura, listarTarefas(banco, "concluida"), deps.agora())), chamador);
      },
    },
    {
      metodo: "POST",
      caminho: "/api/ignorados",
      quem: ["painel", "agente"],
      async tratar({ req, chamador }) {
        const corpo = await lerCorpo(req);
        if (!corpo.ok) return respostaJson(falha(corpo.codigo), chamador);
        const lido = corpoDoIgnorado.safeParse(corpo.valor);
        if (!lido.success) return respostaJson(falha("entrada_invalida", FORMA_DO_IGNORADO), chamador);
        const agora = deps.agora();
        const hoje = diaEm(agora);
        const quem: QuemIgnorou = chamador === "agente" ? "agente" : "vendedor";
        const motivo = lido.data.motivo === undefined ? null : lerMotivo(lido.data.motivo);
        const pedido = alvoDoPedido(lido.data);
        const alvo = alvoDeIgnorar(pedido, hoje);
        // A mesma regra para proposta, cliente e conversa: `decidirIgnorar`.
        const decisao = decidirIgnorar({ quem, motivo, trouxeMotivo: lido.data.motivo !== undefined, semItem: alvo.semItem, marcaDoVendedor: alvo.marcaDoVendedor, pertoDoBloqueio: alvo.pertoDoBloqueio });
        if (!decisao.ok) return respostaJson(decisao, chamador);
        const ate = voltaEm(agora);
        alvo.gravar({ quem, motivo: decisao.dados.motivo, ate }, agora);
        publicador.tarefasMudaram();
        return respostaJson(ok(itemIgnorado(pedido, { ate, quem, motivo: decisao.dados.motivo === null ? null : motivoPara(decisao.dados.motivo, chamador) })), chamador);
      },
    },
    {
      metodo: "POST",
      caminho: "/api/ignorados/desfazer",
      quem: ["painel", "agente"],
      async tratar({ req, chamador }) {
        const corpo = await lerCorpo(req);
        if (!corpo.ok) return respostaJson(falha(corpo.codigo), chamador);
        const lido = corpoDoItem.safeParse(corpo.valor);
        if (!lido.success) return respostaJson(falha("entrada_invalida", FORMA_DO_ITEM), chamador);
        const pedido = alvoDoPedido(lido.data);
        const alvo = alvoDeIgnorar(pedido, diaEm(deps.agora()));
        if (chamador === "agente" && alvo.marcaDoVendedor) return respostaJson(falha("so_no_painel", MARCA_DO_VENDEDOR), chamador);
        const desfeito = alvo.desfazer();
        if (desfeito) publicador.tarefasMudaram();
        return respostaJson(ok({ ...pedido, desfeito }), chamador);
      },
    },
    {
      metodo: "POST",
      caminho: "/api/vinculos/escolher",
      quem: ["painel", "agente"],
      async tratar({ req, chamador }) {
        if (chamador !== "painel") return respostaJson(falha("so_no_painel", SO_O_VENDEDOR_ESCOLHE), chamador);
        const corpo = await lerCorpo(req);
        if (!corpo.ok) return respostaJson(falha(corpo.codigo), chamador);
        const lido = corpoDeEscolher.safeParse(corpo.valor);
        if (!lido.success) return respostaJson(falha("entrada_invalida", FORMA_DA_ESCOLHA), chamador);
        const escolha: EscolhaDeVinculo = "clienteId" in lido.data ? { tipo: "cliente", clienteId: lido.data.clienteId } : { tipo: "nao_cliente" };
        const agora = deps.agora();
        const decidido = decidirVinculoDoVendedor(banco, lido.data.canal, lido.data.chave, (atual) => escolherNoVinculo(atual, escolha, agora));
        if (!decidido.ok) return respostaJson(decidido, chamador);
        if (decidido.dados.mudou) publicador.tarefasMudaram();
        const { vinculo } = decidido.dados;
        const confirmado = vinculo.estado === "confirmado" ? vinculo : null;
        return respostaJson(
          ok({ canal: vinculo.canal, chave: vinculo.chave, estado: vinculo.estado, cliente: confirmado?.cliente ?? null, decididoEm: vinculo.decididoEm }),
          chamador,
        );
      },
    },
    {
      metodo: "POST",
      caminho: "/api/vinculos/desfazer",
      quem: ["painel", "agente"],
      async tratar({ req, chamador }) {
        if (chamador !== "painel") return respostaJson(falha("so_no_painel", SO_O_VENDEDOR_ESCOLHE), chamador);
        const corpo = await lerCorpo(req);
        if (!corpo.ok) return respostaJson(falha(corpo.codigo), chamador);
        const lido = corpoDoVinculo.safeParse(corpo.valor);
        if (!lido.success) return respostaJson(falha("entrada_invalida", FORMA_DO_VINCULO), chamador);
        const { desfeito, mudou } = desfazerDecisaoDoVendedor(banco, lido.data.canal, lido.data.chave, deps.agora());
        if (mudou) publicador.tarefasMudaram();
        return respostaJson(ok({ ...lido.data, desfeito }), chamador);
      },
    },
    {
      metodo: "POST",
      caminho: "/api/sincronizar",
      quem: ["painel", "agente"],
      async tratar({ req, chamador }) {
        const corpo = await lerCorpo(req);
        if (!corpo.ok) return respostaJson(falha(corpo.codigo), chamador);
        const lido = corpoDaSincronizacao.safeParse(corpo.valor);
        if (!lido.success) {
          return respostaJson(falha("entrada_invalida", `Mande nenhum corpo, ou {"semAtendimentoHaDias": n} com n de 1 a ${SEM_ATENDIMENTO_MAXIMO_DIAS}.`), chamador);
        }
        const durante = deps.aplicador.recusaDuranteAAtualizacao();
        if (durante !== null) return respostaJson(durante, chamador);
        const rodada = await conectores.sincronizar(lido.data ?? {});
        return respostaJson(ok(sincronizacaoParaOLeitor(rodada, leitorDe(chamador))), chamador);
      },
    },
    {
      // Só a sessão do painel: o CLI do agente não abre o painel, então não dispara a rodada automática.
      metodo: "POST",
      caminho: "/api/painel/aberto",
      quem: ["painel"],
      async tratar({ chamador }) {
        const durante = deps.aplicador.recusaDuranteAAtualizacao();
        if (durante !== null) return respostaJson(durante, chamador);
        return respostaJson(ok(await conectores.sincronizarAoAbrirOPainel()), chamador);
      },
    },
    {
      // O nome de quem usa é dado pessoal: só a sessão do painel o lê. O agente não o recebe por rota nenhuma.
      metodo: "GET",
      caminho: "/api/painel/quem-usa",
      quem: ["painel"],
      tratar: ({ chamador }) => respostaJson(ok(quemUsa()), chamador),
    },
    {
      metodo: "POST",
      caminho: "/api/painel/quem-usa",
      quem: ["painel", "agente"],
      async tratar({ req, chamador }) {
        if (chamador !== "painel") return respostaJson(falha("so_no_painel", "O nome de quem usa a Secretária é o vendedor que diz ou muda, no painel."), chamador);
        const corpo = await lerCorpo(req);
        if (!corpo.ok) return respostaJson(falha(corpo.codigo), chamador);
        const lido = corpoDeQuemUsa.safeParse(corpo.valor);
        if (!lido.success) return respostaJson(falha("entrada_invalida", 'Mande {"nome":"..."} ou {"agoraNao":true}.'), chamador);
        if ("agoraNao" in lido.data) {
          marcarNomePerguntado(banco, deps.agora());
          return respostaJson(ok(quemUsa()), chamador);
        }
        const nome = lerNomeDigitado(lido.data.nome);
        if (nome === null) return respostaJson(falha("entrada_invalida", `Escreva um nome de 1 a ${TAMANHO_DO_NOME} letras.`), chamador);
        gravarNomeDigitado(banco, nome, deps.agora());
        return respostaJson(ok(quemUsa()), chamador);
      },
    },
    {
      metodo: "POST",
      caminho: "/api/whatsapp/ler",
      quem: ["agente"],
      async tratar({ req, chamador }) {
        const corpo = await lerCorpo(req);
        if (!corpo.ok) return respostaJson(falha(corpo.codigo), chamador);
        const lido = corpoDaLeitura.safeParse(corpo.valor);
        if (!lido.success) return respostaJson(falha("entrada_invalida", 'Mande {"args":["chats","list"]}.'), chamador);
        const leitura = await conectores.lerWhatsapp(lido.data.args);
        return respostaJson(leitura.ok ? ok(leituraParaOAgente(leitura.dados)) : leitura, chamador);
      },
    },
    {
      metodo: "GET",
      caminho: "/api/whatsapp/quarentena",
      quem: ["painel", "agente"],
      async tratar({ url, chamador }) {
        if (chamador !== "painel") return respostaJson(falha("so_no_painel", SO_O_VENDEDOR_ABRE_A_MENSAGEM), chamador);
        const lido = consultaDaQuarentena.safeParse({ conversa: url.searchParams.get("conversa"), id: url.searchParams.get("id") });
        if (!lido.success) return respostaJson(falha("entrada_invalida", "Mande ?conversa=<jid da conversa>&id=<id da mensagem>."), chamador);
        const mensagem = await conectores.lerMensagem(lido.data.conversa, lido.data.id);
        return respostaJson(mensagem.ok ? ok(mensagemParaOPainel(mensagem.dados)) : mensagem, chamador);
      },
    },
    {
      metodo: "GET",
      caminho: "/api/email/mensagens",
      quem: ["painel", "agente"],
      tratar({ url, chamador }) {
        const lido = consultaDosEmails.safeParse({
          conta: url.searchParams.get("conta") ?? undefined,
          de: url.searchParams.get("de") ?? undefined,
          limite: url.searchParams.get("limite") ?? undefined,
        });
        if (!lido.success) return respostaJson(falha("entrada_invalida", FORMA_DA_LISTA_DE_EMAIL), chamador);
        const todas = conectores.estado().email.contas;
        const contaId = lido.data.conta === undefined ? undefined : lerIdContaEmail(lido.data.conta) ?? undefined;
        const contas = contaId === undefined ? todas : todas.filter((conta) => conta.id === contaId);
        if (contaId !== undefined && contas.length === 0) return respostaJson(falha("nao_encontrado", "Esta conta de e-mail não existe. Confira a lista em `email.contas` do estado."), chamador);
        const de = lido.data.de === undefined ? null : lerEnderecoEmail(lido.data.de);
        const guardados = listarCabecalhos(banco, {
          limite: lido.data.limite ?? LIMITE_PADRAO_DE_EMAIL,
          ...(contaId === undefined ? {} : { contaId }),
          ...(de === null ? {} : { de: de.toLowerCase() as EnderecoEmail }),
        });
        const rotulos = new Map(todas.map((conta) => [conta.id, { id: conta.id, rotulo: conta.rotulo }] as const));
        const lidoEm = lidoEmDasContas(banco);
        return respostaJson(
          ok({
            aviso: AVISO_DA_LISTA_DE_EMAIL,
            mensagens: guardados.flatMap((guardado) => {
              const conta = rotulos.get(guardado.contaId);
              return conta === undefined ? [] : [cabecalhoParaOAgente(guardado, conta)];
            }),
            contas: contas.map((conta) => ({ id: conta.id, rotulo: conta.rotulo, lidoEm: lidoEm.get(conta.id) ?? null })),
          }),
          chamador,
        );
      },
    },
    {
      metodo: "POST",
      caminho: "/api/email/ler",
      quem: ["agente"],
      async tratar({ req, chamador }) {
        const corpo = await lerCorpo(req);
        if (!corpo.ok) return respostaJson(falha(corpo.codigo), chamador);
        const lido = corpoDaLeituraDeEmail.safeParse(corpo.valor);
        if (!lido.success) return respostaJson(falha("entrada_invalida", FORMA_DA_LEITURA_DE_EMAIL), chamador);
        const lida = await lerOCorpo(lido.data.conta, lido.data.id);
        return respostaJson(lida.ok ? ok(emailParaOAgente(lida.dados.email, lida.dados.corpo)) : lida, chamador);
      },
    },
    {
      metodo: "GET",
      caminho: "/api/email/corpo",
      quem: ["painel", "agente"],
      async tratar({ url, chamador }) {
        if (chamador !== "painel") return respostaJson(falha("so_no_painel", SO_O_VENDEDOR_ABRE_O_EMAIL), chamador);
        const lido = consultaDoCorpo.safeParse({ conta: url.searchParams.get("conta"), id: url.searchParams.get("id") });
        if (!lido.success) return respostaJson(falha("entrada_invalida", FORMA_DA_LEITURA_DE_EMAIL), chamador);
        const lida = await lerOCorpo(lido.data.conta, lido.data.id);
        return respostaJson(lida.ok ? ok(emailParaOPainel(lida.dados.email, lida.dados.corpo)) : lida, chamador);
      },
    },
    {
      metodo: "POST",
      caminho: "/api/sessoes/bilhete",
      quem: ["agente"],
      tratar: ({ chamador }) => respostaJson(ok({ url: `${deps.guarda.origem}/entrar?b=${sessoes.emitirBilhete()}` }), chamador),
    },
    {
      metodo: "POST",
      caminho: "/api/servidor/parar",
      quem: ["agente"],
      tratar({ chamador }) {
        deps.pedirParada();
        return respostaJson(ok({ parando: true }), chamador);
      },
    },
    {
      metodo: "GET",
      caminho: "/oauth/crm/iniciar",
      quem: ["painel"],
      async tratar() {
        const durante = deps.aplicador.recusaDuranteAAtualizacao();
        if (durante !== null && !durante.ok) return erroEmPagina(durante.erro);
        const resultado = await conectores.agir("crm", "conectar");
        if (!resultado.ok) return erroEmPagina(resultado.erro);
        const destino = resultado.dados.urlAutorizacao;
        if (destino === null) return erroEmPagina(erroDaTabela("acao_indisponivel"));
        return new Response(null, { status: 303, headers: { Location: destino } });
      },
    },
    {
      metodo: "GET",
      caminho: "/oauth/crm/retorno",
      quem: ["anonimo", "painel"],
      entreSites: true,
      async tratar({ url }) {
        const resultado = await conectores.retornoDoCrm(url.searchParams);
        if (!resultado.ok) {
          const erro = paraOLeitor(resultado.erro, "vendedor");
          return html(paginaSimples("O CRM não foi conectado", [erro.mensagem, erro.acao, "Pode fechar esta aba."]), 400);
        }
        return html(paginaSimples("CRM conectado", ["Pode fechar esta aba e voltar ao painel."]));
      },
    },
    {
      metodo: "GET",
      caminho: "/:arquivo",
      quem: ["painel"],
      tratar({ url, chamador }) {
        const arquivo = deps.painel.get(url.pathname);
        if (arquivo === undefined) return recusar(url, "nao_encontrado", chamador);
        return new Response(arquivo.corpo, { headers: { "Content-Type": arquivo.tipo } });
      },
    },
  ];
}

function casar(caminho: string, segmentos: readonly string[]): Record<string, string> | null {
  const partes = caminho.split("/").slice(1);
  if (partes.length !== segmentos.length) return null;
  const parametros: Record<string, string> = {};
  for (const [i, parte] of partes.entries()) {
    const segmento = segmentos[i] ?? "";
    if (parte.startsWith(":")) {
      if (segmento === "") return null;
      try {
        parametros[parte.slice(1)] = decodeURIComponent(segmento);
      } catch {
        // `%` solto ou sequência que não é UTF-8: não é caminho de nenhuma rota.
        return null;
      }
    } else if (parte !== segmento) return null;
  }
  return parametros;
}

/** Caminho fixo vence caminho com parâmetro, para `/:arquivo` nunca engolir uma rota da API. */
function acharCaminho(rotas: readonly Rota[], url: URL): { readonly rotas: readonly Rota[]; readonly parametros: Record<string, string> } | null {
  const segmentos = url.pathname.split("/").slice(1);
  const fixas = rotas.filter((rota) => rota.caminho === url.pathname);
  if (fixas.length > 0) return { rotas: fixas, parametros: {} };
  for (const rota of rotas) {
    if (!rota.caminho.includes(":")) continue;
    const parametros = casar(rota.caminho, segmentos);
    if (parametros !== null) return { rotas: rotas.filter((outra) => outra.caminho === rota.caminho), parametros };
  }
  return null;
}

export type Atender = (req: Request, server: Server<unknown>) => Promise<Response>;

/** Confere a origem, roteia, identifica quem chama e põe os cabeçalhos fixos em toda resposta. */
export function criarAtendimento(rotas: readonly Rota[], guarda: ContextoDaGuarda): Atender {
  async function rotear(req: Request, server: Server<unknown>): Promise<Response> {
    const url = new URL(req.url);
    if (!origemAceita(req, guarda)) return recusar(url, "origem_recusada", req.headers.has("authorization") ? "agente" : null);
    const achado = acharCaminho(rotas, url);
    const rota = achado?.rotas.find((candidata) => candidata.metodo === req.method);
    const identificacao = identificar(req, guarda, rota?.entreSites === true);
    if (!identificacao.ok) return recusar(url, identificacao.codigo, req.headers.has("authorization") ? "agente" : null);
    const { chamador } = identificacao;
    if (achado === null) return recusar(url, "nao_encontrado", chamador);
    if (rota === undefined) {
      const resposta = recusar(url, "metodo_nao_permitido", chamador);
      resposta.headers.set("Allow", achado.rotas.map((candidata) => candidata.metodo).join(", "));
      return resposta;
    }
    if (!rota.quem.includes(chamador)) return recusar(url, "nao_autorizado", chamador);
    return rota.tratar({ req, url, chamador, parametros: achado.parametros, server });
  }

  return async (req, server) => {
    const resposta = await rotear(req, server);
    for (const [nome, valor] of Object.entries(CABECALHOS_FIXOS)) resposta.headers.set(nome, valor);
    return resposta;
  };
}

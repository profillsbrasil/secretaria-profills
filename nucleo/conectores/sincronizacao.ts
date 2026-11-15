import { z } from "zod";
import { contarCabecalhos, gravarCache, gravarNomeNoCrm, listarCabecalhosDasConversas, gravarColetasDeEmail, gravarConversasLidas, gravarVinculoConsultado, lerCache, lerConversasLidas, listarCache, listarVinculos, type BancoAberto, type ColetaParaGravar } from "../banco";
import {
  CANDIDATOS_NO_MAXIMO,
  CONVERSA_ATIVA_DIAS,
  FONTES_DA_SINCRONIZACAO,
  FONTES_DO_CRM,
  MENSAGENS_POR_CONVERSA,
  SEM_ATENDIMENTO_PADRAO_DIAS,
  TAMANHO_MAXIMO_DA_BUSCA,
  decidirVinculo,
  digitosDoTelefone,
  motivoDoPulo,
  nomeDoResponsavel,
  diaEm,
  falha,
  instante,
  ok,
  paraOLeitor,
  conversasDeEmail,
  contaFalouPorUltimoEm,
  deForaDaSituacao,
  corteDaJanela,
  situacaoComIlegiveis,
  situacaoDaConversa,
  situacaoNoTempo,
  telefoneDoJid,
  varianteDoNove,
  vinculoConsultado,
  vinculoDe,
  vinculoVenceu,
  type ClienteDaBusca,
  type EnderecoEmail,
  type ClienteDaCarteira,
  type ColetaDaConta,
  type Compromisso,
  type Conversa,
  type ConversaLida,
  type Dia,
  type ErroOperacao,
  type EstadoCrm,
  type EstadoDoEmail,
  type EstadoWhatsapp,
  type FonteDaSincronizacao,
  type FonteDoCrm,
  type IdContaEmail,
  type Instante,
  type Leitor,
  type LeituraDeConversas,
  type LeiturasDoCrm,
  type Mensagem,
  type ParDeIdentidade,
  type PropostaEnviada,
  type Resultado,
  type Telefone,
  type TextoExterno,
  type VinculoDeContato,
} from "../dominio";
import type { Registro } from "../registro";
import type { LeitorDoCrm } from "./crm/leitura";

/**
 * A rodada sai de `POST /api/sincronizar`, de `bun secretaria sincronizar` e dos dois gatilhos do
 * vendedor que `decidirSincronizacaoAutomatica` decide. Nenhum temporizador. Uma por vez: quem pede durante uma rodada recebe a mesma rodada, salvo
 * quando pede outro corte da carteira. Esse espera a rodada acabar e roda outra com o corte dele.
 * Cada fonte lê tudo antes de gravar e grava a leitura inteira numa linha do cache, então uma
 * queda no meio deixa a leitura anterior intacta, e a próxima rodada converge.
 */

/** Consultas ao CRM por número, por rodada. O resto espera a próxima, das conversas mais novas para as mais velhas. */
export const CONSULTAS_DE_NUMERO_POR_RODADA = 30;
/** Consultas ao CRM por endereço de e-mail, por rodada. Teto próprio, não dividido com o dos números. */
export const CONSULTAS_DE_ENDERECO_POR_RODADA = 30;
/** O teto de `chats list` do conector: as 200 conversas mais recentes. */
const CONVERSAS_NO_MAXIMO = 200;
const LOTE_DE_IDENTIDADES = 50;
const UM_DIA_MS = 86_400_000;

/** Teto de páginas de 50 por fonte. Além dele, a leitura vem com `cortado`. */
const PAGINAS_NO_MAXIMO = 20;
const POR_PAGINA = 50;
/** `ver_proposta` por rodada, só para propostas sem link no cache: o link de uma versão não muda. */
const LINKS_POR_RODADA = 20;
const CHAVE_UNICA = "atual";
/** Prazo da rodada inteira. Vencido, as leituras em voo são cortadas e as fontes seguintes, puladas. */
export const PRAZO_DA_RODADA_MS = 120_000;

/**
 * Falhas da conexão, não da fonte: depois de uma delas, as fontes seguintes nem chamam o CRM.
 * No limite de chamadas, o MCP pede para não repetir antes da espera.
 */
const FALHAS_DA_CONEXAO = ["crm_limite_de_chamadas", "crm_fora_do_ar", "crm_sessao_vencida", "crm_nao_liberado", "crm_desconectado"] as const;
type FalhaDaConexao = (typeof FALHAS_DA_CONEXAO)[number];

function ehFalhaDaConexao(codigo: string): codigo is FalhaDaConexao {
  return (FALHAS_DA_CONEXAO as readonly string[]).includes(codigo);
}

export type MotivoDoPulo =
  | "crm_autorizando"
  | "crm_app_nao_liberado"
  | "crm_em_atencao"
  | "whatsapp_desconectado"
  | "whatsapp_em_atencao"
  | "email_sem_conta"
  | "email_sem_conta_conectada"
  | FalhaDaConexao;

/** Por que uma conta de e-mail não foi lida: a fase dela, ou o prazo da rodada que acabou antes de a vez dela chegar. */
export type MotivoDaContaPulada = "desconectado" | "em_atencao" | "testando" | "prazo";

/** A linha de uma conta no resultado da fonte `email`. Nenhum campo leva texto de e-mail. */
export type ResultadoDaContaDeEmail =
  | {
      readonly id: IdContaEmail;
      readonly rotulo: string;
      readonly situacao: "leu";
      /** Cabeçalhos que esta rodada trouxe e o banco ainda não tinha. */
      readonly novos: number;
      /** Alguma pasta passou do teto da rodada: a seguinte continua. */
      readonly cortado: boolean;
      /** O servidor não tem pasta de enviados: a conta lê só a entrada. */
      readonly semEnviados: boolean;
      /** Mensagens sem remetente válido ou sem data, que não entraram. */
      readonly ilegiveis: number;
    }
  | { readonly id: IdContaEmail; readonly rotulo: string; readonly situacao: "falhou"; readonly erro: ErroOperacao }
  | { readonly id: IdContaEmail; readonly rotulo: string; readonly situacao: "pulada"; readonly motivo: MotivoDaContaPulada };

/** Por que a fonte de conversas não consultou o CRM, ou parou de consultar no meio. */
export interface ConsultaAoCrm {
  readonly motivo: MotivoDoPulo;
  readonly erro?: ErroOperacao;
}

export type ResultadoDaFonte =
  | {
      readonly fonte: FonteDaSincronizacao;
      readonly situacao: "leu";
      readonly itens: number;
      readonly lidoEm: Instante;
      readonly cortado: boolean;
      /** Só as fontes do CRM: itens com campo obrigatório vazio no cadastro, que ficaram de fora de `itens`. */
      readonly foraPorCadastroIncompleto?: number;
      /** Só as fontes `conversas` e `email`: o CRM não foi consultado por número ou endereço novo (ou parou no meio), e a fonte usou os vínculos que já tinha. */
      readonly semConsultaAoCrm?: ConsultaAoCrm;
      /** Só a fonte `email`: uma linha por conta, na ordem da lista. `itens` é o total de cabeçalhos guardados das contas lidas. */
      readonly contas?: readonly ResultadoDaContaDeEmail[];
    }
  | { readonly fonte: FonteDaSincronizacao; readonly situacao: "falhou"; readonly erro: ErroOperacao; readonly contas?: readonly ResultadoDaContaDeEmail[] }
  /** Não leu: o conector da fonte não está conectado, ou uma fonte anterior achou a conexão do CRM com problema (`erro`). */
  | {
      readonly fonte: FonteDaSincronizacao;
      readonly situacao: "pulada";
      readonly motivo: MotivoDoPulo;
      readonly erro?: ErroOperacao;
      readonly contas?: readonly ResultadoDaContaDeEmail[];
    };

export interface Sincronizacao {
  readonly id: string;
  readonly iniciadaEm: Instante;
  readonly terminadaEm: Instante;
  readonly fontes: readonly ResultadoDaFonte[];
  /** O pedido chegou com uma rodada em andamento e recebeu o resultado dela. A carteira dessa rodada nunca foi lida com um corte diferente do pedido. */
  readonly jaEmAndamento: boolean;
}

/**
 * A rodada como quem pediu a lê. O erro de cada fonte viaja dentro de uma resposta `ok`, então
 * passa aqui pela mesma troca de texto que o erro de uma resposta recusada.
 */
export function sincronizacaoParaOLeitor(rodada: Sincronizacao, leitor: Leitor): Sincronizacao {
  const contasParaOLeitor = (contas: readonly ResultadoDaContaDeEmail[] | undefined) =>
    contas === undefined ? {} : { contas: contas.map((conta): ResultadoDaContaDeEmail => (conta.situacao === "falhou" ? { ...conta, erro: paraOLeitor(conta.erro, leitor) } : conta)) };
  const fontes = rodada.fontes.map((fonte): ResultadoDaFonte => {
    if (fonte.situacao === "leu") {
      const sem = fonte.semConsultaAoCrm;
      const semErro = sem?.erro === undefined ? {} : { semConsultaAoCrm: { ...sem, erro: paraOLeitor(sem.erro, leitor) } };
      return { ...fonte, ...semErro, ...contasParaOLeitor(fonte.contas) };
    }
    return { ...fonte, ...(fonte.erro === undefined ? {} : { erro: paraOLeitor(fonte.erro, leitor) }), ...contasParaOLeitor(fonte.contas) };
  });
  return { ...rodada, fontes };
}

/** Até quando o CRM pediu para não ser chamado, pela maior `esperaS` dos erros da rodada. `null` quando ele não pediu. */
export function esperaPedidaNaRodada(rodada: Sincronizacao): Instante | null {
  const esperas = rodada.fontes.flatMap((fonte) => {
    const erro = fonte.situacao === "leu" ? fonte.semConsultaAoCrm?.erro : fonte.erro;
    return erro?.esperaS === undefined ? [] : [erro.esperaS];
  });
  return esperas.length === 0 ? null : instante(new Date(Date.parse(rodada.terminadaEm) + Math.max(...esperas) * 1000));
}

/** Evento leve do SSE: só onde a rodada está, sem dado do CRM. */
export type AndamentoDaSincronizacao =
  | { readonly id: string; readonly etapa: "comecou"; readonly fontes: readonly FonteDaSincronizacao[] }
  | { readonly id: string; readonly etapa: "fonte"; readonly fonte: FonteDaSincronizacao; readonly situacao: "lendo" | ResultadoDaFonte["situacao"] }
  | { readonly id: string; readonly etapa: "terminou" };

export interface OpcoesDaSincronizacao {
  /** Dias sem atendimento da carteira, de 1 a 3650. Sem ele, vale o da última leitura, ou 30. */
  readonly semAtendimentoHaDias?: number;
}

export interface Sincronizador {
  sincronizar(opcoes?: OpcoesDaSincronizacao): Promise<Sincronizacao>;
  /** O que o cache tem, já conferido. Linha que não bate com a forma conta como sem leitura. */
  leituras(): LeiturasDoCrm;
  /** A última leitura das conversas do WhatsApp, já conferida. `null` sem leitura. */
  conversas(): LeituraDeConversas | null;
  /** Espera a rodada em voo e não grava mais nada depois. */
  parar(): Promise<void>;
}

/** O que a fonte `conversas` pede ao WhatsApp. É a parte de leitura de `Conectores`. */
export interface LeitorDeConversas {
  estado(): EstadoWhatsapp;
  listarConversas(opcoes: { readonly limite: number }): Promise<Resultado<readonly Conversa[]>>;
  /** As mensagens legíveis e quantos itens da resposta ficaram de fora por estarem fora do formato. `sinal` corta a leitura em voo. */
  ultimasMensagens(conversa: string, limite: number, sinal: AbortSignal): Promise<Resultado<{ readonly mensagens: readonly Mensagem[]; readonly ilegiveis: number }>>;
  resolverIdentidades(entradas: readonly string[]): Promise<Resultado<readonly ParDeIdentidade[]>>;
}

/** O que a fonte `email` pede às contas. É a parte de leitura de `ContasDeEmail`. */
export interface LeitorDeEmail {
  estado(): EstadoDoEmail;
  /** Só lê: os cabeçalhos da janela da conta. Quem chama grava, depois de ler todas as contas. */
  coletar(id: IdContaEmail, agora: Instante, sinal: AbortSignal): Promise<Resultado<ColetaDaConta>>;
}

export interface DependenciasDoSincronizador {
  readonly banco: BancoAberto;
  readonly registro: Registro;
  readonly whatsapp: LeitorDeConversas;
  readonly email: LeitorDeEmail;
  agora(): Instante;
  estadoDoCrm(): EstadoCrm;
  leitor(sinal: AbortSignal): LeitorDoCrm;
  aoAndar(andamento: AndamentoDaSincronizacao): void;
  /** O prazo da rodada. Sem ele, `PRAZO_DA_RODADA_MS`. */
  readonly prazoDaRodadaMs?: number;
}

const ref = z.object({ id: z.number(), nome: z.string() });
/** A linha gravada antes desta contagem existir não tinha o campo: lê como zero. */
const foraPorCadastroIncompleto = z.number().int().min(0).default(0);
const guardado = {
  agenda: z.object({
    dia: z.string(),
    cortado: z.boolean(),
    foraPorCadastroIncompleto,
    itens: z.array(z.object({ id: z.number(), titulo: z.string(), inicio: z.string(), fim: z.string().nullable(), tipo: z.string(), cliente: ref.nullable() })),
  }),
  propostas: z.object({
    cortado: z.boolean(),
    foraPorCadastroIncompleto,
    itens: z.array(
      z.object({
        id: z.number(),
        codigo: z.string(),
        versao: z.number(),
        cliente: ref,
        valor_total: z.string().nullable(),
        moeda: z.string().nullable(),
        enviada_em: z.string(),
        prazo_retorno: z.string().nullable(),
        link: z.string().nullable(),
      }),
    ),
  }),
  carteira: z.object({
    semAtendimentoHaDias: z.number(),
    cortado: z.boolean(),
    foraPorCadastroIncompleto,
    itens: z.array(
      z.object({
        id: z.number(),
        nome: z.string(),
        nome_fantasia: z.string().nullable(),
        cidade: z.string().nullable(),
        uf: z.string().nullable(),
        ultimo_atendimento_em: z.string().nullable(),
        ultimo_atendimento_aproximado: z.boolean(),
      }),
    ),
  }),
  link: z.object({ link: z.string() }),
  conversas: z.object({
    cortado: z.boolean(),
    itens: z.array(
      z.object({
        conversa: z.string(),
        telefone: z.string().regex(/^\+[1-9][0-9]{7,14}$/),
        nome: z.string().nullable(),
        ultimaMensagemEm: z.string(),
        naoLidas: z.number().int().optional(),
        contaFalouEm: z.string().nullable(),
        situacao: z.discriminatedUnion("tipo", [
          z.object({
            tipo: z.literal("responder"),
            desde: z.string(),
            novas: z.number().int(),
            em_quarentena: z.boolean(),
            mensagens_em_quarentena: z.array(z.string()),
            sinais: z.array(z.string()),
            tem_ilegiveis: z.boolean(),
            mais_que_o_lido: z.boolean(),
          }),
          z.object({ tipo: z.literal("esperando"), desde: z.string(), dias_uteis: z.number().int() }),
          z.object({ tipo: z.literal("nada") }),
        ]),
      }),
    ),
  }),
};

type Agenda = { readonly dia: Dia; readonly cortado: boolean; readonly foraPorCadastroIncompleto: number; readonly itens: readonly Compromisso[] };
type Propostas = { readonly cortado: boolean; readonly foraPorCadastroIncompleto: number; readonly itens: readonly PropostaEnviada[] };
type Carteira = { readonly semAtendimentoHaDias: number; readonly cortado: boolean; readonly foraPorCadastroIncompleto: number; readonly itens: readonly ClienteDaCarteira[] };
type Conversas = { readonly cortado: boolean; readonly itens: readonly ConversaLida[] };
type ConversaAtiva = Conversa & { readonly ultimaMensagemEm: Instante };
interface ConversaDoTelefone {
  readonly jid: string;
  readonly nome: TextoExterno | null;
  readonly telefone: Telefone;
  readonly ultimaMensagemEm: Instante;
  readonly naoLidas: number;
}

/** O cache é desta Secretária; a conferência só pega a linha que um núcleo de outra versão gravou. */
function lerGuardado<T>(banco: BancoAberto, recurso: "agenda" | "propostas" | "carteira", esquema: z.ZodType): { readonly valor: T; readonly lidoEm: Instante } | null {
  const linha = lerCache(banco, recurso, CHAVE_UNICA);
  if (linha === null) return null;
  const lido = esquema.safeParse(linha.json);
  return lido.success ? { valor: lido.data as T, lidoEm: linha.lidoEm } : null;
}

function lerConversasGuardadas(banco: BancoAberto): LeituraDeConversas | null {
  const linha = lerConversasLidas(banco);
  if (linha === null) return null;
  const lido = guardado.conversas.safeParse(linha.json);
  // O formato é o de `ConversaLida`; os textos de instante e de sinal só passaram por esta conferência.
  return lido.success ? { ...(lido.data as unknown as Conversas), lidoEm: linha.lidoEm } : null;
}

/** O que uma fonte leu: a gravação fica para depois de a leitura inteira chegar. */
interface Lido {
  readonly itens: number;
  readonly cortado: boolean;
  /** Só as fontes do CRM. */
  readonly foraPorCadastroIncompleto?: number;
  gravar(lidoEm: Instante): void;
  /** O CRM pediu pausa no meio de uma leitura que ainda assim terminou. As fontes seguintes esperam. */
  readonly limite?: ErroOperacao;
  /** Só `conversas`: a fonte terminou sem consultar o CRM, ou parou de consultar no meio. */
  readonly semConsultaAoCrm?: ConsultaAoCrm;
  /** Só `email`: o total que a gravação deixou no banco, que só se sabe depois dela. Vale no lugar de `itens`. */
  readonly totalGravado?: () => number;
}

export function criarSincronizador(deps: DependenciasDoSincronizador): Sincronizador {
  const { banco } = deps;
  let emCurso: { readonly rodada: Promise<Sincronizacao>; readonly semAtendimentoHaDias: number } | null = null;
  let parado = false;

  function semAtendimentoAnterior(): number {
    return lerGuardado<Carteira>(banco, "carteira", guardado.carteira)?.valor.semAtendimentoHaDias ?? SEM_ATENDIMENTO_PADRAO_DIAS;
  }

  async function lerAgenda(leitor: LeitorDoCrm, hoje: Dia): Promise<Resultado<Lido>> {
    const lida = await leitor.ler("minha_agenda", { de: hoje, ate: hoje });
    if (!lida.ok) return lida;
    const valor: Agenda = { dia: hoje, cortado: lida.dados.mais, foraPorCadastroIncompleto: lida.dados.fora_por_cadastro_incompleto, itens: lida.dados.compromissos };
    return ok({
      itens: valor.itens.length,
      cortado: valor.cortado,
      foraPorCadastroIncompleto: valor.foraPorCadastroIncompleto,
      gravar: (lidoEm) => gravarCache(banco, "agenda", CHAVE_UNICA, valor, lidoEm),
    });
  }

  async function lerPropostas(leitor: LeitorDoCrm): Promise<Resultado<Lido>> {
    const enviadas: Omit<PropostaEnviada, "link">[] = [];
    let antes: number | undefined;
    let cortado = true;
    let fora = 0;
    // Com `escopo=minhas`, o responsável de cada proposta é o vendedor: o nome do cartão do pé sai daqui, sem chamada a mais.
    let responsavel: string | null = null;
    for (let pagina = 0; pagina < PAGINAS_NO_MAXIMO; pagina += 1) {
      const lida = await leitor.ler("listar_propostas", { escopo: "minhas", estagio: "enviada", limite: POR_PAGINA, ...(antes === undefined ? {} : { antes }) });
      if (!lida.ok) return lida;
      fora += lida.dados.fora_por_cadastro_incompleto;
      for (const proposta of lida.dados.propostas) {
        responsavel ??= proposta.responsavel?.nome ?? null;
        // O filtro do CRM já pede `enviada`; a conferência aqui protege o prazo de quem não está nele.
        if (proposta.estagio !== "enviada" || proposta.data_envio === null) continue;
        const { estagio: _estagio, data_envio, responsavel: _responsavel, ...resto } = proposta;
        enviadas.push({ ...resto, enviada_em: data_envio });
      }
      antes = lida.dados.ultimo_id ?? undefined;
      if (!lida.dados.mais || antes === undefined) {
        cortado = false;
        break;
      }
    }

    const links = new Map(listarCache(banco, "proposta_link").flatMap((linha) => {
      const lido = guardado.link.safeParse(linha.json);
      return lido.success ? [[linha.chave, lido.data.link] as const] : [];
    }));
    const novos = new Map<string, string>();
    // O link é um extra da lista: a falha dele deixa o link nulo e corta os pedidos desta rodada.
    let limite: ErroOperacao | undefined;
    let pedidos = 0;
    let cortarLinks = false;
    for (const proposta of enviadas) {
      const chave = String(proposta.id);
      if (links.has(chave) || cortarLinks || pedidos >= LINKS_POR_RODADA) continue;
      pedidos += 1;
      const detalhe = await leitor.ler("ver_proposta", { proposta_id: proposta.id });
      if (detalhe.ok) {
        if (detalhe.dados.link !== null) novos.set(chave, detalhe.dados.link);
        continue;
      }
      if (detalhe.erro.codigo === "crm_nao_encontrado") continue;
      cortarLinks = true;
      if (detalhe.erro.codigo === "crm_limite_de_chamadas") limite = detalhe.erro;
    }
    const valor: Propostas = {
      cortado,
      foraPorCadastroIncompleto: fora,
      itens: enviadas.map((proposta) => ({ ...proposta, link: links.get(String(proposta.id)) ?? novos.get(String(proposta.id)) ?? null })),
    };
    return ok({
      itens: valor.itens.length,
      cortado,
      foraPorCadastroIncompleto: fora,
      ...(limite === undefined ? {} : { limite }),
      gravar(lidoEm) {
        banco.db.transaction(() => {
          for (const [chave, link] of novos) gravarCache(banco, "proposta_link", chave, { link }, lidoEm);
          gravarCache(banco, "propostas", CHAVE_UNICA, valor, lidoEm);
          gravarNomeNoCrm(banco, responsavel === null ? null : nomeDoResponsavel(responsavel), lidoEm);
        });
      },
    });
  }

  async function lerCarteira(leitor: LeitorDoCrm, semAtendimentoHaDias: number): Promise<Resultado<Lido>> {
    const porId = new Map<number, ClienteDaCarteira>();
    let cursor: string | undefined;
    let cortado = true;
    let fora = 0;
    for (let pagina = 0; pagina < PAGINAS_NO_MAXIMO; pagina += 1) {
      const lida = await leitor.ler("minha_carteira", { sem_atendimento_ha_dias: semAtendimentoHaDias, limite: POR_PAGINA, ...(cursor === undefined ? {} : { cursor }) });
      if (!lida.ok) return lida;
      fora += lida.dados.fora_por_cadastro_incompleto;
      // Um cliente atendido entre duas páginas volta no fim da lista: fica a primeira vez.
      for (const cliente of lida.dados.clientes) if (!porId.has(cliente.id)) porId.set(cliente.id, cliente);
      cursor = lida.dados.proximo_cursor ?? undefined;
      if (!lida.dados.mais || cursor === undefined) {
        cortado = false;
        break;
      }
    }
    const valor: Carteira = { semAtendimentoHaDias, cortado, foraPorCadastroIncompleto: fora, itens: [...porId.values()] };
    return ok({ itens: valor.itens.length, cortado, foraPorCadastroIncompleto: fora, gravar: (lidoEm) => gravarCache(banco, "carteira", CHAVE_UNICA, valor, lidoEm) });
  }

  /** O CRM não vai ser consultado por número: `motivo` diz por quê. */
  interface ContextoDasConversas {
    readonly leitor: LeitorDoCrm | null;
    readonly semCrm: ConsultaAoCrm | null;
    readonly sinal: AbortSignal;
  }

  /**
   * Os candidatos de uma busca para decidir o vínculo. Candidato com cadastro incompleto ficou de fora
   * da lista, e decidir sem ele daria `auto` ou `sem_cliente` sem prova: o contato espera o cadastro.
   */
  async function buscarCandidatos(leitor: LeitorDoCrm, q: string): Promise<Resultado<readonly ClienteDaBusca[]>> {
    const lida = await leitor.ler("buscar_clientes", { q, limite: CANDIDATOS_NO_MAXIMO });
    if (!lida.ok) return lida;
    if (lida.dados.fora_por_cadastro_incompleto > 0) return falha("crm_resposta_inesperada", "A busca do CRM trouxe cliente com campo obrigatório vazio: o vínculo espera o cadastro ser corrigido no CRM.");
    return ok(lida.dados.clientes);
  }

  /** O vínculo de um número, com no máximo duas buscas ao CRM. Só os dígitos do telefone saem daqui. */
  async function consultar(telefone: Telefone, leitor: LeitorDoCrm): Promise<Resultado<VinculoDeContato>> {
    const exata = await buscarCandidatos(leitor, digitosDoTelefone(telefone));
    if (!exata.ok) return exata;
    let variante: readonly ClienteDaBusca[] = [];
    const outra = varianteDoNove(telefone);
    if (exata.dados.length === 0 && outra !== null) {
      const lida = await buscarCandidatos(leitor, digitosDoTelefone(outra));
      // Sem a resposta da variante o número não é `sem_cliente`: fica sem vínculo até a próxima rodada.
      if (!lida.ok) return lida;
      variante = lida.dados;
    }
    return ok(vinculoDe("whatsapp", telefone, decidirVinculo({ canal: "whatsapp", telefone }, exata.dados, variante), deps.agora()));
  }

  /** Um contato à espera de vínculo: a chave que o banco guarda e a consulta ao CRM que o decide. */
  interface PendenteDeConsulta {
    readonly chave: string;
    consultar(leitor: LeitorDoCrm): Promise<Resultado<VinculoDeContato>>;
  }

  /**
   * O laço das consultas ao CRM, o mesmo para número e endereço. `pendentes` vem na ordem de
   * prioridade; quem já tem vínculo válido não é consultado. O teto, o prazo da rodada, o `parar()` e
   * uma falha da conexão cortam as consultas, e o que sobra fica para a próxima rodada com o vínculo
   * antigo. Falha de uma consulta que não é da conexão segue para o próximo. `semVinculo` diz se
   * ficou contato sem vínculo nenhum. O registro leva só o código do erro.
   */
  async function consultarPendentes(
    pendentes: readonly PendenteDeConsulta[],
    vinculos: ReadonlyMap<string, VinculoDeContato>,
    ctx: ContextoDasConversas,
    teto: number,
    evento: string,
  ): Promise<{ readonly semCrm: ConsultaAoCrm | null; readonly semVinculo: boolean; readonly falhaNova: ErroOperacao | null }> {
    const agora = deps.agora();
    let semCrm = ctx.semCrm;
    let semVinculo = false;
    let falhaNova: ErroOperacao | null = null;
    let consultas = 0;
    for (const { chave, consultar } of pendentes) {
      const atual = vinculos.get(chave);
      if (atual !== undefined && !vinculoVenceu(atual, agora)) continue;
      if (ctx.leitor === null || semCrm !== null || consultas >= teto || ctx.sinal.aborted || parado) {
        if (atual === undefined) semVinculo = true;
        continue;
      }
      consultas += 1;
      const novo = await consultar(ctx.leitor);
      if (novo.ok) {
        gravarVinculoConsultado(banco, vinculoConsultado(atual, novo.dados));
        continue;
      }
      deps.registro.aviso(evento, { codigo: novo.erro.codigo });
      if (atual === undefined) semVinculo = true;
      if (ehFalhaDaConexao(novo.erro.codigo)) {
        semCrm = { motivo: novo.erro.codigo, erro: novo.erro };
        falhaNova = novo.erro;
      }
    }
    return { semCrm, semVinculo, falhaNova };
  }

  /** O vínculo de um endereço, com uma busca ao CRM. Só o endereço, em minúsculas, sai daqui. */
  async function consultarEndereco(endereco: EnderecoEmail, leitor: LeitorDoCrm): Promise<Resultado<VinculoDeContato>> {
    const lida = await buscarCandidatos(leitor, endereco);
    if (!lida.ok) return lida;
    return ok(vinculoDe("email", endereco, decidirVinculo({ canal: "email", endereco }, lida.dados), deps.agora()));
  }

  /** O telefone de cada conversa direta, da mais recente para a mais antiga. Um `@lid` passa por `contacts resolve`; sem par, a conversa fica fora. */
  async function telefonesDasConversas(ativas: readonly ConversaAtiva[], anterior: ReadonlyMap<string, Telefone>): Promise<{ readonly lista: ConversaDoTelefone[]; readonly incompleto: boolean }> {
    const porJid = new Map<string, Telefone>();
    const lids: string[] = [];
    for (const conversa of ativas) {
      const telefone = telefoneDoJid(conversa.jid);
      if (telefone !== null) porJid.set(conversa.jid, telefone);
      else if (conversa.jid.endsWith("@lid")) lids.push(conversa.jid);
    }
    let incompleto = false;
    for (let inicio = 0; inicio < lids.length; inicio += LOTE_DE_IDENTIDADES) {
      const lote = lids.slice(inicio, inicio + LOTE_DE_IDENTIDADES);
      const pares = await deps.whatsapp.resolverIdentidades(lote);
      if (!pares.ok) {
        // Falha do wacli, não "sem par": a conversa segue com o telefone que a leitura anterior já tinha.
        incompleto = true;
        for (const jid of lote) {
          const antigo = anterior.get(jid);
          if (antigo !== undefined) porJid.set(jid, antigo);
        }
        continue;
      }
      for (const par of pares.dados) if (par.resolvido && par.telefone !== null) porJid.set(par.entrada, par.telefone);
    }
    const vistos = new Set<Telefone>();
    const lista: ConversaDoTelefone[] = [];
    for (const conversa of ativas) {
      const telefone = porJid.get(conversa.jid);
      // O mesmo número em duas conversas (JID de telefone e `@lid`): fica a mais recente.
      if (telefone === undefined || vistos.has(telefone)) continue;
      vistos.add(telefone);
      lista.push({ jid: conversa.jid, nome: conversa.sinaisDoNome.length === 0 && conversa.nome !== "" ? conversa.nome : null, telefone, ultimaMensagemEm: conversa.ultimaMensagemEm, naoLidas: conversa.naoLidas });
    }
    return { lista, incompleto };
  }

  /**
   * Conversas diretas dos últimos 30 dias: vínculo de cada número, situação de cada conversa com
   * cliente. Número novo, até 30 consultas por rodada, das conversas mais recentes. Falha da conexão
   * com o CRM para as consultas e a fonte termina com os vínculos que tem. Nenhum texto de mensagem sai daqui.
   */
  async function lerConversas(ctx: ContextoDasConversas): Promise<Resultado<Lido>> {
    const agora = deps.agora();
    const listadas = await deps.whatsapp.listarConversas({ limite: CONVERSAS_NO_MAXIMO });
    if (!listadas.ok) return listadas;
    const corte = Date.parse(agora) - CONVERSA_ATIVA_DIAS * UM_DIA_MS;
    const ativas = listadas.dados
      .filter((conversa): conversa is ConversaAtiva => conversa.tipo === "direta" && conversa.ultimaMensagemEm !== null && Date.parse(conversa.ultimaMensagemEm) >= corte)
      .toSorted((a, b) => Date.parse(b.ultimaMensagemEm) - Date.parse(a.ultimaMensagemEm));

    const anteriores = lerConversasGuardadas(banco)?.itens ?? [];
    const { lista, incompleto } = await telefonesDasConversas(ativas, new Map(anteriores.map((item) => [item.conversa, item.telefone])));
    // A lista vem das mais recentes, grupos inclusos. Cheia e sem nenhuma mais velha que o corte, pode ter ficado conversa ativa de fora.
    const listaCheia = listadas.dados.length >= CONVERSAS_NO_MAXIMO && !listadas.dados.some((conversa) => conversa.ultimaMensagemEm !== null && Date.parse(conversa.ultimaMensagemEm) < corte);
    let cortado = incompleto || listaCheia;

    const consulta = await consultarPendentes(
      lista.map(({ telefone }) => ({ chave: telefone, consultar: (leitor) => consultar(telefone, leitor) })),
      listarVinculos(banco, "whatsapp"),
      ctx,
      CONSULTAS_DE_NUMERO_POR_RODADA,
      "sincronizacao.consulta_de_numero_falhou",
    );
    const { semCrm } = consulta;
    if (consulta.semVinculo) cortado = true;

    // Os vínculos de agora, não os de antes das consultas: a escolha do vendedor pode ter entrado no meio.
    const atuais = listarVinculos(banco, "whatsapp");
    const guardadas = new Map(anteriores.map((item) => [item.telefone, item]));
    const itens: ConversaLida[] = [];
    for (const { jid, nome, telefone, ultimaMensagemEm, naoLidas } of lista) {
      const vinculo = atuais.get(telefone);
      // `nao_cliente` também é lido: sem a leitura guardada, o Desfazer não traria a conversa de volta sem esperar uma sincronização.
      if (vinculo === undefined || vinculo.estado === "sem_cliente") continue;
      const antiga = guardadas.get(telefone);
      // Sem mensagem nova desde a leitura guardada, o cache basta; só a espera anda com o relógio. Conversa com ilegível é relida.
      const semMudanca = antiga !== undefined && antiga.conversa === jid && Date.parse(antiga.ultimaMensagemEm) === Date.parse(ultimaMensagemEm) && antiga.naoLidas === naoLidas;
      if (semMudanca && !(antiga.situacao.tipo === "responder" && antiga.situacao.tem_ilegiveis)) {
        itens.push({ ...antiga, nome, situacao: situacaoNoTempo(antiga, agora) });
        continue;
      }
      // Sem ler as mensagens (prazo, parada ou falha do wacli), a conversa fica como a leitura anterior a deixou.
      const lidas = ctx.sinal.aborted || parado ? null : await deps.whatsapp.ultimasMensagens(jid, MENSAGENS_POR_CONVERSA, ctx.sinal);
      if (lidas === null || !lidas.ok) {
        cortado = true;
        if (lidas !== null && !ctx.sinal.aborted) deps.registro.aviso("sincronizacao.mensagens_falharam", { codigo: lidas.erro.codigo });
        if (antiga !== undefined) itens.push({ ...antiga, situacao: situacaoNoTempo(antiga, agora) });
        continue;
      }
      const { mensagens, ilegiveis } = lidas.dados;
      const paginaCheia = mensagens.length + ilegiveis >= MENSAGENS_POR_CONVERSA;
      let situacao = situacaoDaConversa(mensagens, agora, paginaCheia);
      if (ilegiveis > 0) {
        cortado = true;
        deps.registro.aviso("sincronizacao.mensagens_ilegiveis", { ilegiveis });
        situacao = situacaoComIlegiveis(mensagens, agora, paginaCheia, antiga?.situacao ?? null, ultimaMensagemEm);
      }
      itens.push({ conversa: jid, telefone, nome, ultimaMensagemEm, naoLidas, contaFalouEm: contaFalouPorUltimoEm(mensagens), situacao });
    }

    const valor: Conversas = { cortado, itens };
    const doVendedor = new Set([...atuais].filter(([, vinculo]) => vinculo.estado === "nao_cliente").map(([telefone]) => telefone));
    return ok({
      itens: itens.filter((item) => item.situacao.tipo !== "nada" && !doVendedor.has(item.telefone)).length,
      cortado,
      ...(semCrm === null ? {} : { semConsultaAoCrm: semCrm }),
      ...(consulta.falhaNova === null ? {} : { limite: consulta.falhaNova }),
      gravar: (lidoEm) => gravarConversasLidas(banco, valor, lidoEm),
    });
  }

  /** A fase que não deixa ler a conta, ou `null` quando ela está conectada. */
  function motivoDaConta(fase: EstadoDoEmail["contas"][number]["estado"]["fase"]): "desconectado" | "em_atencao" | "testando" | null {
    switch (fase) {
      case "conectado":
        return null;
      case "atencao":
        return "em_atencao";
      case "testando":
        return "testando";
      default:
        return "desconectado";
    }
  }

  /**
   * Uma conta por vez, na ordem da lista. Conta fora de `conectado` é pulada sem abrir conexão, e a
   * que falha não derruba as outras. Lê tudo em memória; só `gravar` escreve, e só as contas já
   * lidas. O prazo da rodada corta a leitura em voo, e as contas que faltam saem puladas.
   */
  async function lerEmail(contasDaRodada: EstadoDoEmail["contas"], sinal: AbortSignal, saida: { contas: ResultadoDaContaDeEmail[] }): Promise<Resultado<Lido>> {
    const linhas = saida.contas;
    const lidas: (ColetaParaGravar & { readonly novos: number })[] = [];
    let primeiroErro: ErroOperacao | null = null;
    for (const inicial of contasDaRodada) {
      const { id, rotulo } = inicial;
      // O estado de agora, não o do começo da rodada: a conta pode ter mudado de fase ou saído da lista.
      const conta = deps.email.estado().contas.find((candidata) => candidata.id === id);
      if (conta === undefined) continue;
      const motivo = motivoDaConta(conta.estado.fase);
      if (motivo !== null) {
        linhas.push({ id, rotulo, situacao: "pulada", motivo });
        continue;
      }
      if (sinal.aborted || parado) {
        linhas.push({ id, rotulo, situacao: "pulada", motivo: "prazo" });
        continue;
      }
      const agora = deps.agora();
      const coleta = await deps.email.coletar(id, agora, sinal);
      if (!coleta.ok) {
        deps.registro.aviso("sincronizacao.email_conta_falhou", { conta: id, codigo: coleta.erro.codigo });
        linhas.push({ id, rotulo, situacao: "falhou", erro: coleta.erro });
        primeiroErro ??= coleta.erro;
        continue;
      }
      const novos = coleta.dados.pastas.reduce((total, pasta) => total + pasta.cabecalhos.length, 0);
      const ilegiveis = coleta.dados.pastas.reduce((total, pasta) => total + pasta.ilegiveis, 0);
      lidas.push({ contaId: id, coleta: coleta.dados, corte: corteDaJanela(agora, conta.janelaDias), novos });
      linhas.push({ id, rotulo, situacao: "leu", novos, cortado: coleta.dados.pastas.some((pasta) => pasta.cortado), semEnviados: coleta.dados.semEnviados, ilegiveis });
      if (ilegiveis > 0) deps.registro.aviso("sincronizacao.email_ilegiveis", { conta: id, ilegiveis });
    }
    if (lidas.length === 0) return { ok: false, erro: primeiroErro ?? (linhas.some((linha) => linha.situacao === "pulada" && linha.motivo === "prazo") ? ERRO_DO_PRAZO : ERRO_SEM_LEITURA) };
    const total = () => {
      const guardados = contarCabecalhos(banco);
      return lidas.reduce((soma, lida) => soma + (guardados.get(lida.contaId) ?? 0), 0);
    };
    return ok({
      itens: lidas.reduce((soma, lida) => soma + lida.novos, 0),
      cortado: lidas.some((lida) => lida.coleta.pastas.some((pasta) => pasta.cortado)),
      totalGravado: total,
      gravar: (lidoEm) => gravarColetasDeEmail(banco, lidas, lidoEm),
    });
  }

  function motivoDoWhatsapp(whatsapp: EstadoWhatsapp): "whatsapp_desconectado" | "whatsapp_em_atencao" | null {
    switch (whatsapp.fase) {
      case "conectado":
        return null;
      case "atencao":
        return "whatsapp_em_atencao";
      default:
        return "whatsapp_desconectado";
    }
  }

  async function rodar(id: string, semAtendimentoHaDias: number): Promise<Sincronizacao> {
    const iniciadaEm = deps.agora();
    const hoje = diaEm(iniciadaEm);
    deps.aoAndar({ id, etapa: "comecou", fontes: FONTES_DA_SINCRONIZACAO });
    const fontes: ResultadoDaFonte[] = [];
    const pulo = motivoDoPulo(deps.estadoDoCrm());
    // O prazo é um só para a rodada inteira, as conversas incluídas.
    const sinal = AbortSignal.timeout(deps.prazoDaRodadaMs ?? PRAZO_DA_RODADA_MS);
    const leitor = pulo === null ? deps.leitor(sinal) : null;
    // Objeto, não `let`: quem anota é `lerFonte`, e o TypeScript não acompanha a mudança feita lá dentro.
    const rodada: { conexao: (ErroOperacao & { readonly codigo: FalhaDaConexao }) | null } = { conexao: null };

    /** Uma fonte do CRM: pulada quando o conector não está conectado ou uma fonte anterior achou a conexão com problema. */
    function doCrm(fonte: FonteDoCrm, ler: (leitor: LeitorDoCrm) => Promise<Resultado<Lido>>): Promise<ResultadoDaFonte> {
      if (pulo !== null || leitor === null) return Promise.resolve({ fonte, situacao: "pulada", motivo: pulo ?? "crm_desconectado" });
      if (rodada.conexao !== null) return Promise.resolve({ fonte, situacao: "pulada", motivo: rodada.conexao.codigo, erro: rodada.conexao });
      return lerFonte(fonte, () => ler(leitor));
    }

    function doWhatsapp(): Promise<ResultadoDaFonte> {
      const motivo = motivoDoWhatsapp(deps.whatsapp.estado());
      if (motivo !== null) return Promise.resolve({ fonte: "conversas", situacao: "pulada", motivo });
      return lerFonte("conversas", () => lerConversas({ leitor, semCrm: semCrmDaRodada(), sinal }));
    }

    /** Por que a rodada não consulta o CRM: o conector, ou uma falha da conexão que uma fonte anterior achou. `null` quando consulta. */
    function semCrmDaRodada(): ConsultaAoCrm | null {
      if (pulo !== null) return { motivo: pulo };
      if (leitor === null) return { motivo: "crm_desconectado" };
      return rodada.conexao === null ? null : { motivo: rodada.conexao.codigo, erro: rodada.conexao };
    }

    /**
     * Depois de a coleta gravar, consulta o CRM pelo endereço de cada conversa de e-mail com mensagem de fora,
     * da conversa mais recente para a mais antiga. Um endereço é consultado uma vez por rodada.
     */
    async function consultarEnderecos(): Promise<{ readonly cortado: boolean; readonly semCrm: ConsultaAoCrm | null; readonly falhaNova: ErroOperacao | null }> {
      const agora = deps.agora();
      const vistos = new Set<EnderecoEmail>();
      const pendentes: PendenteDeConsulta[] = [];
      for (const conversa of conversasDeEmail(listarCabecalhosDasConversas(banco), agora)) {
        const deFora = deForaDaSituacao(conversa.situacao);
        if (deFora === null || deFora.endereco.length > TAMANHO_MAXIMO_DA_BUSCA || vistos.has(deFora.endereco)) continue;
        vistos.add(deFora.endereco);
        const { endereco } = deFora;
        pendentes.push({ chave: endereco, consultar: (l) => consultarEndereco(endereco, l) });
      }
      const consulta = await consultarPendentes(pendentes, listarVinculos(banco, "email"), { leitor, semCrm: semCrmDaRodada(), sinal }, CONSULTAS_DE_ENDERECO_POR_RODADA, "sincronizacao.consulta_de_endereco_falhou");
      return { cortado: consulta.semVinculo, semCrm: consulta.semCrm, falhaNova: consulta.falhaNova };
    }

    async function doEmail(): Promise<ResultadoDaFonte> {
      const { contas } = deps.email.estado();
      if (contas.length === 0) return Promise.resolve({ fonte: "email", situacao: "pulada", motivo: "email_sem_conta" });
      if (!contas.some((conta) => motivoDaConta(conta.estado.fase) === null)) {
        const linhas = contas.map((conta): ResultadoDaContaDeEmail => ({ id: conta.id, rotulo: conta.rotulo, situacao: "pulada", motivo: motivoDaConta(conta.estado.fase) ?? "desconectado" }));
        return Promise.resolve({ fonte: "email", situacao: "pulada", motivo: "email_sem_conta_conectada", contas: linhas });
      }
      const saida: { contas: ResultadoDaContaDeEmail[] } = { contas: [] };
      const lida = await lerFonteDeEmail(() => lerEmail(contas, sinal, saida), saida);
      if (lida.situacao !== "leu") return lida;
      let consulta: Awaited<ReturnType<typeof consultarEnderecos>>;
      try {
        consulta = await consultarEnderecos();
      } catch (erro) {
        // Fora de `lerFonte`: a coleta já gravou, e a exceção derrubaria a rodada inteira.
        deps.registro.erro("sincronizacao.fonte_quebrou", { fonte: "email", erro: erro instanceof Error ? erro.name : typeof erro });
        return { ...lida, cortado: true };
      }
      if (consulta.falhaNova !== null) anotarConexao(consulta.falhaNova);
      return { ...lida, cortado: lida.cortado || consulta.cortado, ...(consulta.semCrm === null ? {} : { semConsultaAoCrm: consulta.semCrm }) };
    }

    const leituras: { readonly [F in FonteDaSincronizacao]: () => Promise<ResultadoDaFonte> } = {
      agenda: () => doCrm("agenda", (l) => lerAgenda(l, hoje)),
      propostas: () => doCrm("propostas", lerPropostas),
      carteira: () => doCrm("carteira", (l) => lerCarteira(l, semAtendimentoHaDias)),
      conversas: doWhatsapp,
      email: doEmail,
    };

    for (const fonte of FONTES_DA_SINCRONIZACAO) {
      const resultado = await leituras[fonte]();
      if (resultado.situacao === "falhou") anotarConexao(resultado.erro);
      fontes.push(resultado);
      deps.aoAndar({ id, etapa: "fonte", fonte, situacao: resultado.situacao });
    }
    deps.aoAndar({ id, etapa: "terminou" });
    return { id, iniciadaEm, terminadaEm: deps.agora(), fontes, jaEmAndamento: false };

    function anotarConexao(erro: ErroOperacao): void {
      const { codigo } = erro;
      if (ehFalhaDaConexao(codigo)) rodada.conexao = { ...erro, codigo };
    }

    /** A fonte `email` leva, junto do resultado, a linha de cada conta, que `lerFonte` não conhece. */
    async function lerFonteDeEmail(ler: () => Promise<Resultado<Lido>>, saida: { contas: ResultadoDaContaDeEmail[] }): Promise<ResultadoDaFonte> {
      const resultado = await lerFonte("email", ler);
      return saida.contas.length === 0 ? resultado : { ...resultado, contas: saida.contas };
    }

    async function lerFonte(fonte: FonteDaSincronizacao, ler: () => Promise<Resultado<Lido>>): Promise<ResultadoDaFonte> {
      deps.aoAndar({ id, etapa: "fonte", fonte, situacao: "lendo" });
      let lido: Resultado<Lido>;
      try {
        lido = await ler();
      } catch (erro) {
        deps.registro.erro("sincronizacao.fonte_quebrou", { fonte, erro: erro instanceof Error ? erro.name : typeof erro });
        lido = falha("interno");
      }
      if (!lido.ok) {
        deps.registro.aviso("sincronizacao.fonte_falhou", { fonte, codigo: lido.erro.codigo });
        return { fonte, situacao: "falhou", erro: lido.erro };
      }
      if (parado) return { fonte, situacao: "falhou", erro: { ...ERRO_PARADO } };
      const lidoEm = deps.agora();
      lido.dados.gravar(lidoEm);
      if (lido.dados.limite !== undefined) anotarConexao(lido.dados.limite);
      return {
        fonte,
        situacao: "leu",
        itens: lido.dados.totalGravado?.() ?? lido.dados.itens,
        lidoEm,
        cortado: lido.dados.cortado,
        ...(lido.dados.foraPorCadastroIncompleto === undefined ? {} : { foraPorCadastroIncompleto: lido.dados.foraPorCadastroIncompleto }),
        ...(lido.dados.semConsultaAoCrm === undefined ? {} : { semConsultaAoCrm: lido.dados.semConsultaAoCrm }),
      };
    }
  }

  /** Depois do `parar()`, nenhuma fonte lê nem grava. */
  function rodadaRecusada(): Sincronizacao {
    const agora = deps.agora();
    const fontes = FONTES_DA_SINCRONIZACAO.map((fonte): ResultadoDaFonte => ({ fonte, situacao: "falhou", erro: { ...ERRO_PARADO } }));
    return { id: crypto.randomUUID(), iniciadaEm: agora, terminadaEm: agora, fontes, jaEmAndamento: false };
  }

  /** Com a conexão assim, a carteira da rodada não foi lida, e o CRM não quer outra chamada agora. */
  function conexaoComProblema(rodada: Sincronizacao): boolean {
    return rodada.fontes.some((fonte) => (FONTES_DO_CRM as readonly string[]).includes(fonte.fonte) && (fonte.situacao === "pulada" || (fonte.situacao === "falhou" && ehFalhaDaConexao(fonte.erro.codigo))));
  }

  function sincronizar(opcoes: OpcoesDaSincronizacao = {}): Promise<Sincronizacao> {
    if (emCurso !== null) {
      const pedido = opcoes.semAtendimentoHaDias;
      const outroCorte = pedido !== undefined && pedido !== emCurso.semAtendimentoHaDias;
      return emCurso.rodada.then((rodada) => (outroCorte && !conexaoComProblema(rodada) ? sincronizar(opcoes) : { ...rodada, jaEmAndamento: true }));
    }
    if (parado) return Promise.resolve(rodadaRecusada());
    const semAtendimentoHaDias = opcoes.semAtendimentoHaDias ?? semAtendimentoAnterior();
    const rodada = rodar(crypto.randomUUID(), semAtendimentoHaDias).finally(() => {
      emCurso = null;
    });
    emCurso = { rodada, semAtendimentoHaDias };
    return rodada;
  }

  return {
    sincronizar,
    conversas: () => lerConversasGuardadas(banco),
    leituras() {
      const agenda = lerGuardado<Agenda>(banco, "agenda", guardado.agenda);
      const propostas = lerGuardado<Propostas>(banco, "propostas", guardado.propostas);
      const carteira = lerGuardado<Carteira>(banco, "carteira", guardado.carteira);
      return {
        agenda: agenda === null ? null : { ...agenda.valor, lidoEm: agenda.lidoEm },
        propostas: propostas === null ? null : { ...propostas.valor, lidoEm: propostas.lidoEm },
        carteira: carteira === null ? null : { ...carteira.valor, lidoEm: carteira.lidoEm },
      };
    },
    async parar() {
      parado = true;
      await emCurso?.rodada.catch(() => {});
    },
  };
}

function erroDa(codigo: "email_conta_desconectada" | "email_prazo_da_leitura"): ErroOperacao {
  const resultado = falha(codigo);
  if (resultado.ok) throw new Error("falha() sempre devolve erro");
  return resultado.erro;
}

const ERRO_SEM_LEITURA = erroDa("email_conta_desconectada");
const ERRO_DO_PRAZO = erroDa("email_prazo_da_leitura");

const ERRO_PARADO: ErroOperacao = (() => {
  const resultado = falha("servidor_fora_do_ar", "A Secretária parou no meio da sincronização. Nada desta fonte foi gravado.");
  if (resultado.ok) throw new Error("falha() sempre devolve erro");
  return resultado.erro;
})();

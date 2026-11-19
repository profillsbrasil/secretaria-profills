/**
 * Todas as chamadas HTTP do painel. É a especificação do chamador para o servidor (U3).
 *
 * | Método | Caminho                     | Corpo                               | Resposta                                   |
 * |--------|-----------------------------|-------------------------------------|--------------------------------------------|
 * | GET    | /api/eventos                | (SSE)                               | `event: estado`, `data: EstadoPainel`      |
 * | GET    | /oauth/crm/iniciar          | (navegação em nova aba, não fetch)  | 303 para o login do CRM                    |
 * | POST   | /api/conectores/:id/:acao   | `CorpoConectar[id]`, `CorpoReparear` ou nenhum | `Saida<EstadoPorConector[id]>`  |
 * | POST   | /api/email/contas           | `CorpoDeAdicionarEmail`             | `Saida<VisaoDaContaEmail>`                 |
 * | POST   | /api/email/contas/:id/:acao | `CorpoDaAcaoDoEmail[acao]` ou nenhum | `Saida<VisaoDaContaEmail>`; `remover` dá `Saida<{ removida }>` |
 * | POST   | /api/email/pular            | `{ pulado: boolean }`               | `Saida<VisaoDoEmail>`                      |
 * | GET    | /api/meu-dia                |                                     | `Saida<MeuDia>`                            |
 * | GET    | /api/tarefas?estado=        |                                     | `Saida<{ tarefas: Tarefa[] }>`             |
 * | POST   | /api/tarefas                | `CorpoDeCriar`                      | `Saida<RespostaDaTarefa>`                  |
 * | GET    | /api/tarefas/:id            |                                     | `Saida<RespostaDaTarefa>`                  |
 * | POST   | /api/tarefas/:id/:acao      | `CorpoDaAcaoDaTarefa[acao]`         | `Saida<RespostaDaTarefa>`                  |
 * | POST   | /api/sincronizar            | nenhum                              | `Saida<Sincronizacao>`, no fim da rodada   |
 * | POST   | /api/painel/aberto          | nenhum                              | `Saida<DecisaoAutomatica>`, sem esperar a rodada |
 * | GET    | /api/painel/quem-usa        |                                     | `Saida<VisaoDeQuemUsa>`                    |
 * | POST   | /api/painel/quem-usa        | `{ nome }` ou `{ agoraNao: true }`  | `Saida<VisaoDeQuemUsa>`                    |
 * | POST   | /api/meu-dia/tarefas        | `{ tipo, id, tarefaId }`; conversa leva `canal` | `Saida<RespostaDaTarefa>`, vencendo hoje |
 * | POST   | /api/ignorados              | `{ tipo, id }`; conversa leva `canal` | `Saida<ItemIgnorado>`                    |
 * | POST   | /api/ignorados/desfazer     | `{ tipo, id }`; conversa leva `canal` | `Saida<{ tipo, id, desfeito }>`          |
 * | POST   | /api/vinculos/escolher      | `{ canal, chave, clienteId \| naoCliente }` | `Saida<RespostaDaEscolha>`           |
 * | POST   | /api/vinculos/desfazer      | `{ canal, chave }`                  | `Saida<{ canal, chave, desfeito }>`        |
 * | GET    | /api/whatsapp/quarentena    | `?conversa=<jid>&id=<id>`           | `Saida<MensagemParaOPainel>`               |
 * | GET    | /api/email/corpo            | `?conta=<id da conta>&id=<id do e-mail>` | `Saida<EmailParaOPainel>`             |
 * | GET    | /api/escritas/:id           |                                     | `Saida<CartaoVisto>`                       |
 * | POST   | /api/escritas/:id/editar    | `{ hash, versao, campos }`          | `Saida<CartaoVisto>`, em `rascunho`        |
 * | POST   | /api/escritas/:id/descartar | `{ hash, versao }`                  | `Saida<CartaoVisto>`, `descartado`         |
 * | POST   | /api/escritas/:id/aprovar   | `{ hash, versao }`                  | `Saida<CartaoVisto>`, no estado final da gravação |
 * | POST   | /api/escritas/:id/tentar_de_novo | `{ hash, versao }`             | como `aprovar`                             |
 * | POST   | /api/escritas/:id/ja_esta_no_crm | `{ hash, versao }`             | `Saida<CartaoVisto>`, `gravado`            |
 * | GET    | /api/atualizacao            | `?releitura=1` não busca a versão   | `Saida<EstadoDaAtualizacao>`               |
 * | POST   | /api/atualizacao/conferir   | nenhum                              | `Saida<EstadoDaAtualizacao>`, depois da busca |
 * | POST   | /api/atualizacao/aplicar    | nenhum                              | `Saida<EstadoDaAtualizacao>`, já `atualizando`; a recusa traz `erro.atual` |
 * | GET    | /api/info                   |                                     | `Saida<Info>`, também sem sessão           |
 *
 * O SSE também manda `event: atualizacao` (`EstadoDaAtualizacao`) a cada passo da atualização.
 * O SSE também manda `event: sincronizacao` (`AndamentoDaSincronizacao`), sem dado do CRM.
 * Nas ações de conector, o painel não aplica o `dados` da resposta: o estado novo chega pelo SSE.
 * Nas tarefas, ele usa o `dados`; o `event: tarefas` do SSE só avisa que vale recarregar.
 * Sem corpo, o pedido sai sem `Content-Type`. Com corpo, sai `Content-Type: application/json`.
 * O navegador manda `Origin` e o cookie de sessão sozinho (`credentials: "same-origin"`).
 */
import {
  ERROS,
  type Acao,
  type ConfigEmail,
  type DecisaoAutomatica,
  type EntradaConectar,
  type ErroOperacao,
  type EstadoPorConector,
  type IdConectorUnico,
  type IdContaEmail,
  type Instante,
  type JanelaDias,
  type ProvedorEmail,
  type Saida,
  type VisaoDaContaEmail,
  type VisaoDeQuemUsa,
  type VisaoDoEmail,
} from "../dominio";
import type { Sincronizacao } from "../conectores";
import type { CartaoVisto } from "../escritas";
import type { EmailParaOPainel, MensagemParaOPainel } from "../dominio";
import type { EstadoDaAtualizacao } from "../atualizacao";
import type { Info, ItemIgnorado, RespostaDaTarefa } from "../servidor";
import type { AlvoDeVinculo, Escolha, RespostaDaEscolha } from "./conversas";
import type { AlvoDoDia } from "./meu-dia";
import type { AcaoDaTarefa, CorpoDaAcao as CorpoDaAcaoDaTarefa, CorpoDeCriar, EstadoDaTarefa, MeuDia, Tarefa } from "../tarefas";

export const ROTA_DOS_EVENTOS = "/api/eventos";
export const ROTA_DO_LOGIN_DO_CRM = "/oauth/crm/iniciar";

export function rotaDaAcao(id: IdConectorUnico, acao: Acao): string {
  return `/api/conectores/${id}/${acao}`;
}

/**
 * Corpo de `POST /api/conectores/:id/conectar`. O CRM não entra aqui: o login começa por
 * navegação em `ROTA_DO_LOGIN_DO_CRM`. O e-mail tem rotas próprias, por conta.
 */
export interface CorpoConectar {
  readonly whatsapp: EntradaConectar["whatsapp"];
}

/**
 * Corpo de `POST /api/conectores/whatsapp/reparear`: o do `conectar` e a rodada, o `expiraEm` do pareamento
 * que o vendedor viu. O clique duplo manda a mesma rodada duas vezes, e o servidor reinicia uma vez só.
 */
export type CorpoReparear = CorpoConectar["whatsapp"] & { readonly rodada: Instante };

/** Pedido de ação que o painel faz. Só `conectar` e `reparear` levam corpo. */
export type PedidoDeAcao =
  | { readonly id: "whatsapp"; readonly acao: "conectar"; readonly corpo: CorpoConectar["whatsapp"] }
  | { readonly id: "whatsapp"; readonly acao: "reparear"; readonly corpo: CorpoReparear }
  | { readonly id: IdConectorUnico; readonly acao: Exclude<Acao, "conectar" | "reparear"> };

export type RespostaDaAcao<C extends IdConectorUnico = IdConectorUnico> = Saida<EstadoPorConector[C]>;

/**
 * Corpo de `POST /api/email/contas`, com a senha em texto só durante a viagem HTTP: o servidor a
 * envolve em `Segredo` na borda e nunca a devolve. Em `gmail` e `profills`, servidor, porta e
 * segurança saem de `PREDEFINICOES_DE_EMAIL` quando faltam; em `outro`, são obrigatórios.
 */
export interface CorpoDeAdicionarEmail {
  /**
   * UUID que o painel gera ao abrir o formulário e manda em toda tentativa dele. O clique duplo e a
   * nova tentativa depois de um erro caem na mesma conta, em vez de `email_rotulo_repetido`.
   */
  readonly id: IdContaEmail;
  readonly rotulo: string;
  readonly provedor: ProvedorEmail;
  readonly endereco: string;
  readonly servidor?: string;
  readonly porta?: number;
  readonly seguranca?: ConfigEmail["seguranca"];
  readonly janelaDias?: JanelaDias;
  readonly senha: string;
}

/** Corpo de cada ação de `POST /api/email/contas/:id/:acao`. `undefined` é ação sem corpo. */
export interface CorpoDaAcaoDoEmail {
  /** A senha e, quando o vendedor mudou, servidor, porta e segurança. O endereço da conta não muda. */
  readonly conectar: { readonly senha: string; readonly servidor?: string; readonly porta?: number; readonly seguranca?: ConfigEmail["seguranca"] };
  readonly cancelar: undefined;
  readonly testar: undefined;
  readonly desconectar: undefined;
  readonly remover: undefined;
  /** Pelo menos um dos dois. */
  readonly mudar: { readonly rotulo?: string; readonly janelaDias?: JanelaDias };
}

export type AcaoDoEmail = keyof CorpoDaAcaoDoEmail;

export type PedidoDoEmail = { readonly [A in AcaoDoEmail]: { readonly acao: A; readonly corpo: CorpoDaAcaoDoEmail[A] } }[AcaoDoEmail];

export function rotaDaContaEmail(id: IdContaEmail, acao: AcaoDoEmail): string {
  return `/api/email/contas/${encodeURIComponent(id)}/${acao}`;
}

function erroDaTabela(codigo: keyof typeof ERROS): ErroOperacao {
  return { codigo, mensagem: ERROS[codigo].mensagem, acao: ERROS[codigo].acao };
}

/** Borda da resposta: confere o envelope; o `dados` é da forma que a rota promete. */
function ehSaida<T>(valor: unknown): valor is Saida<T> {
  if (typeof valor !== "object" || valor === null) return false;
  const objeto = valor as { v?: unknown; ok?: unknown; erro?: unknown };
  if (objeto.v !== 1 || typeof objeto.ok !== "boolean") return false;
  if (objeto.ok) return true;
  const erro = objeto.erro as { mensagem?: unknown; acao?: unknown } | undefined;
  return typeof erro?.mensagem === "string" && typeof erro.acao === "string";
}

export type Buscar = (url: string, init: RequestInit) => Promise<Response>;

/** Faz a ação e devolve o erro para o cartão mostrar, ou `null` quando deu certo. Nunca lança. */
export async function pedirAcao(pedido: PedidoDeAcao, buscar: Buscar = (url, init) => fetch(url, init)): Promise<ErroOperacao | null> {
  const corpo = "corpo" in pedido ? JSON.stringify(pedido.corpo) : undefined;
  let resposta: Response;
  try {
    resposta = await buscar(rotaDaAcao(pedido.id, pedido.acao), {
      method: "POST",
      credentials: "same-origin",
      headers: corpo === undefined ? undefined : { "Content-Type": "application/json" },
      body: corpo,
    });
  } catch {
    return erroDaTabela("servidor_fora_do_ar");
  }
  const saida: unknown = await resposta.json().catch(() => null);
  if (!ehSaida(saida)) return erroDaTabela("interno");
  return saida.ok ? null : saida.erro;
}

/** Resposta lida da API de tarefas. Rede caída e corpo fora do envelope viram erro, nunca exceção. */
export type Resposta<T> = { readonly ok: true; readonly dados: T } | { readonly ok: false; readonly erro: ErroOperacao };

async function pedir<T>(buscar: Buscar, rota: string, corpo?: unknown, metodo?: "POST"): Promise<Resposta<T>> {
  const texto = corpo === undefined ? undefined : JSON.stringify(corpo);
  let resposta: Response;
  try {
    resposta = await buscar(rota, {
      method: metodo ?? (texto === undefined ? "GET" : "POST"),
      credentials: "same-origin",
      headers: texto === undefined ? undefined : { "Content-Type": "application/json" },
      body: texto,
    });
  } catch {
    return { ok: false, erro: erroDaTabela("servidor_fora_do_ar") };
  }
  const saida: unknown = await resposta.json().catch(() => null);
  if (!ehSaida<T>(saida)) return { ok: false, erro: erroDaTabela("interno") };
  return saida.ok ? { ok: true, dados: saida.dados } : { ok: false, erro: saida.erro };
}

/** Ação e corpo casados: `concluir` só anda com o corpo de concluir. */
export type PedidoDaTarefa = { readonly [A in AcaoDaTarefa]: { readonly acao: A; readonly corpo: CorpoDaAcaoDaTarefa[A] } }[AcaoDaTarefa];

/** O corpo de um alvo do Meu dia: a conversa leva o canal, e o id é a chave do item nele. */
const corpoDoAlvo = (alvo: AlvoDoDia) => (alvo.tipo === "conversa" ? { tipo: alvo.tipo, canal: alvo.canal, id: alvo.id } : { tipo: alvo.tipo, id: alvo.id });

const rotaDaTarefa = (id: string) => `/api/tarefas/${encodeURIComponent(id)}`;
const rotaDaEscrita = (id: string) => `/api/escritas/${encodeURIComponent(id)}`;

/** O que o vendedor viu: o hash e a versão do cartão. Qualquer diferença é `conflito_da_escrita`. */
export interface CorpoDeDecidirEscrita {
  readonly hash: string;
  readonly versao: number;
}

/** `campos` leva só os campos de texto que mudaram. Opcional esvaziado vai como `""`. */
export interface CorpoDeEditarEscrita extends CorpoDeDecidirEscrita {
  readonly campos: Readonly<Record<string, string>>;
}

export interface ApiDeTarefas {
  meuDia(): Promise<Resposta<MeuDia>>;
  listar(estado: EstadoDaTarefa): Promise<Resposta<{ readonly tarefas: readonly Tarefa[] }>>;
  ver(id: string): Promise<Resposta<RespostaDaTarefa>>;
  criar(corpo: CorpoDeCriar): Promise<Resposta<RespostaDaTarefa>>;
  /** Criar tarefa de uma proposta, de um cliente ou de uma conversa do Meu dia. `tarefaId` é o do rascunho, o mesmo em toda tentativa. */
  criarDoMeuDia(alvo: AlvoDoDia, tarefaId: string): Promise<Resposta<RespostaDaTarefa>>;
  agir(id: string, pedido: PedidoDaTarefa): Promise<Resposta<RespostaDaTarefa>>;
  sincronizar(): Promise<Resposta<Sincronizacao>>;
  /** O painel abriu: o servidor sincroniza se a leitura mais velha passou de 30 minutos. O andamento chega pelo SSE. */
  painelAberto(): Promise<Resposta<DecisaoAutomatica>>;
  /** O nome do cartão do pé e se o painel abre as boas-vindas. Só a sessão do painel lê. */
  quemUsa(): Promise<Resposta<VisaoDeQuemUsa>>;
  /** `{ nome }` grava o nome que o vendedor disse; `{ agoraNao: true }` para de perguntar sozinho. Fica só nesta máquina. */
  dizerNome(corpo: { readonly nome: string } | { readonly agoraNao: true }): Promise<Resposta<VisaoDeQuemUsa>>;
  ignorar(alvo: AlvoDoDia): Promise<Resposta<ItemIgnorado>>;
  desfazerIgnorado(alvo: AlvoDoDia): Promise<Resposta<{ readonly desfeito: boolean }>>;
  /** Só o painel escolhe. A chave é o telefone da conversa (E.164 com `+`) ou o endereço do remetente. */
  escolherCliente(alvo: AlvoDeVinculo, escolha: Escolha): Promise<Resposta<RespostaDaEscolha>>;
  /** `nao_cliente` volta a ambíguo na hora, com os candidatos guardados. `confirmado` (Trocar cliente) volta a ambíguo na hora, com o cliente que era como candidato. */
  desfazerEscolha(alvo: AlvoDeVinculo): Promise<Resposta<{ readonly desfeito: boolean }>>;
  /** O texto de uma mensagem em quarentena, com cada caractere invisível trocado por `⟦U+XXXX⟧`. */
  mensagemEmQuarentena(conversa: string, id: string): Promise<Resposta<MensagemParaOPainel>>;
  /** Lê um e-mail agora, sem guardar: abre uma conexão IMAP por chamada. `conta` é o id da conta, `id` o do e-mail. */
  corpoDoEmail(conta: string, id: string): Promise<Resposta<EmailParaOPainel>>;
  /** O cartão da fila de aprovação, com o texto como está guardado. */
  verEscrita(id: string): Promise<Resposta<CartaoVisto>>;
  editarEscrita(id: string, corpo: CorpoDeEditarEscrita): Promise<Resposta<CartaoVisto>>;
  descartarEscrita(id: string, corpo: CorpoDeDecidirEscrita): Promise<Resposta<CartaoVisto>>;
  /** Fica aberto até o CRM responder, uns 30 s ou mais. O painel não corta o pedido por tempo. */
  aprovarEscrita(id: string, corpo: CorpoDeDecidirEscrita): Promise<Resposta<CartaoVisto>>;
  /** Como `aprovar`: grava na hora. */
  tentarDeNovo(id: string, corpo: CorpoDeDecidirEscrita): Promise<Resposta<CartaoVisto>>;
  jaEstaNoCrm(id: string, corpo: CorpoDeDecidirEscrita): Promise<Resposta<CartaoVisto>>;
  /** Sem `releitura`, é a abertura do painel: o servidor busca a versão se passou das 6 horas. */
  atualizacao(releitura: boolean): Promise<Resposta<EstadoDaAtualizacao>>;
  /** O Tentar agora: busca sempre. */
  conferirAtualizacao(): Promise<Resposta<EstadoDaAtualizacao>>;
  /** O clique em Atualizar ou em Tentar de novo. */
  aplicarAtualizacao(): Promise<Resposta<EstadoDaAtualizacao>>;
  /** A versão que o servidor no ar responde. Sem sessão: serve para ver o servidor voltar depois do restart. */
  info(): Promise<Resposta<Info>>;
}

/**
 * As contas de e-mail. Nas respostas, o painel pode usar o `dados`, mas o estado novo também
 * chega pelo SSE, em `EstadoPainel.email`.
 */
export interface ApiDoEmail {
  adicionar(corpo: CorpoDeAdicionarEmail): Promise<Resposta<VisaoDaContaEmail>>;
  agir(id: IdContaEmail, pedido: PedidoDoEmail): Promise<Resposta<VisaoDaContaEmail | { readonly removida: IdContaEmail }>>;
  pular(pulado: boolean): Promise<Resposta<VisaoDoEmail>>;
}

export function criarApiDoEmail(buscar: Buscar = (url, init) => fetch(url, init)): ApiDoEmail {
  return {
    adicionar: (corpo) => pedir(buscar, "/api/email/contas", corpo),
    // Ação sem corpo sai como POST vazio, sem `Content-Type`.
    agir: (id, pedido) => pedir(buscar, rotaDaContaEmail(id, pedido.acao), pedido.corpo, "POST"),
    pular: (pulado) => pedir(buscar, "/api/email/pular", { pulado }),
  };
}

export function criarApiDeTarefas(buscar: Buscar = (url, init) => fetch(url, init)): ApiDeTarefas {
  return {
    meuDia: () => pedir(buscar, "/api/meu-dia"),
    listar: (estado) => pedir(buscar, `/api/tarefas?estado=${estado}`),
    ver: (id) => pedir(buscar, rotaDaTarefa(id)),
    criar: (corpo) => pedir(buscar, "/api/tarefas", corpo),
    criarDoMeuDia: (alvo, tarefaId) => pedir(buscar, "/api/meu-dia/tarefas", { ...corpoDoAlvo(alvo), tarefaId }),
    agir: (id, pedido) => pedir(buscar, `${rotaDaTarefa(id)}/${pedido.acao}`, pedido.corpo),
    sincronizar: () => pedir(buscar, "/api/sincronizar", undefined, "POST"),
    painelAberto: () => pedir(buscar, "/api/painel/aberto", undefined, "POST"),
    quemUsa: () => pedir(buscar, "/api/painel/quem-usa"),
    dizerNome: (corpo) => pedir(buscar, "/api/painel/quem-usa", corpo),
    ignorar: (alvo) => pedir(buscar, "/api/ignorados", corpoDoAlvo(alvo)),
    desfazerIgnorado: (alvo) => pedir(buscar, "/api/ignorados/desfazer", corpoDoAlvo(alvo)),
    escolherCliente: ({ canal, chave }, escolha) => pedir(buscar, "/api/vinculos/escolher", { canal, chave, ...escolha }),
    desfazerEscolha: ({ canal, chave }) => pedir(buscar, "/api/vinculos/desfazer", { canal, chave }),
    mensagemEmQuarentena: (conversa, id) => pedir(buscar, `/api/whatsapp/quarentena?conversa=${encodeURIComponent(conversa)}&id=${encodeURIComponent(id)}`),
    corpoDoEmail: (conta, id) => pedir(buscar, `/api/email/corpo?conta=${encodeURIComponent(conta)}&id=${encodeURIComponent(id)}`),
    verEscrita: (id) => pedir(buscar, rotaDaEscrita(id)),
    editarEscrita: (id, corpo) => pedir(buscar, `${rotaDaEscrita(id)}/editar`, corpo),
    descartarEscrita: (id, corpo) => pedir(buscar, `${rotaDaEscrita(id)}/descartar`, corpo),
    aprovarEscrita: (id, corpo) => pedir(buscar, `${rotaDaEscrita(id)}/aprovar`, corpo),
    tentarDeNovo: (id, corpo) => pedir(buscar, `${rotaDaEscrita(id)}/tentar_de_novo`, corpo),
    jaEstaNoCrm: (id, corpo) => pedir(buscar, `${rotaDaEscrita(id)}/ja_esta_no_crm`, corpo),
    atualizacao: (releitura) => pedir(buscar, releitura ? "/api/atualizacao?releitura=1" : "/api/atualizacao"),
    conferirAtualizacao: () => pedir(buscar, "/api/atualizacao/conferir", undefined, "POST"),
    aplicarAtualizacao: () => pedir(buscar, "/api/atualizacao/aplicar", undefined, "POST"),
    info: () => pedir(buscar, "/api/info"),
  };
}

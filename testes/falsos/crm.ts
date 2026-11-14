/**
 * CRM falso: servidor de autorização OAuth, recurso protegido e MCP num `Bun.serve` em porta livre.
 * Copia as regras do OAuth do CRM, conferidas contra o CRM em 11/11/2026 e na documentação do MCP:
 * allowlist de clients por CIMD, redirect loopback com porta livre, PKCE S256, `iss` no retorno,
 * rotação de refresh com detecção de reuso e a janela de 30 s para a resposta que se perdeu.
 * A única regra relaxada é o https do documento CIMD, que aqui é servido pelo próprio falso.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { diaEm, somarAoDia, type Dia } from "../../nucleo/dominio";

const CIMD = join(import.meta.dir, "..", "..", "nucleo", "conectores", "crm", "cliente-oauth.json");
const ESCOPO = "crm.leitura";
const JANELA_DE_RETRY_MS = 30_000;
const FERRAMENTAS = 18;

export interface BotoesDoCrmFalso {
  /** O client sai da allowlist, como antes de a Profills liberar a Secretária. */
  foraDaAllowlist: boolean;
  /** O vendedor clica em negar na tela de consentimento. */
  usuarioNega: boolean;
  /** O retorno traz o `iss` de outro servidor. */
  issErrado: boolean;
  /** Todas as rotas respondem 503. */
  foraDoAr: boolean;
  /** Enquanto não for `null`, o pedido de autorização recebe uma página com este status HTTP. */
  statusDoAuthorize: number | null;
  /** Quantas renovações o falso processa e responde 502, como um intermediário que perdeu a resposta. */
  perderRespostasDoRefresh: number;
  /** O MCP responde 401 mesmo com token bom. */
  mcpRecusa: boolean;
  /** O MCP responde em `text/event-stream`. */
  mcpEmSse: boolean;
  vidaDoAccessS: number;
  /** Segundos do `Retry-After` de um HTTP 429 a todo `tools/call`. */
  limiteHttpS: number | null;
  /** Segundos da mensagem de limite que o MCP devolve como erro da tool, como o 429 do CRM traduzido. */
  limiteNaFerramentaS: number | null;
  /** Quantos `tools/call` passam antes de o limite valer. */
  chamadasAntesDoLimite: number;
  /** Toda tool responde "Sessão sem usuário do CRM. Reconecte o conector." */
  semUsuario: boolean;
  /** Estas tools respondem "O CRM está indisponível agora." */
  ferramentasForaDoAr: Set<string>;
  /** Estas tools respondem com `structuredContent` fora do formato da doc. */
  ferramentasMalformadas: Set<string>;
  /** Estas tools respondem com este `structuredContent`, como veio, sem passar pelos dados do falso. */
  respostasCruas: Map<string, unknown>;
  /** Estas tools respondem com erro da tool (`isError`) e este texto, que a Secretária não conhece. */
  ferramentasComErro: Map<string, string>;
  /** Todo `tools/call` recebe um erro JSON-RPC com esta mensagem. */
  erroRpc: string | null;
  /** Estas tools respondem 401, como um access que o CRM revogou. */
  ferramentasRecusamToken: Set<string>;
  /** Enquanto não for `null`, todo `tools/call` espera esta promessa antes de responder. */
  segurar: Promise<void> | null;
  /** Chamado quando um `tools/call` chega, antes de `segurar`. */
  aoChamar: ((nome: string) => void) | null;
  /** `buscar_clientes` responde sem o campo `contatos`. */
  buscaSemContatos: boolean;
  /** `buscar_clientes` responde este `bateu_em` em todo cliente, no lugar da lista que o falso calcula. */
  bateuEmCru: { readonly valor: unknown } | null;
  /** Quantas escritas o falso grava e responde 502, como um intermediário que perdeu a resposta: a queda no meio. */
  perderRespostasDaEscrita: number;
  /** Quando não é `null`, a resposta das três tools de escrita leva este `link`. A doc não promete `link`: o padrão é sem. */
  linkDaEscrita: string | null;
}

/** Os dados que as tools de leitura devolvem. O teste troca à vontade. Valor monetário é string, como no CRM. */
export interface DadosDoCrmFalso {
  compromissos: Record<string, unknown>[];
  propostas: Record<string, unknown>[];
  carteira: Record<string, unknown>[];
  /** Nasce vazia: só o teste do relatório a enche. */
  atendimentos: Record<string, unknown>[];
  /** O que as tools de escrita gravaram, na ordem. `chamadasDeFerramenta` conta também a chamada que o falso recusou. */
  gravados: GravadoNoCrmFalso[];
}

export interface GravadoNoCrmFalso {
  readonly tool: string;
  /** Crescente a partir de 70001. */
  readonly id: number;
  /** Os `arguments` do `tools/call`, como chegaram. */
  readonly argumentos: Record<string, unknown>;
}

export interface ChamadaDeFerramenta {
  readonly nome: string;
  readonly argumentos: Record<string, unknown>;
}

export interface RegistroDoCrmFalso {
  /** Pedidos ao authorize sem sessão: a consulta que o conector faz antes de mostrar a URL. */
  readonly consultas: number;
  readonly consentimentos: number;
  readonly trocasDeCodigo: number;
  readonly refreshes: number;
  readonly familiasRevogadas: number;
  readonly chamadasAoMcp: number;
  readonly chamadasDeFerramenta: readonly ChamadaDeFerramenta[];
  /** O `client_id` de cada pedido ao authorize que o falso recusou por causa do aplicativo. */
  readonly clientesRecusados: readonly string[];
  /** Tudo o que é segredo e passou pelo falso: tokens emitidos e `code_verifier` recebidos. */
  readonly segredos: readonly string[];
}

export interface CrmFalso {
  readonly origem: string;
  readonly recurso: URL;
  readonly clientId: URL;
  readonly botoes: BotoesDoCrmFalso;
  readonly dados: DadosDoCrmFalso;
  /** O dia de Brasília no relógio do falso, deslocado em `dias`. */
  dia(dias?: number): Dia;
  /** Faz o papel do vendedor logado no navegador: abre a URL e devolve a query do retorno. */
  autorizar(urlDeAutorizacao: string): Promise<URLSearchParams>;
  /** O administrador do CRM derruba todas as conexões: o próximo refresh recebe `invalid_grant`. */
  revogarConexoes(): void;
  /** Um access token válido sem passar pelo login, para testar o cliente MCP sozinho. */
  emitirAcesso(): string;
  registro(): RegistroDoCrmFalso;
  parar(): Promise<void>;
}

interface Codigo {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly desafio: string;
  readonly recurso: string;
  readonly familia: string;
  usado: boolean;
}

interface Refresh {
  readonly familia: string;
  readonly clientId: string;
  trocadoEm: number | null;
  reemitidoEm: number | null;
  revogado: "substituido" | "familia" | null;
  filho: string | null;
}

function resumo(texto: string): string {
  return createHash("sha256").update(texto).digest("base64url");
}

function loopback(uri: URL): boolean {
  return uri.protocol === "http:" && (uri.hostname === "127.0.0.1" || uri.hostname === "localhost");
}

function json(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function pagina(mensagem: string, status: number): Response {
  return new Response(`<!doctype html><p>${mensagem}</p>`, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}


/** Data e hora de Brasília com o offset, como o CRM manda. */
function isoDeBrasilia(dia: Dia, hora: string): string {
  return `${dia}T${hora}:00-03:00`;
}

/** Proposta canário no formato de `listar_propostas`, com os campos de `ver_proposta` junto. */
export function propostaFalsa(id: number, estagio: string, enviadaEm: Dia | null, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    codigo: `${String(id).padStart(4, "0")}/26`,
    versao: 1,
    ativa: 1,
    estagio,
    cliente: { id: 9000 + id, nome: `CANARIO Cliente Proposta ${id}` },
    responsavel: { id: 77, nome: "CANARIO Vendedor" },
    valor_total: "1500.00",
    moeda: "BRL",
    data_envio: enviadaEm === null ? null : isoDeBrasilia(enviadaEm, "09:00"),
    prazo_retorno: enviadaEm === null ? null : somarAoDia(enviadaEm, 30),
    valor_final: estagio === "cliente_aceitou" ? "1350.00" : null,
    fechada_em: null,
    atualizado_em: enviadaEm === null ? null : isoDeBrasilia(enviadaEm, "09:00"),
    forma_escolhida: estagio === "cliente_aceitou" ? { valor_final: "1350.00" } : null,
    campo_que_o_crm_acrescentou: "o cliente MCP ignora",
    ...extra,
  };
}

/** Atendimento canário no formato de `meus_atendimentos`, com a hora de Brasília e um campo que o CRM acrescentou. */
export function atendimentoFalso(id: number, status: string, data: Dia, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    assunto: `CANARIO Assunto ${id}`,
    status,
    data: isoDeBrasilia(data, "10:00"),
    cliente: { id: 8001, nome: "CANARIO Cliente Atendimento" },
    campo_que_o_crm_acrescentou: "o cliente MCP ignora",
    ...extra,
  };
}

/**
 * Os contatos de um cliente do falso: `contatos` como o teste os escreveu (até fora do formato), ou um
 * contato por número de `telefones`, no formato da doc.
 */
function contatosDoFalso(cliente: Record<string, unknown>): Record<string, unknown>[] {
  if (Array.isArray(cliente.contatos)) return cliente.contatos as Record<string, unknown>[];
  if (!Array.isArray(cliente.telefones)) return [];
  return cliente.telefones.map((telefone, i) => ({
    id: Number(cliente.id) * 10 + i,
    id_cliente: cliente.id,
    nome: `CANARIO Contato ${i + 1}`,
    telefone: String(telefone),
    email: `canario${i + 1}@exemplo.test`,
    cargo: null,
  }));
}

export function clienteFalso(id: number, ultimoAtendimento: string | null, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    nome: `CANARIO Cliente ${id}`,
    nome_fantasia: `CANARIO Fantasia ${id}`,
    cidade: "Curitiba",
    uf: "PR",
    ultimo_atendimento_em: ultimoAtendimento,
    ultimo_atendimento_aproximado: false,
    campo_que_o_crm_acrescentou: 1,
    ...extra,
  };
}

function dadosCanario(hoje: Dia): DadosDoCrmFalso {
  const cliente = { id: 9101, nome: "CANARIO Cliente Agenda" };
  return {
    compromissos: [
      { id: 502, titulo: "CANARIO Visita da tarde", descricao: "texto do CRM", inicio: isoDeBrasilia(hoje, "15:30"), fim: isoDeBrasilia(hoje, "16:30"), tipo: "client", cliente, via_app: null },
      { id: 501, titulo: "CANARIO Reunião da manhã", descricao: null, inicio: isoDeBrasilia(hoje, "10:00"), fim: null, tipo: "internal", cliente: null, via_app: null },
      { id: 503, titulo: "CANARIO Amanhã", descricao: null, inicio: isoDeBrasilia(somarAoDia(hoje, 1), "10:00"), fim: null, tipo: "internal", cliente: null, via_app: null },
    ],
    propostas: [
      propostaFalsa(7001, "enviada", somarAoDia(hoje, -3)),
      propostaFalsa(7002, "enviada", somarAoDia(hoje, -7)),
      propostaFalsa(7003, "enviada", somarAoDia(hoje, -15)),
      propostaFalsa(7004, "enviada", somarAoDia(hoje, -28)),
      propostaFalsa(7005, "enviada", somarAoDia(hoje, -31)),
      propostaFalsa(7006, "rascunho", null),
      propostaFalsa(7007, "cliente_aceitou", somarAoDia(hoje, -40)),
    ],
    carteira: [
      clienteFalso(8001, null),
      clienteFalso(8002, isoDeBrasilia(somarAoDia(hoje, -45), "11:00")),
      clienteFalso(8003, isoDeBrasilia(somarAoDia(hoje, -400), "00:00"), { ultimo_atendimento_aproximado: true }),
      clienteFalso(8004, isoDeBrasilia(somarAoDia(hoje, -5), "11:00")),
    ],
    atendimentos: [],
    gravados: [],
  };
}

function resultadoDaFerramenta(dados: unknown): unknown {
  return { content: [{ type: "text", text: JSON.stringify(dados) }], structuredContent: dados, isError: false };
}

function erroDaFerramenta(mensagem: string): unknown {
  return { content: [{ type: "text", text: mensagem }], isError: true };
}

const NAO_ENCONTRADO = "Não encontrado, ou você não tem acesso a este registro.";

export function iniciarCrmFalso(opcoes: { readonly agora?: () => number } = {}): CrmFalso {
  const agora = opcoes.agora ?? Date.now;
  const dia = (dias = 0) => somarAoDia(diaEm(new Date(agora())), dias);
  const botoes: BotoesDoCrmFalso = {
    foraDaAllowlist: false,
    usuarioNega: false,
    issErrado: false,
    foraDoAr: false,
    statusDoAuthorize: null,
    perderRespostasDoRefresh: 0,
    mcpRecusa: false,
    mcpEmSse: false,
    vidaDoAccessS: 3600,
    limiteHttpS: null,
    limiteNaFerramentaS: null,
    chamadasAntesDoLimite: 0,
    semUsuario: false,
    ferramentasForaDoAr: new Set(),
    ferramentasMalformadas: new Set(),
    respostasCruas: new Map(),
    ferramentasComErro: new Map(),
    erroRpc: null,
    ferramentasRecusamToken: new Set(),
    segurar: null,
    aoChamar: null,
    buscaSemContatos: false,
    bateuEmCru: null,
    perderRespostasDaEscrita: 0,
    linkDaEscrita: null,
  };
  // Preguiçoso: quem cria o falso costuma passar um relógio que só existe depois dele.
  let canario: DadosDoCrmFalso | null = null;
  const dados = () => (canario ??= dadosCanario(dia()));
  const contagem = { consultas: 0, consentimentos: 0, trocasDeCodigo: 0, refreshes: 0, familiasRevogadas: 0, chamadasAoMcp: 0 };
  const chamadasDeFerramenta: ChamadaDeFerramenta[] = [];
  let proximoIdGravado = 70_001;
  const segredos: string[] = [];
  const clientesRecusados: string[] = [];
  const codigos = new Map<string, Codigo>();
  const refreshes = new Map<string, Refresh>();
  const acessos = new Map<string, { readonly familia: string; readonly expiraEm: number }>();
  const familiasRevogadas = new Set<string>();

  const servidor = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: atender });
  const origem = `http://127.0.0.1:${servidor.port}`;
  const recurso = `${origem}/mcp`;
  const clientId = `${origem}/cimd/cliente-oauth.json`;

  function opaco(prefixo: string): string {
    const valor = `CANARIO-${prefixo}-${randomBytes(18).toString("base64url")}`;
    segredos.push(valor);
    return valor;
  }

  function documentoCimd(): string {
    return JSON.stringify({ ...(JSON.parse(readFileSync(CIMD, "utf8")) as object), client_id: clientId });
  }

  /** `parse_documento` e `resolver` do CRM. Devolve os redirects registrados ou o motivo da recusa. */
  function resolverCliente(pedido: string): { readonly redirects: readonly string[] } | { readonly recusa: string } {
    if (botoes.foraDaAllowlist || pedido !== clientId) return { recusa: "client_id fora da allowlist" };
    const texto = documentoCimd();
    if (Buffer.byteLength(texto) > 5 * 1024) return { recusa: "documento acima de 5 KB" };
    const documento = JSON.parse(texto) as Record<string, unknown>;
    if (documento.client_id !== pedido) return { recusa: "client_id do documento difere da URL" };
    if ("client_secret" in documento) return { recusa: "documento traz client_secret" };
    const redirects = documento.redirect_uris;
    if (!Array.isArray(redirects) || redirects.length === 0 || !redirects.every((r) => typeof r === "string" && r !== "")) {
      return { recusa: "redirect_uris ausente ou inválido" };
    }
    if (documento.token_endpoint_auth_method !== "none") return { recusa: "token_endpoint_auth_method recusado" };
    return { redirects: redirects as string[] };
  }

  function redirectRegistrado(registrados: readonly string[], pedido: string): boolean {
    if (registrados.includes(pedido)) return true;
    let alvo: URL;
    try {
      alvo = new URL(pedido);
    } catch {
      return false;
    }
    if (!loopback(alvo) || alvo.username !== "" || alvo.password !== "" || alvo.hash !== "") return false;
    return registrados.some((registrado) => {
      const reg = new URL(registrado);
      return loopback(reg) && reg.hostname === alvo.hostname && reg.pathname === alvo.pathname && reg.search === alvo.search;
    });
  }

  function voltar(redirectUri: string, valores: Record<string, string | null>): Response {
    const destino = new URL(redirectUri);
    for (const [chave, valor] of Object.entries(valores)) if (valor !== null) destino.searchParams.set(chave, valor);
    destino.searchParams.set("iss", botoes.issErrado ? "https://outro-servidor.invalid" : origem);
    return new Response(null, { status: 303, headers: { location: destino.href } });
  }

  function authorize(pedido: Request, url: URL): Response {
    if (botoes.statusDoAuthorize !== null) return pagina(`HTTP ${botoes.statusDoAuthorize}`, botoes.statusDoAuthorize);
    const p = url.searchParams;
    for (const campo of new Set(p.keys())) if (p.getAll(campo).length > 1) return pagina("parâmetro repetido", 400);
    const cliente = resolverCliente(p.get("client_id") ?? "");
    if ("recusa" in cliente) {
      clientesRecusados.push(p.get("client_id") ?? "");
      return pagina(cliente.recusa, 400);
    }
    const redirectUri = p.get("redirect_uri") ?? "";
    if (!redirectRegistrado(cliente.redirects, redirectUri)) return pagina("redirect_uri não registrado", 400);

    const state = p.get("state");
    const erro = (error: string) => voltar(redirectUri, { error, state });
    if (p.get("response_type") !== "code") return erro("unsupported_response_type");
    const desafio = p.get("code_challenge") ?? "";
    if (p.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(desafio)) return erro("invalid_request");
    const alvo = p.get("resource") ?? "";
    if (alvo === "") return erro("invalid_request");
    if (alvo !== recurso) return erro("invalid_target");
    if ((p.get("scope") ?? ESCOPO) !== ESCOPO) return erro("invalid_scope");

    if (!(pedido.headers.get("cookie") ?? "").includes("sessao=vendedor")) {
      contagem.consultas += 1;
      return new Response(null, { status: 302, headers: { location: `${origem}/login` } });
    }
    contagem.consentimentos += 1;
    if (botoes.usuarioNega) return erro("access_denied");
    const codigo = opaco("code");
    codigos.set(codigo, {
      clientId: p.get("client_id") ?? "",
      redirectUri,
      desafio,
      recurso: alvo,
      familia: randomBytes(8).toString("hex"),
      usado: false,
    });
    return voltar(redirectUri, { code: codigo, state });
  }

  const negado = () => json({ error: "invalid_grant", error_description: "grant invalido, vencido ou revogado" }, 400);

  function revogarFamilia(familia: string): Response {
    if (!familiasRevogadas.has(familia)) contagem.familiasRevogadas += 1;
    familiasRevogadas.add(familia);
    for (const refresh of refreshes.values()) if (refresh.familia === familia) refresh.revogado ??= "familia";
    return negado();
  }

  function emitir(familia: string, cliente: string): { readonly refresh: string; readonly corpo: object } {
    const access = opaco("access");
    const refresh = opaco("refresh");
    acessos.set(access, { familia, expiraEm: agora() + botoes.vidaDoAccessS * 1000 });
    refreshes.set(refresh, { familia, clientId: cliente, trocadoEm: null, reemitidoEm: null, revogado: null, filho: null });
    return {
      refresh,
      corpo: { access_token: access, token_type: "Bearer", expires_in: botoes.vidaDoAccessS, refresh_token: refresh, scope: ESCOPO },
    };
  }

  async function token(pedido: Request): Promise<Response> {
    if (!(pedido.headers.get("content-type") ?? "").startsWith("application/x-www-form-urlencoded")) {
      return json({ error: "invalid_request" }, 400);
    }
    const form = new URLSearchParams(await pedido.text());
    for (const campo of new Set(form.keys())) if (form.getAll(campo).length > 1) return json({ error: "invalid_request" }, 400);
    const concessao = form.get("grant_type");
    if (concessao !== "authorization_code" && concessao !== "refresh_token") return json({ error: "unsupported_grant_type" }, 400);
    const cliente = form.get("client_id") ?? "";
    if ("recusa" in resolverCliente(cliente)) return json({ error: "invalid_client" }, 401);

    if (concessao === "authorization_code") {
      contagem.trocasDeCodigo += 1;
      const verificador = form.get("code_verifier") ?? "";
      if (verificador !== "") segredos.push(verificador);
      const registro = codigos.get(form.get("code") ?? "");
      if (registro === undefined || registro.clientId !== cliente || registro.redirectUri !== form.get("redirect_uri")) return negado();
      if (resumo(verificador) !== registro.desafio) return negado();
      if (registro.usado) return revogarFamilia(registro.familia);
      if ((form.get("resource") ?? registro.recurso) !== registro.recurso) return negado();
      registro.usado = true;
      return json(emitir(registro.familia, cliente).corpo);
    }

    contagem.refreshes += 1;
    const registro = refreshes.get(form.get("refresh_token") ?? "");
    if (registro === undefined) return negado();
    if (registro.revogado === "substituido") return revogarFamilia(registro.familia);
    if (registro.revogado !== null) return negado();
    const naJanela =
      registro.trocadoEm !== null && registro.reemitidoEm === null && agora() - registro.trocadoEm <= JANELA_DE_RETRY_MS;
    if (registro.trocadoEm !== null && !naJanela) return revogarFamilia(registro.familia);
    if (registro.clientId !== cliente) return negado();

    if (registro.trocadoEm === null) registro.trocadoEm = agora();
    else {
      registro.reemitidoEm = agora();
      const filho = registro.filho === null ? undefined : refreshes.get(registro.filho);
      if (filho !== undefined) filho.revogado = "substituido";
    }
    const novo = emitir(registro.familia, cliente);
    registro.filho = novo.refresh;
    if (botoes.perderRespostasDoRefresh > 0) {
      botoes.perderRespostasDoRefresh -= 1;
      return new Response("bad gateway", { status: 502 });
    }
    return json(novo.corpo);
  }

  /** Uma página no formato do CRM: a lista com o nome que o CRM dá em cada tool, e `mais`. */
  function fatiar<K extends string, T>(nome: K, lista: readonly T[], limite: number): { readonly mais: boolean } & Record<K, T[]> {
    return { [nome]: lista.slice(0, limite), mais: lista.length > limite } as { readonly mais: boolean } & Record<K, T[]>;
  }

  const ehDoDia = (iso: unknown, de: string, ate: string) => {
    const diaDoItem = diaEm(new Date(String(iso)));
    return diaDoItem >= de && diaDoItem <= ate;
  };

  function clienteDoFalso(id: unknown): Record<string, unknown> | undefined {
    const daProposta = dados().propostas.map((p) => p.cliente as { id: number; nome: string }).find((c) => c.id === id);
    return dados().carteira.find((c) => c.id === id) ?? (daProposta === undefined ? undefined : clienteFalso(daProposta.id, null, { nome: daProposta.nome }));
  }

  /** `AAAA-MM-DD HH:MM` de Brasília para o ISO com `-03:00`, como o CRM devolve. */
  const isoDaEscrita = (momento: string) => `${momento.replace(" ", "T")}:00-03:00`;
  // Menos 2 h é mais 1 h do fim e menos 3 h do offset: o texto UTC sai na hora de Brasília.
  const umaHoraDepois = (iso: string) => `${new Date(Date.parse(iso) - 2 * 3_600_000).toISOString().slice(0, 19)}-03:00`;

  const VENDEDOR = { id: 77, nome: "CANARIO Vendedor" };

  /**
   * As três tools de escrita, com as regras de `docs/tools.md`. Cada chamada que passa grava outro registro.
   * A resposta tem a forma que a documentação do MCP dá a cada tool, conferida contra o CRM em 14/11/2026.
   */
  function gravar(tool: string, argumentos: Record<string, unknown>, resposta: (id: number, cliente: { id: unknown; nome: unknown } | null) => Record<string, unknown>): unknown {
    const achado = argumentos.cliente_id === undefined ? undefined : clienteDoFalso(argumentos.cliente_id);
    if (argumentos.cliente_id !== undefined && achado === undefined) return erroDaFerramenta(NAO_ENCONTRADO);
    const cliente = achado === undefined ? null : { id: achado.id, nome: achado.nome };
    const id = proximoIdGravado;
    proximoIdGravado += 1;
    dados().gravados.push({ tool, id, argumentos });
    return { ...resposta(id, cliente), campo_que_o_crm_acrescentou: "o cliente MCP ignora", ...(botoes.linkDaEscrita === null ? {} : { link: botoes.linkDaEscrita }) };
  }

  const ESCRITAS_FALSAS: Record<string, (args: Record<string, unknown>) => unknown> = {
    registrar_atendimento: (args) =>
      gravar("registrar_atendimento", args, (id, cliente) => ({
        id,
        assunto: args.assunto,
        descricao: args.descricao ?? null,
        status: args.status,
        data: `${new Date(agora() - 3 * 3_600_000).toISOString().slice(0, 19)}-03:00`,
        contato: null,
        autor: VENDEDOR,
        cliente,
        via_app: "secretaria",
      })),
    criar_compromisso(args) {
      const inicio = isoDaEscrita(String(args.inicio));
      const fim = args.fim === undefined ? umaHoraDepois(inicio) : isoDaEscrita(String(args.fim));
      if (Date.parse(fim) <= Date.parse(inicio)) return erroDaFerramenta("O fim precisa ser depois do início.");
      return gravar("criar_compromisso", args, (id, cliente) => ({
        id,
        titulo: args.titulo,
        descricao: args.descricao ?? null,
        inicio,
        fim,
        tipo: args.tipo ?? (cliente === null ? "internal" : "client"),
        cor: "#3b82f6",
        cliente,
        via_app: "secretaria",
      }));
    },
    criar_contato: (args) =>
      gravar("criar_contato", args, (id, cliente) => ({
        id,
        nome: args.nome,
        cargo: args.cargo ?? null,
        departamento: args.departamento ?? null,
        telefone: args.telefone,
        email: args.email ?? null,
        observacoes: args.observacoes ?? null,
        responsavel: VENDEDOR,
        cliente,
      })),
  };

  /** As tools de leitura, com as regras de `docs/tools.md`: paginação por `antes` e por `cursor`, filtros e o 404 igual para tudo. */
  const FERRAMENTAS_FALSAS: Record<string, (args: Record<string, unknown>) => unknown> = {
    minha_agenda(args) {
      const de = typeof args.de === "string" ? args.de : dia();
      const ate = typeof args.ate === "string" ? args.ate : somarAoDia(de as Dia, 14);
      const doPeriodo = dados().compromissos.filter((c) => ehDoDia(c.inicio, de, ate));
      return { de, ate, ...fatiar("compromissos", doPeriodo, 200) };
    },
    listar_propostas(args) {
      const limite = typeof args.limite === "number" ? args.limite : 20;
      const antes = typeof args.antes === "number" ? args.antes : Number.POSITIVE_INFINITY;
      const propostas = [...dados().propostas]
        .sort((a, b) => Number(b.id) - Number(a.id))
        .filter((p) => Number(p.id) < antes && (args.estagio === undefined || p.estagio === args.estagio))
        .map(({ link: _link, forma_escolhida: _forma, ativa: _ativa, ...lista }) => lista);
      return fatiar("propostas", propostas, limite);
    },
    ver_proposta(args) {
      const achada = dados().propostas.find((p) => p.id === args.proposta_id || (args.codigo !== undefined && p.codigo === args.codigo));
      if (achada === undefined) return erroDaFerramenta(`${NAO_ENCONTRADO} Se o número veio do vendedor, use \`codigo\`.`);
      const { valor_final: _valor, data_envio, ...detalhe } = achada;
      return { link: `${origem}/propostas/${String(achada.id)}`, ...detalhe, data_envio, maquinas: [], embalagens: [], acessorios: [], versoes: [], follow_ups: [] };
    },
    minha_carteira(args) {
      const limite = typeof args.limite === "number" ? args.limite : 20;
      const inicio = typeof args.cursor === "string" ? Number(args.cursor.slice(2)) : 0;
      const corte = typeof args.sem_atendimento_ha_dias === "number" ? somarAoDia(dia(), -args.sem_atendimento_ha_dias) : null;
      const todos = dados().carteira.filter((c) => corte === null || c.ultimo_atendimento_em === null || diaEm(new Date(String(c.ultimo_atendimento_em))) <= corte);
      const fatia = todos.slice(inicio, inicio + limite);
      const mais = inicio + limite < todos.length;
      return { clientes: fatia, mais, proximo_cursor: mais ? `c:${inicio + limite}` : null };
    },
    buscar_clientes(args) {
      const termo = String(args.q ?? "").toLowerCase();
      const digitos = termo.replace(/\D/g, "");
      // Como a doc: só número e pontuação busca CPF/CNPJ e, com 8 dígitos ou mais, o telefone dos contatos, com ou sem 55 e DDD.
      const soNumero = /^[\d\s().+\-/]+$/.test(termo);
      const bateTelefone = (contato: Record<string, unknown>) => {
        const doContato = String(contato.telefone ?? "").replace(/\D/g, "");
        return digitos.length >= 8 && doContato.length >= 8 && (doContato.endsWith(digitos) || digitos.endsWith(doContato));
      };
      // Com `@`, como a doc: busca o e-mail do cliente e o dos contatos, sem diferença de maiúscula.
      const porEmail = termo.includes("@");
      const bateEmail = (contato: Record<string, unknown>) => String(contato.email ?? "").toLowerCase().includes(termo);
      const bateContato = (contato: Record<string, unknown>) => (porEmail ? bateEmail(contato) : bateTelefone(contato));
      // Como o CRM: `bateu_em` é a lista dos rótulos de onde a busca bateu, sem repetição.
      const ondeBateu = (c: Record<string, unknown>): string[] => {
        if (porEmail) {
          const rotulos: string[] = [];
          if (String(c.email ?? "").toLowerCase().includes(termo)) rotulos.push("email");
          if (contatosDoFalso(c).some(bateEmail)) rotulos.push("contato_email");
          return rotulos;
        }
        if (!soNumero) return String(c.nome).toLowerCase().includes(termo) ? ["nome"] : [];
        const rotulos: string[] = [];
        if (digitos !== "" && String(c.cnpj ?? "").replace(/\D/g, "") === digitos) rotulos.push("cpf_cnpj");
        if (contatosDoFalso(c).some(bateTelefone)) rotulos.push("contato_telefone");
        return rotulos;
      };
      const achados = dados().carteira.flatMap((c) => {
        const bateu = ondeBateu(c);
        return bateu.length === 0 ? [] : [{ c, bateu: botoes.bateuEmCru === null ? bateu : botoes.bateuEmCru.valor }];
      });
      const clientes = achados.map(({ c, bateu }) => {
        const { telefones: _telefones, cnpj: _cnpj, contatos: _contatos, ...resto } = c;
        const todos = contatosDoFalso(c);
        const contatos = achados.length <= 3 ? todos : todos.filter(bateContato);
        return { ...resto, bateu_em: bateu, ...(botoes.buscaSemContatos ? {} : { contatos }) };
      });
      // Como o MCP: `dica` só vem com a lista vazia.
      return { clientes, mais: false, ...(clientes.length === 0 ? { dica: "Tente uma palavra só do nome." } : {}) };
    },
    ver_cliente(args) {
      const achado = clienteDoFalso(args.cliente_id);
      if (achado === undefined) return erroDaFerramenta(`${NAO_ENCONTRADO} Ache o id com \`buscar_clientes\`.`);
      return { ...achado, dono: { id: 77, nome: "CANARIO Vendedor" }, secundarios: [], contatos: [], atendimentos: [], propostas: [], compromissos: [], link: `${origem}/clientes/${String(achado.id)}` };
    },
    /** Como a doc: sem `status`, só Pendente e Em Andamento; `desde` é o dia de Brasília de `data`; `id` decrescente. */
    meus_atendimentos(args) {
      const limite = typeof args.limite === "number" ? args.limite : 20;
      const antes = typeof args.antes === "number" ? args.antes : Number.POSITIVE_INFINITY;
      const desde = typeof args.desde === "string" ? args.desde : null;
      // Status que a doc não tem passa sem filtro: é como um teste faz o CRM mandar um valor fora dos quatro.
      const fechados = ["Concluído", "Cancelado"];
      const atendimentos = [...dados().atendimentos]
        .sort((a, b) => Number(b.id) - Number(a.id))
        .filter(
          (a) =>
            Number(a.id) < antes &&
            (args.status === undefined ? !fechados.includes(String(a.status)) : a.status === args.status) &&
            (desde === null || diaEm(new Date(String(a.data))) >= desde),
        );
      return fatiar("atendimentos", atendimentos, limite);
    },
  };

  /** O resultado de um `tools/call`, ou a resposta HTTP inteira quando o falso responde fora do JSON-RPC. */
  async function chamarFerramenta(params: { name?: unknown; arguments?: unknown }): Promise<unknown> {
    const nome = String(params.name);
    const argumentos = (params.arguments ?? {}) as Record<string, unknown>;
    chamadasDeFerramenta.push({ nome, argumentos });
    botoes.aoChamar?.(nome);
    if (botoes.segurar !== null) await botoes.segurar;
    if (botoes.ferramentasRecusamToken.has(nome)) return new Response(null, { status: 401 });
    const passou = chamadasDeFerramenta.length > botoes.chamadasAntesDoLimite;
    if (botoes.limiteHttpS !== null && passou) return new Response(null, { status: 429, headers: { "retry-after": String(botoes.limiteHttpS) } });
    if (botoes.limiteNaFerramentaS !== null && passou) {
      return erroDaFerramenta(`O CRM limitou as chamadas e recusou este pedido sem executá-lo. Espere ${botoes.limiteNaFerramentaS} segundos antes de tentar de novo.`);
    }
    if (botoes.semUsuario) return erroDaFerramenta("Sessão sem usuário do CRM. Reconecte o conector.");
    if (botoes.ferramentasForaDoAr.has(nome)) return erroDaFerramenta("O CRM está indisponível agora. Tente de novo em alguns segundos.");
    const comErro = botoes.ferramentasComErro.get(nome);
    if (comErro !== undefined) return erroDaFerramenta(comErro);
    const tool = FERRAMENTAS_FALSAS[nome] ?? ESCRITAS_FALSAS[nome];
    if (tool === undefined) return erroDaFerramenta(`Unknown tool: ${nome}`);
    if (botoes.ferramentasMalformadas.has(nome)) {
      const naoELista = "não é lista";
      return resultadoDaFerramenta({ compromissos: naoELista, propostas: naoELista, clientes: naoELista, atendimentos: naoELista, id: "não é número" });
    }
    if (botoes.respostasCruas.has(nome)) return resultadoDaFerramenta(botoes.respostasCruas.get(nome));
    const resposta = tool(argumentos);
    if (typeof resposta === "object" && resposta !== null && "isError" in resposta) return resposta;
    if (Object.hasOwn(ESCRITAS_FALSAS, nome) && botoes.perderRespostasDaEscrita > 0) {
      botoes.perderRespostasDaEscrita -= 1;
      return new Response("bad gateway", { status: 502 });
    }
    return resultadoDaFerramenta(resposta);
  }

  async function mcp(pedido: Request): Promise<Response> {
    contagem.chamadasAoMcp += 1;
    const portador = /^Bearer (.+)$/.exec(pedido.headers.get("authorization") ?? "")?.[1] ?? "";
    const acesso = acessos.get(portador);
    if (botoes.mcpRecusa || acesso === undefined || acesso.expiraEm <= agora() || familiasRevogadas.has(acesso.familia)) {
      return new Response(null, { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${origem}/.well-known/oauth-protected-resource/mcp"` } });
    }
    const chamada = (await pedido.json()) as { id?: number; method?: string; params?: { name?: unknown; arguments?: unknown } };
    if (chamada.id === undefined) return new Response(null, { status: 202 });
    const daFerramenta = chamada.method === "tools/call" ? await chamarFerramenta(chamada.params ?? {}) : undefined;
    if (daFerramenta instanceof Response) return daFerramenta;
    if (chamada.method === "tools/call" && botoes.erroRpc !== null) return json({ jsonrpc: "2.0", id: chamada.id, error: { code: -32000, message: botoes.erroRpc } });
    const resultado =
      chamada.method === "initialize"
        ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "crm-falso", version: "1" } }
        : chamada.method === "tools/list"
          ? { tools: Array.from({ length: FERRAMENTAS }, (_, i) => ({ name: `ferramenta_${i + 1}`, inputSchema: { type: "object" } })) }
          : chamada.method === "tools/call"
            ? daFerramenta
            : null;
    const resposta =
      resultado === null
        ? { jsonrpc: "2.0", id: chamada.id, error: { code: -32601, message: "método desconhecido" } }
        : { jsonrpc: "2.0", id: chamada.id, result: resultado };
    if (!botoes.mcpEmSse) return json(resposta);
    return new Response(`event: message\ndata: ${JSON.stringify(resposta)}\n\n`, { headers: { "content-type": "text/event-stream" } });
  }

  async function atender(pedido: Request): Promise<Response> {
    const url = new URL(pedido.url);
    if (botoes.foraDoAr) return json({ error: "temporarily_unavailable" }, 503);
    const rota = `${pedido.method} ${url.pathname}`;
    switch (rota) {
      case "GET /.well-known/oauth-protected-resource/mcp":
        return json({ resource: recurso, authorization_servers: [origem], scopes_supported: [], bearer_methods_supported: ["header"] });
      case "GET /.well-known/oauth-authorization-server":
        return json({
          issuer: origem,
          authorization_endpoint: `${origem}/oauth/authorize`,
          token_endpoint: `${origem}/oauth/token`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
          client_id_metadata_document_supported: true,
          authorization_response_iss_parameter_supported: true,
          scopes_supported: [ESCOPO],
        });
      case "GET /cimd/cliente-oauth.json":
        return new Response(documentoCimd(), { headers: { "content-type": "application/json" } });
      case "GET /oauth/authorize":
        return authorize(pedido, url);
      case "POST /oauth/token":
        return token(pedido);
      case "POST /mcp":
        return mcp(pedido);
      default:
        return json({ error: "not_found" }, 404);
    }
  }

  return {
    origem,
    recurso: new URL(recurso),
    clientId: new URL(clientId),
    botoes,
    get dados() {
      return dados();
    },
    dia,
    async autorizar(urlDeAutorizacao) {
      const resposta = await fetch(urlDeAutorizacao, { redirect: "manual", headers: { cookie: "sessao=vendedor" } });
      const destino = resposta.headers.get("location");
      if (resposta.status !== 303 || destino === null) throw new Error(`o CRM falso recusou a autorização: HTTP ${resposta.status}`);
      const retorno = new URL(destino);
      if (retorno.hostname !== "127.0.0.1" || retorno.pathname !== "/oauth/crm/retorno") {
        throw new Error(`retorno fora do loopback: ${retorno.origin}${retorno.pathname}`);
      }
      return retorno.searchParams;
    },
    emitirAcesso: () => {
      const acesso = opaco("access");
      acessos.set(acesso, { familia: randomBytes(8).toString("hex"), expiraEm: agora() + botoes.vidaDoAccessS * 1000 });
      return acesso;
    },
    revogarConexoes() {
      for (const refresh of refreshes.values()) {
        familiasRevogadas.add(refresh.familia);
        refresh.revogado ??= "familia";
      }
    },
    registro: () => ({ ...contagem, chamadasDeFerramenta: [...chamadasDeFerramenta], clientesRecusados: [...clientesRecusados], segredos: [...segredos] }),
    parar: () => servidor.stop(true),
  };
}

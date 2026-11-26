/**
 * Servidor de desenvolvimento do painel: serve a página e um SSE com estados de mentira.
 * `bun nucleo/painel/dev/servidor.ts [porta]` e abra `http://localhost:<porta>/?cena=<nome>`.
 * `/cenas` lista os nomes. `&falha=1` faz toda ação responder com erro, para ver o erro no cartão.
 * `&tarefas=<fixture>` escolhe as tarefas (`vazio`, `atrasadas`, `agente`, `conflito`); o padrão é `atrasadas`.
 * Cada fixture guarda o que o painel muda até o servidor parar.
 * `&crm=<fixture>` escolhe o que a sincronização teria lido (`/cenas` lista); `&sinc=lento` ou
 * `&sinc=parcial` mudam a rodada do botão Sincronizar. Os passos dela chegam pelo SSE.
 *
 * O WhatsApp responde às ações pela máquina de verdade, sobre o estado da cena: `conectar` e `reparear` mostram
 * "preparando" e, depois de um instante, um QR novo ou um código. Por isso `tudo-desconectado` mostra o QR
 * aparecer sozinho ao abrir Conexões; com `&falha=1` o cartão fica no quadro vazio.
 * O e-mail responde às rotas de verdade sobre um estado em memória por cena, empurrado pelo SSE.
 * O teste do login leva 3 s e passa, menos com a senha `errada`. `&teste=lento` deixa o teste
 * rodando até alguém cancelar. A gaveta abre pelo hash: `#/conexoes/email/nova`,
 * `#/conexoes/email/nova/gmail` ou `#/conexoes/email/<id da conta>` (`/cenas` lista exemplos).
 * Os ignorados pelo agente abrem em `#/meu-dia/ignorados`, com `&crm=ignorados` (`/cenas` lista exemplos).
 * `&conversas=cheio` traz uma conversa de cada tipo em Responder e uma em Esperando cliente; `&conversas=vazio`,
 * a leitura sem nenhuma. Escolher o cliente, ignorar, criar tarefa e abrir a mensagem em quarentena respondem
 * às rotas de verdade, sobre as conversas de mentira de `conversas.ts`.
 */
import {
  TIPOS_DE_IGNORADO,
  SEM_CONVERSAS,
  diaEm,
  falha,
  instante,
  lerTelefone,
  montarEstadoPainel,
  ok,
  saida,
  statusHttp,
  transicionarWhatsapp,
  verEmail,
  type ContaEmailComEstado,
  type EntradaConectar,
  type EstadoDoEmail,
  type EstadoWhatsapp,
  type EventoWhatsapp,
  type Instante,
  type EstadoPainel,
  type IdContaEmail,
  type RetratoDosConectores,
  type Resultado,
} from "../../dominio";
import type { ResultadoDaFonte } from "../../conectores";
import painel from "../index.html";
import { CENA_PADRAO, GAVETAS_DE_EXEMPLO, MEU_DIA_DE_EXEMPLO, NOMES_DAS_CENAS, montarCena, qrDaRodada } from "./cenas";
import * as emailDev from "./email";
import { FIXTURES_DE_CONVERSAS, criarConversasDeMentira, type ConversasDeMentira } from "./conversas";
import { FIXTURES_DO_CRM, criarCrmDeMentira, type CrmDeMentira } from "./crm";
import { FIXTURES_DE_TAREFAS, criarLoja, type FixtureDeTarefas, type Loja } from "./tarefas";

const porta = Number(process.argv[2] ?? 47910);
const SEM_CONEXAO = "sem-conexao";

/** O EventSource não leva a query da página, então a cena vem do Referer, que o navegador manda na mesma origem. */
function parametrosDaPagina(req: Request): URLSearchParams {
  const referer = req.headers.get("referer");
  return referer === null ? new URLSearchParams() : new URL(referer).searchParams;
}

function eventoDeEstado(estado: EstadoPainel): string {
  return `event: estado\ndata: ${JSON.stringify(estado)}\n\n`;
}

/** Na cena do QR, um QR novo chega a cada 20 s, como o wacli faz. */
function comQrNovo(estado: EstadoPainel, rodada: number): EstadoPainel {
  const whatsapp = estado.conectores.whatsapp;
  if (whatsapp.estado.fase !== "pareando" || whatsapp.estado.meio.tipo !== "qr") return estado;
  const meio = { ...whatsapp.estado.meio, qr: qrDaRodada(rodada), emitidoEm: instante(new Date()) };
  return { ...estado, conectores: { ...estado.conectores, whatsapp: { ...whatsapp, estado: { ...whatsapp.estado, meio } } } };
}

const lojas = new Map<FixtureDeTarefas, Loja>();

function lojaDoPedido(req: Request): Loja {
  const pedida = parametrosDaPagina(req).get("tarefas");
  const fixture = FIXTURES_DE_TAREFAS.find((nome) => nome === pedida) ?? "atrasadas";
  let loja = lojas.get(fixture);
  if (loja === undefined) {
    loja = criarLoja(fixture);
    lojas.set(fixture, loja);
  }
  return loja;
}

/** O que o painel mudou na cena até agora. Cada página que abre o mesmo endereço vê o mesmo palco. */
interface Palco {
  retrato: RetratoDosConectores;
  readonly assinantes: Set<() => void>;
  /** Eventos crus do SSE que não são o retrato, como os passos da sincronização. */
  readonly ouvintes: Set<(texto: string) => void>;
  readonly crm: CrmDeMentira;
  readonly conversas: ConversasDeMentira;
}

const palcos = new Map<string, Palco>();

function retratoDaCena(nome: string): RetratoDosConectores {
  const estado = montarCena(nome, new Date()) ?? montarCena(CENA_PADRAO, new Date())!;
  const { whatsapp, crm } = estado.conectores;
  return { whatsapp: whatsapp.estado, crm: crm.estado, email: { pulado: estado.email.pulado, contas: estado.email.contas.map(({ acoes: _acoes, ...conta }) => conta) } };
}

/** Um palco por endereço: `&teste=lento` e `&falha=1` não sujam a cena sem eles. */
function palcoDoPedido(req: Request): Palco {
  const parametros = parametrosDaPagina(req);
  const chave = parametros.toString();
  let palco = palcos.get(chave);
  if (palco === undefined) {
    const fixture = FIXTURES_DO_CRM.find((nome) => nome === parametros.get("crm")) ?? "sem-leitura";
    const conversas = FIXTURES_DE_CONVERSAS.find((nome) => nome === parametros.get("conversas")) ?? null;
    palco = { retrato: retratoDaCena(parametros.get("cena") ?? CENA_PADRAO), assinantes: new Set(), ouvintes: new Set(), crm: criarCrmDeMentira(fixture), conversas: criarConversasDeMentira(conversas) };
    palcos.set(chave, palco);
  }
  return palco;
}

function estadoDoPalco(palco: Palco): EstadoPainel {
  return montarEstadoPainel({ id: "painel-dev", versaoNucleo: "0.1.0", criadaEm: instante(new Date()) }, palco.retrato);
}

function mudarEmail(palco: Palco, email: EstadoDoEmail): void {
  palco.retrato = { ...palco.retrato, email };
  for (const avisar of palco.assinantes) avisar();
}

function mudarWhatsapp(palco: Palco, whatsapp: EstadoWhatsapp): void {
  palco.retrato = { ...palco.retrato, whatsapp };
  for (const avisar of palco.assinantes) avisar();
}

let qrsEmitidos = 100;

function pedidoDoWhatsapp(acao: string, corpo: unknown, atual: EstadoWhatsapp): EventoWhatsapp | null {
  const lido = (corpo ?? {}) as { meio?: unknown; telefone?: unknown; rodada?: unknown };
  const telefone = typeof lido.telefone === "string" ? lerTelefone(lido.telefone) : null;
  const entrada: EntradaConectar["whatsapp"] = lido.meio === "codigo" && telefone !== null ? { meio: "codigo", telefone } : { meio: "qr" };
  switch (acao) {
    case "conectar":
      return { tipo: "pedido_conectar", entrada };
    case "reparear": {
      const rodada = typeof lido.rodada === "string" ? (lido.rodada as Instante) : atual.fase === "pareando" ? atual.expiraEm : instante(new Date());
      return { tipo: "pedido_reparear", entrada, rodada };
    }
    case "cancelar":
    case "testar":
    case "desconectar":
    case "confirmar":
    case "recusar":
      return { tipo: `pedido_${acao}` };
    default:
      return null;
  }
}

/** Aplica o pedido na máquina de verdade. Do processo do wacli, só o QR ou o código chegam, um instante depois. */
function agirNoWhatsapp(palco: Palco, acao: string, corpo: unknown): void {
  const evento = pedidoDoWhatsapp(acao, corpo, palco.retrato.whatsapp);
  if (evento === null) return;
  const { estado, efeitos } = transicionarWhatsapp(palco.retrato.whatsapp, evento, instante(new Date()));
  if (estado !== palco.retrato.whatsapp) mudarWhatsapp(palco, estado);
  for (const efeito of efeitos) {
    if (efeito.tipo !== "iniciar_pareamento") continue;
    const emitido: EventoWhatsapp =
      efeito.entrada.meio === "qr" ? { tipo: "qr_emitido", qr: qrDaRodada((qrsEmitidos += 1)) } : { tipo: "codigo_emitido", codigo: "K7QD-2MXP", telefone: efeito.entrada.telefone };
    setTimeout(() => mudarWhatsapp(palco, transicionarWhatsapp(palco.retrato.whatsapp, emitido, instante(new Date())).estado), 800);
  }
}

const visaoDaConta = (conta: ContaEmailComEstado) => verEmail({ pulado: false, contas: [conta] }).contas[0]!;

/** Aplica um passo do e-mail de mentira e, quando um teste começou, conclui depois de 3 s. */
function aplicar<T>(req: Request, passo: emailDev.Passo<T>): Resultado<T> {
  const palco = palcoDoPedido(req);
  mudarEmail(palco, passo.email);
  const { testar } = passo;
  if (testar && parametrosDaPagina(req).get("teste") !== "lento") {
    setTimeout(() => mudarEmail(palco, emailDev.concluirTeste(palco.retrato.email, testar.id, testar.passa, instante(new Date()))), 3000);
  }
  return passo.resultado;
}

async function registrarPedido(req: Request, corpo: unknown): Promise<void> {
  const chaves = typeof corpo === "object" && corpo !== null ? Object.keys(corpo).join(", ") : "sem corpo";
  await Bun.write(Bun.stdout, `POST ${new URL(req.url).pathname} (${chaves})\n`);
}

function responder<T>(resultado: Resultado<T>): Response {
  return Response.json(saida(resultado), { status: resultado.ok ? 200 : statusHttp(resultado.erro) });
}

async function corpoJson(req: Request): Promise<unknown> {
  return req.json().catch(() => null);
}

const servidor = Bun.serve({
  port: porta,
  hostname: "127.0.0.1",
  development: true,
  routes: {
    "/": painel,
    "/cenas": () => Response.json({ cenas: [...NOMES_DAS_CENAS, SEM_CONEXAO], tarefas: FIXTURES_DE_TAREFAS, crm: FIXTURES_DO_CRM, conversas: FIXTURES_DE_CONVERSAS, sinc: ["lento", "parcial"], gavetas: GAVETAS_DE_EXEMPLO, meuDia: MEU_DIA_DE_EXEMPLO }),
    "/api/meu-dia": (req) => {
      const palco = palcoDoPedido(req);
      const agora = instante(new Date());
      return responder(ok(lojaDoPedido(req).meuDia(palco.retrato, palco.crm.leituras(agora), palco.crm.ignorados(diaEm(agora)), palco.conversas.dados(agora) ?? SEM_CONVERSAS)));
    },
    "/api/sincronizar": {
      POST: async (req) => {
        const palco = palcoDoPedido(req);
        const avisar = (andamento: unknown) => {
          for (const ouvinte of palco.ouvintes) ouvinte(`event: sincronizacao\ndata: ${JSON.stringify(andamento)}\n\n`);
        };
        const lerConversas = (): ResultadoDaFonte => {
          const whatsapp = palco.retrato.whatsapp;
          if (whatsapp.fase === "conectado") {
            const agora = instante(new Date());
            return { fonte: "conversas", situacao: "leu", itens: palco.conversas.sincronizar(agora), lidoEm: agora, cortado: false };
          }
          return { fonte: "conversas", situacao: "pulada", motivo: whatsapp.fase === "atencao" ? "whatsapp_em_atencao" : "whatsapp_desconectado" };
        };
        return responder(ok(await palco.crm.sincronizar(palco.retrato.crm, parametrosDaPagina(req).get("sinc"), avisar, lerConversas)));
      },
    },
    "/api/ignorados": {
      POST: async (req) => {
        const corpo = (await corpoJson(req)) as { tipo?: unknown; id?: unknown } | null;
        if (corpo?.tipo === "conversa" && typeof corpo.id === "string") return responder(palcoDoPedido(req).conversas.ignorar(corpo.id, instante(new Date())));
        const tipo = TIPOS_DE_IGNORADO.find((nome) => nome === corpo?.tipo);
        if (tipo === undefined || typeof corpo?.id !== "number") return responder(falha("entrada_invalida"));
        const ate = palcoDoPedido(req).crm.ignorar(tipo, corpo.id, instante(new Date()));
        return responder(ok({ tipo, id: corpo.id, ate, quem: "vendedor", motivo: null }));
      },
    },
    "/api/meu-dia/tarefas": {
      POST: async (req) => {
        const corpo = (await corpoJson(req)) as { tipo?: unknown; id?: unknown; tarefaId?: unknown } | null;
        if (corpo?.tipo === "conversa" && typeof corpo.id === "string" && typeof corpo.tarefaId === "string") {
          const conversa = palcoDoPedido(req).conversas.item(corpo.id, instante(new Date()));
          if (conversa === null) return responder(falha("nao_encontrado", "Esta conversa não está em Responder nem em Esperando cliente."));
          if (conversa.item.cliente === null) return responder(falha("vinculo_pendente"));
          const origem = { canal: "whatsapp", chave: corpo.id, ate: conversa.ultimaEm } as const;
          return responder(lojaDoPedido(req).criarDaConversa({ bloco: conversa.bloco, clienteId: conversa.item.cliente.id, nome: conversa.item.cliente.nome, conversa: origem }, corpo.tarefaId));
        }
        const tipo = TIPOS_DE_IGNORADO.find((nome) => nome === corpo?.tipo);
        if (tipo === undefined || typeof corpo?.id !== "number" || typeof corpo.tarefaId !== "string") return responder(falha("entrada_invalida"));
        const item = palcoDoPedido(req).crm.item(tipo, corpo.id, instante(new Date()));
        if (item === null) return responder(falha("nao_encontrado", "Este item não está na última leitura do CRM."));
        return responder(lojaDoPedido(req).criarDoCrm(item, corpo.tarefaId));
      },
    },
    "/api/ignorados/desfazer": {
      POST: async (req) => {
        const corpo = (await corpoJson(req)) as { tipo?: unknown; id?: unknown } | null;
        if (corpo?.tipo === "conversa" && typeof corpo.id === "string") return responder(ok({ tipo: "conversa", id: corpo.id, desfeito: palcoDoPedido(req).conversas.desfazerIgnorado(corpo.id) }));
        const tipo = TIPOS_DE_IGNORADO.find((nome) => nome === corpo?.tipo);
        if (tipo === undefined || typeof corpo?.id !== "number") return responder(falha("entrada_invalida"));
        return responder(ok({ tipo, id: corpo.id, desfeito: palcoDoPedido(req).crm.desfazer(tipo, corpo.id) }));
      },
    },
    "/api/vinculos/escolher": {
      POST: async (req) => {
        const corpo = await corpoJson(req);
        const chave = (corpo as { chave?: unknown } | null)?.chave;
        if (typeof chave !== "string") return responder(falha("entrada_invalida"));
        return responder(palcoDoPedido(req).conversas.escolher(chave, corpo, instante(new Date())));
      },
    },
    "/api/vinculos/desfazer": {
      POST: async (req) => {
        const chave = ((await corpoJson(req)) as { chave?: unknown } | null)?.chave;
        if (typeof chave !== "string") return responder(falha("entrada_invalida"));
        return responder(ok({ canal: "whatsapp", chave, desfeito: palcoDoPedido(req).conversas.desfazerVinculo(chave, instante(new Date())) }));
      },
    },
    "/api/whatsapp/quarentena": (req) => {
      const consulta = new URL(req.url).searchParams;
      const [conversa, id] = [consulta.get("conversa"), consulta.get("id")];
      if (conversa === null || id === null) return responder(falha("entrada_invalida"));
      return responder(palcoDoPedido(req).conversas.mensagem(conversa, id, instante(new Date())));
    },
    "/api/tarefas": {
      GET: (req) => {
        const estado = new URL(req.url).searchParams.get("estado");
        if (estado !== "aberta" && estado !== "concluida" && estado !== "descartada") return responder(falha("entrada_invalida"));
        return responder(ok(lojaDoPedido(req).listar(estado)));
      },
      POST: async (req) => responder(lojaDoPedido(req).criar(await corpoJson(req))),
    },
    "/api/tarefas/:id": (req) => responder(lojaDoPedido(req).ver(req.params.id)),
    "/api/tarefas/:id/:acao": {
      POST: async (req) => responder(lojaDoPedido(req).agir(req.params.id, req.params.acao, await corpoJson(req))),
    },
    "/api/eventos": (req, server) => {
      const cena = parametrosDaPagina(req).get("cena") ?? CENA_PADRAO;
      if (cena === SEM_CONEXAO) return new Response("fora do ar", { status: 503 });
      const palco = palcoDoPedido(req);
      server.timeout(req, 0);
      const codificar = new TextEncoder();
      let relogio: ReturnType<typeof setInterval> | undefined;
      let avisar: (() => void) | undefined;
      let ouvir: ((texto: string) => void) | undefined;
      const corpo = new ReadableStream<Uint8Array>({
        start(controle) {
          let rodada = 1;
          controle.enqueue(codificar.encode(eventoDeEstado(estadoDoPalco(palco))));
          avisar = () => controle.enqueue(codificar.encode(eventoDeEstado(comQrNovo(estadoDoPalco(palco), rodada))));
          palco.assinantes.add(avisar);
          ouvir = (texto) => controle.enqueue(codificar.encode(texto));
          palco.ouvintes.add(ouvir);
          relogio = setInterval(() => {
            rodada += 1;
            const estado = estadoDoPalco(palco);
            const novo = comQrNovo(estado, rodada);
            controle.enqueue(codificar.encode(novo === estado ? ": vivo\n\n" : eventoDeEstado(novo)));
          }, 20_000);
        },
        cancel() {
          clearInterval(relogio);
          if (avisar) palco.assinantes.delete(avisar);
          if (ouvir) palco.ouvintes.delete(ouvir);
        },
      });
      return new Response(corpo, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" } });
    },
    "/api/conectores/:id/:acao": {
      POST: async (req) => {
        const corpo = req.headers.get("content-type") === "application/json" ? await req.json() : null;
        const resumo = corpo === null ? "sem corpo" : `corpo com ${Object.keys(corpo).join(", ")}`;
        await Bun.write(Bun.stdout, `POST ${new URL(req.url).pathname} (${resumo})\n`);
        const resultado = parametrosDaPagina(req).get("falha") === "1" ? falha("acao_indisponivel") : ok(null);
        if (resultado.ok && req.params.id === "whatsapp") agirNoWhatsapp(palcoDoPedido(req), req.params.acao, corpo);
        const status = resultado.ok ? 200 : statusHttp(resultado.erro);
        return Response.json(saida(resultado), { status });
      },
    },
    "/api/email/contas": {
      POST: async (req) => {
        const corpo = await corpoJson(req);
        await registrarPedido(req, corpo);
        if (parametrosDaPagina(req).get("falha") === "1") return responder(falha("email_rotulo_repetido"));
        const resultado = aplicar(req, emailDev.adicionar(palcoDoPedido(req).retrato.email, corpo, instante(new Date())));
        return responder(resultado.ok ? ok(visaoDaConta(resultado.dados)) : resultado);
      },
    },
    "/api/email/contas/:id/:acao": {
      POST: async (req) => {
        const corpo = req.headers.get("content-type") === "application/json" ? await corpoJson(req) : undefined;
        await registrarPedido(req, corpo);
        if (parametrosDaPagina(req).get("falha") === "1") return responder(falha("acao_indisponivel"));
        const resultado = aplicar(req, emailDev.agir(palcoDoPedido(req).retrato.email, req.params.id, req.params.acao, corpo, instante(new Date())));
        if (!resultado.ok) return responder(resultado);
        const dados = resultado.dados as ContaEmailComEstado | { removida: IdContaEmail };
        return responder(ok("removida" in dados ? dados : visaoDaConta(dados)));
      },
    },
    "/api/email/pular": {
      POST: async (req) => {
        const resultado = aplicar(req, emailDev.pular(palcoDoPedido(req).retrato.email, await corpoJson(req)));
        return responder(resultado.ok ? ok(verEmail(resultado.dados)) : resultado);
      },
    },
    "/oauth/crm/iniciar": () =>
      new Response("<!doctype html><meta charset=utf-8><title>Login do CRM</title><p>Aqui abriria o login do CRM.</p>", {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
  },
});

await Bun.write(Bun.stdout, `Painel de desenvolvimento em ${servidor.url}?cena=${CENA_PADRAO}\n`);

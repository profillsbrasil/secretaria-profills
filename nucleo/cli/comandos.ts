import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { caminhosDosDados, fecharPastaDeDados, type Ambiente } from "../ambiente";
import { bancoEmUso } from "../banco";
import {
  ACOES,
  CONECTORES_UNICOS,
  FASES,
  JANELAS_DE_EMAIL,
  SEM_ATENDIMENTO_MAXIMO_DIAS,
  TIPOS_DE_IGNORADO,
  falha,
  fraseDoCadastroIncompleto,
  lerEnderecoEmail,
  lerIdDoEmail,
  lerIdDoItemDeEmail,
  lerTelefone,
  ok,
  type Acao,
  type ErroOperacao,
  type EstadoAgente,
  type EstadoPorConector,
  type Fase,
  type IdConector,
  type IdConectorUnico,
  type CodigoProblema,
  type Problema,
  type Relatorio,
  type Resultado,
  type TipoDeIgnorado,
  type VisaoDaContaEmail,
  type VisaoDoEmail,
} from "../dominio";
import type { EstadoDaAtualizacao, Impedimento, PassoDaAplicacao, VersaoPublicada } from "../atualizacao";
import { haAtualizacaoPendente, recuperar } from "../atualizador";
import type { ResultadoDaFonte, Sincronizacao } from "../conectores";
import { ESTADOS_DA_ESCRITA, TOOLS_DE_ESCRITA, type CartaoVisto, type ResumoDaEscrita, type ToolDeEscrita } from "../escritas";
import { LIMITE_DO_CORPO, VERSAO_DO_NUCLEO, lerPidDoServidor, lerSistema, type AtualizacaoNoDiagnostico, type ContaNoDiagnostico, type Diagnostico, type Info, type ItemIgnorado, type RespostaDaTarefa } from "../servidor";
import { ESTADOS_DA_TAREFA, NOMES_DOS_TITULOS_FIXOS, type IdadeDaFonte, type MeuDia, type Tarefa } from "../tarefas";
import { acharServidor, type ClienteDoServidor } from "./cliente";
import { destacar, encerrarPid, vivo } from "../processos";
import { abrirNoNavegador } from "./navegador";

const PRAZO_PADRAO_MS = 180_000;
const PARADA_MS = 15_000;
const LOCK_DO_BANCO_MS = 10_000;
/** A rodada do servidor tem prazo de 2 min; o CLI espera um pouco mais para receber o resultado dela. */
const PRAZO_DA_SINCRONIZACAO_MS = 150_000;
/** A leitura do CRM no servidor para em 60 s; o CLI espera um pouco mais para receber o relatório. */
const PRAZO_DO_RELATORIO_MS = 90_000;
const INTERVALO_DA_SONDA_MS = 100;
/** A leitura de um corpo abre uma conexão IMAP, e o servidor espera até 45 s por ela. */
const PRAZO_DA_LEITURA_DE_EMAIL_MS = 60_000;

export interface ContextoDoCli {
  /** Resolvido só quando o comando precisa; `ambiente.json` inválido vira erro do comando. */
  ambiente(): Ambiente;
  readonly raizDoRepo: string;
  /** Como `abrir` sobe o servidor e quanto espera por ele. O teste troca por um processo que não responde. */
  readonly subida: { readonly argv: readonly [string, ...string[]]; readonly prazoMs: number };
  /** O comando `servidor` segura o processo até esta promessa resolver, depois de imprimir. */
  manterVivo(ate: Promise<void>): void;
}

export interface Argumentos {
  readonly posicionais: readonly string[];
  readonly opcoes: Readonly<Record<string, string | true>>;
}

type Interpretado<A> = { readonly ok: true; readonly args: A } | { readonly ok: false; readonly uso: string };

export interface Comando<A = unknown, D = unknown> {
  readonly nome: string;
  readonly uso: string;
  readonly resumo: string;
  /** `false`: devolve `servidor_fora_do_ar` quando o servidor não responde. */
  readonly semServidor: boolean;
  /** Opções que levam valor, como `--ate 30s`. */
  readonly opcoesComValor?: readonly string[];
  /** Opções sem valor, como `--forcar`. Opção fora desta lista e de `opcoesComValor` é erro de uso. */
  readonly interruptores?: readonly string[];
  /** Repassa todo argumento como posicional, inclusive `--opcao`: são do programa de fora. */
  readonly repassar?: true;
  interpretar(args: Argumentos): Interpretado<A>;
  executar(args: A, ctx: ContextoDoCli, servidor: ClienteDoServidor | null): Promise<Resultado<D>>;
  /** Texto curto em pt-BR quando não há `--json`. */
  descrever(dados: D): string;
}

function definir<A, D>(comando: Comando<A, D>): Comando {
  return comando as unknown as Comando;
}

/** As opções que o comando aceita. `--json` sai da linha antes, e vale para todos. */
export function opcoesAceitas(comando: Comando): ReadonlySet<string> {
  return new Set([...(comando.opcoesComValor ?? []), ...(comando.interruptores ?? [])]);
}

const certo = <A>(args: A): Interpretado<A> => ({ ok: true, args });
const errado = (uso: string): Interpretado<never> => ({ ok: false, uso });
const semArgumentos = (nome: string) => (args: Argumentos) => (args.posicionais.length === 0 ? certo(null) : errado(`\`${nome}\` não leva argumentos.`));

function ehDaLista<T extends string>(lista: readonly T[], valor: string | undefined): valor is T {
  return valor !== undefined && (lista as readonly string[]).includes(valor);
}

const NOMES: { readonly [C in IdConector]: string } = { whatsapp: "WhatsApp", crm: "CRM", email: "E-mail" };

function linhaDoConector(id: IdConectorUnico, visao: { readonly estado: { readonly fase: string }; readonly acoes: readonly Acao[] }): string {
  return `${NOMES[id]}: ${visao.estado.fase}. Ações: ${visao.acoes.join(", ")}.`;
}

function linhaDaConta(conta: Pick<ContaNoDiagnostico, "rotulo" | "endereco" | "fase" | "acoes" | "janelaDias">): string {
  return `E-mail "${conta.rotulo}" (${conta.endereco}, ${conta.janelaDias} dias): ${conta.fase}. Ações: ${conta.acoes.join(", ")}.`;
}

/** E-mail é opcional: sem conta ou pulado, a linha só informa, sem pedir ação. */
function linhasDoEmail(email: { readonly pulado: boolean; readonly contas: readonly Parameters<typeof linhaDaConta>[0][] }): string[] {
  if (email.contas.length > 0) return email.contas.map(linhaDaConta);
  return [email.pulado ? "E-mail: pulado por enquanto. É opcional." : "E-mail: nenhuma conta. É opcional."];
}

function contasDoEstado(email: VisaoDoEmail) {
  return { pulado: email.pulado, contas: email.contas.map((conta) => ({ ...conta, endereco: conta.config.endereco, fase: conta.estado.fase })) };
}

function descreverEstado(estado: EstadoAgente): string {
  const linhas = [...CONECTORES_UNICOS.map((id) => linhaDoConector(id, estado.conectores[id])), ...linhasDoEmail(contasDoEstado(estado.email))];
  if (estado.onboardingCompleto) linhas.push("WhatsApp e CRM prontos: o Meu dia já serve.");
  return linhas.join("\n");
}

/** `30s`, `3m`, `500ms` ou só o número em segundos. */
export function lerDuracao(texto: string): number | null {
  const casamento = /^(\d+)(ms|s|m)?$/.exec(texto.trim());
  if (casamento === null) return null;
  const valor = Number(casamento[1]);
  return casamento[2] === "ms" ? valor : casamento[2] === "m" ? valor * 60_000 : valor * 1000;
}

async function esperarAte(condicao: () => Promise<boolean> | boolean, limiteMs: number): Promise<boolean> {
  const fim = Date.now() + limiteMs;
  for (;;) {
    if (await condicao()) return true;
    if (Date.now() >= fim) return false;
    await Bun.sleep(INTERVALO_DA_SONDA_MS);
  }
}

const envelopeDeErro = z.object({ ok: z.literal(false), erro: z.object({ codigo: z.string(), mensagem: z.string(), acao: z.string() }) });

/** O servidor roda com `--json`: quando sai no boot, a última linha da saída dele é o envelope do erro. */
function erroDoBoot(arquivoDeSaida: string): ErroOperacao | null {
  try {
    const ultima = readFileSync(arquivoDeSaida, "utf8").trimEnd().split("\n").at(-1) ?? "";
    return envelopeDeErro.parse(JSON.parse(ultima)).erro as ErroOperacao;
  } catch {
    return null;
  }
}

/**
 * Sobe o servidor fora deste processo e espera responder em `/api/info`. Nenhum fim deixa um
 * processo mudo segurando o banco: o filho que não respondeu no prazo é encerrado, e o que saiu
 * devolve o próprio erro. `subiu` só é verdadeiro quando quem responde é o filho que este comando subiu.
 */
async function subirServidor(ctx: ContextoDoCli, ambiente: Ambiente): Promise<Resultado<{ readonly cliente: ClienteDoServidor; readonly subiu: boolean }>> {
  fecharPastaDeDados(ambiente);
  const saida = join(caminhosDosDados(ambiente).logs, "servidor-saida.log");
  const filho = destacar(ctx.subida.argv, { saidaEm: saida, cwd: ctx.raizDoRepo });
  let achado: Resultado<ClienteDoServidor> = falha("servidor_fora_do_ar");
  let doBoot: ErroOperacao | null | undefined;
  await esperarAte(async () => {
    achado = await acharServidor(ambiente);
    if (achado.ok || filho.erro() !== null) return true;
    if (filho.saida() === null) return false;
    if (doBoot === undefined) doBoot = erroDoBoot(saida);
    // Quem perdeu a corrida de dois `abrir` espera o servidor do outro responder, até o prazo.
    return doBoot?.codigo !== "servidor_ja_rodando";
  }, ctx.subida.prazoMs);
  if (achado.ok) return ok({ cliente: achado.dados, subiu: achado.dados.arquivo.pid === filho.pid });
  if (filho.saida() !== null && doBoot === undefined) doBoot = erroDoBoot(saida);
  if (filho.saida() === null && filho.erro() === null) {
    const encerrado = filho.pid !== undefined && (await encerrarPid(filho.pid, { educado: false }));
    const fim = encerrado ? "foi encerrado" : `segue vivo (pid ${filho.pid}): rode \`bun secretaria parar --forcar\``;
    return falha("interno", `O servidor não respondeu em ${Math.round(ctx.subida.prazoMs / 1000)} s e ${fim}. A saída dele está em ${saida}.`);
  }
  // Alguém segura o banco desta pasta e não atende: é um servidor preso.
  if (doBoot?.codigo === "servidor_ja_rodando") return falha("servidor_preso");
  if (doBoot != null) return { ok: false, erro: doBoot };
  return falha("interno", `O servidor não subiu. A saída dele está em ${saida}.`);
}

/**
 * Encerra pelo pid o servidor que segura o banco sem responder. Só mata quando pid e hora de início
 * batem com o `servidor.pid`: outro processo pode ter recebido o pid de um servidor caído. Sem banco
 * preso, não mata ninguém: só limpa os arquivos velhos.
 */
async function forcarParada(ambiente: Ambiente): Promise<Resultado<{ parado: true; forcado: boolean }>> {
  const caminhos = caminhosDosDados(ambiente);
  if (bancoEmUso(caminhos.banco)) {
    const anotado = lerPidDoServidor(caminhos.pid);
    if (anotado.tipo !== "servidor") {
      const qual = anotado.tipo === "nenhum" ? "nenhum processo anotado" : `o pid ${anotado.pid}, que não confirmei ser o servidor`;
      return falha("banco_preso_por_outro", `O banco está em uso e o \`servidor.pid\` aponta ${qual}.`);
    }
    if (!(await encerrarPid(anotado.pid, { educado: false }))) {
      return falha("interno", `Não consegui encerrar o servidor (pid ${anotado.pid}). Encerre esse processo pelo sistema e rode \`bun secretaria abrir\`.`);
    }
    rmSync(caminhos.pid, { force: true });
    rmSync(caminhos.servidor, { force: true });
    // O Windows solta o lock do banco depois que o processo morto some: `parado` só vale com o banco livre.
    if (!(await esperarAte(() => !bancoEmUso(caminhos.banco) && !bancoEmUso(caminhos.bancoDoVendedor), LOCK_DO_BANCO_MS))) {
      return falha("banco_preso_por_outro", `O servidor (pid ${anotado.pid}) foi encerrado, e o banco seguiu em uso por ${LOCK_DO_BANCO_MS / 1000} s.`);
    }
    return ok({ parado: true, forcado: true });
  }
  rmSync(caminhos.pid, { force: true });
  rmSync(caminhos.servidor, { force: true });
  return ok({ parado: true, forcado: false });
}

interface AtualizacaoDesfeita {
  readonly de: string | null;
  readonly para: string | null;
}

/**
 * Uma atualização que morreu no meio deixa a pasta entre duas versões. Antes de subir o servidor,
 * `abrir` termina a volta: o servidor que sobe depois é o da versão antiga.
 */
async function terminarAtualizacaoInterrompida(
  ctx: ContextoDoCli,
  ambiente: Ambiente,
  servidor: Resultado<ClienteDoServidor>,
): Promise<Resultado<AtualizacaoDesfeita | null>> {
  if (!haAtualizacaoPendente(ctx.raizDoRepo)) return ok(null);
  let versaoNoAr: string | null = null;
  if (servidor.ok) {
    const info = await servidor.dados.pedir<Info>("GET", "/api/info");
    if (!info.ok) return ok(null);
    versaoNoAr = info.dados.versaoNucleo;
  }
  const volta = await recuperar({ raizDoRepo: ctx.raizDoRepo, dirDados: ambiente.dirDados, versaoNoAr });
  if (volta.tipo === "em_andamento") return falha("atualizacao_em_andamento");
  if (volta.tipo === "banco_em_uso") return falha("servidor_preso", "Uma atualização parou no meio, e um processo ainda segura o banco da Secretária.");
  if (volta.tipo === "processo_preso") {
    const oQue = volta.papel === "instalar" ? "que instalava a versão nova" : "do servidor da versão nova";
    return falha("banco_preso_por_outro", `Uma atualização parou no meio, e o processo ${oQue} (pid ${volta.pid}) não encerrou. A pasta e o banco ficaram como estavam.`);
  }
  if (volta.tipo === "servidor_no_meio") return falha("servidor_preso", `Uma atualização parou no meio, e um servidor da versão ${volta.versaoNoAr} está no ar sobre a pasta.`);
  if (volta.tipo === "falhou") return falha("interno", `Uma atualização parou no meio e não deu para voltar à versão anterior: ${volta.detalhe}`);
  return ok(volta.tipo === "desfeita" ? { de: volta.de, para: volta.para } : null);
}

/**
 * O link com bilhete vai só para o navegador. Sem navegador, sai só a origem: quem lê a saída do CLI não entra no painel.
 * `atualizacaoDesfeita` só vem quando este `abrir` desfez uma atualização que tinha parado no meio.
 */
type DadosDoAbrir = ({ readonly navegador: true; readonly subiu: boolean } | { readonly navegador: false; readonly subiu: boolean; readonly endereco: string }) & {
  readonly atualizacaoDesfeita?: AtualizacaoDesfeita;
};

/** O alvo da espera: um conector único, ou uma conta de e-mail pelo rótulo. */
type Alvo = { readonly tipo: "conector"; readonly id: IdConectorUnico } | { readonly tipo: "email"; readonly rotulo: string };

interface Espera {
  readonly alvo: Alvo;
  readonly fase: Fase;
  readonly prazoMs: number;
}

function acharConta(email: VisaoDoEmail, rotulo: string): VisaoDaContaEmail | null {
  return email.contas.find((conta) => conta.rotulo.toLowerCase() === rotulo.toLowerCase()) ?? null;
}

function nomeDoAlvo(alvo: Alvo): string {
  return alvo.tipo === "conector" ? NOMES[alvo.id] : `e-mail "${alvo.rotulo}"`;
}

function falhaDoProblema(problema: Pick<Problema<IdConector>, "detalhe"> & { readonly codigo: CodigoProblema }): Resultado<never> {
  const resultado = falha(problema.codigo);
  if (!resultado.ok && problema.detalhe !== undefined) {
    // O servidor já entrega o detalhe citado como dado (`verComoAgente`).
    return { ok: false, erro: { ...resultado.erro, mensagem: `${resultado.erro.mensagem} ${problema.detalhe}` } };
  }
  return resultado;
}

async function esperar(servidor: ClienteDoServidor, { alvo, fase, prazoMs }: Espera): Promise<Resultado<EstadoAgente>> {
  const sinal = AbortSignal.timeout(prazoMs);
  let ultima: string | null = null;
  for await (const estado of servidor.eventos(sinal)) {
    const conta = alvo.tipo === "email" ? acharConta(estado.email, alvo.rotulo) : null;
    if (alvo.tipo === "email" && conta === null) {
      return falha("nao_encontrado", `Não há conta de e-mail com o rótulo "${alvo.rotulo}". Veja os rótulos em \`bun secretaria status\`.`);
    }
    const atual = alvo.tipo === "conector" ? estado.conectores[alvo.id].estado : conta!.estado;
    ultima = atual.fase;
    if (atual.fase === fase) return ok(estado);
    if (atual.fase === "atencao") return falhaDoProblema(atual.problema);
  }
  if (!sinal.aborted) return falha("servidor_fora_do_ar");
  const onde = ultima === null ? "" : ` O ${nomeDoAlvo(alvo)} seguia em "${ultima}".`;
  return falha("prazo_esgotado", `O ${nomeDoAlvo(alvo)} não chegou a "${fase}" em ${Math.round(prazoMs / 1000)} s.${onde}`);
}

const USO_DE_ESPERAR = `Use \`esperar <conector>=<fase>\`, com conector em ${CONECTORES_UNICOS.join(", ")}, ou \`esperar email:<rótulo>=<fase>\` para uma conta de e-mail.`;

function interpretarEspera(args: Argumentos): Interpretado<Espera> {
  const [texto, ...resto] = args.posicionais;
  const corte = (texto ?? "").lastIndexOf("=");
  if (resto.length > 0 || corte <= 0) return errado(USO_DE_ESPERAR);
  const nome = (texto ?? "").slice(0, corte);
  const fase = (texto ?? "").slice(corte + 1);
  let alvo: Alvo;
  let fases: readonly string[];
  if (nome.startsWith("email:") && nome.length > "email:".length) {
    alvo = { tipo: "email", rotulo: nome.slice("email:".length) };
    fases = FASES.email;
  } else if (ehDaLista(CONECTORES_UNICOS, nome)) {
    alvo = { tipo: "conector", id: nome };
    fases = FASES[nome];
  } else return errado(USO_DE_ESPERAR);
  if (!fases.includes(fase)) return errado(`As fases de ${nomeDoAlvo(alvo)} são ${fases.join(", ")}.`);
  const ate = args.opcoes.ate;
  const prazoMs = ate === undefined ? PRAZO_PADRAO_MS : typeof ate === "string" ? lerDuracao(ate) : null;
  if (prazoMs === null || prazoMs <= 0) return errado("`--ate` leva uma duração, como 30s ou 3m.");
  return certo({ alvo, fase: fase as Fase, prazoMs });
}

const LIMITE_DE_MENSAGENS_DE_EMAIL = 200;

const SUBCOMANDOS_DE_EMAIL = ["testar", "cancelar", "rotulo", "janela", "pular", "retomar", "mensagens", "ler"] as const;
type SubcomandoDeEmail = (typeof SUBCOMANDOS_DE_EMAIL)[number];

const USO_DE_EMAIL = [
  "email testar <rótulo>",
  "email cancelar <rótulo>",
  "email rotulo <rótulo> <novo rótulo>",
  `email janela <rótulo> <${JANELAS_DE_EMAIL.join("|")}>`,
  "email pular",
  "email retomar",
  `email mensagens [--conta <rótulo>] [--de <endereço>] [--limite <1-${LIMITE_DE_MENSAGENS_DE_EMAIL}>]`,
  "email ler <rótulo> <id do e-mail>",
].join("\n  ");

/** Adicionar, conectar, desconectar e remover pedem a senha ou desligam a conta: são do vendedor. */
const EMAIL_SO_NO_PAINEL = ["adicionar", "conectar", "desconectar", "remover"];

type PedidoDeEmail =
  | { readonly sub: "pular" }
  | { readonly sub: "retomar" }
  | { readonly sub: "testar" | "cancelar"; readonly rotulo: string }
  | { readonly sub: "rotulo"; readonly rotulo: string; readonly novo: string }
  | { readonly sub: "janela"; readonly rotulo: string; readonly janelaDias: number }
  | { readonly sub: "mensagens"; readonly conta?: string; readonly de?: string; readonly limite?: number }
  | { readonly sub: "ler"; readonly rotulo: string; readonly id: string };

function interpretarMensagensDeEmail(resto: readonly string[], opcoes: Argumentos["opcoes"]): Interpretado<PedidoDeEmail> {
  if (resto.length > 0) return errado("`email mensagens` não leva argumentos, só `--conta`, `--de` e `--limite`.");
  const { conta, de, limite } = opcoes;
  if (conta === true || de === true || limite === true) return errado("`--conta`, `--de` e `--limite` precisam de um valor.");
  if (conta !== undefined && conta === "") return errado("`--conta` leva o rótulo da conta, de `bun secretaria status`.");
  const endereco = de === undefined ? null : lerEnderecoEmail(de.trim());
  if (de !== undefined && endereco === null) return errado("`--de` leva um endereço de e-mail, como compras@cliente.com.br.");
  if (limite !== undefined && !(/^\d{1,3}$/.test(limite) && Number(limite) >= 1 && Number(limite) <= LIMITE_DE_MENSAGENS_DE_EMAIL)) {
    return errado(`\`--limite\` leva um número inteiro de 1 a ${LIMITE_DE_MENSAGENS_DE_EMAIL}.`);
  }
  return certo({
    sub: "mensagens",
    ...(conta === undefined ? {} : { conta }),
    ...(endereco === null ? {} : { de: endereco.toLowerCase() }),
    ...(limite === undefined ? {} : { limite: Number(limite) }),
  });
}

function interpretarEmail(args: Argumentos): Interpretado<PedidoDeEmail> {
  const [sub, ...resto] = args.posicionais;
  if (sub === "mensagens") return interpretarMensagensDeEmail(resto, args.opcoes);
  if (Object.keys(args.opcoes).length > 0) return errado("`--conta`, `--de` e `--limite` só valem em `email mensagens`.");
  if (sub !== undefined && EMAIL_SO_NO_PAINEL.includes(sub)) {
    return errado(`\`email ${sub}\` é do vendedor, no painel: a senha e a decisão de desligar a conta não passam pelo agente. Rode \`bun secretaria abrir\`.`);
  }
  if (!ehDaLista<SubcomandoDeEmail>(SUBCOMANDOS_DE_EMAIL, sub)) return errado(`Use:\n  ${USO_DE_EMAIL}`);
  if (sub === "pular" || sub === "retomar") return resto.length === 0 ? certo({ sub }) : errado(`\`email ${sub}\` não leva argumentos.`);
  const [rotulo, ...valores] = resto;
  if (rotulo === undefined || rotulo === "") return errado(`Use \`email ${sub} <rótulo>\`, com o rótulo de \`bun secretaria status\`.`);
  if (sub === "ler") {
    return valores.length === 1 && lerIdDoEmail(valores[0] ?? "") !== null
      ? certo({ sub, rotulo, id: valores[0] ?? "" })
      : errado("Use `email ler <rótulo> <id do e-mail>`, com o id de `email mensagens`, como entrada-1731500000-42.");
  }
  if (sub === "testar" || sub === "cancelar") return valores.length === 0 ? certo({ sub, rotulo }) : errado(`\`email ${sub}\` leva só o rótulo.`);
  if (sub === "rotulo") return valores.length > 0 ? certo({ sub, rotulo, novo: valores.join(" ") }) : errado("Use `email rotulo <rótulo> <novo rótulo>`.");
  const dias = Number(valores[0]);
  if (valores.length !== 1 || !(JANELAS_DE_EMAIL as readonly number[]).includes(dias)) return errado(`Use \`email janela <rótulo> <${JANELAS_DE_EMAIL.join("|")}>\`.`);
  return certo({ sub, rotulo, janelaDias: dias });
}

async function executarEmail(pedido: PedidoDeEmail, servidor: ClienteDoServidor): Promise<Resultado<unknown>> {
  if (pedido.sub === "pular" || pedido.sub === "retomar") return servidor.pedir("POST", "/api/email/pular", { pulado: pedido.sub === "pular" });
  const rotulo = pedido.sub === "mensagens" ? pedido.conta : pedido.rotulo;
  let conta: VisaoDaContaEmail | null = null;
  if (rotulo !== undefined) {
    const estado = await servidor.pedir<EstadoAgente>("GET", "/api/estado");
    if (!estado.ok) return estado;
    conta = acharConta(estado.dados.email, rotulo);
    if (conta === null) {
      const rotulos = estado.dados.email.contas.map((c) => `"${c.rotulo}"`).join(", ") || "nenhuma";
      return falha("nao_encontrado", `Não há conta de e-mail com o rótulo "${rotulo}". Contas: ${rotulos}.`);
    }
  }
  if (pedido.sub === "mensagens") {
    const consulta = new URLSearchParams();
    if (conta !== null) consulta.set("conta", conta.id);
    if (pedido.de !== undefined) consulta.set("de", pedido.de);
    if (pedido.limite !== undefined) consulta.set("limite", String(pedido.limite));
    const texto = consulta.toString();
    return servidor.pedir("GET", `/api/email/mensagens${texto === "" ? "" : `?${texto}`}`);
  }
  if (conta === null) return falha("interno");
  if (pedido.sub === "ler") return servidor.pedir("POST", "/api/email/ler", { conta: conta.id, id: pedido.id }, PRAZO_DA_LEITURA_DE_EMAIL_MS);
  const caminho = `/api/email/contas/${encodeURIComponent(conta.id)}`;
  if (pedido.sub === "rotulo") return servidor.pedir("POST", `${caminho}/mudar`, { rotulo: pedido.novo });
  if (pedido.sub === "janela") return servidor.pedir("POST", `${caminho}/mudar`, { janelaDias: pedido.janelaDias });
  return servidor.pedir("POST", `${caminho}/${pedido.sub}`);
}

function descreverEmail(dados: unknown): string {
  // A leitura de e-mail é dado para o agente, como a do `wa`: sai como o servidor a mandou.
  if (typeof dados === "object" && dados !== null && ("mensagens" in dados || "quarentena" in dados || "texto" in dados)) return JSON.stringify(dados, null, 2);
  const visao = dados as Partial<VisaoDaContaEmail & VisaoDoEmail>;
  if (Array.isArray(visao.contas) && typeof visao.pulado === "boolean") return linhasDoEmail(contasDoEstado(visao as VisaoDoEmail)).join("\n");
  const conta = dados as VisaoDaContaEmail;
  return linhaDaConta({ ...conta, endereco: conta.config.endereco, fase: conta.estado.fase });
}

/**
 * Cada subcomando de `tarefa` vira um pedido HTTP. O corpo vai cru: quem valida é a borda do servidor.
 * `idDaCriacao` é o id que `criar` mandou, para o agente repetir o comando sem criar outra tarefa.
 */
type PedidoDeTarefa =
  | { readonly metodo: "GET"; readonly caminho: string }
  | { readonly metodo: "POST"; readonly caminho: string; readonly corpo: Record<string, unknown>; readonly idDaCriacao?: string };

/** Erros em que o pedido pode ter chegado ao servidor sem a resposta voltar. */
const SEM_RESPOSTA: readonly string[] = ["servidor_fora_do_ar", "interno"];

const SUBCOMANDOS_DE_TAREFA = ["criar", "listar", "ver", "concluir", "adiar", "descartar", "anotar"] as const;

const USO_DE_TAREFA = [
  `tarefa criar <${NOMES_DOS_TITULOS_FIXOS.join("|")}> [--vence AAAA-MM-DD] [--cliente-id <id no CRM>] [--proposta <código>] [--nota <texto>] [--id <uuid>]`,
  "tarefa listar [--estado aberta|concluida|descartada]",
  "tarefa ver <id>",
  "tarefa concluir <id> --versao <n> [--nota <texto>] [--proximo <próximo passo> [--vence AAAA-MM-DD]]",
  "tarefa adiar <id> --versao <n> --para AAAA-MM-DD [--nota <texto>]",
  "tarefa descartar <id> --versao <n> [--nota <texto>]",
  "tarefa anotar <id> <texto> [--proximo <próximo passo>]",
].join("\n  ");

/** Opção de texto de `tarefa` para o campo do corpo. `true` é a opção sem valor: erro de uso. */
const CAMPOS: Readonly<Record<string, string>> = {
  vence: "venceEm",
  "cliente-id": "clienteId",
  proposta: "propostaCodigo",
  nota: "nota",
  proximo: "proximoPasso",
  para: "para",
  id: "id",
};

const OPCOES_DE_TAREFA: { readonly [S in (typeof SUBCOMANDOS_DE_TAREFA)[number]]: readonly string[] } = {
  criar: ["vence", "cliente-id", "proposta", "nota", "id"],
  listar: ["estado"],
  ver: [],
  concluir: ["versao", "nota", "proximo", "vence"],
  adiar: ["versao", "para", "nota"],
  descartar: ["versao", "nota"],
  anotar: ["proximo"],
};

const SEM_NOME_DO_CLIENTE =
  "`tarefa criar` não aceita --cliente. O nome do cliente vem do CRM: passe `--cliente-id <id no CRM>`. Texto livre vai em `--nota`.";

function interpretarTarefa(args: Argumentos): Interpretado<PedidoDeTarefa> {
  const [sub, ...resto] = args.posicionais;
  if (sub === "reabrir") return errado("Reabrir tarefa concluída ou descartada é do vendedor, no painel.");
  if (!ehDaLista(SUBCOMANDOS_DE_TAREFA, sub)) return errado(`Use:\n  ${USO_DE_TAREFA}`);
  const aceitas = OPCOES_DE_TAREFA[sub];
  if (sub === "criar" && args.opcoes.cliente !== undefined) return errado(SEM_NOME_DO_CLIENTE);
  const sobrando = Object.keys(args.opcoes).find((opcao) => !aceitas.includes(opcao));
  if (sobrando !== undefined) return errado(`\`tarefa ${sub}\` não aceita --${sobrando}.`);
  const corpo: Record<string, unknown> = {};
  for (const opcao of aceitas) {
    const valor = args.opcoes[opcao];
    if (valor === undefined || opcao === "estado" || opcao === "versao") continue;
    if (valor === true) return errado(`\`--${opcao}\` precisa de um valor.`);
    corpo[CAMPOS[opcao] ?? opcao] = valor;
  }
  if (aceitas.includes("versao")) {
    const versao = args.opcoes.versao;
    if (typeof versao !== "string" || !/^[1-9]\d*$/.test(versao)) {
      return errado(`\`tarefa ${sub}\` precisa de \`--versao <n>\`, a versão que você leu em \`tarefa ver\`.`);
    }
    corpo.versao = Number(versao);
  }
  if (sub === "listar") {
    const estado = args.opcoes.estado;
    if (resto.length > 0) return errado("`tarefa listar` não leva argumentos.");
    if (estado === undefined) return certo({ metodo: "GET", caminho: "/api/tarefas" });
    if (!ehDaLista(ESTADOS_DA_TAREFA, typeof estado === "string" ? estado : undefined)) {
      return errado(`\`--estado\` é ${ESTADOS_DA_TAREFA.join(", ")}.`);
    }
    return certo({ metodo: "GET", caminho: `/api/tarefas?estado=${estado}` });
  }
  if (sub === "criar") {
    const [tituloFixo, ...sobra] = resto;
    if (!ehDaLista(NOMES_DOS_TITULOS_FIXOS, tituloFixo) || sobra.length > 0) {
      return errado(`Use \`tarefa criar <${NOMES_DOS_TITULOS_FIXOS.join("|")}>\`. O título sai dessa lista e do nome que o CRM dá ao \`--cliente-id\`; o texto livre vai em \`--nota\`.`);
    }
    const id = typeof corpo.id === "string" ? corpo.id : crypto.randomUUID();
    return certo({ metodo: "POST", caminho: "/api/tarefas", corpo: { ...corpo, tituloFixo, id }, idDaCriacao: id });
  }
  const [id, ...textos] = resto;
  if (id === undefined || id === "") return errado(`Use \`tarefa ${sub} <id>\`.`);
  const caminho = `/api/tarefas/${encodeURIComponent(id)}`;
  if (sub === "ver") return textos.length === 0 ? certo({ metodo: "GET", caminho }) : errado("`tarefa ver` leva só o id.");
  if (sub === "anotar") {
    if (textos.length === 0) return errado("Use `tarefa anotar <id> <texto>`.");
    return certo({ metodo: "POST", caminho: `${caminho}/anotar`, corpo: { texto: textos.join(" "), ...corpo } });
  }
  if (textos.length > 0) return errado(`\`tarefa ${sub}\` leva só o id; o texto vai em \`--nota\`.`);
  return certo({ metodo: "POST", caminho: `${caminho}/${sub}`, corpo });
}

function linhaDaTarefa(t: Tarefa): string {
  const prazo = t.venceEm ?? "sem data";
  const cliente = t.clienteNome === null ? "" : ` (${t.clienteNome})`;
  const doAgente = t.origem === "agente" ? " [agente]" : "";
  return `${t.id} v${t.versao} ${t.estado} ${prazo}: ${t.titulo}${cliente}${doAgente}`;
}

function descreverTarefas(dados: { readonly tarefas: readonly Tarefa[] } | RespostaDaTarefa): string {
  if ("tarefas" in dados) return dados.tarefas.length === 0 ? "Nenhuma tarefa." : dados.tarefas.map(linhaDaTarefa).join("\n");
  const linhas = [linhaDaTarefa(dados.tarefa)];
  for (const nota of dados.notas) {
    const proximo = nota.proximoPasso === null ? "" : ` Próximo passo: ${nota.proximoPasso}`;
    linhas.push(`  ${nota.criadaEm} ${nota.autor}: ${nota.texto}${proximo}`);
  }
  if (dados.seguinte !== null) linhas.push(`Seguinte: ${linhaDaTarefa(dados.seguinte)}`);
  return linhas.join("\n");
}

/** `escrita` propõe, lista, vê e retira. Aprovar, editar e descartar são do vendedor, no painel. */
type PedidoDeEscrita =
  | { readonly metodo: "GET"; readonly caminho: string }
  | { readonly metodo: "POST"; readonly caminho: string; readonly corpo?: Record<string, unknown>; readonly idDaProposta?: string };

const SUBCOMANDOS_DE_ESCRITA = ["propor", "listar", "ver", "retirar"] as const;

const USO_DE_ESCRITA = [
  `escrita propor <${TOOLS_DE_ESCRITA.join("|")}> --dados <arquivo.json> [--id <uuid>]`,
  `escrita listar [--estado ${ESTADOS_DA_ESCRITA.join("|")}]`,
  "escrita ver <id>",
  "escrita retirar <id>",
].join("\n  ");

const OPCOES_DE_ESCRITA: { readonly [S in (typeof SUBCOMANDOS_DE_ESCRITA)[number]]: readonly string[] } = {
  propor: ["dados", "id"],
  listar: ["estado"],
  ver: [],
  retirar: [],
};

const SO_O_VENDEDOR_DECIDE = "Aprovar, editar e descartar um cartão são do vendedor, no painel. Avise o vendedor de que o cartão espera por ele; você só propõe, lista, vê e retira o seu rascunho.";

/** O arquivo de `--dados`: o objeto `dados` da tool. Lido como o caminho veio, para valer igual em Linux, macOS e Windows. */
function lerArquivoDeDados(caminho: string): { readonly ok: true; readonly dados: Record<string, unknown> } | { readonly ok: false; readonly uso: string } {
  let texto: string;
  try {
    if (statSync(caminho).size > LIMITE_DO_CORPO) return { ok: false, uso: "O arquivo de `--dados` passa de 64 KiB." };
    texto = readFileSync(caminho, "utf8");
  } catch {
    return { ok: false, uso: "Não consegui ler o arquivo de `--dados`. Confira o caminho." };
  }
  let lido: unknown;
  try {
    // O PowerShell 5.1 grava UTF-8 com BOM, e o JSON.parse recusa o BOM.
    lido = JSON.parse(texto.replace(/^﻿/, ""));
  } catch {
    return { ok: false, uso: "O arquivo de `--dados` não é JSON." };
  }
  if (typeof lido !== "object" || lido === null || Array.isArray(lido)) return { ok: false, uso: "O arquivo de `--dados` precisa ter um objeto JSON, com os campos da tool." };
  return { ok: true, dados: lido as Record<string, unknown> };
}

function interpretarEscrita(args: Argumentos): Interpretado<PedidoDeEscrita> {
  const [sub, ...resto] = args.posicionais;
  if (sub === "aprovar" || sub === "editar" || sub === "descartar") return errado(SO_O_VENDEDOR_DECIDE);
  if (!ehDaLista(SUBCOMANDOS_DE_ESCRITA, sub)) return errado(`Use:\n  ${USO_DE_ESCRITA}`);
  const aceitas = OPCOES_DE_ESCRITA[sub];
  const sobrando = Object.keys(args.opcoes).find((opcao) => !aceitas.includes(opcao));
  if (sobrando !== undefined) return errado(`\`escrita ${sub}\` não aceita --${sobrando}.`);
  for (const opcao of aceitas) if (args.opcoes[opcao] === true) return errado(`\`--${opcao}\` precisa de um valor.`);
  if (sub === "listar") {
    const estado = args.opcoes.estado;
    if (resto.length > 0) return errado("`escrita listar` não leva argumentos.");
    if (estado === undefined) return certo({ metodo: "GET", caminho: "/api/escritas" });
    if (!ehDaLista(ESTADOS_DA_ESCRITA, typeof estado === "string" ? estado : undefined)) return errado(`\`--estado\` é ${ESTADOS_DA_ESCRITA.join(", ")}.`);
    return certo({ metodo: "GET", caminho: `/api/escritas?estado=${estado}` });
  }
  if (sub === "propor") {
    const [tool, ...sobra] = resto;
    if (!ehDaLista(TOOLS_DE_ESCRITA, tool) || sobra.length > 0) return errado(`Use \`escrita propor <${TOOLS_DE_ESCRITA.join("|")}> --dados <arquivo.json>\`.`);
    const caminho = args.opcoes.dados;
    if (typeof caminho !== "string" || caminho === "") return errado("`escrita propor` precisa de `--dados <arquivo.json>`, com os campos da tool.");
    const lido = lerArquivoDeDados(caminho);
    if (!lido.ok) return errado(lido.uso);
    const id = typeof args.opcoes.id === "string" ? args.opcoes.id : crypto.randomUUID();
    return certo({ metodo: "POST", caminho: "/api/escritas", corpo: { id, tool, dados: lido.dados }, idDaProposta: id });
  }
  const [id, ...sobra] = resto;
  if (id === undefined || id === "" || sobra.length > 0) return errado(`Use \`escrita ${sub} <id>\`.`);
  const caminho = `/api/escritas/${encodeURIComponent(id)}`;
  return sub === "ver" ? certo({ metodo: "GET", caminho }) : certo({ metodo: "POST", caminho: `${caminho}/retirar` });
}

const ROTULOS_DAS_TOOLS: { readonly [T in ToolDeEscrita]: string } = {
  registrar_atendimento: "Registrar atendimento",
  criar_compromisso: "Criar compromisso",
  criar_contato: "Criar contato",
};

/** O cartão numa linha, sem nenhum texto do payload: o texto em quarentena é do vendedor. */
function linhaDoCartao(c: ResumoDaEscrita): string {
  const cliente =
    c.cliente === null ? "sem cliente" : c.cliente.conferido ? `${c.cliente.nome}${c.cliente.cidade === null ? "" : ` (${c.cliente.cidade})`}` : `cliente ${c.cliente.id} por conferir`;
  const marcas = [
    ...(c.confiraOCliente ? ["confira o cliente"] : []),
    ...(c.confiraOTexto ? ["texto em quarentena: o vendedor o lê no painel"] : []),
    ...(c.erro === null ? [] : [`erro ${c.erro.codigo}`]),
    ...(c.recibo?.id == null ? [] : [`id no CRM ${c.recibo.id}`]),
  ];
  const estado = c.estado === "gravado" ? "gravado no CRM" : c.estado;
  return `${ROTULOS_DAS_TOOLS[c.tool]}, ${cliente}, ${estado}${marcas.length === 0 ? "" : ` (${marcas.join("; ")})`}, id ${c.id}`;
}

function descreverEscritas(dados: { readonly escritas: readonly ResumoDaEscrita[] } | CartaoVisto): string {
  if ("escritas" in dados) return dados.escritas.length === 0 ? "Nenhum cartão." : dados.escritas.map(linhaDoCartao).join("\n");
  const compromisso = dados.compromisso === null ? [] : [`Início ${dados.compromisso.inicio}, ${dados.compromisso.duracaoMin} min${dados.compromisso.fimAssumido ? " (fim assumido pelo CRM)" : ""}.`];
  const aprovar = dados.estado === "rascunho" ? ["Diga ao vendedor para aprovar este cartão no painel: aprovar, editar e descartar são dele."] : [];
  const oQueFazer = dados.erro !== null && "acao" in dados.erro ? [`O que fazer: ${dados.erro.acao}`] : [];
  return [linhaDoCartao(dados), ...compromisso, ...aprovar, ...oQueFazer].join("\n");
}

function linhasDasTravas(travas: Diagnostico["travas"]): string[] {
  const noLugar = travas.regras.length - travas.faltando;
  return [
    `Travas do agente: ${noLugar} de ${travas.regras.length} regras no lugar em ${travas.arquivo}${travas.lido ? "" : " (o arquivo não existe ou não é um JSON)"}. Servidores do CRM que a Secretária conhece: ${travas.servidoresConhecidos.join(", ")}.`,
    ...travas.regras.filter((regra) => !regra.presente).map((regra) => `Falta em ${regra.lista}: ${regra.regra}`),
    "Conector com outro nome e o Codex não têm trava no repo: o nome do conector tem de ser CRM Profills, e a configuração do Codex não foi verificada.",
  ];
}

function idadeDaFonte(fonte: IdadeDaFonte): string {
  const contas = fonte.fonte === "email" && fonte.total > 1 ? ` (${fonte.conectadas} de ${fonte.total} contas)` : "";
  if (fonte.idadeMin === null) return `${fonte.fonte} sem leitura${contas}`;
  return `${fonte.fonte} há ${fonte.idadeMin} min${contas}`;
}

/** O cabeçalho de um bloco do CRM: a contagem, ou por que veio vazio, e quando foi lido. */
function cabecalhoDoCrm(
  titulo: string,
  bloco: { readonly itens: readonly unknown[]; readonly lido_em: string | null; readonly motivo: string | null; readonly cortado: boolean; readonly fora_por_cadastro_incompleto: number },
): string {
  const lido = bloco.lido_em === null ? "" : `, lido em ${bloco.lido_em}`;
  const cortado = bloco.cortado ? ", lista cortada" : "";
  const fora = bloco.fora_por_cadastro_incompleto === 0 ? "" : `, ${bloco.fora_por_cadastro_incompleto} fora por cadastro incompleto no CRM`;
  if (bloco.motivo !== null && bloco.motivo !== "sem_itens") return `${titulo}: vazio (${bloco.motivo})${lido}.`;
  return `${titulo} (${bloco.itens.length}${lido}${cortado}${fora}):`;
}

const semEnviados = (rotulos: readonly string[]) =>
  rotulos.length === 0 ? "" : `; sem a pasta de enviados em ${rotulos.map((rotulo) => `"${rotulo}"`).join(", ")}: a Secretária não sabe o que o vendedor já respondeu por essa conta`;

/** O cabeçalho de um bloco de conversas: a contagem, ou por que veio vazio, o `lido_em` do WhatsApp e, com conta de e-mail, a leitura do e-mail. */
function cabecalhoDeConversas(titulo: string, bloco: { readonly itens: readonly unknown[]; readonly lido_em: string | null; readonly motivo: string | null; readonly cortado: boolean; readonly email: MeuDia["responder"]["email"] }): string {
  const { email } = bloco;
  const doEmail =
    email.contas === 0
      ? ""
      : `e-mail: ${email.contas_lidas} de ${email.contas} contas lidas${email.lido_em === null ? "" : `, lido em ${email.lido_em}`}${email.cortado ? ", lista cortada" : ""}${email.motivo === null ? "" : ` (${email.motivo})`}${semEnviados(email.contas_sem_enviados)}`;
  const lido = bloco.lido_em === null ? "" : `, lido em ${bloco.lido_em}`;
  const cortado = bloco.cortado ? ", lista cortada" : "";
  const emailNoFim = doEmail === "" ? "" : `; ${doEmail}`;
  const problemaDoWhatsapp = bloco.motivo !== null && bloco.motivo !== "sem_itens";
  if (problemaDoWhatsapp && bloco.itens.length === 0) return `${titulo}: vazio (${bloco.motivo})${lido}${emailNoFim}.`;
  return `${titulo} (${bloco.itens.length}${problemaDoWhatsapp ? `, WhatsApp: ${bloco.motivo}` : ""}${lido}${cortado}${emailNoFim}):`;
}

const comCidade = (cliente: { readonly nome: string; readonly cidade: string | null }) => `${cliente.nome}${cliente.cidade === null ? "" : ` (${cliente.cidade})`}`;

/**
 * Só o nome do cliente do CRM, o telefone ou o endereço e as contagens. Texto de mensagem nunca sai
 * daqui, e o assunto e o nome do remetente de e-mail ficam para o `--json`, já citados como dado.
 */
function linhasDasConversas(dia: MeuDia): string[] {
  const responder = dia.responder;
  const esperando = dia.esperando_cliente;
  const quarentena = (ids: readonly string[]) => (ids.length === 0 ? "" : `, em quarentena (ids ${ids.join(", ")}: o vendedor abre no painel)`);
  const deEmail = (c: { readonly conta: { readonly rotulo: string }; readonly endereco: string | null }) => `e-mail "${c.conta.rotulo}" ${c.endereco ?? "(endereço em quarentena)"}`;
  return [
    cabecalhoDeConversas("Responder", responder),
    ...responder.itens.map((c) => {
      if (c.canal === "email") {
        const contagem = `${c.novas} ${c.novas === 1 ? "e-mail novo" : "e-mails novos"}`;
        const fim = `desde ${c.desde}${quarentena(c.mensagens_em_quarentena)} [item ${c.id}]`;
        if (c.vinculo === "ambiguo") return `- ${deEmail(c)}: qual cliente? ${c.candidatos.length} candidatos (${c.motivo_da_duvida}), o vendedor escolhe no painel; ${contagem} ${fim}`;
        return `- ${deEmail(c)} ${comCidade(c.cliente)}: ${contagem} ${fim}`;
      }
      const contagem = `${c.novas}${c.mais_que_o_lido ? " ou mais" : ""} ${c.novas === 1 && !c.mais_que_o_lido ? "mensagem nova" : "mensagens novas"}`;
      const novas = c.tem_ilegiveis ? `${contagem}, e alguma que a Secretária não conseguiu ler (o vendedor confere no WhatsApp)` : contagem;
      if (c.vinculo === "ambiguo") {
        const nome = c.nome_no_whatsapp === null ? "" : ` ${c.nome_no_whatsapp}`;
        return `- ${c.telefone}${nome}: qual cliente? ${c.candidatos.length} candidatos (${c.motivo_da_duvida}), o vendedor escolhe no painel; ${novas} desde ${c.desde}${quarentena(c.mensagens_em_quarentena)}`;
      }
      return `- ${c.telefone} ${comCidade(c.cliente)}: ${novas} desde ${c.desde}${quarentena(c.mensagens_em_quarentena)}`;
    }),
    cabecalhoDeConversas("Esperando cliente", esperando),
    ...esperando.itens.map((c) => {
      const espera = `você falou por último em ${c.desde}, há ${c.dias_uteis} dias úteis`;
      const quem =
        c.vinculo === "ambiguo"
          ? `${c.canal === "email" ? "" : c.nome_no_whatsapp === null ? "" : ` ${c.nome_no_whatsapp}`}: qual cliente? ${c.candidatos.length} candidatos (${c.motivo_da_duvida}), o vendedor escolhe no painel;`
          : ` ${comCidade(c.cliente)}:`;
      return c.canal === "email"
        ? `- ${deEmail(c)}${quem} ${espera}${c.em_quarentena ? `, em quarentena (id ${c.ultimo_email}: o vendedor abre no painel)` : ""} [item ${c.id}]`
        : `- ${c.telefone}${quem} ${espera}`;
    }),
  ];
}

function descreverMeuDia(dia: MeuDia): string {
  const bloco = (titulo: string, tarefas: readonly Tarefa[]) => [`${titulo} (${tarefas.length}):`, ...tarefas.map((t) => `- ${linhaDaTarefa(t)}`)];
  const compromissos = dia.compromissos_de_hoje;
  const propostas = dia.propostas_abertas;
  const clientes = dia.clientes_sem_atendimento;
  return [
    `Hoje é ${dia.hoje}.`,
    ...bloco("Fazer hoje", dia.fazer_hoje),
    ...bloco("Sem data", dia.sem_data),
    `Aprovar (${dia.aprovar.length}):`,
    ...dia.aprovar.map((c) => `- ${linhaDoCartao(c)}`),
    cabecalhoDoCrm("Compromissos de hoje", compromissos),
    ...compromissos.itens.map((c) => `- ${c.inicio} ${c.titulo}${c.cliente === null ? "" : ` (${c.cliente.nome})`}`),
    cabecalhoDoCrm("Propostas enviadas sem retorno", propostas),
    ...propostas.itens.map(
      (p) => `- ${p.codigo} ${p.cliente.nome}: ${p.dias_desde_envio} dias${p.prazo_vencido ? ", prazo de retorno vencido" : `, prazo em ${p.prazo_retorno ?? "?"}`}${p.link === null ? "" : ` ${p.link}`}`,
    ),
    ...(propostas.itens.some((p) => p.prazo_vencido) ? [propostas.aviso] : []),
    cabecalhoDoCrm(`Clientes sem atendimento há ${clientes.sem_atendimento_ha_dias} dias ou mais`, clientes),
    ...clientes.itens.map((c) => `- ${c.nome}${c.cidade === null ? "" : ` (${c.cidade})`}: ${c.dias_sem_atendimento === null ? "nunca atendido" : `${c.dias_sem_atendimento} dias${c.ultimo_atendimento_aproximado ? " ou mais" : ""}`}`),
    ...linhasDasConversas(dia),
    ...(dia.nao_clientes.length === 0
      ? []
      : [`Números e endereços que o vendedor marcou como não cliente (${dia.nao_clientes.length}): ${dia.nao_clientes.map((n) => (n.canal === "email" ? (n.endereco ?? "(endereço em quarentena)") : n.telefone)).join(", ")}. Só ele desfaz, no painel; o nome da conversa vem em --json.`]),
    ...(dia.ignorados_pelo_agente.length === 0
      ? []
      : [
          `Ignorados por você a pedido do vendedor (${dia.ignorados_pelo_agente.length}):`,
          ...dia.ignorados_pelo_agente.map((i) => `- ${i.tipo === "conversa" && i.canal === "email" ? "conversa de e-mail" : i.tipo} ${i.id} ${i.codigo === null ? "" : `${i.codigo} `}${i.nome}, até ${i.ate}. Motivo: ${i.motivo}`),
        ]),
    `Fontes: ${dia.fontes.map(idadeDaFonte).join("; ")}.`,
  ].join("\n");
}

function linhaDaFonte(fonte: ResultadoDaFonte): string {
  switch (fonte.situacao) {
    case "leu": {
      const sem = fonte.semConsultaAoCrm;
      const consulta = sem === undefined ? "" : ` O CRM não foi consultado por número ou endereço novo (${sem.motivo}); valeram os vínculos que já existiam.${sem.erro?.esperaS === undefined ? "" : ` Espere ${sem.erro.esperaS} s.`}`;
      const fora = fraseDoCadastroIncompleto(fonte.foraPorCadastroIncompleto ?? 0);
      return `${fonte.fonte}: leu ${fonte.itens}${fonte.cortado ? ", lista cortada" : ""}.${fora === null ? "" : ` ${fora}`}${consulta}${linhasDasContas(fonte)}`;
    }
    case "falhou":
      return `${fonte.fonte}: falhou (${fonte.erro.codigo}). ${fonte.erro.acao}${linhasDasContas(fonte)}`;
    case "pulada":
      return `${fonte.fonte}: pulada (${fonte.motivo}).${fonte.erro?.esperaS === undefined ? "" : ` Espere ${fonte.erro.esperaS} s.`}${linhasDasContas(fonte)}`;
  }
}

/** Uma linha por conta de e-mail, pelo rótulo: o rótulo é do vendedor, e nenhuma linha leva texto de e-mail. */
function linhasDasContas(fonte: ResultadoDaFonte): string {
  return (fonte.contas ?? [])
    .map((conta) => {
      switch (conta.situacao) {
        case "leu":
          return `\n  conta "${conta.rotulo}": leu, ${conta.novos} novos${conta.cortado ? ", lista cortada" : ""}${conta.semEnviados ? ", sem pasta de enviados" : ""}.`;
        case "falhou":
          return `\n  conta "${conta.rotulo}": falhou (${conta.erro.codigo}). ${conta.erro.acao}`;
        case "pulada":
          return `\n  conta "${conta.rotulo}": pulada (${conta.motivo}).`;
      }
    })
    .join("");
}

function descreverSincronizacao(rodada: Sincronizacao): string {
  const quem = rodada.jaEmAndamento ? "Já havia uma sincronização rodando; este é o resultado dela." : "Sincronização feita.";
  return [quem, ...rodada.fontes.map(linhaDaFonte)].join("\n");
}

const DUAS_DATAS_OU_NENHUMA = "O relatório leva as duas datas, ou nenhuma: sem datas, é a semana, de segunda a hoje.";

const SEM_CRM_NO_RELATORIO: Readonly<Record<string, string>> = {
  crm_desconectado: "o CRM não está conectado.",
  crm_autorizando: "o login do CRM não terminou.",
  crm_app_nao_liberado: "a Profills ainda não liberou a Secretária no CRM.",
  crm_em_atencao: "o CRM pede atenção em Conexões.",
};

function linhaDaLeituraDoRelatorio({ atendimentos, contagens }: Relatorio): string[] {
  if (atendimentos.motivo !== null) {
    const motivo = atendimentos.motivo === "crm_falhou" ? descreverErroDoRelatorio(atendimentos.erro) : (SEM_CRM_NO_RELATORIO[atendimentos.motivo] ?? atendimentos.motivo);
    return [`Atendimentos no CRM: não li, ${motivo}`, "O relatório abaixo só tem a parte local, as tarefas concluídas."];
  }
  const porStatus = Object.entries(contagens.por_status ?? {}).map(([status, quantos]) => `${status} ${quantos}`);
  const total = contagens.atendimentos ?? 0;
  const clientes = contagens.clientes_atendidos ?? 0;
  const linhas = [
    total === 0
      ? "Atendimentos no CRM: nenhum no período."
      : `Atendimentos no CRM: ${total} (${porStatus.join(", ")}), em ${clientes} ${clientes === 1 ? "cliente" : "clientes"}.`,
  ];
  for (const { dia, itens } of atendimentos.dias) {
    linhas.push(dia);
    for (const item of itens) {
      const cliente = item.cliente.nome ?? `cliente ${item.cliente.id} com o nome retido: o vendedor confere no CRM`;
      linhas.push(`- ${cliente}: ${item.assunto ?? "assunto retido: o vendedor confere no CRM"} (${item.status})`);
    }
  }
  const fora = fraseDoCadastroIncompleto(atendimentos.fora_por_cadastro_incompleto ?? 0);
  if (fora !== null) linhas.push(`Atendimentos de fora das contagens: ${fora}`);
  if (atendimentos.cortado) {
    linhas.push("O CRM tinha mais atendimentos, do início do período até hoje, do que a Secretária lê de uma vez. Os mais antigos do período ficaram de fora. Peça um período que comece mais perto de hoje.");
  }
  return linhas;
}

function descreverErroDoRelatorio(erro: Relatorio["atendimentos"]["erro"]): string {
  if (erro === null) return "o CRM falhou.";
  return `${erro.acao}${erro.esperaS === undefined ? "" : ` Espere ${erro.esperaS} s.`}`;
}

function descreverRelatorio(relatorio: Relatorio): string {
  const { periodo, tarefas_concluidas } = relatorio;
  const quando = periodo.padrao ? `esta semana, de segunda a hoje (${periodo.de} a ${periodo.ate})` : `de ${periodo.de} a ${periodo.ate}`;
  const tarefas =
    tarefas_concluidas.length === 0
      ? ["Tarefas concluídas: nenhuma no período."]
      : [`Tarefas concluídas: ${tarefas_concluidas.length}.`, ...tarefas_concluidas.map((t) => `- ${t.dia}: ${t.titulo}`)];
  return [`Relatório de atividade, ${quando}.`, ...linhaDaLeituraDoRelatorio(relatorio), ...tarefas].join("\n");
}

/**
 * `ignorar` e `ignorar desfazer` viram um pedido HTTP; o servidor confere o motivo e a proposta perto do bloqueio.
 * Conversa do WhatsApp leva o telefone no lugar do id; a de e-mail leva o id do item e `canal: "email"`.
 */
type AlvoDeIgnorar = { readonly tipo: TipoDeIgnorado; readonly id: number } | { readonly tipo: "conversa"; readonly canal?: "email"; readonly id: string };

type PedidoDeIgnorar = ({ readonly acao: "ignorar"; readonly motivo: string } | { readonly acao: "desfazer" }) & AlvoDeIgnorar;

type RespostaDeIgnorar = ItemIgnorado | ((({ readonly tipo: TipoDeIgnorado; readonly id: number } | { readonly tipo: "conversa"; readonly canal: "whatsapp" | "email"; readonly id: string })) & { readonly desfeito: boolean });

const TIPOS_NO_CLI = [...TIPOS_DE_IGNORADO, "conversa", "email"] as const;

const USO_DE_IGNORAR = [
  `ignorar <proposta|cliente> <id no CRM> --motivo <as palavras do vendedor>`,
  `ignorar conversa <telefone +5511999998888> --motivo <as palavras do vendedor>`,
  `ignorar email <id do item, e-0123456789abcdef> --motivo <as palavras do vendedor>`,
  `ignorar desfazer <${TIPOS_NO_CLI.join("|")}> <id no CRM, telefone, ou id do item de e-mail>`,
].join("\n  ");

const MOTIVO_E_DO_VENDEDOR =
  "`ignorar` precisa de `--motivo`: o que o vendedor disse nesta conversa sobre por que tirar o item da lista. Pergunte a ele; não invente o motivo.";

/** O telefone da conversa com ou sem o `+`: o servidor recebe sempre `+` e os dígitos. */
function alvoDoIgnorar(tipo: string | undefined, id: string | undefined): AlvoDeIgnorar | null {
  if (id === undefined) return null;
  if (tipo === "conversa") {
    const telefone = lerTelefone(id.startsWith("+") ? id : `+${id}`);
    return telefone === null ? null : { tipo, id: telefone };
  }
  if (tipo === "email") return lerIdDoItemDeEmail(id) === null ? null : { tipo: "conversa", canal: "email", id };
  return ehDaLista(TIPOS_DE_IGNORADO, tipo) && /^[1-9]\d{0,9}$/.test(id) ? { tipo, id: Number(id) } : null;
}

function interpretarIgnorar(args: Argumentos): Interpretado<PedidoDeIgnorar> {
  const desfazer = args.posicionais[0] === "desfazer";
  const [tipo, id, ...sobra] = desfazer ? args.posicionais.slice(1) : args.posicionais;
  const alvo = alvoDoIgnorar(tipo, id);
  if (alvo === null || sobra.length > 0) return errado(`Use:\n  ${USO_DE_IGNORAR}`);
  const motivo = args.opcoes.motivo;
  if (desfazer) return motivo === undefined ? certo({ acao: "desfazer", ...alvo }) : errado("`ignorar desfazer` não leva `--motivo`.");
  if (typeof motivo !== "string" || motivo.trim() === "") return errado(MOTIVO_E_DO_VENDEDOR);
  return certo({ acao: "ignorar", motivo, ...alvo });
}

const NOMES_DO_ALVO = { proposta: "Proposta", cliente: "Cliente", conversa: "Conversa" } as const;

function descreverIgnorar(dados: RespostaDeIgnorar): string {
  const item = `${dados.tipo === "conversa" && dados.canal === "email" ? "Conversa de e-mail" : NOMES_DO_ALVO[dados.tipo]} ${dados.id}`;
  if ("desfeito" in dados) return dados.desfeito ? `${item} de volta ao Meu dia.` : `${item} não estava ignorado.`;
  return `${item} fora do Meu dia até ${dados.ate}. Motivo: ${dados.motivo ?? "nenhum"}`;
}

interface PassoDaInstalacao {
  readonly id: string;
  readonly resultado: "feito" | "ja_estava" | "falhou" | "depende_do_usuario";
  readonly detalhe: string;
}

function linhaDaAtualizacao(a: AtualizacaoNoDiagnostico): string {
  const nova = a.versaoNova === null ? "" : `, versão nova ${a.versaoNova}`;
  const impedimento = a.impedimento === null ? "" : ` (${a.impedimento})`;
  return `Atualização: ${a.fase}${nova}${impedimento}, última conferência ${a.ultimaConferencia ?? "nenhuma"}.`;
}

const FRASE_DO_IMPEDIMENTO: { readonly [I in Impedimento]: (nova: VersaoPublicada) => string } = {
  instalacao_de_desenvolvimento: () => "Esta pasta é de desenvolvimento (tem .git) e não se atualiza pelo painel.",
  bun_antigo: (nova) => `Esta versão pede o Bun ${nova.bunMinimo} ou mais novo, e esta máquina tem o ${Bun.version}.`,
};

const PASSO_EM_PALAVRAS: { readonly [P in PassoDaAplicacao]: string } = {
  baixando: "baixando e conferindo a versão nova",
  instalando: "instalando as dependências da versão nova",
  reiniciando: "reiniciando para trocar de versão",
};

function descreverAtualizacao(estado: EstadoDaAtualizacao): string {
  switch (estado.fase) {
    case "atualizando":
      return `A Secretária está se atualizando da ${estado.instalada} para a ${estado.para}: ${PASSO_EM_PALAVRAS[estado.passo]}. O painel volta sozinho; se não voltar em 3 minutos, rode \`bun secretaria abrir\`.`;
    case "atualizado":
      return [
        `Atualizada da ${estado.de ?? "versão anterior"} para a ${estado.instalada} em ${estado.em}.`,
        ...(estado.nucleoMudado !== null && estado.nucleoMudado > 0
          ? [`${estado.nucleoMudado} arquivo(s) do núcleo tinham sido mudados nesta máquina e saíram do ar; a cópia ficou guardada. Refaça a mudança em meu/ se o vendedor ainda quiser.`]
          : []),
        "Esta conversa ainda usa as regras e as skills da versão de antes: abra uma conversa nova para usar as da versão nova.",
      ].join("\n");
    case "falhou":
      return [
        `Não deu para atualizar${estado.para === null ? "" : ` para a ${estado.para}`} (${estado.motivo}, em ${estado.em}): ${estado.explicacao} A Secretária continua na ${estado.instalada} e funciona normalmente.`,
        ...(estado.bloqueio === null ? [] : [estado.bloqueio.explicacao]),
      ].join("\n");
    case "nao_conferida":
      return `Versão ${estado.instalada}. A Secretária ainda não conferiu se há versão nova: rode \`bun secretaria atualizacao conferir\`.`;
    case "em_dia":
      return `Versão ${estado.instalada}, a mais nova. Conferida em ${estado.conferidaEm}.`;
    case "sem_internet":
      return `Versão ${estado.instalada}. Em ${estado.tentadaEm} não deu para conferir se há versão nova: sem internet, ou o GitHub não respondeu. A Secretária confere de novo quando o vendedor abrir o painel.`;
    case "versao_nova":
      return [
        `Tem versão nova: ${estado.nova.versao}, de ${estado.nova.data}. A instalada é a ${estado.instalada}.`,
        "O que muda:",
        ...estado.nova.oQueMuda.map((frase) => `- ${frase}`),
        estado.impedimento !== null
          ? FRASE_DO_IMPEDIMENTO[estado.impedimento](estado.nova)
          : estado.bloqueio !== null
            ? `Agora não dá para atualizar: ${estado.bloqueio.explicacao}`
            : "Atualizar pelo painel ainda não existe nesta versão da Secretária.",
      ].join("\n");
  }
}

/** O que o `diagnostico` lê sem o servidor: nada do banco, do cofre nem dos dados do vendedor. */
interface DiagnosticoSemServidor {
  readonly servidor: null;
  readonly motivo: string;
  readonly instalacao: Pick<Diagnostico["instalacao"], "versaoNucleo">;
  readonly sistema: Diagnostico["sistema"];
  readonly wacli: Pick<Diagnostico["wacli"], "existe">;
}

export const COMANDOS: readonly Comando[] = [
  definir<null, { origem: string; pid: number }>({
    nome: "servidor",
    uso: "servidor",
    resumo: "Roda o servidor em primeiro plano até Ctrl+C ou `parar`.",
    semServidor: true,
    interpretar: semArgumentos("servidor"),
    async executar(_args, ctx) {
      const { iniciarServidor, BancoEmUso, CofreIndisponivel } = await import("../servidor");
      let rodando;
      try {
        rodando = await iniciarServidor(ctx.ambiente());
      } catch (erro) {
        if (erro instanceof BancoEmUso) return falha("servidor_ja_rodando");
        if (erro instanceof CofreIndisponivel) return falha("cofre_indisponivel");
        throw erro;
      }
      const parar = () => void rodando.parar();
      process.once("SIGINT", parar);
      process.once("SIGTERM", parar);
      ctx.manterVivo(rodando.parado);
      return ok({ origem: rodando.origem, pid: process.pid });
    },
    descrever: (dados) => `Servidor no ar em ${dados.origem} (pid ${dados.pid}). Ctrl+C para parar.`,
  }),
  definir<{ semNavegador: boolean }, DadosDoAbrir>({
    nome: "abrir",
    uso: "abrir [--sem-navegador]",
    resumo: "Sobe o servidor se faltar e abre o painel. `--sem-navegador` só sobe o servidor e devolve o endereço, sem link de entrada.",
    semServidor: true,
    interruptores: ["sem-navegador"],
    interpretar: (args) => (args.posicionais.length === 0 ? certo({ semNavegador: args.opcoes["sem-navegador"] === true }) : errado("`abrir` não leva argumentos.")),
    async executar({ semNavegador }, ctx) {
      const ambiente = ctx.ambiente();
      const achado = await acharServidor(ambiente);
      const volta = await terminarAtualizacaoInterrompida(ctx, ambiente, achado);
      if (!volta.ok) return volta;
      const desfeita = volta.dados === null ? {} : { atualizacaoDesfeita: volta.dados };
      const servidor = achado.ok ? ok({ cliente: achado.dados, subiu: false }) : await subirServidor(ctx, ambiente);
      if (!servidor.ok) return servidor;
      const { cliente, subiu } = servidor.dados;
      if (semNavegador) return ok({ navegador: false, subiu, endereco: `${cliente.arquivo.origem}/`, ...desfeita });
      const bilhete = await cliente.pedir<{ url: string }>("POST", "/api/sessoes/bilhete");
      if (!bilhete.ok) return bilhete;
      const aberto = await abrirNoNavegador(bilhete.dados.url, ambiente.navegador);
      if (!aberto.abriu) return falha("navegador_nao_abriu", `O navegador não abriu: ${aberto.motivo}.`);
      return ok({ navegador: true, subiu, ...desfeita });
    },
    descrever(dados) {
      const desfeita =
        dados.atualizacaoDesfeita === undefined
          ? ""
          : `Uma atualização da Secretária parou no meio e foi desfeita: ela segue na versão ${dados.atualizacaoDesfeita.de ?? "anterior"}. Avise o vendedor.\n`;
      return dados.navegador
        ? `${desfeita}Abri o painel no navegador do vendedor. Se a janela não abriu, peça a ele que rode \`bun secretaria abrir\` no terminal dele.`
        : `${desfeita}O servidor está de pé em ${dados.endereco}. O vendedor entra no painel rodando \`bun secretaria abrir\` no terminal dele.`;
    },
  }),
  definir<{ forcar: boolean }, { parado: true; forcado: boolean }>({
    nome: "parar",
    uso: "parar [--forcar]",
    resumo: "Para o servidor, os conectores e os processos do WhatsApp. `--forcar` encerra pelo pid o servidor que não responde.",
    semServidor: true,
    interruptores: ["forcar"],
    interpretar: (args) => (args.posicionais.length === 0 ? certo({ forcar: args.opcoes.forcar === true }) : errado("`parar` não leva argumentos.")),
    async executar({ forcar }, ctx) {
      const ambiente = ctx.ambiente();
      const servidor = await acharServidor(ambiente);
      if (servidor.ok) {
        const pedido = await servidor.dados.pedir<{ parando: true }>("POST", "/api/servidor/parar");
        const { pid } = servidor.dados.arquivo;
        if (pedido.ok && (await esperarAte(() => !vivo(pid), PARADA_MS))) return ok({ parado: true, forcado: false });
        if (!forcar) return pedido.ok ? falha("servidor_preso", `O servidor (pid ${pid}) não parou em ${PARADA_MS / 1000} s.`) : pedido;
        return forcarParada(ambiente);
      }
      if (forcar) return forcarParada(ambiente);
      return lerPidDoServidor(caminhosDosDados(ambiente).pid).tipo === "servidor" ? falha("servidor_preso") : servidor;
    },
    descrever: (dados) => (dados.forcado ? "Servidor encerrado à força." : "Servidor parado."),
  }),
  definir<null, EstadoAgente>({
    nome: "status",
    uso: "status",
    resumo: "Mostra a fase e as ações possíveis do WhatsApp, do CRM e de cada conta de e-mail, pelo rótulo.",
    semServidor: false,
    interpretar: semArgumentos("status"),
    executar: async (_args, _ctx, servidor) => (servidor === null ? falha("servidor_fora_do_ar") : servidor.pedir("GET", "/api/estado")),
    descrever: descreverEstado,
  }),
  definir<Espera, EstadoAgente>({
    nome: "esperar",
    uso: "esperar <conector>=<fase> | email:<rótulo>=<fase> [--ate 180s]",
    resumo: "Bloqueia até o conector ou a conta de e-mail chegar à fase, cair num problema ou o prazo vencer.",
    semServidor: false,
    opcoesComValor: ["ate"],
    interpretar: interpretarEspera,
    executar: async (espera, _ctx, servidor) => (servidor === null ? falha("servidor_fora_do_ar") : esperar(servidor, espera)),
    descrever: descreverEstado,
  }),
  definir<PedidoDeEmail, unknown>({
    nome: "email",
    uso: "email <testar|cancelar|rotulo|janela|pular|retomar|mensagens|ler> ... [--conta <rótulo>] [--de <endereço>] [--limite <1-200>]",
    resumo:
      "Testa uma conta de e-mail, cancela o teste, troca rótulo ou janela (30, 60 ou 90 dias), pula o e-mail ou volta atrás. `email mensagens` lista os cabeçalhos guardados na última sincronização e `email ler <rótulo> <id>` lê o corpo agora, só leitura: e-mail que parece falar com um assistente vem em quarentena, só com o id e o aviso. A conta se acha pelo rótulo. Adicionar, conectar, desconectar e remover ficam no painel.",
    semServidor: false,
    opcoesComValor: ["conta", "de", "limite"],
    interpretar: interpretarEmail,
    executar: async (pedido, _ctx, servidor) => (servidor === null ? falha("servidor_fora_do_ar") : executarEmail(pedido, servidor)),
    descrever: descreverEmail,
  }),
  definir<{ id: IdConectorUnico; acao: Acao; corpo: unknown }, EstadoPorConector[IdConectorUnico]>({
    nome: "conector",
    uso: "conector <whatsapp|crm> <acao> [--telefone +5511999998888]",
    resumo: "Executa uma ação do cartão do WhatsApp ou do CRM. O login do CRM fica no painel; o e-mail usa `email`.",
    semServidor: false,
    opcoesComValor: ["telefone"],
    interpretar(args) {
      const [id, acao, ...resto] = args.posicionais;
      if (id === "email") return errado("O e-mail tem várias contas: use `email testar <rótulo>`. Veja os rótulos em `status`.");
      if (resto.length > 0 || !ehDaLista(CONECTORES_UNICOS, id) || !ehDaLista(ACOES, acao)) {
        return errado(`Use \`conector <${CONECTORES_UNICOS.join("|")}> <${ACOES.join("|")}>\`.`);
      }
      const telefone = args.opcoes.telefone;
      if (telefone === undefined) return certo({ id, acao, corpo: id === "whatsapp" && acao === "conectar" ? { meio: "qr" } : undefined });
      if (id !== "whatsapp" || acao !== "conectar") return errado("`--telefone` só vale em `conector whatsapp conectar`.");
      if (typeof telefone !== "string" || lerTelefone(telefone) === null) return errado("O telefone precisa estar no formato +5511999998888.");
      return certo({ id, acao, corpo: { meio: "codigo", telefone } });
    },
    executar: async ({ id, acao, corpo }, _ctx, servidor) =>
      servidor === null ? falha("servidor_fora_do_ar") : servidor.pedir("POST", `/api/conectores/${id}/${acao}`, corpo),
    descrever(estado) {
      if (estado.fase === "pareando") return "Pareando. O QR ou o código aparece só no painel: rode `bun secretaria abrir` se ele não estiver aberto.";
      return `Fase agora: ${estado.fase}.`;
    },
  }),
  definir<null, Diagnostico | DiagnosticoSemServidor>({
    nome: "diagnostico",
    uso: "diagnostico",
    resumo: "Mostra instalação, sistema, cofre, wacli, processos, conectores, contas de e-mail com rótulo e as travas do agente no CRM, sem segredo. Sem servidor, mostra só versão, sistema e wacli, com `servidor: null`.",
    semServidor: true,
    interpretar: semArgumentos("diagnostico"),
    async executar(_args, ctx) {
      const ambiente = ctx.ambiente();
      const servidor = await acharServidor(ambiente);
      if (servidor.ok) return servidor.dados.pedir("GET", "/api/diagnostico");
      const wacli = ambiente.wacli[0];
      return ok({
        servidor: null,
        motivo: servidor.erro.codigo,
        instalacao: { versaoNucleo: VERSAO_DO_NUCLEO },
        sistema: lerSistema(),
        wacli: { existe: wacli !== undefined && existsSync(wacli) },
      });
    },
    descrever: (d) =>
      d.servidor === null
        ? [
            `O servidor não está rodando (${d.motivo}): só li o que não depende dele. Núcleo ${d.instalacao.versaoNucleo}.`,
            `Sistema: ${d.sistema.plataforma} ${d.sistema.versao} (${d.sistema.arquitetura}), Bun ${d.sistema.bun}.`,
            `wacli: ${d.wacli.existe ? "instalado" : "ausente"}.`,
          ].join("\n")
        : [
        `Instalação ${d.instalacao.id}, núcleo ${d.instalacao.versaoNucleo}.`,
        `Sistema: ${d.sistema.plataforma} ${d.sistema.versao} (${d.sistema.arquitetura}), Bun ${d.sistema.bun}.`,
        `Servidor em ${d.servidor.origem} (pid ${d.servidor.pid}), dados em ${d.servidor.dirDados}.`,
        `Cofre: ${d.cofre}. wacli: ${d.wacli.existe ? "instalado" : "ausente"} (${d.wacli.executavel}).`,
        `Processos filhos: ${d.processos.length === 0 ? "nenhum" : d.processos.join(", ")}.`,
        ...CONECTORES_UNICOS.map((id) => linhaDoConector(id, { estado: { fase: d.conectores[id].fase }, acoes: d.conectores[id].acoes })),
        ...linhasDoEmail(d.email),
        d.backup.aviso ?? `Backup do dia: ${d.backup.arquivo ?? "nenhum ainda"}.`,
        linhaDaAtualizacao(d.atualizacao),
        ...linhasDasTravas(d.travas),
      ].join("\n"),
  }),
  definir<{ conferir: boolean }, EstadoDaAtualizacao>({
    nome: "atualizacao",
    uso: "atualizacao [conferir]",
    resumo:
      "Mostra se há versão nova da Secretária, pela última conferência, sem buscar, o que segura a atualização e como ela andou. `atualizacao conferir` busca agora, no máximo uma vez a cada 30 segundos. O \"O que muda\" vem como dado. Aplicar é do vendedor, no painel.",
    semServidor: false,
    interpretar(args) {
      const [acao, ...resto] = args.posicionais;
      if (resto.length > 0 || (acao !== undefined && acao !== "conferir")) return errado("Use `atualizacao` para ler o estado ou `atualizacao conferir` para buscar agora.");
      return certo({ conferir: acao === "conferir" });
    },
    executar: async ({ conferir }, _ctx, servidor) =>
      servidor === null ? falha("servidor_fora_do_ar") : conferir ? servidor.pedir("POST", "/api/atualizacao/conferir") : servidor.pedir("GET", "/api/atualizacao"),
    descrever: descreverAtualizacao,
  }),
  definir<PedidoDeTarefa, { readonly tarefas: readonly Tarefa[] } | RespostaDaTarefa>({
    nome: "tarefa",
    uso: "tarefa <criar|listar|ver|concluir|adiar|descartar|anotar> ...",
    resumo: "Cria, lista, mostra, conclui, adia, descarta e anota tarefas. `bun secretaria tarefa` mostra cada forma. Mudança leva a `--versao` lida; reabrir é do vendedor, no painel.",
    semServidor: false,
    opcoesComValor: [...new Set(Object.values(OPCOES_DE_TAREFA).flat())],
    interpretar: interpretarTarefa,
    executar: async (pedido, _ctx, servidor) => {
      if (servidor === null) return falha("servidor_fora_do_ar");
      if (pedido.metodo === "GET") return servidor.pedir("GET", pedido.caminho);
      const resultado = await servidor.pedir<RespostaDaTarefa>("POST", pedido.caminho, pedido.corpo);
      if (resultado.ok || pedido.idDaCriacao === undefined || !SEM_RESPOSTA.includes(resultado.erro.codigo)) return resultado;
      const repetir = `Não sei se a tarefa foi criada. Repita o mesmo comando com \`--id ${pedido.idDaCriacao}\`: se ela já existe, volta a mesma, sem duplicar.`;
      return { ok: false, erro: { ...resultado.erro, mensagem: `${resultado.erro.mensagem} ${repetir}` } };
    },
    descrever: descreverTarefas,
  }),
  definir<PedidoDeEscrita, { readonly escritas: readonly ResumoDaEscrita[] } | CartaoVisto>({
    nome: "escrita",
    uso: "escrita <propor|listar|ver|retirar> ...",
    resumo:
      "Propõe uma escrita no CRM (atendimento, compromisso ou contato) como cartão para o vendedor aprovar no painel, lista os cartões, mostra um e retira o seu rascunho. Aprovar, editar e descartar são do vendedor. O servidor grava no CRM depois de o vendedor aprovar no painel. `bun secretaria escrita` mostra cada forma.",
    semServidor: false,
    opcoesComValor: [...new Set(Object.values(OPCOES_DE_ESCRITA).flat())],
    interpretar: interpretarEscrita,
    executar: async (pedido, _ctx, servidor) => {
      if (servidor === null) return falha("servidor_fora_do_ar");
      if (pedido.metodo === "GET") return servidor.pedir("GET", pedido.caminho);
      const resultado = await servidor.pedir<CartaoVisto>("POST", pedido.caminho, pedido.corpo);
      if (resultado.ok || pedido.idDaProposta === undefined || !SEM_RESPOSTA.includes(resultado.erro.codigo)) return resultado;
      const repetir = `Não sei se o cartão foi proposto. Repita o mesmo comando com \`--id ${pedido.idDaProposta}\`: se ele já existe, volta o mesmo, sem duplicar.`;
      return { ok: false, erro: { ...resultado.erro, mensagem: `${resultado.erro.mensagem} ${repetir}` } };
    },
    descrever: descreverEscritas,
  }),
  definir<{ semAtendimentoHaDias?: number }, Sincronizacao>({
    nome: "sincronizar",
    uso: `sincronizar [--sem-atendimento <1-${SEM_ATENDIMENTO_MAXIMO_DIAS}>]`,
    resumo:
      "Lê o CRM agora (agenda de hoje, propostas enviadas e clientes sem atendimento) e guarda para o Meu dia. Cada fonte diz se leu, quantos itens e o erro. Uma por vez.",
    semServidor: false,
    opcoesComValor: ["sem-atendimento"],
    interpretar(args) {
      if (args.posicionais.length > 0) return errado("`sincronizar` não leva argumentos.");
      const dias = args.opcoes["sem-atendimento"];
      if (dias === undefined) return certo({});
      const numero = typeof dias === "string" && /^\d+$/.test(dias) ? Number(dias) : Number.NaN;
      if (!(numero >= 1 && numero <= SEM_ATENDIMENTO_MAXIMO_DIAS)) return errado(`\`--sem-atendimento\` leva os dias, de 1 a ${SEM_ATENDIMENTO_MAXIMO_DIAS}.`);
      return certo({ semAtendimentoHaDias: numero });
    },
    executar: async (args, _ctx, servidor) =>
      servidor === null
        ? falha("servidor_fora_do_ar")
        : servidor.pedir("POST", "/api/sincronizar", args.semAtendimentoHaDias === undefined ? undefined : args, PRAZO_DA_SINCRONIZACAO_MS),
    descrever: descreverSincronizacao,
  }),
  definir<{ de?: string; ate?: string }, Relatorio>({
    nome: "relatorio",
    uso: "relatorio [--de AAAA-MM-DD --ate AAAA-MM-DD]",
    resumo:
      "Conta a atividade do vendedor: os atendimentos que ele registrou no CRM, lidos agora, e as tarefas locais que concluiu. Sem datas é a semana, de segunda a hoje. Sem CRM sai só a parte local, com o motivo. Não guarda nada.",
    semServidor: false,
    opcoesComValor: ["de", "ate"],
    interpretar(args) {
      if (args.posicionais.length > 0) return errado("`relatorio` não leva argumentos soltos: use `--de` e `--ate`.");
      const { de, ate } = args.opcoes;
      if ((de === undefined) !== (ate === undefined)) return errado(DUAS_DATAS_OU_NENHUMA);
      if (de === undefined || ate === undefined) return certo({});
      return typeof de === "string" && typeof ate === "string" ? certo({ de, ate }) : errado(DUAS_DATAS_OU_NENHUMA);
    },
    executar: async (args, _ctx, servidor) =>
      servidor === null
        ? falha("servidor_fora_do_ar")
        : servidor.pedir("GET", `/api/relatorio${args.de === undefined ? "" : `?${new URLSearchParams({ de: args.de, ate: args.ate ?? "" })}`}`, undefined, PRAZO_DO_RELATORIO_MS),
    descrever: descreverRelatorio,
  }),
  definir<null, MeuDia>({
    nome: "meu-dia",
    uso: "meu-dia",
    resumo:
      "Mostra o que fazer hoje (atrasadas e de hoje), as tarefas sem data, os cartões que esperam o vendedor aprovar no painel, sem o texto, os compromissos de hoje, as propostas enviadas sem retorno, os clientes sem atendimento e as conversas do WhatsApp e os e-mails de cliente para responder e esperando o cliente, lidos da última sincronização, e a idade de cada fonte. Das conversas vêm o cliente, o telefone ou o endereço e as contagens, nunca texto de mensagem.",
    semServidor: false,
    interpretar: semArgumentos("meu-dia"),
    executar: async (_args, _ctx, servidor) => (servidor === null ? falha("servidor_fora_do_ar") : servidor.pedir("GET", "/api/meu-dia")),
    descrever: descreverMeuDia,
  }),
  definir<PedidoDeIgnorar, RespostaDeIgnorar>({
    nome: "ignorar",
    uso: `ignorar [desfazer] <${TIPOS_NO_CLI.join("|")}> <id, telefone ou id do item> [--motivo <texto>]`,
    resumo:
      "Tira uma proposta, um cliente, uma conversa do WhatsApp (`conversa <telefone>`) ou uma conversa de e-mail (`email <id do item>`) do Meu dia por 7 dias, só a pedido do vendedor e com as palavras dele em `--motivo`. Proposta a 7 dias ou menos do bloqueio do CRM, ou vencida, só o vendedor ignora, no painel. `ignorar desfazer` traz de volta.",
    semServidor: false,
    opcoesComValor: ["motivo"],
    interpretar: interpretarIgnorar,
    executar: async (pedido, _ctx, servidor) => {
      if (servidor === null) return falha("servidor_fora_do_ar");
      const alvo = pedido.tipo === "conversa" && pedido.canal !== undefined ? { tipo: pedido.tipo, canal: pedido.canal, id: pedido.id } : { tipo: pedido.tipo, id: pedido.id };
      if (pedido.acao === "desfazer") return servidor.pedir("POST", "/api/ignorados/desfazer", alvo);
      return servidor.pedir("POST", "/api/ignorados", { ...alvo, motivo: pedido.motivo });
    },
    descrever: descreverIgnorar,
  }),
  definir<{ args: readonly string[] }, unknown>({
    nome: "wa",
    uso: "wa <leitura...>",
    resumo:
      "Lê do WhatsApp pelo wacli, só os comandos de leitura permitidos. Mensagem que parece falar com um assistente vem em quarentena, só com o id e o aviso: o vendedor abre o texto no painel.",
    semServidor: false,
    repassar: true,
    interpretar: (args) => (args.posicionais.length > 0 ? certo({ args: args.posicionais }) : errado("Use `wa <leitura...>`, como `wa chats list`.")),
    executar: async ({ args }, _ctx, servidor) => (servidor === null ? falha("servidor_fora_do_ar") : servidor.pedir("POST", "/api/whatsapp/ler", { args })),
    descrever: (dados) => JSON.stringify(dados, null, 2),
  }),
  definir<null, { pronto: true; passos: readonly PassoDaInstalacao[] }>({
    nome: "instalar",
    uso: "instalar",
    resumo: "Instala ou confere o que a Secretária precisa nesta máquina. Pode rodar de novo.",
    semServidor: true,
    interpretar: semArgumentos("instalar"),
    async executar(_args, ctx) {
      const { instalar } = await import("../instalador");
      const relatorio = await instalar({ raizDoRepo: ctx.raizDoRepo });
      if (relatorio.pronto) return ok({ pronto: true, passos: relatorio.passos });
      const pendentes = relatorio.passos.filter((passo) => passo.resultado === "falhou" || passo.resultado === "depende_do_usuario");
      return falha("instalacao_incompleta", `Passos pendentes: ${pendentes.map((passo) => `${passo.id} (${passo.resultado}: ${passo.detalhe})`).join("; ")}.`);
    },
    descrever: (dados) => [...dados.passos.map((passo) => `${passo.id}: ${passo.resultado}. ${passo.detalhe}`), "Instalação pronta."].join("\n"),
  }),
  definir<null, readonly { readonly uso: string; readonly resumo: string }[]>({
    nome: "ajuda",
    uso: "ajuda",
    resumo: "Lista os comandos.",
    semServidor: true,
    interpretar: semArgumentos("ajuda"),
    executar: async () => ok(COMANDOS.map((comando) => ({ uso: `bun secretaria ${comando.uso} [--json]`, resumo: comando.resumo }))),
    descrever: (lista) => lista.map((item) => `${item.uso}\n  ${item.resumo}`).join("\n"),
  }),
];

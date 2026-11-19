import { rmSync } from "node:fs";
import { z } from "zod";
import { caminhosDosDados } from "../../ambiente";
import { gravarConector, lerConector } from "../../banco";
import {
  falha,
  lerIdDeMensagem,
  lerJid,
  lerTelefone,
  ok,
  transicionarWhatsapp,
  type Acao,
  type EfeitoWhatsapp,
  type Conversa,
  type EntradaConectar,
  type EstadoWhatsapp,
  type EventoWhatsapp,
  type Instante,
  type LeituraDeWhatsapp,
  type Mensagem,
  type ParDeIdentidade,
  type PapelWhatsapp,
  type Resultado,
  type SondagemWhatsapp,
} from "../../dominio";
import type { Comando, ResultadoDaExecucao, SinalDoProcesso } from "../../processos";
import type { Dependencias } from "../dependencias";
import { criarMotor, pedir, type Motor } from "../motor";
import {
  ambienteDoWacli,
  argumentosDoWacli,
  interpretarLinhaDoWacli,
  lerAuthStatus,
  lerDoctor,
  lerErroDaResposta,
  lerLeitura,
  lerResposta,
  type UsoDoWacli,
} from "./wacli";
import { lerConversas, lerIdentidades, lerLeituraDoAgente, lerMensagemUnica, lerMensagens } from "./leitura";

const LIMITES_MS = { sondagem: 15_000, encerrar: 30_000, leitura: 60_000 } as const;

const RODADA = z.iso.datetime().transform((texto) => texto as Instante);

const entradaConectar = z
  .union([
    z.object({ meio: z.literal("qr"), rodada: RODADA.optional() }),
    z.object({ meio: z.literal("codigo"), telefone: z.string().transform((texto) => lerTelefone(texto)), rodada: RODADA.optional() }),
  ])
  .optional();

interface PedidoDePareamento {
  readonly entrada: EntradaConectar["whatsapp"];
  /** Só o `reparear` lê. `null` é a rodada atual. */
  readonly rodada: Instante | null;
}

function lerEntrada(dados: unknown): PedidoDePareamento | null {
  const lida = entradaConectar.safeParse(dados ?? undefined);
  if (!lida.success) return null;
  const rodada = lida.data?.rodada ?? null;
  if (lida.data === undefined || lida.data.meio === "qr") return { entrada: { meio: "qr" }, rodada };
  return lida.data.telefone === null ? null : { entrada: { meio: "codigo", telefone: lida.data.telefone }, rodada };
}

export interface CascaWhatsapp {
  readonly motor: Motor<"whatsapp", EventoWhatsapp>;
  agir(acao: Acao, dados: unknown): Promise<Resultado<EstadoWhatsapp>>;
  /** Sonda o wacli e reconcilia. É o que roda no boot. */
  reconciliar(): Promise<void>;
  /** Leitura do banco local do wacli para o agente. Só comandos da lista, sempre `--read-only --json`, com a resposta lida pelo schema. */
  ler(args: readonly string[]): Promise<Resultado<LeituraDeWhatsapp>>;
  conversas(opcoes: OpcoesDasConversas): Promise<Resultado<readonly Conversa[]>>;
  /** `sinal` abortado derruba a leitura em voo e responde `prazo_esgotado`. */
  ultimasMensagens(conversa: string, limite: number, sinal?: AbortSignal): Promise<Resultado<MensagensLidas>>;
  identidades(entradas: readonly string[]): Promise<Resultado<readonly ParDeIdentidade[]>>;
  mensagem(conversa: string, id: string): Promise<Resultado<Mensagem>>;
}

/** As mensagens que deu para ler e quantos itens da resposta do wacli ficaram de fora por estarem fora do formato. */
export interface MensagensLidas {
  readonly mensagens: readonly Mensagem[];
  readonly ilegiveis: number;
}

export interface OpcoesDasConversas {
  /** Só as conversas com mensagem não lida (`--unread`). */
  readonly naoLidas?: boolean;
  /** De 1 a `LIMITE_DAS_LEITURAS`. Sem ele, 50. */
  readonly limite?: number;
}

export const LIMITE_DAS_LEITURAS = 200;
const LIMITE_PADRAO_DAS_CONVERSAS = 50;
const LIMITE_PADRAO_DAS_MENSAGENS = 20;
const LIMITE_DE_IDENTIDADES = 50;
const IDENTIDADE = /^\+?\d{6,20}$/;

function limitado(limite: number | undefined, padrao: number): number | null {
  const valor = limite ?? padrao;
  return Number.isInteger(valor) && valor >= 1 && valor <= LIMITE_DAS_LEITURAS ? valor : null;
}

/** Como o wacli 0.26.0 diz que o `messages show` não achou a linha: `sql: no rows in result set`, conferido no binário. */
const NAO_ACHADA = /no rows in result set/i;
const SEM_RESPOSTA_LEGIVEL = "O wacli não devolveu uma resposta legível.";
const PRAZO_DA_LEITURA = "A leitura do WhatsApp foi cortada pelo prazo de quem pediu.";

export function criarCascaWhatsapp(deps: Dependencias, aoMudar: () => void): CascaWhatsapp {
  const { ambiente, supervisor, registro } = deps;
  const dirStore = caminhosDosDados(ambiente).storeDoWacli;
  const [executavel, ...prefixo] = ambiente.wacli;

  function comando(pedido: UsoDoWacli): Comando | null {
    if (executavel === undefined) return null;
    // O wacli escreve o erro em stderr: só `messages show` precisa dele, para dizer "não achei".
    const comErro = pedido.uso === "leitura_do_servidor" && pedido.leitura.comando === "messages show" ? ({ capturarStderr: true } as const) : {};
    return { argv: [executavel, ...prefixo, ...argumentosDoWacli(pedido)], env: ambienteDoWacli(dirStore, pedido), ...comErro };
  }

  async function rodar(pedido: UsoDoWacli, limiteMs: number, sinal?: AbortSignal): Promise<ResultadoDaExecucao> {
    const cmd = comando(pedido);
    if (cmd === null) return { iniciou: false, codigo: null, stdout: "", estourouOLimite: false };
    return supervisor.executar(cmd, limiteMs, sinal);
  }

  const motor = criarMotor<"whatsapp", EventoWhatsapp, EfeitoWhatsapp>({
    id: "whatsapp",
    inicial: lerConector(deps.banco, "whatsapp"),
    transicionar: transicionarWhatsapp,
    executar,
    aoMudar,
    aoFalhar: () => void reconciliar(),
    gravar: (efeito, causa) => gravarConector(deps.banco, "whatsapp", efeito.estado, causa, ambiente.agora()),
    agora: ambiente.agora,
    armar: deps.armar,
    registro,
  });

  function aoSinal(papel: PapelWhatsapp, sinal: SinalDoProcesso): void {
    switch (sinal.tipo) {
      case "linha": {
        const evento = interpretarLinhaDoWacli(sinal.texto);
        if (evento !== null) motor.despachar(evento);
        return;
      }
      case "saiu":
        motor.despachar({ tipo: "processo_saiu", papel, codigo: sinal.codigo });
        return;
      case "nao_iniciou":
        motor.despachar({ tipo: "sondagem", resultado: { binario: "ausente" } });
        return;
      case "desistiu":
        if (papel === "whatsapp.espelho") motor.despachar({ tipo: "processo_desistiu", papel });
        return;
    }
  }

  function iniciar(papel: PapelWhatsapp, pedido: UsoDoWacli): void {
    const cmd = comando(pedido);
    if (cmd === null) {
      motor.despachar({ tipo: "sondagem", resultado: { binario: "ausente" } });
      return;
    }
    supervisor.iniciar(papel, cmd, (sinal) => aoSinal(papel, sinal));
    registro.info("whatsapp.processo_pedido", { papel, uso: pedido.uso });
  }

  async function sondarOWacli(): Promise<SondagemWhatsapp> {
    const ausente: SondagemWhatsapp = { binario: "ausente" };
    let exame = await rodar({ uso: "sondar_doctor" }, LIMITES_MS.sondagem);
    if (!exame.iniciou) return ausente;
    let doctor = lerDoctor(exame.stdout);
    if (doctor === null) {
      registro.aviso("whatsapp.doctor_ilegivel", { codigo: exame.codigo ?? -1, estourou: exame.estourouOLimite });
      return ausente;
    }

    // A store é só desta instalação: quem segura o lock sem ser filho deste servidor é um wacli
    // que um servidor anterior deixou vivo. Enquanto ele viver, nenhum outro consegue o lock.
    if (doctor.donoDoLock !== null && !supervisor.pids().includes(doctor.donoDoLock)) {
      const morreu = await supervisor.encerrarPid(doctor.donoDoLock);
      registro.aviso("whatsapp.orfao_encerrado", { pid: doctor.donoDoLock, morreu });
      exame = await rodar({ uso: "sondar_doctor" }, LIMITES_MS.sondagem);
      doctor = lerDoctor(exame.stdout) ?? doctor;
    }

    const status = lerAuthStatus((await rodar({ uso: "sondar_auth" }, LIMITES_MS.sondagem)).stdout);
    if (status === null) {
      registro.aviso("whatsapp.auth_status_ilegivel", {});
      return ausente;
    }
    if (!status.autenticado) return { binario: "ok", autenticado: false, revogada: doctor.revogada };
    if (status.conta === null) {
      registro.aviso("whatsapp.conta_sem_telefone", {});
      return { binario: "ok", autenticado: false, revogada: false };
    }
    return { binario: "ok", autenticado: true, conta: status.conta };
  }

  async function sondar(geracao: number): Promise<void> {
    const resultado = await sondarOWacli();
    // Uma decisão mais nova (desconectar, conectar, sessão revogada) tem os próprios efeitos na
    // fila: aplicar este retrato desfaria o que ela decidiu.
    if (motor.geracao() !== geracao) {
      registro.info("whatsapp.sondagem_descartada", {});
      return;
    }
    motor.despachar({ tipo: "sondagem", resultado });
  }

  async function executar(efeito: Exclude<EfeitoWhatsapp, { tipo: "armar_prazo" | "gravar" }>, geracao: number): Promise<void> {
    switch (efeito.tipo) {
      case "iniciar_pareamento":
        return iniciar("whatsapp.pareamento", { uso: "pareamento", entrada: efeito.entrada });
      case "iniciar_espelho":
        return iniciar("whatsapp.espelho", { uso: "espelho" });
      case "parar":
        return supervisor.parar(efeito.papel);
      case "sondar":
        return sondar(geracao);
      case "encerrar_sessao": {
        const saida = await rodar({ uso: "encerrar_sessao" }, LIMITES_MS.encerrar);
        registro.info("whatsapp.sessao_encerrada", { logout: saida.iniciou && saida.codigo === 0 });
        // Mesmo sem o logout (sem internet), a sessão sai desta máquina junto com a store.
        rmSync(dirStore, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        return;
      }
    }
  }

  function dadosDaSaida(saida: ResultadoDaExecucao): Resultado<unknown> {
    if (!saida.iniciou) return falha("whatsapp_binario_ausente");
    const resposta = lerResposta(saida.stdout);
    return resposta === undefined ? falha("interno", SEM_RESPOSTA_LEGIVEL) : ok(resposta.dados);
  }

  /** Leitura que o servidor monta, validada pela mesma lista do agente. */
  async function lerDados(args: readonly string[], sinal?: AbortSignal): Promise<Resultado<unknown>> {
    const leitura = lerLeitura(args);
    if (leitura === null) return falha("interno", "O servidor montou uma leitura fora da lista.");
    // Função, não o campo: o TypeScript fixaria `aborted` em falso depois do primeiro teste.
    const cortada = () => sinal?.aborted === true;
    if (cortada()) return falha("prazo_esgotado", PRAZO_DA_LEITURA);
    const saida = await rodar({ uso: "leitura", leitura }, LIMITES_MS.leitura, sinal);
    return cortada() ? falha("prazo_esgotado", PRAZO_DA_LEITURA) : dadosDaSaida(saida);
  }

  async function lerComoAgente(args: readonly string[]): Promise<Resultado<LeituraDeWhatsapp>> {
    const leitura = lerLeitura(args);
    if (leitura === null) {
      return falha("entrada_invalida", "Este comando do WhatsApp não está na lista de leituras permitidas.");
    }
    const dados = dadosDaSaida(await rodar({ uso: "leitura", leitura }, LIMITES_MS.leitura));
    return dados.ok ? lerLeituraDoAgente(leitura.comando, dados.dados) : dados;
  }

  function reconciliar(): Promise<void> {
    const geracao = motor.geracao();
    return motor.enfileirar(() => sondar(geracao));
  }

  return {
    motor,
    async agir(acao, dados) {
      if (acao !== "conectar" && acao !== "reparear") return pedir(motor, acao, { tipo: `pedido_${acao}` });
      const lido = lerEntrada(dados);
      if (lido === null) return falha("entrada_invalida", "O telefone precisa estar no formato +5511999998888.");
      if (acao === "conectar") return pedir(motor, acao, { tipo: "pedido_conectar", entrada: lido.entrada });
      const atual = motor.estado();
      // Fora do pareamento a rodada não importa: `pedir` responde `acao_indisponivel` antes da máquina.
      const rodada = lido.rodada ?? (atual.fase === "pareando" ? atual.expiraEm : ambiente.agora());
      return pedir(motor, acao, { tipo: "pedido_reparear", entrada: lido.entrada, rodada });
    },
    reconciliar,
    ler: (args) => lerComoAgente(args),
    async conversas(opcoes) {
      const limite = limitado(opcoes.limite, LIMITE_PADRAO_DAS_CONVERSAS);
      if (limite === null) return falha("entrada_invalida", `O limite vai de 1 a ${LIMITE_DAS_LEITURAS}.`);
      const dados = await lerDados(["chats", "list", `--limit=${limite}`, ...(opcoes.naoLidas === true ? ["--unread"] : [])]);
      return dados.ok ? lerConversas(dados.dados) : dados;
    },
    async ultimasMensagens(conversa, limite, sinal) {
      const quanto = limitado(limite, LIMITE_PADRAO_DAS_MENSAGENS);
      if (quanto === null || lerJid(conversa) === null) return falha("entrada_invalida", "Confira o JID da conversa e o limite, de 1 a 200.");
      const dados = await lerDados(["messages", "list", `--chat=${conversa}`, `--limit=${quanto}`], sinal);
      if (!dados.ok) return dados;
      const lidas = lerMensagens(dados.dados);
      return lidas.ok ? ok({ mensagens: lidas.dados.mensagens, ilegiveis: lidas.dados.ilegiveis ?? 0 }) : lidas;
    },
    async identidades(entradas) {
      const validas = entradas.length >= 1 && entradas.length <= LIMITE_DE_IDENTIDADES && entradas.every((entrada) => IDENTIDADE.test(entrada) || lerJid(entrada) !== null);
      if (!validas) return falha("entrada_invalida", `Passe de 1 a ${LIMITE_DE_IDENTIDADES} telefones ou JIDs.`);
      const saida = await rodar({ uso: "leitura_do_servidor", leitura: { comando: "contacts resolve", identidades: entradas } }, LIMITES_MS.leitura);
      const dados = dadosDaSaida(saida);
      return dados.ok ? lerIdentidades(dados.dados) : dados;
    },
    async mensagem(conversa, id) {
      if (lerJid(conversa) === null || lerIdDeMensagem(id) === null) return falha("entrada_invalida", "Confira o JID da conversa e o id da mensagem.");
      const saida = await rodar({ uso: "leitura_do_servidor", leitura: { comando: "messages show", conversa, id } }, LIMITES_MS.leitura);
      if (saida.iniciou && lerResposta(saida.stdout) === undefined && NAO_ACHADA.test(lerErroDaResposta(saida.stdout, saida.stderr ?? "") ?? "")) {
        return falha("nao_encontrado", "O WhatsApp não tem esta mensagem nesta conversa.");
      }
      const dados = dadosDaSaida(saida);
      if (!dados.ok) return dados;
      const lida = lerMensagemUnica(dados.dados);
      return lida.ok && lida.dados.id !== id ? falha("nao_encontrado", "O WhatsApp não tem esta mensagem nesta conversa.") : lida;
    },
  };
}

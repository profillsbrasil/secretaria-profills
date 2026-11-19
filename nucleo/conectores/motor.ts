import {
  acoesPossiveis,
  falha,
  ok,
  type Acao,
  type EfeitoArmarPrazo,
  type EfeitoGravar,
  type EstadoPorConector,
  type Fase,
  type IdConector,
  type Instante,
  type Resultado,
  type Transicao,
} from "../dominio";
import type { Registro } from "../registro";

/** Agenda `disparar` para daqui a `ms` e devolve o cancelamento. */
export type Temporizador = (ms: number, disparar: () => void) => () => void;

export const temporizadorPadrao: Temporizador = (ms, disparar) => {
  const id = setTimeout(disparar, ms);
  return () => clearTimeout(id);
};

type EfeitoComum<C extends IdConector> = EfeitoArmarPrazo | EfeitoGravar<C>;

export interface OpcoesDoMotor<C extends IdConector, V extends { readonly tipo: string }, F extends { readonly tipo: string }> {
  readonly id: C;
  readonly inicial: EstadoPorConector[C];
  readonly transicionar: (estado: EstadoPorConector[C], evento: V, agora: Instante) => Transicao<EstadoPorConector[C], F>;
  /**
   * Executa um efeito próprio do conector. `armar_prazo` e `gravar` ficam com o motor.
   * `geracao` é a da decisão que pediu o efeito, para a sondagem saber se ficou velha.
   */
  readonly executar: (efeito: Exclude<F, EfeitoComum<C>>, geracao: number) => Promise<void> | void;
  readonly aoMudar: () => void;
  /**
   * Um efeito falhou (cofre fora, disco cheio): o estado em memória pode não valer mais.
   * A casca responde sondando a fonte de verdade.
   */
  readonly aoFalhar: () => void;
  /** Grava o estado durável. Uma transação: a linha da instância e um evento na trilha dela. */
  readonly gravar: (efeito: Extract<F, EfeitoGravar<C>>, causa: string) => void;
  readonly agora: () => Instante;
  readonly armar: Temporizador;
  readonly registro: Registro;
}

export interface Motor<C extends IdConector, V> {
  estado(): EstadoPorConector[C];
  /** Aplica a transição agora e põe os efeitos na fila, na ordem que a máquina deu. */
  despachar(evento: V): void;
  /** Põe uma tarefa na mesma fila dos efeitos. */
  enfileirar(tarefa: () => Promise<void> | void): Promise<void>;
  /** Resolve quando a fila esvaziou, contando o que entrou nela durante a espera. */
  assentar(): Promise<void>;
  /**
   * Muda a cada transição que gerou efeito. Uma sondagem só vale se nenhuma decisão veio depois
   * da que a pediu: o retrato da fonte de verdade pode ser de antes dos efeitos dessa decisão.
   */
  geracao(): number;
  falhas(): number;
  /** Deixa de aceitar eventos e solta o prazo armado. A fila termina o que já recebeu. */
  encerrar(): void;
}

function nomeDoErro(erro: unknown): string {
  return erro instanceof Error ? erro.name : typeof erro;
}

/**
 * Casca genérica de um conector: guarda o estado, aplica a máquina pura e executa os efeitos
 * um por vez. A transição é síncrona, então o estado nunca fica pela metade; os efeitos são
 * lentos e por isso passam por uma fila, que mantém a ordem entre uma transição e a seguinte
 * (o `parar` de um cancelamento termina antes do `iniciar` do próximo pedido).
 */
export function criarMotor<C extends IdConector, V extends { readonly tipo: string }, F extends { readonly tipo: string }>(
  opcoes: OpcoesDoMotor<C, V, F>,
): Motor<C, V> {
  const { id, registro } = opcoes;
  let estado = opcoes.inicial;
  let cauda: Promise<void> = Promise.resolve();
  let geracao = 0;
  let falhas = 0;
  let encerrado = false;
  let cancelarPrazo: (() => void) | null = null;

  function enfileirar(tarefa: () => Promise<void> | void, aoFalhar?: () => void): Promise<void> {
    cauda = cauda.then(tarefa).catch((erro: unknown) => {
      falhas += 1;
      // Só o nome: a mensagem de um erro pode carregar dado de fora.
      registro.erro("conector.efeito_falhou", { conector: id, erro: nomeDoErro(erro) });
      aoFalhar?.();
    });
    return cauda;
  }

  function despachar(evento: V): void {
    if (encerrado) return;
    const transicao = opcoes.transicionar(estado, evento, opcoes.agora());
    const mudou = transicao.estado !== estado;
    estado = transicao.estado;
    if (transicao.efeitos.length > 0) {
      geracao += 1;
      const decisao = geracao;
      // Só efeito de transição pede reconciliação ao falhar. A própria reconciliação entra pela
      // fila sem isso, então uma fonte de verdade fora do ar não vira laço.
      for (const efeito of transicao.efeitos) void enfileirar(() => executar(efeito, evento.tipo, decisao), opcoes.aoFalhar);
    }
    if (mudou) opcoes.aoMudar();
  }

  function executar(efeito: F, causa: string, decisao: number): Promise<void> | void {
    const comum = efeito as unknown as EfeitoComum<C> | { readonly tipo: "outro" };
    if (comum.tipo === "armar_prazo") {
      cancelarPrazo?.();
      const espera = Math.max(0, Date.parse(comum.ate) - Date.parse(opcoes.agora()));
      cancelarPrazo = opcoes.armar(espera, () => despachar({ tipo: "prazo_vencido" } as unknown as V));
      return;
    }
    if (comum.tipo === "gravar") {
      opcoes.gravar(efeito as Extract<F, EfeitoGravar<C>>, causa);
      return;
    }
    return opcoes.executar(efeito as Exclude<F, EfeitoComum<C>>, decisao);
  }

  return {
    estado: () => estado,
    despachar,
    enfileirar: (tarefa) => enfileirar(tarefa),
    async assentar() {
      let vista: Promise<void>;
      do {
        vista = cauda;
        await vista;
      } while (vista !== cauda);
    },
    geracao: () => geracao,
    falhas: () => falhas,
    encerrar() {
      encerrado = true;
      cancelarPrazo?.();
      cancelarPrazo = null;
    },
  };
}

/**
 * Fases em que a ação já foi atendida. Repetir a ação nelas responde o estado atual, sem
 * erro e sem segundo processo: é o que deixa cada ação rodar duas vezes e em paralelo.
 */
const JA_ATENDIDA: { readonly [A in Acao]: readonly Fase[] } = {
  conectar: ["pareando", "sincronizando", "autorizando", "testando"],
  cancelar: ["desconectado", "conectado", "atencao"],
  desconectar: ["desconectado"],
  confirmar: ["conectado"],
  recusar: ["desconectado"],
  testar: [],
  // O clique duplo cai na máquina, que compara a rodada.
  reparear: [],
};

/** Ações cujo pedido falha quando o conector termina pedindo atenção. */
const REVELA_O_PROBLEMA: readonly Acao[] = ["conectar", "reparear", "testar", "confirmar"];

/** Despacha o pedido de uma ação e responde com o estado depois que os efeitos assentaram. */
export async function pedir<C extends IdConector, V>(
  motor: Motor<C, V>,
  acao: Acao,
  evento: V,
): Promise<Resultado<EstadoPorConector[C]>> {
  const antes = motor.estado();
  const possiveis = acoesPossiveis(antes);
  const falhasAntes = motor.falhas();
  if (possiveis.includes(acao)) motor.despachar(evento);
  else if (!JA_ATENDIDA[acao].includes(antes.fase)) {
    return falha(
      "acao_indisponivel",
      `A ação "${acao}" não cabe na fase "${antes.fase}". Ações possíveis agora: ${possiveis.join(", ")}.`,
    );
  }
  await motor.assentar();
  if (motor.falhas() !== falhasAntes) return falha("interno");
  const depois = motor.estado();
  if (depois.fase === "atencao" && REVELA_O_PROBLEMA.includes(acao)) return falha(depois.problema.codigo);
  return ok(depois);
}

import { acoesPossiveis, type Acao, type EstadoConector, type EstadoDuravel, type IdConector, type Instante } from "./tipos";

export interface Transicao<E, F> {
  readonly estado: E;
  /** Executados pela casca na ordem da lista. A ordem carrega regras como "cofre antes da linha". */
  readonly efeitos: readonly F[];
}

export type Pedido =
  | { readonly tipo: "pedido_cancelar" }
  | { readonly tipo: "pedido_testar" }
  | { readonly tipo: "pedido_desconectar" }
  | { readonly tipo: "pedido_confirmar" }
  | { readonly tipo: "pedido_recusar" };

export interface EfeitoArmarPrazo {
  readonly tipo: "armar_prazo";
  readonly ate: Instante;
}

/** Uma transação: a linha de `conector` e uma linha na trilha `evento_conector`. */
export interface EfeitoGravar<C extends IdConector> {
  readonly tipo: "gravar";
  readonly estado: EstadoDuravel<C>;
}

export const PRAZOS_MS = {
  pareamento: 3 * 60_000,
  sincronizacao: 30 * 60_000,
  autorizacao: 10 * 60_000,
  testeDoEmail: 30_000,
} as const;

export function instante(data: Date): Instante {
  return data.toISOString() as Instante;
}

export function somar(agora: Instante, ms: number): Instante {
  return instante(new Date(Date.parse(agora) + ms));
}

/** Prazo velho que dispara depois de a fase mudar é ignorado, então timer atrasado não estraga nada. */
export function venceu(agora: Instante, expiraEm: Instante): boolean {
  return Date.parse(agora) >= Date.parse(expiraEm);
}

const ACAO_DO_PEDIDO: Readonly<Record<string, Acao>> = {
  pedido_conectar: "conectar",
  pedido_cancelar: "cancelar",
  pedido_testar: "testar",
  pedido_desconectar: "desconectar",
  pedido_confirmar: "confirmar",
  pedido_recusar: "recusar",
  pedido_reparear: "reparear",
};

/** A ação que o pedido representa, para a casca responder `acao_indisponivel` com a mesma regra da máquina. */
export function acaoDoPedido(evento: { readonly tipo: string }): Acao | null {
  return ACAO_DO_PEDIDO[evento.tipo] ?? null;
}

/** Pedido fora de `acoesPossiveis` não muda nada: a máquina e os botões seguem a mesma tabela. */
export function pedidoForaDeHora(estado: EstadoConector, evento: { readonly tipo: string }): boolean {
  const acao = acaoDoPedido(evento);
  return acao !== null && !acoesPossiveis(estado).includes(acao);
}

export function parado<E>(estado: E): Transicao<E, never> {
  return { estado, efeitos: [] };
}

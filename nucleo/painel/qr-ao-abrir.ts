import type { Acao, Fase } from "../dominio";
import type { PedidoDeAcao } from "./api";
import { podeAgir, type Conexao } from "./conexao";

/**
 * Se a tela Conexões já pediu o QR sozinha. Uma por montagem da tela: sai de `esperando` uma vez e
 * não volta, então prazo vencido, cancelar, recusar e desconectar não reabrem o pareamento.
 */
export type DecisaoDoQr = "esperando" | "pediu" | "dispensou";

export interface VistaParaODisparo {
  readonly canalAberto: boolean;
  /** `null` sem snapshot. */
  readonly whatsapp: { readonly fase: Fase; readonly acoes: readonly Acao[] } | null;
  /** Nenhum pedido de ação em andamento nesta tela. */
  readonly livre: boolean;
  /** A aba está na frente. Aba de fundo não gasta os 3 minutos do pareamento. */
  readonly visivel: boolean;
}

export interface PassoDoDisparo {
  readonly decisao: DecisaoDoQr;
  readonly pedir: boolean;
}

export const PEDIDO_DO_QR_AO_ABRIR = { id: "whatsapp", acao: "conectar", corpo: { meio: "qr" } } as const satisfies PedidoDeAcao;

/** `atencao` dispensa mesmo com `conectar` na saída: o vendedor segue o próximo passo do problema. */
export function decidirQrAoAbrir(decisao: DecisaoDoQr, vista: VistaParaODisparo): PassoDoDisparo {
  if (decisao !== "esperando") return { decisao, pedir: false };
  if (!vista.canalAberto || vista.whatsapp === null || !vista.visivel || !vista.livre) return { decisao, pedir: false };
  const pede = vista.whatsapp.fase === "desconectado" && vista.whatsapp.acoes.includes("conectar");
  return pede ? { decisao: "pediu", pedir: true } : { decisao: "dispensou", pedir: false };
}

export function vistaParaODisparo(conexao: Conexao, livre: boolean, visivel: boolean): VistaParaODisparo {
  const whatsapp = conexao.estado?.conectores.whatsapp ?? null;
  return {
    canalAberto: podeAgir(conexao),
    whatsapp: whatsapp === null ? null : { fase: whatsapp.estado.fase, acoes: whatsapp.acoes },
    livre,
    visivel,
  };
}

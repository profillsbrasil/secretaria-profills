import type { FonteDaSincronizacao } from "./conversa";
import { FONTES_DO_CRM } from "./crm-leitura";
import { motivoDoPulo } from "./relatorio";
import type { IdContaEmail, Instante, RetratoDosConectores } from "./tipos";

/** Abrir o painel sincroniza quando a leitura mais velha das fontes conectadas passa disto, ou quando a última rodada já passou disto. */
export const LEITURA_VELHA_MS = 30 * 60_000;

/**
 * A fase que só o pedido do vendedor abre e que leva a `conectado`. A rodada sai só dessa passagem:
 * o reinício e a sondagem levam um conector a `conectado` sem passar por ela, então não sincronizam.
 */
const FASE_DO_PEDIDO = { whatsapp: "confirmar_conta", crm: "autorizando", email: "testando" } as const;

export type ConectorQueConectou = keyof typeof FASE_DO_PEDIDO;

/** O `lido_em` de cada fonte. `email` tem a última coleta de cada conta; conta sem coleta não está no mapa. */
export interface LidoEmDasFontes {
  readonly agenda: Instante | null;
  readonly propostas: Instante | null;
  readonly carteira: Instante | null;
  readonly conversas: Instante | null;
  readonly email: ReadonlyMap<IdContaEmail, Instante>;
}

export type GatilhoAutomatico =
  | { readonly tipo: "conectores_mudaram"; readonly antes: RetratoDosConectores; readonly depois: RetratoDosConectores }
  | { readonly tipo: "painel_aberto"; readonly conectores: RetratoDosConectores; readonly lidoEm: LidoEmDasFontes };

export interface EntradaDaSincronizacaoAutomatica {
  readonly gatilho: GatilhoAutomatico;
  readonly agora: Instante;
  /** O começo da última rodada desde que o servidor subiu, de qualquer gatilho. */
  readonly ultimaRodadaEm: Instante | null;
  /** O CRM pediu para não chamar antes deste instante (`esperaS` da última rodada). */
  readonly esperarAte: Instante | null;
}

export type DecisaoAutomatica =
  | { readonly dispara: true; readonly motivo: "conectou"; readonly conector: ConectorQueConectou }
  | { readonly dispara: true; readonly motivo: "sem_leitura" | "leitura_velha"; readonly fonte: FonteDaSincronizacao }
  | { readonly dispara: false; readonly motivo: "sem_conexao_nova" | "nada_conectado" | "leitura_recente" | "rodou_ha_pouco" | "crm_pediu_espera" };

function conectorQueConectou(antes: RetratoDosConectores, depois: RetratoDosConectores): ConectorQueConectou | null {
  if (antes.crm.fase === FASE_DO_PEDIDO.crm && depois.crm.fase === "conectado") return "crm";
  if (antes.whatsapp.fase === FASE_DO_PEDIDO.whatsapp && depois.whatsapp.fase === "conectado") return "whatsapp";
  const fasesDeAntes = new Map(antes.email.contas.map((conta) => [conta.id, conta.estado.fase]));
  const conta = depois.email.contas.find((agora) => agora.estado.fase === "conectado" && fasesDeAntes.get(agora.id) === FASE_DO_PEDIDO.email);
  return conta === undefined ? null : "email";
}

/** O `lido_em` de cada fonte que a rodada leria agora. A do e-mail é a da conta conectada lida há mais tempo, e `null` se alguma nunca foi lida. */
function leiturasDasConectadas(conectores: RetratoDosConectores, lidoEm: LidoEmDasFontes): readonly (readonly [FonteDaSincronizacao, Instante | null])[] {
  const fontes: [FonteDaSincronizacao, Instante | null][] = [];
  if (motivoDoPulo(conectores.crm) === null) for (const fonte of FONTES_DO_CRM) fontes.push([fonte, lidoEm[fonte]]);
  if (conectores.whatsapp.fase === "conectado") fontes.push(["conversas", lidoEm.conversas]);
  const contas = conectores.email.contas.filter((conta) => conta.estado.fase === "conectado");
  let email: Instante | null = null;
  for (const conta of contas) {
    const lida = lidoEm.email.get(conta.id);
    if (lida === undefined) return [...fontes, ["email", null]];
    if (email === null || Date.parse(lida) < Date.parse(email)) email = lida;
  }
  return email === null ? fontes : [...fontes, ["email", email]];
}

/**
 * Decide se a Secretária sincroniza sozinha agora. Só dois gatilhos, os dois do vendedor: um conector que
 * chega a `conectado` pela fase do pedido dele, e o painel aberto com a leitura mais velha das fontes
 * conectadas com mais de `LEITURA_VELHA_MS`. A espera que o CRM pediu vale para os dois. Ao abrir o
 * painel, uma rodada há menos de `LEITURA_VELHA_MS` segura a próxima mesmo com fonte sem leitura: a
 * rodada que falhou não se repete sozinha.
 */
export function decidirSincronizacaoAutomatica(entrada: EntradaDaSincronizacaoAutomatica): DecisaoAutomatica {
  const { gatilho, agora, ultimaRodadaEm, esperarAte } = entrada;
  const desde = (instante: Instante) => Date.parse(agora) - Date.parse(instante);
  const crmPediuEspera = esperarAte !== null && desde(esperarAte) < 0;

  if (gatilho.tipo === "conectores_mudaram") {
    const conector = conectorQueConectou(gatilho.antes, gatilho.depois);
    if (conector === null) return { dispara: false, motivo: "sem_conexao_nova" };
    return crmPediuEspera ? { dispara: false, motivo: "crm_pediu_espera" } : { dispara: true, motivo: "conectou", conector };
  }

  const fontes = leiturasDasConectadas(gatilho.conectores, gatilho.lidoEm);
  if (fontes.length === 0) return { dispara: false, motivo: "nada_conectado" };
  if (crmPediuEspera) return { dispara: false, motivo: "crm_pediu_espera" };
  if (ultimaRodadaEm !== null && desde(ultimaRodadaEm) <= LEITURA_VELHA_MS) return { dispara: false, motivo: "rodou_ha_pouco" };
  let maisVelha: { readonly fonte: FonteDaSincronizacao; readonly idade: number } | null = null;
  for (const [fonte, lido] of fontes) {
    if (lido === null) return { dispara: true, motivo: "sem_leitura", fonte };
    if (maisVelha === null || desde(lido) > maisVelha.idade) maisVelha = { fonte, idade: desde(lido) };
  }
  return maisVelha !== null && maisVelha.idade > LEITURA_VELHA_MS ? { dispara: true, motivo: "leitura_velha", fonte: maisVelha.fonte } : { dispara: false, motivo: "leitura_recente" };
}

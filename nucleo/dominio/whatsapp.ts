import {
  PRAZOS_MS,
  parado,
  pedidoForaDeHora,
  somar,
  venceu,
  type EfeitoArmarPrazo,
  type EfeitoGravar,
  type Pedido,
  type Transicao,
} from "./maquina";
import type {
  ContaWhatsapp,
  EntradaConectar,
  EstadoWhatsapp,
  Instante,
  PayloadQr,
  ProblemaDe,
  Telefone,
  TextoExterno,
} from "./tipos";

export type PapelWhatsapp = "whatsapp.pareamento" | "whatsapp.espelho";

/** Resultado de `wacli auth status --json` e `doctor --json`, já interpretado pela casca. */
export type SondagemWhatsapp =
  | { readonly binario: "ausente" }
  | { readonly binario: "ok"; readonly autenticado: false; readonly revogada: boolean }
  | { readonly binario: "ok"; readonly autenticado: true; readonly conta: ContaWhatsapp };

/** Eventos de domínio. A casca traduz cada linha NDJSON do wacli para um destes. */
export type EventoWhatsapp =
  | { readonly tipo: "pedido_conectar"; readonly entrada: EntradaConectar["whatsapp"] }
  /** `rodada` é o `expiraEm` do pareamento que o vendedor viu. Rodada que não é a atual não faz nada. */
  | { readonly tipo: "pedido_reparear"; readonly entrada: EntradaConectar["whatsapp"]; readonly rodada: Instante }
  | Pedido
  | { readonly tipo: "qr_emitido"; readonly qr: PayloadQr }
  | { readonly tipo: "codigo_emitido"; readonly codigo: string; readonly telefone: Telefone }
  | { readonly tipo: "ligou" }
  | { readonly tipo: "caiu" }
  | { readonly tipo: "progresso"; readonly mensagens: number }
  | { readonly tipo: "passkey_exigida"; readonly detalhe: TextoExterno }
  | { readonly tipo: "sessao_revogada"; readonly detalhe: TextoExterno }
  | { readonly tipo: "limite_do_banco"; readonly detalhe: TextoExterno }
  | { readonly tipo: "processo_saiu"; readonly papel: PapelWhatsapp; readonly codigo: number | null }
  | { readonly tipo: "processo_desistiu"; readonly papel: "whatsapp.espelho" }
  | { readonly tipo: "sondagem"; readonly resultado: SondagemWhatsapp }
  | { readonly tipo: "prazo_vencido" };

export type EfeitoWhatsapp =
  | { readonly tipo: "iniciar_pareamento"; readonly entrada: EntradaConectar["whatsapp"] }
  | { readonly tipo: "iniciar_espelho" }
  | { readonly tipo: "parar"; readonly papel: PapelWhatsapp }
  | { readonly tipo: "sondar" }
  /** `wacli auth logout` e apagar a store: a conta sai desta máquina. */
  | { readonly tipo: "encerrar_sessao" }
  | EfeitoArmarPrazo
  | EfeitoGravar<"whatsapp">;

type Resultado = Transicao<EstadoWhatsapp, EfeitoWhatsapp>;

const PARAR_PAREAMENTO: EfeitoWhatsapp = { tipo: "parar", papel: "whatsapp.pareamento" };
const PARAR_ESPELHO: EfeitoWhatsapp = { tipo: "parar", papel: "whatsapp.espelho" };
const DESCONECTADO: EstadoWhatsapp = { fase: "desconectado" };
const GRAVAR_DESCONECTADO: EfeitoWhatsapp = { tipo: "gravar", estado: { fase: "desconectado" } };

function iniciarPareamento(entrada: EntradaConectar["whatsapp"], agora: Instante): Resultado {
  const expiraEm = somar(agora, PRAZOS_MS.pareamento);
  return {
    estado: { fase: "pareando", meio: { tipo: "iniciando" }, expiraEm },
    efeitos: [{ tipo: "iniciar_pareamento", entrada }, { tipo: "armar_prazo", ate: expiraEm }],
  };
}

function contaConfirmada(estado: EstadoWhatsapp): ContaWhatsapp | null {
  return estado.fase === "conectado" || estado.fase === "atencao" ? estado.conta : null;
}

function atencao(
  estado: EstadoWhatsapp,
  codigo: ProblemaDe<"whatsapp">,
  agora: Instante,
  detalhe: TextoExterno | undefined,
  parar: readonly EfeitoWhatsapp[],
): Resultado {
  if (estado.fase === "atencao" && estado.problema.codigo === codigo) return parado(estado);
  const novo: EstadoWhatsapp = {
    fase: "atencao",
    problema: detalhe === undefined ? { codigo, desde: agora } : { codigo, desde: agora, detalhe },
    conta: contaConfirmada(estado),
  };
  return { estado: novo, efeitos: [...parar, { tipo: "gravar", estado: novo }] };
}

function conectar(conta: ContaWhatsapp, agora: Instante, anterior: EstadoWhatsapp): Resultado {
  const ligado = anterior.fase === "conectado" && anterior.espelho !== "parado";
  const novo: EstadoWhatsapp = {
    fase: "conectado",
    conta,
    verificadoEm: agora,
    espelho: ligado ? anterior.espelho : "ligando",
    ultimaAtividade: anterior.fase === "conectado" ? anterior.ultimaAtividade : null,
  };
  const gravar: EfeitoWhatsapp = { tipo: "gravar", estado: novo };
  return { estado: novo, efeitos: ligado ? [gravar] : [{ tipo: "iniciar_espelho" }, gravar] };
}

function aplicarSondagem(estado: EstadoWhatsapp, resultado: SondagemWhatsapp, agora: Instante): Resultado {
  if (resultado.binario === "ausente") {
    return atencao(estado, "whatsapp_binario_ausente", agora, undefined, [PARAR_PAREAMENTO, PARAR_ESPELHO]);
  }
  if (!resultado.autenticado) {
    if (resultado.revogada && contaConfirmada(estado) !== null) {
      return atencao(estado, "whatsapp_sessao_revogada", agora, undefined, [PARAR_ESPELHO]);
    }
    const aindaPedeNovoPareamento =
      estado.fase === "atencao" &&
      (estado.problema.codigo === "whatsapp_sessao_revogada" || estado.problema.codigo === "whatsapp_passkey_exigida");
    if (estado.fase === "desconectado" || aindaPedeNovoPareamento) return parado(estado);
    return { estado: DESCONECTADO, efeitos: [PARAR_PAREAMENTO, PARAR_ESPELHO, GRAVAR_DESCONECTADO] };
  }
  const conta = resultado.conta;
  if (estado.fase === "confirmar_conta") return parado({ fase: "confirmar_conta", conta });
  if (contaConfirmada(estado)?.telefone === conta.telefone) return conectar(conta, agora, estado);
  return { estado: { fase: "confirmar_conta", conta }, efeitos: [PARAR_PAREAMENTO, PARAR_ESPELHO] };
}

/**
 * Máquina pura do WhatsApp. Pareamento, sincronização inicial, confirmação da conta,
 * espelho ao vivo e problemas. Evento que não casa com a fase devolve o mesmo estado e nenhum efeito.
 */
export function transicionarWhatsapp(estado: EstadoWhatsapp, evento: EventoWhatsapp, agora: Instante): Resultado {
  if (pedidoForaDeHora(estado, evento)) return parado(estado);
  switch (evento.tipo) {
    case "pedido_conectar":
      return iniciarPareamento(evento.entrada, agora);
    case "pedido_reparear": {
      if (estado.fase !== "pareando" || evento.rodada !== estado.expiraEm) return parado(estado);
      // O `wacli auth` novo pega o lock da store: o antigo sai antes, e a fila do motor espera o `parar`.
      const novo = iniciarPareamento(evento.entrada, agora);
      return { estado: novo.estado, efeitos: [PARAR_PAREAMENTO, ...novo.efeitos] };
    }
    case "pedido_cancelar":
      // Depois de `ligou` a conta já está pareada nesta máquina: cancelar também a desliga.
      return estado.fase === "sincronizando"
        ? { estado: DESCONECTADO, efeitos: [PARAR_PAREAMENTO, { tipo: "encerrar_sessao" }, GRAVAR_DESCONECTADO] }
        : { estado: DESCONECTADO, efeitos: [PARAR_PAREAMENTO, GRAVAR_DESCONECTADO] };
    case "pedido_desconectar":
      return {
        estado: DESCONECTADO,
        efeitos: [PARAR_PAREAMENTO, PARAR_ESPELHO, { tipo: "encerrar_sessao" }, GRAVAR_DESCONECTADO],
      };
    case "pedido_recusar":
      return { estado: DESCONECTADO, efeitos: [{ tipo: "encerrar_sessao" }, GRAVAR_DESCONECTADO] };
    case "pedido_confirmar":
      return estado.fase === "confirmar_conta" ? conectar(estado.conta, agora, estado) : parado(estado);
    case "pedido_testar":
      return { estado, efeitos: [{ tipo: "sondar" }] };
    case "qr_emitido":
      return estado.fase === "pareando"
        ? parado({ ...estado, meio: { tipo: "qr", qr: evento.qr, emitidoEm: agora } })
        : parado(estado);
    case "codigo_emitido":
      return estado.fase === "pareando"
        ? parado({ ...estado, meio: { tipo: "codigo", codigo: evento.codigo, telefone: evento.telefone } })
        : parado(estado);
    case "ligou": {
      if (estado.fase === "conectado") return parado({ ...estado, espelho: "ao_vivo" });
      if (estado.fase !== "pareando") return parado(estado);
      const expiraEm = somar(agora, PRAZOS_MS.sincronizacao);
      return {
        estado: { fase: "sincronizando", mensagens: 0, desde: agora, expiraEm },
        efeitos: [{ tipo: "armar_prazo", ate: expiraEm }],
      };
    }
    case "caiu":
      return estado.fase === "conectado" ? parado({ ...estado, espelho: "reconectando" }) : parado(estado);
    case "progresso":
      if (estado.fase === "sincronizando") return parado({ ...estado, mensagens: evento.mensagens });
      if (estado.fase === "conectado") return parado({ ...estado, ultimaAtividade: agora });
      return parado(estado);
    case "passkey_exigida":
      return estado.fase === "pareando" || estado.fase === "sincronizando"
        ? atencao(estado, "whatsapp_passkey_exigida", agora, evento.detalhe, [PARAR_PAREAMENTO])
        : parado(estado);
    case "sessao_revogada":
      return estado.fase === "conectado"
        ? atencao(estado, "whatsapp_sessao_revogada", agora, evento.detalhe, [PARAR_ESPELHO])
        : parado(estado);
    case "limite_do_banco":
      return estado.fase === "conectado"
        ? atencao(estado, "whatsapp_limite_do_banco", agora, evento.detalhe, [PARAR_ESPELHO])
        : parado(estado);
    case "processo_saiu":
      if (evento.papel === "whatsapp.pareamento" && (estado.fase === "pareando" || estado.fase === "sincronizando")) {
        // O wacli não emite "pareou": a prova é `auth status` depois que o `auth` sai.
        return { estado, efeitos: [{ tipo: "sondar" }] };
      }
      if (evento.papel === "whatsapp.espelho" && estado.fase === "conectado") {
        return parado({ ...estado, espelho: "reconectando" });
      }
      return parado(estado);
    case "processo_desistiu":
      return estado.fase === "conectado"
        ? atencao(estado, "whatsapp_espelho_caindo", agora, undefined, [])
        : parado(estado);
    case "prazo_vencido":
      if (estado.fase === "pareando" && venceu(agora, estado.expiraEm)) {
        return { estado: DESCONECTADO, efeitos: [PARAR_PAREAMENTO, GRAVAR_DESCONECTADO] };
      }
      if (estado.fase === "sincronizando" && venceu(agora, estado.expiraEm)) {
        return { estado, efeitos: [PARAR_PAREAMENTO, { tipo: "sondar" }] };
      }
      return parado(estado);
    case "sondagem":
      return aplicarSondagem(estado, evento.resultado, agora);
  }
}

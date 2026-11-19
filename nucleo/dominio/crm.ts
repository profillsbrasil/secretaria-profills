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
import type { EstadoCrm, EstadoDuravel, Instante, ProblemaDe, TextoExterno } from "./tipos";

export type SondagemCrm =
  | { readonly token: "ausente" }
  /** O refresh devolveu `invalid_grant`. */
  | { readonly token: "recusado" }
  | { readonly token: "ok"; readonly ferramentas: number; readonly conexaoExpiraEm: Instante }
  /** Rede fora ou CRM fora do ar: não muda a fase durável. */
  | { readonly token: "indeterminado"; readonly detalhe: TextoExterno };

export type MotivoDaRecusa = "app_nao_liberado" | "acesso_negado" | "retorno_invalido" | "inacessivel";

export type EventoCrm =
  | { readonly tipo: "pedido_conectar" }
  | Pedido
  /** Só o WhatsApp repareia; a casca monta `pedido_<ação>` para toda ação. */
  | { readonly tipo: "pedido_reparear" }
  | { readonly tipo: "retorno_ok"; readonly conexaoExpiraEm: Instante; readonly ferramentas: number }
  /** A autorização falhou: descoberta sem resposta, `invalid_client`, `access_denied`, `state` ou `iss` errados. */
  | { readonly tipo: "autorizacao_recusada"; readonly motivo: MotivoDaRecusa; readonly detalhe: TextoExterno }
  | { readonly tipo: "sondagem"; readonly resultado: SondagemCrm }
  | { readonly tipo: "prazo_vencido" };

export type EfeitoCrm =
  /** Descobre o servidor de autorização e monta a URL com PKCE e `state`. */
  | { readonly tipo: "iniciar_autorizacao" }
  | { readonly tipo: "esquecer_pendente" }
  | { readonly tipo: "sondar" }
  | { readonly tipo: "apagar_refresh" }
  | EfeitoArmarPrazo
  | EfeitoGravar<"crm">;

type Resultado = Transicao<EstadoCrm, EfeitoCrm>;

const PROBLEMA_DA_RECUSA: { readonly [M in MotivoDaRecusa]: ProblemaDe<"crm"> } = {
  app_nao_liberado: "crm_app_nao_liberado",
  acesso_negado: "crm_acesso_negado",
  retorno_invalido: "crm_retorno_invalido",
  inacessivel: "crm_inacessivel",
};

const DESCONECTADO: EstadoDuravel<"crm"> = { fase: "desconectado" };

function conectado(conexaoExpiraEm: Instante, ferramentas: number, agora: Instante): EstadoDuravel<"crm"> {
  return { fase: "conectado", conexaoExpiraEm, verificadoEm: agora, ferramentas };
}

function aplicarSondagem(estado: EstadoCrm, resultado: SondagemCrm, agora: Instante): Resultado {
  if (estado.fase === "autorizando" || resultado.token === "indeterminado") return parado(estado);
  if (estado.fase === "desconectado") {
    // Refresh sem linha: sobra de uma queda entre gravar o cofre e gravar a linha.
    return resultado.token === "ausente" ? parado(estado) : { estado, efeitos: [{ tipo: "apagar_refresh" }] };
  }
  switch (resultado.token) {
    case "ok": {
      const novo = conectado(resultado.conexaoExpiraEm, resultado.ferramentas, agora);
      return { estado: novo, efeitos: [{ tipo: "gravar", estado: novo }] };
    }
    case "recusado": {
      const novo: EstadoDuravel<"crm"> = { fase: "atencao", problema: { codigo: "crm_conexao_vencida", desde: agora } };
      return { estado: novo, efeitos: [{ tipo: "gravar", estado: novo }, { tipo: "apagar_refresh" }] };
    }
    case "ausente": {
      if (estado.fase === "atencao") return { estado: DESCONECTADO, efeitos: [{ tipo: "gravar", estado: DESCONECTADO }] };
      const novo: EstadoDuravel<"crm"> = { fase: "atencao", problema: { codigo: "crm_conexao_vencida", desde: agora } };
      return { estado: novo, efeitos: [{ tipo: "gravar", estado: novo }] };
    }
  }
}

/** Máquina pura do CRM: login OAuth no navegador, conexão de 90 dias e teste pelo MCP. */
export function transicionarCrm(estado: EstadoCrm, evento: EventoCrm, agora: Instante): Resultado {
  if (pedidoForaDeHora(estado, evento)) return parado(estado);
  switch (evento.tipo) {
    case "pedido_conectar": {
      if (estado.fase !== "desconectado" && estado.fase !== "atencao") return parado(estado);
      const expiraEm = somar(agora, PRAZOS_MS.autorizacao);
      return {
        estado: { fase: "autorizando", expiraEm, anterior: estado },
        efeitos: [{ tipo: "iniciar_autorizacao" }, { tipo: "armar_prazo", ate: expiraEm }],
      };
    }
    case "pedido_cancelar":
      return estado.fase === "autorizando"
        ? { estado: estado.anterior, efeitos: [{ tipo: "esquecer_pendente" }] }
        : parado(estado);
    case "pedido_desconectar":
      // A linha sai antes do cofre: uma queda no meio deixa um refresh órfão, que a sondagem apaga.
      return { estado: DESCONECTADO, efeitos: [{ tipo: "gravar", estado: DESCONECTADO }, { tipo: "apagar_refresh" }] };
    case "pedido_testar":
      return { estado, efeitos: [{ tipo: "sondar" }] };
    case "pedido_confirmar":
    case "pedido_recusar":
    case "pedido_reparear":
      return parado(estado);
    case "retorno_ok": {
      if (estado.fase !== "autorizando") return parado(estado);
      const novo = conectado(evento.conexaoExpiraEm, evento.ferramentas, agora);
      return { estado: novo, efeitos: [{ tipo: "esquecer_pendente" }, { tipo: "gravar", estado: novo }] };
    }
    case "autorizacao_recusada": {
      if (estado.fase !== "autorizando") return parado(estado);
      const novo: EstadoDuravel<"crm"> = {
        fase: "atencao",
        problema: { codigo: PROBLEMA_DA_RECUSA[evento.motivo], desde: agora, detalhe: evento.detalhe },
      };
      return { estado: novo, efeitos: [{ tipo: "esquecer_pendente" }, { tipo: "gravar", estado: novo }] };
    }
    case "prazo_vencido":
      return estado.fase === "autorizando" && venceu(agora, estado.expiraEm)
        ? { estado: estado.anterior, efeitos: [{ tipo: "esquecer_pendente" }] }
        : parado(estado);
    case "sondagem":
      return aplicarSondagem(estado, evento.resultado, agora);
  }
}

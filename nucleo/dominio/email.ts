import type { Segredo } from "../cofre";
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
  ConfigEmail,
  EnderecoEmail,
  EntradaConectar,
  EstadoDuravel,
  EstadoEmail,
  Instante,
  ProblemaDe,
  ProvedorEmail,
  TextoExterno,
} from "./tipos";

export type FalhaDoImap = "senha_recusada" | "senha_de_app_exigida" | "servidor_inacessivel" | "certificado_invalido";

/** Login, `STATUS INBOX` e logout. É o que a casca do IMAP devolve. */
export type ResultadoDoTesteImap =
  | { readonly ok: true; readonly mensagens: number; readonly naoLidas: number }
  | { readonly ok: false; readonly motivo: FalhaDoImap; readonly detalhe: TextoExterno };

export type SondagemEmail =
  | { readonly senha: "ausente" }
  | { readonly senha: "presente"; readonly resultado: ResultadoDoTesteImap };

export type EventoEmail =
  | { readonly tipo: "pedido_conectar"; readonly entrada: EntradaConectar["email"] }
  | Pedido
  /** Só o WhatsApp repareia; a casca monta `pedido_<ação>` para toda ação. */
  | { readonly tipo: "pedido_reparear" }
  /** A senha volta no evento para a máquina mandá-la ao cofre sem guardá-la no estado. */
  | { readonly tipo: "teste_ok"; readonly mensagens: number; readonly naoLidas: number; readonly senha: Segredo }
  | { readonly tipo: "teste_falhou"; readonly motivo: FalhaDoImap; readonly detalhe: TextoExterno }
  | { readonly tipo: "sondagem"; readonly resultado: SondagemEmail }
  | { readonly tipo: "prazo_vencido" };

/** Gravar a conta. `config` vem só quando um login passou com ela: é a configuração nova da conta. */
export interface EfeitoGravarConta extends EfeitoGravar<"email"> {
  readonly config?: ConfigEmail;
}

export type EfeitoEmail =
  | { readonly tipo: "testar"; readonly config: ConfigEmail; readonly senha: Segredo }
  /** Lê a senha do cofre e testa com a config gravada da conta. */
  | { readonly tipo: "sondar" }
  | { readonly tipo: "guardar_senha"; readonly senha: Segredo }
  | { readonly tipo: "apagar_senha" }
  | EfeitoArmarPrazo
  | EfeitoGravarConta;

type Resultado = Transicao<EstadoEmail, EfeitoEmail>;

export interface Predefinicao {
  readonly servidor: string;
  readonly porta: number;
  readonly seguranca: ConfigEmail["seguranca"];
  /** O provedor recusa a senha da conta e só aceita senha de app. */
  readonly senhaDeApp: boolean;
  /** `false` quando o valor veio de fonte de terceiros e não passou por uma conta real. O campo segue editável. */
  readonly conferida: boolean;
  /** Link que o painel mostra para o vendedor criar a senha certa. */
  readonly ajuda: string | null;
}

/**
 * Tabela única de predefinições. `outro` não tem: o vendedor informa servidor, porta e segurança.
 * O IMAP da Profills veio de um manual de terceiros e não foi conferido com conta real.
 */
export const PREDEFINICOES_DE_EMAIL: { readonly [P in ProvedorEmail]: Predefinicao | null } = {
  profills: { servidor: "imap.kinghost.net", porta: 993, seguranca: "tls", senhaDeApp: false, conferida: false, ajuda: null },
  gmail: {
    servidor: "imap.gmail.com",
    porta: 993,
    seguranca: "tls",
    senhaDeApp: true,
    conferida: true,
    ajuda: "https://myaccount.google.com/apppasswords",
  },
  outro: null,
};

/** O que o vendedor digitou vence; o que faltou sai da predefinição. Sem predefinição e com falta, `null`. */
export function configDoProvedor(
  provedor: ProvedorEmail,
  endereco: EnderecoEmail,
  campos: { readonly servidor?: string; readonly porta?: number; readonly seguranca?: ConfigEmail["seguranca"] },
): ConfigEmail | null {
  const base = PREDEFINICOES_DE_EMAIL[provedor];
  const servidor = campos.servidor ?? base?.servidor;
  const porta = campos.porta ?? base?.porta;
  const seguranca = campos.seguranca ?? base?.seguranca;
  return servidor === undefined || porta === undefined || seguranca === undefined ? null : { endereco, servidor, porta, seguranca };
}

const PROBLEMA_DA_FALHA: { readonly [F in FalhaDoImap]: ProblemaDe<"email"> } = {
  senha_recusada: "email_senha_recusada",
  senha_de_app_exigida: "email_senha_recusada",
  servidor_inacessivel: "email_servidor_inacessivel",
  certificado_invalido: "email_certificado_invalido",
};

/** No provedor que só aceita senha de app, toda recusa de senha vira o problema próprio dele. */
export function problemaDaFalha(provedor: ProvedorEmail, motivo: FalhaDoImap): ProblemaDe<"email"> {
  const recusa = motivo === "senha_recusada" || motivo === "senha_de_app_exigida";
  if (recusa && PREDEFINICOES_DE_EMAIL[provedor]?.senhaDeApp === true) return "email_gmail_senha_de_app";
  return PROBLEMA_DA_FALHA[motivo];
}

const DESCONECTADO: EstadoDuravel<"email"> = { fase: "desconectado" };

function aplicarSondagem(estado: EstadoEmail, resultado: SondagemEmail, agora: Instante, provedor: ProvedorEmail): Resultado {
  if (estado.fase === "testando") return parado(estado);
  if (estado.fase === "desconectado") {
    // Senha sem conta conectada: sobra de uma queda entre gravar o cofre e gravar a linha.
    return resultado.senha === "ausente" ? parado(estado) : { estado, efeitos: [{ tipo: "apagar_senha" }] };
  }
  if (resultado.senha === "ausente") {
    return { estado: DESCONECTADO, efeitos: [{ tipo: "gravar", estado: DESCONECTADO }, { tipo: "apagar_senha" }] };
  }
  const teste = resultado.resultado;
  if (teste.ok) {
    const novo: EstadoDuravel<"email"> = {
      fase: "conectado",
      verificadoEm: agora,
      caixaDeEntrada: { mensagens: teste.mensagens, naoLidas: teste.naoLidas },
    };
    return { estado: novo, efeitos: [{ tipo: "gravar", estado: novo }] };
  }
  const codigo = problemaDaFalha(provedor, teste.motivo);
  if (codigo === "email_servidor_inacessivel") return parado(estado);
  if (estado.fase === "atencao" && estado.problema.codigo === codigo) return parado(estado);
  const novo: EstadoDuravel<"email"> = { fase: "atencao", problema: { codigo, desde: agora, detalhe: teste.detalhe } };
  return { estado: novo, efeitos: [{ tipo: "gravar", estado: novo }] };
}

/**
 * Máquina pura de uma conta de e-mail. Credencial que não passou no teste nunca vai ao cofre.
 * `provedor` é da conta e não muda: decide o problema de uma senha recusada.
 */
export function transicionarEmail(estado: EstadoEmail, evento: EventoEmail, agora: Instante, provedor: ProvedorEmail): Resultado {
  if (pedidoForaDeHora(estado, evento)) return parado(estado);
  switch (evento.tipo) {
    case "pedido_conectar": {
      if (estado.fase !== "desconectado" && estado.fase !== "atencao") return parado(estado);
      const { config, senha } = evento.entrada;
      const expiraEm = somar(agora, PRAZOS_MS.testeDoEmail);
      return {
        estado: { fase: "testando", config, expiraEm, anterior: estado },
        efeitos: [{ tipo: "testar", config, senha }, { tipo: "armar_prazo", ate: expiraEm }],
      };
    }
    case "pedido_cancelar":
      return estado.fase === "testando" ? parado(estado.anterior) : parado(estado);
    case "pedido_desconectar":
      return { estado: DESCONECTADO, efeitos: [{ tipo: "gravar", estado: DESCONECTADO }, { tipo: "apagar_senha" }] };
    case "pedido_testar":
      return { estado, efeitos: [{ tipo: "sondar" }] };
    case "pedido_confirmar":
    case "pedido_recusar":
    case "pedido_reparear":
      return parado(estado);
    case "teste_ok": {
      if (estado.fase !== "testando") return parado(estado);
      const novo: EstadoDuravel<"email"> = {
        fase: "conectado",
        verificadoEm: agora,
        caixaDeEntrada: { mensagens: evento.mensagens, naoLidas: evento.naoLidas },
      };
      // O cofre vem antes da linha: uma queda no meio deixa senha sem linha, que a sondagem apaga.
      return {
        estado: novo,
        efeitos: [{ tipo: "guardar_senha", senha: evento.senha }, { tipo: "gravar", estado: novo, config: estado.config }],
      };
    }
    case "teste_falhou":
      return estado.fase === "testando"
        ? parado({ fase: "atencao", problema: { codigo: problemaDaFalha(provedor, evento.motivo), desde: agora, detalhe: evento.detalhe } })
        : parado(estado);
    case "prazo_vencido":
      return estado.fase === "testando" && venceu(agora, estado.expiraEm) ? parado(estado.anterior) : parado(estado);
    case "sondagem":
      return aplicarSondagem(estado, evento.resultado, agora, provedor);
  }
}

/** Entre dois `testar` da mesma conta pedidos pelo agente. Um laço de testes faria o provedor bloquear a conta. */
export const INTERVALO_DO_TESTE_DO_AGENTE_MS = 30_000;

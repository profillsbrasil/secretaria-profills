import {
  CONECTORES_UNICOS,
  PROBLEMAS,
  finalDoTelefone,
  type Acao,
  type ContaWhatsapp,
  type EstadoCrm,
  type EstadoEmail,
  type EstadoPainel,
  type EstadoPorConector,
  type EstadoWhatsapp,
  type Fase,
  type IdConector,
  type Instante,
} from "../dominio";
import { data, momento, numero } from "./tempo";

export const NOMES_DOS_CONECTORES: { readonly [C in IdConector]: string } = {
  whatsapp: "WhatsApp",
  crm: "CRM",
  email: "E-mail",
};

export type Tom = "neutro" | "andamento" | "ok" | "atencao";

const TOM_DA_FASE: { readonly [F in Fase]: Tom } = {
  desconectado: "neutro",
  pareando: "andamento",
  sincronizando: "andamento",
  confirmar_conta: "andamento",
  autorizando: "andamento",
  testando: "andamento",
  conectado: "ok",
  atencao: "atencao",
};

export const SELO_DO_TOM: { readonly [T in Tom]: string } = {
  neutro: "Não conectado",
  andamento: "Em andamento",
  ok: "Conectado",
  atencao: "Precisa de atenção",
};

/** Tudo o que o cartão escreve sobre um estado. Os botões vêm de `acoes`, não daqui. */
export interface Descricao {
  readonly tom: Tom;
  /** A fase em uma frase. */
  readonly frase: string;
  /** De quem é a conta, quando o estado traz. */
  readonly identidade: string | null;
  readonly detalhes: readonly string[];
  /** O próximo passo de um problema, da tabela `PROBLEMAS`. */
  readonly proximoPasso: string | null;
  /** Fim da fase transitória, para o cartão mostrar quanto falta. */
  readonly prazo: Instante | null;
}

type SemTom = Omit<Descricao, "tom">;

function descricao(frase: string, resto: Partial<Omit<Descricao, "tom" | "frase">> = {}): SemTom {
  return { frase, identidade: null, detalhes: [], proximoPasso: null, prazo: null, ...resto };
}

function doProblema(codigo: keyof typeof PROBLEMAS, identidade: string | null): SemTom {
  const { mensagem, acao } = PROBLEMAS[codigo];
  return descricao(mensagem, { identidade, proximoPasso: acao });
}

const telefone = (conta: ContaWhatsapp | null) => (conta === null ? null : `Telefone terminado em ${finalDoTelefone(conta.telefone)}`);

const ESPELHO = {
  ligando: "Ligando a cópia das conversas.",
  ao_vivo: "Recebendo as mensagens novas.",
  reconectando: "Reconectando ao WhatsApp.",
  parado: "A cópia das conversas está parada.",
} as const;

function descreverWhatsapp(estado: EstadoWhatsapp, agora: Date): SemTom {
  switch (estado.fase) {
    case "desconectado":
      return descricao("Conecte o WhatsApp de trabalho lendo um QR com o celular.");
    case "pareando":
      switch (estado.meio.tipo) {
        case "iniciando":
          return descricao("Preparando o QR para o celular ler.", { prazo: estado.expiraEm });
        case "qr":
          return descricao("Leia o QR com o celular.", { prazo: estado.expiraEm });
        case "codigo":
          return descricao("Digite este código no celular.", { prazo: estado.expiraEm });
      }
      break;
    case "sincronizando":
      return descricao("Copiando as suas conversas para esta máquina.", {
        detalhes: [`${numero(estado.mensagens)} mensagens copiadas até agora.`],
        prazo: estado.expiraEm,
      });
    case "confirmar_conta":
      return descricao("Confira se esta é a sua conta de trabalho.", { identidade: telefone(estado.conta) });
    case "conectado":
      return descricao("O WhatsApp está conectado.", {
        identidade: telefone(estado.conta),
        detalhes: [
          ESPELHO[estado.espelho],
          ...(estado.ultimaAtividade === null ? [] : [`Última mensagem ${momento(estado.ultimaAtividade, agora)}.`]),
        ],
      });
    case "atencao":
      return doProblema(estado.problema.codigo, telefone(estado.conta));
  }
}

function descreverCrm(estado: EstadoCrm, agora: Date): SemTom {
  switch (estado.fase) {
    case "desconectado":
      return descricao("Conecte o CRM com o mesmo login que você usa no dia a dia.");
    case "autorizando":
      return descricao("Faça o login do CRM na aba que abriu.", { prazo: estado.expiraEm });
    case "conectado":
      return descricao("O CRM está conectado.", {
        detalhes: [`A conexão vale até ${data(estado.conexaoExpiraEm)}.`, `Conferido ${momento(estado.verificadoEm, agora)}.`],
      });
    case "atencao":
      return doProblema(estado.problema.codigo, null);
  }
}

function descreverEmail(estado: EstadoEmail, agora: Date): SemTom {
  switch (estado.fase) {
    case "desconectado":
      return descricao("Conecte o e-mail de trabalho com o endereço e a senha dele.");
    case "testando":
      return descricao("Testando o acesso ao seu e-mail.", { identidade: estado.config.endereco, prazo: estado.expiraEm });
    case "conectado": {
      const caixa = estado.caixaDeEntrada;
      return descricao("O e-mail está conectado.", {
        detalhes: [
          ...(caixa === null ? [] : [`${numero(caixa.mensagens)} mensagens na caixa de entrada, ${numero(caixa.naoLidas)} não lidas.`]),
          `Conferido ${momento(estado.verificadoEm, agora)}.`,
        ],
      });
    }
    case "atencao":
      return doProblema(estado.problema.codigo, null);
  }
}

export function descrever<C extends IdConector>(id: C, estado: EstadoPorConector[C], agora: Date): Descricao {
  const porConector: { readonly [K in IdConector]: (estado: EstadoPorConector[K], agora: Date) => SemTom } = {
    whatsapp: descreverWhatsapp,
    crm: descreverCrm,
    email: descreverEmail,
  };
  return { tom: TOM_DA_FASE[estado.fase], ...porConector[id](estado, agora) };
}

/**
 * Como cada ação vira controle no cartão. O CRM conecta por navegação (sem popup bloqueado),
 * o e-mail por formulário e o WhatsApp deixa escolher entre QR e código. O resto é botão.
 */
export type Controle = "botao" | "link_do_crm" | "formulario_do_email" | "escolha_do_whatsapp";

const CONTROLES_ESPECIAIS: { readonly [C in IdConector]: Partial<Record<Acao, Controle>> } = {
  whatsapp: { conectar: "escolha_do_whatsapp", reparear: "escolha_do_whatsapp" },
  crm: { conectar: "link_do_crm" },
  email: { conectar: "formulario_do_email" },
};

export function controleDaAcao(id: IdConector, acao: Acao): Controle {
  return CONTROLES_ESPECIAIS[id][acao] ?? "botao";
}

/**
 * Ordem dos botões no rodapé, da esquerda para a direita: o que desfaz primeiro, o passo que avança
 * por último, junto da borda direita.
 */
const POSICAO_NO_RODAPE: { readonly [A in Acao]: number } = {
  desconectar: 0,
  recusar: 1,
  cancelar: 2,
  testar: 3,
  conectar: 4,
  reparear: 4,
  confirmar: 5,
};

export function ordemNoRodape(acoes: readonly Acao[]): Acao[] {
  return [...acoes].sort((a, b) => POSICAO_NO_RODAPE[a] - POSICAO_NO_RODAPE[b]);
}

export function progresso(estado: EstadoPainel): { readonly conectados: number; readonly total: number } {
  return {
    conectados: CONECTORES_UNICOS.filter((id) => estado.conectores[id].estado.fase === "conectado").length,
    total: CONECTORES_UNICOS.length,
  };
}

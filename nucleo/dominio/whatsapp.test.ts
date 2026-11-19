import { describe, expect, test } from "bun:test";
import {
  payloadQr,
  textoExterno,
  transicionarWhatsapp,
  type EfeitoWhatsapp,
  type EstadoWhatsapp,
  type EventoWhatsapp,
  type Instante,
  type Telefone,
} from "./index";

const AGORA = "2026-11-11T12:00:00.000Z" as Instante;
const EM_3_MIN = "2026-11-11T12:03:00.000Z" as Instante;
const EM_30_MIN = "2026-11-11T12:30:00.000Z" as Instante;
const ANTES = "2026-11-10T09:00:00.000Z" as Instante;
const DEPOIS_DE_1_HORA = "2026-11-11T13:00:00.000Z" as Instante;
const CONTA = { telefone: "+5511912345678" as Telefone };
const OUTRA = { telefone: "+5511987654321" as Telefone };
const QR = payloadQr("2@qr-de-teste");
const MOTIVO = textoExterno("logged_out");

const desconectado: EstadoWhatsapp = { fase: "desconectado" };
const pareando: EstadoWhatsapp = { fase: "pareando", meio: { tipo: "iniciando" }, expiraEm: EM_3_MIN };
const sincronizando: EstadoWhatsapp = { fase: "sincronizando", mensagens: 3, desde: AGORA, expiraEm: EM_30_MIN };
const confirmando: EstadoWhatsapp = { fase: "confirmar_conta", conta: CONTA };
const conectado: EstadoWhatsapp = {
  fase: "conectado",
  conta: CONTA,
  verificadoEm: ANTES,
  espelho: "ao_vivo",
  ultimaAtividade: null,
};
const restaurado: EstadoWhatsapp = { ...conectado, espelho: "parado" };
const caindo: EstadoWhatsapp = {
  fase: "atencao",
  problema: { codigo: "whatsapp_espelho_caindo", desde: ANTES },
  conta: CONTA,
};
const revogado: EstadoWhatsapp = {
  fase: "atencao",
  problema: { codigo: "whatsapp_sessao_revogada", desde: ANTES },
  conta: CONTA,
};

const autenticada = (conta = CONTA): EventoWhatsapp => ({
  tipo: "sondagem",
  resultado: { binario: "ok", autenticado: true, conta },
});
const naoAutenticada = (revogada: boolean): EventoWhatsapp => ({
  tipo: "sondagem",
  resultado: { binario: "ok", autenticado: false, revogada },
});

const PARAR_PAREAMENTO: EfeitoWhatsapp = { tipo: "parar", papel: "whatsapp.pareamento" };
const PARAR_ESPELHO: EfeitoWhatsapp = { tipo: "parar", papel: "whatsapp.espelho" };
const GRAVAR_DESCONECTADO: EfeitoWhatsapp = { tipo: "gravar", estado: { fase: "desconectado" } };

interface Linha {
  readonly nome: string;
  readonly de: EstadoWhatsapp;
  readonly evento: EventoWhatsapp;
  readonly agora?: Instante;
  readonly para: EstadoWhatsapp;
  readonly efeitos: readonly EfeitoWhatsapp[];
}

const conectadoAgora: EstadoWhatsapp = {
  fase: "conectado",
  conta: CONTA,
  verificadoEm: AGORA,
  espelho: "ligando",
  ultimaAtividade: null,
};

const TABELA: readonly Linha[] = [
  {
    nome: "conectar abre o pareamento com prazo de 3 minutos",
    de: desconectado,
    evento: { tipo: "pedido_conectar", entrada: { meio: "qr" } },
    para: pareando,
    efeitos: [{ tipo: "iniciar_pareamento", entrada: { meio: "qr" } }, { tipo: "armar_prazo", ate: EM_3_MIN }],
  },
  {
    nome: "QR novo substitui o anterior",
    de: { ...pareando, meio: { tipo: "qr", qr: payloadQr("velho"), emitidoEm: ANTES } },
    evento: { tipo: "qr_emitido", qr: QR },
    para: { ...pareando, meio: { tipo: "qr", qr: QR, emitidoEm: AGORA } },
    efeitos: [],
  },
  {
    nome: "código de pareamento aparece no estado",
    de: pareando,
    evento: { tipo: "codigo_emitido", codigo: "ABCD-EFGH", telefone: CONTA.telefone },
    para: { ...pareando, meio: { tipo: "codigo", codigo: "ABCD-EFGH", telefone: CONTA.telefone } },
    efeitos: [],
  },
  {
    nome: "ligou durante o pareamento começa a sincronização",
    de: pareando,
    evento: { tipo: "ligou" },
    para: { fase: "sincronizando", mensagens: 0, desde: AGORA, expiraEm: EM_30_MIN },
    efeitos: [{ tipo: "armar_prazo", ate: EM_30_MIN }],
  },
  {
    nome: "progresso conta mensagens na sincronização",
    de: sincronizando,
    evento: { tipo: "progresso", mensagens: 42 },
    para: { ...sincronizando, mensagens: 42 },
    efeitos: [],
  },
  {
    nome: "auth que sai na sincronização pede sondagem",
    de: sincronizando,
    evento: { tipo: "processo_saiu", papel: "whatsapp.pareamento", codigo: 0 },
    para: sincronizando,
    efeitos: [{ tipo: "sondar" }],
  },
  {
    nome: "auth que sai no pareamento também pede sondagem",
    de: pareando,
    evento: { tipo: "processo_saiu", papel: "whatsapp.pareamento", codigo: 1 },
    para: pareando,
    efeitos: [{ tipo: "sondar" }],
  },
  {
    nome: "sondagem autenticada depois do pareamento pede confirmação da conta",
    de: sincronizando,
    evento: autenticada(),
    para: confirmando,
    efeitos: [PARAR_PAREAMENTO, PARAR_ESPELHO],
  },
  {
    nome: "sondagem sem autenticação depois do pareamento desconecta",
    de: pareando,
    evento: naoAutenticada(false),
    para: desconectado,
    efeitos: [PARAR_PAREAMENTO, PARAR_ESPELHO, GRAVAR_DESCONECTADO],
  },
  {
    nome: "confirmar a conta liga o espelho e grava",
    de: confirmando,
    evento: { tipo: "pedido_confirmar" },
    para: conectadoAgora,
    efeitos: [{ tipo: "iniciar_espelho" }, { tipo: "gravar", estado: conectadoAgora }],
  },
  {
    nome: "recusar a conta encerra a sessão e apaga a store",
    de: confirmando,
    evento: { tipo: "pedido_recusar" },
    para: desconectado,
    efeitos: [{ tipo: "encerrar_sessao" }, GRAVAR_DESCONECTADO],
  },
  {
    nome: "boot com store autenticada e sem conta confirmada pede confirmação",
    de: desconectado,
    evento: autenticada(),
    para: confirmando,
    efeitos: [PARAR_PAREAMENTO, PARAR_ESPELHO],
  },
  {
    nome: "boot com a mesma conta religa o espelho",
    de: restaurado,
    evento: autenticada(),
    para: conectadoAgora,
    efeitos: [{ tipo: "iniciar_espelho" }, { tipo: "gravar", estado: conectadoAgora }],
  },
  {
    nome: "testar com o espelho no ar só renova a verificação",
    de: conectado,
    evento: autenticada(),
    para: { ...conectado, verificadoEm: AGORA },
    efeitos: [{ tipo: "gravar", estado: { ...conectado, verificadoEm: AGORA } }],
  },
  {
    nome: "store com outra conta para o espelho e pede confirmação",
    de: conectado,
    evento: autenticada(OUTRA),
    para: { fase: "confirmar_conta", conta: OUTRA },
    efeitos: [PARAR_PAREAMENTO, PARAR_ESPELHO],
  },
  {
    nome: "sessão revogada vira atenção mantendo a conta",
    de: restaurado,
    evento: naoAutenticada(true),
    para: { ...revogado, problema: { codigo: "whatsapp_sessao_revogada", desde: AGORA } },
    efeitos: [
      PARAR_ESPELHO,
      {
        tipo: "gravar",
        estado: { ...revogado, problema: { codigo: "whatsapp_sessao_revogada", desde: AGORA } },
      },
    ],
  },
  {
    nome: "atenção de sessão revogada continua igual sem autenticação",
    de: revogado,
    evento: naoAutenticada(false),
    para: revogado,
    efeitos: [],
  },
  {
    nome: "binário ausente vira atenção",
    de: desconectado,
    evento: { tipo: "sondagem", resultado: { binario: "ausente" } },
    para: {
      fase: "atencao",
      problema: { codigo: "whatsapp_binario_ausente", desde: AGORA },
      conta: null,
    },
    efeitos: [
      PARAR_PAREAMENTO,
      PARAR_ESPELHO,
      {
        tipo: "gravar",
        estado: { fase: "atencao", problema: { codigo: "whatsapp_binario_ausente", desde: AGORA }, conta: null },
      },
    ],
  },
  {
    nome: "testar uma atenção com a mesma conta volta a conectado",
    de: caindo,
    evento: autenticada(),
    para: conectadoAgora,
    efeitos: [{ tipo: "iniciar_espelho" }, { tipo: "gravar", estado: conectadoAgora }],
  },
  {
    nome: "espelho caiu e voltou",
    de: { ...conectado, espelho: "reconectando" },
    evento: { tipo: "ligou" },
    para: conectado,
    efeitos: [],
  },
  {
    nome: "queda do websocket marca reconexão",
    de: conectado,
    evento: { tipo: "caiu" },
    para: { ...conectado, espelho: "reconectando" },
    efeitos: [],
  },
  {
    nome: "espelho que saiu fica em reconexão pelo supervisor",
    de: conectado,
    evento: { tipo: "processo_saiu", papel: "whatsapp.espelho", codigo: 1 },
    para: { ...conectado, espelho: "reconectando" },
    efeitos: [],
  },
  {
    nome: "logged_out no espelho vira atenção",
    de: conectado,
    evento: { tipo: "sessao_revogada", detalhe: MOTIVO },
    para: { ...revogado, problema: { codigo: "whatsapp_sessao_revogada", desde: AGORA, detalhe: MOTIVO } },
    efeitos: [
      PARAR_ESPELHO,
      {
        tipo: "gravar",
        estado: { ...revogado, problema: { codigo: "whatsapp_sessao_revogada", desde: AGORA, detalhe: MOTIVO } },
      },
    ],
  },
  {
    nome: "espelho que desiste vira atenção",
    de: conectado,
    evento: { tipo: "processo_desistiu", papel: "whatsapp.espelho" },
    para: { ...caindo, problema: { codigo: "whatsapp_espelho_caindo", desde: AGORA } },
    efeitos: [{ tipo: "gravar", estado: { ...caindo, problema: { codigo: "whatsapp_espelho_caindo", desde: AGORA } } }],
  },
  {
    nome: "passkey no pareamento vira atenção sem conta",
    de: pareando,
    evento: { tipo: "passkey_exigida", detalhe: MOTIVO },
    para: { fase: "atencao", problema: { codigo: "whatsapp_passkey_exigida", desde: AGORA, detalhe: MOTIVO }, conta: null },
    efeitos: [
      PARAR_PAREAMENTO,
      {
        tipo: "gravar",
        estado: { fase: "atencao", problema: { codigo: "whatsapp_passkey_exigida", desde: AGORA, detalhe: MOTIVO }, conta: null },
      },
    ],
  },
  {
    nome: "cancelar o pareamento volta a desconectado",
    de: pareando,
    evento: { tipo: "pedido_cancelar" },
    para: desconectado,
    efeitos: [PARAR_PAREAMENTO, GRAVAR_DESCONECTADO],
  },
  {
    nome: "cancelar na sincronização também encerra a sessão",
    de: sincronizando,
    evento: { tipo: "pedido_cancelar" },
    para: desconectado,
    efeitos: [PARAR_PAREAMENTO, { tipo: "encerrar_sessao" }, GRAVAR_DESCONECTADO],
  },
  {
    nome: "prazo do pareamento vencido desconecta",
    de: pareando,
    evento: { tipo: "prazo_vencido" },
    agora: DEPOIS_DE_1_HORA,
    para: desconectado,
    efeitos: [PARAR_PAREAMENTO, GRAVAR_DESCONECTADO],
  },
  {
    nome: "prazo velho que chega antes do vencimento não muda nada",
    de: pareando,
    evento: { tipo: "prazo_vencido" },
    para: pareando,
    efeitos: [],
  },
  {
    nome: "prazo da sincronização vencido para o auth e sonda",
    de: sincronizando,
    evento: { tipo: "prazo_vencido" },
    agora: DEPOIS_DE_1_HORA,
    para: sincronizando,
    efeitos: [PARAR_PAREAMENTO, { tipo: "sondar" }],
  },
  {
    nome: "desconectar para tudo, encerra a sessão e grava",
    de: conectado,
    evento: { tipo: "pedido_desconectar" },
    para: desconectado,
    efeitos: [PARAR_PAREAMENTO, PARAR_ESPELHO, { tipo: "encerrar_sessao" }, GRAVAR_DESCONECTADO],
  },
  {
    nome: "testar pede sondagem",
    de: conectado,
    evento: { tipo: "pedido_testar" },
    para: conectado,
    efeitos: [{ tipo: "sondar" }],
  },
];

describe("transicionarWhatsapp", () => {
  test.each(TABELA.map((linha) => [linha.nome, linha] as const))("%s", (_nome, linha) => {
    expect(transicionarWhatsapp(linha.de, linha.evento, linha.agora ?? AGORA)).toEqual({
      estado: linha.para,
      efeitos: linha.efeitos,
    });
  });

  const foraDeHora: readonly (readonly [string, EstadoWhatsapp, EventoWhatsapp])[] = [
    ["conectar no pareamento não abre segundo processo", pareando, { tipo: "pedido_conectar", entrada: { meio: "qr" } }],
    ["conectar em conectado não faz nada", conectado, { tipo: "pedido_conectar", entrada: { meio: "qr" } }],
    ["desconectar na confirmação não faz nada", confirmando, { tipo: "pedido_desconectar" }],
    ["confirmar fora da confirmação não faz nada", conectado, { tipo: "pedido_confirmar" }],
    ["QR fora do pareamento é ignorado", conectado, { tipo: "qr_emitido", qr: QR }],
    ["testar no pareamento não faz nada", pareando, { tipo: "pedido_testar" }],
  ];
  test.each(foraDeHora)("%s", (_nome, estado, evento) => {
    expect(transicionarWhatsapp(estado, evento, AGORA)).toEqual({ estado, efeitos: [] });
  });
});

describe("reparear (Novo QR)", () => {
  const UM_MIN_DEPOIS = "2026-11-11T12:01:00.000Z" as Instante;
  const EM_4_MIN = "2026-11-11T12:04:00.000Z" as Instante;
  const comQr: EstadoWhatsapp = { fase: "pareando", meio: { tipo: "qr", qr: QR, emitidoEm: AGORA }, expiraEm: EM_3_MIN };
  const reparear = (rodada: Instante, entrada: Extract<EventoWhatsapp, { tipo: "pedido_reparear" }>["entrada"] = { meio: "qr" }): EventoWhatsapp => ({
    tipo: "pedido_reparear",
    entrada,
    rodada,
  });

  test("com a rodada atual para o processo, abre outro pareamento e arma o prazo novo, nessa ordem", () => {
    expect(transicionarWhatsapp(comQr, reparear(EM_3_MIN), UM_MIN_DEPOIS)).toEqual({
      estado: { fase: "pareando", meio: { tipo: "iniciando" }, expiraEm: EM_4_MIN },
      efeitos: [PARAR_PAREAMENTO, { tipo: "iniciar_pareamento", entrada: { meio: "qr" } }, { tipo: "armar_prazo", ate: EM_4_MIN }],
    });
  });

  test("com o QR na tela, pede o código pelo número no lugar dele", () => {
    const entrada = { meio: "codigo", telefone: CONTA.telefone } as const;
    expect(transicionarWhatsapp(comQr, reparear(EM_3_MIN, entrada), UM_MIN_DEPOIS)).toEqual({
      estado: { fase: "pareando", meio: { tipo: "iniciando" }, expiraEm: EM_4_MIN },
      efeitos: [PARAR_PAREAMENTO, { tipo: "iniciar_pareamento", entrada }, { tipo: "armar_prazo", ate: EM_4_MIN }],
    });
  });

  test("rodada que já passou não faz nada: o clique duplo não sobe dois processos", () => {
    expect(transicionarWhatsapp(comQr, reparear(ANTES), UM_MIN_DEPOIS)).toEqual({ estado: comQr, efeitos: [] });
  });

  test.each([
    ["desconectado", desconectado],
    ["sincronizando", sincronizando],
    ["confirmar a conta", confirmando],
    ["conectado", conectado],
    ["atenção", revogado],
  ] as const)("fora do pareamento (%s) não faz nada", (_nome, estado) => {
    expect(transicionarWhatsapp(estado, reparear(EM_3_MIN), AGORA)).toEqual({ estado, efeitos: [] });
  });

  test("o prazo da rodada anterior não derruba o pareamento novo", () => {
    const novo = transicionarWhatsapp(comQr, reparear(EM_3_MIN), UM_MIN_DEPOIS).estado;
    expect(transicionarWhatsapp(novo, { tipo: "prazo_vencido" }, EM_3_MIN)).toEqual({ estado: novo, efeitos: [] });
  });

  test.each([
    ["prazo vencido", comQr, { tipo: "prazo_vencido" }, DEPOIS_DE_1_HORA],
    ["cancelar", comQr, { tipo: "pedido_cancelar" }, AGORA],
    ["desconectar", conectado, { tipo: "pedido_desconectar" }, AGORA],
    ["recusar", confirmando, { tipo: "pedido_recusar" }, AGORA],
  ] as const)("%s leva a desconectado sem abrir pareamento", (_nome, estado, evento, agora) => {
    const { estado: depois, efeitos } = transicionarWhatsapp(estado, evento, agora);
    expect(depois).toEqual(desconectado);
    expect(efeitos.filter((efeito) => efeito.tipo === "iniciar_pareamento")).toEqual([]);
  });
});

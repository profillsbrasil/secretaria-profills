import { describe, expect, test } from "bun:test";
import { acoesPossiveis, instante, montarEstadoPainel, type EstadoWhatsapp } from "../dominio";
import { CONEXAO_INICIAL, type Conexao } from "./conexao";
import { decidirQrAoAbrir, vistaParaODisparo, type DecisaoDoQr, type VistaParaODisparo } from "./qr-ao-abrir";

const AGORA = instante(new Date("2026-11-19T12:00:00Z"));
const EM_3_MIN = instante(new Date("2026-11-19T12:03:00Z"));

const DESCONECTADO: EstadoWhatsapp = { fase: "desconectado" };
const PAREANDO: EstadoWhatsapp = { fase: "pareando", meio: { tipo: "iniciando" }, expiraEm: EM_3_MIN };
const SINCRONIZANDO: EstadoWhatsapp = { fase: "sincronizando", mensagens: 10, desde: AGORA, expiraEm: EM_3_MIN };
const CONECTADO: EstadoWhatsapp = { fase: "conectado", conta: { telefone: "+5511912345678" as never }, verificadoEm: AGORA, espelho: "ao_vivo", ultimaAtividade: null };
const REVOGADO: EstadoWhatsapp = { fase: "atencao", problema: { codigo: "whatsapp_sessao_revogada", desde: AGORA }, conta: null };

function vista(whatsapp: EstadoWhatsapp | null, extra: Partial<VistaParaODisparo> = {}): VistaParaODisparo {
  return {
    canalAberto: true,
    whatsapp: whatsapp === null ? null : { fase: whatsapp.fase, acoes: acoesPossiveis(whatsapp) },
    livre: true,
    visivel: true,
    ...extra,
  };
}

describe("decidirQrAoAbrir", () => {
  const TABELA: readonly (readonly [string, DecisaoDoQr, VistaParaODisparo, DecisaoDoQr, boolean])[] = [
    ["desconectado com conectar possível pede o QR", "esperando", vista(DESCONECTADO), "pediu", true],
    ["canal ainda não aberto espera", "esperando", vista(DESCONECTADO, { canalAberto: false }), "esperando", false],
    ["sem snapshot espera", "esperando", vista(null), "esperando", false],
    ["aba escondida espera, sem gastar o prazo de 3 minutos", "esperando", vista(DESCONECTADO, { visivel: false }), "esperando", false],
    ["outro pedido em andamento espera", "esperando", vista(DESCONECTADO, { livre: false }), "esperando", false],
    ["pareando dispensa", "esperando", vista(PAREANDO), "dispensou", false],
    ["sincronizando dispensa", "esperando", vista(SINCRONIZANDO), "dispensou", false],
    ["conectado dispensa", "esperando", vista(CONECTADO), "dispensou", false],
    ["atenção dispensa, mesmo com conectar na saída", "esperando", vista(REVOGADO), "dispensou", false],
    ["depois de pedir, desconectado não pede de novo", "pediu", vista(DESCONECTADO), "pediu", false],
    ["depois de dispensar, desconectado não pede", "dispensou", vista(DESCONECTADO), "dispensou", false],
  ];

  test.each(TABELA)("%s", (_nome, decisao, entrada, esperada, pedir) => {
    expect(decidirQrAoAbrir(decisao, entrada)).toEqual({ decisao: esperada, pedir });
  });

  test("prazo vencido, cancelar ou desconectar na mesma montagem não pedem de novo", () => {
    let decisao: DecisaoDoQr = "esperando";
    const pedidos: boolean[] = [];
    for (const estado of [DESCONECTADO, PAREANDO, DESCONECTADO, PAREANDO, CONECTADO, DESCONECTADO]) {
      const passo = decidirQrAoAbrir(decisao, vista(estado));
      decisao = passo.decisao;
      pedidos.push(passo.pedir);
    }
    expect(pedidos).toEqual([true, false, false, false, false, false]);
  });

  test("a aba que volta a aparecer pede, uma vez", () => {
    const escondida = decidirQrAoAbrir("esperando", vista(DESCONECTADO, { visivel: false }));
    const visivel = decidirQrAoAbrir(escondida.decisao, vista(DESCONECTADO));
    const outraVez = decidirQrAoAbrir(visivel.decisao, vista(DESCONECTADO));
    expect([escondida.pedir, visivel.pedir, outraVez.pedir]).toEqual([false, true, false]);
  });
});

describe("vistaParaODisparo", () => {
  const painel = (whatsapp: EstadoWhatsapp) =>
    montarEstadoPainel({ id: "i", versaoNucleo: "0.0.0", criadaEm: AGORA }, { whatsapp, crm: { fase: "desconectado" }, email: { pulado: false, contas: [] } });

  test("lê o canal, a fase e as ações do WhatsApp do snapshot", () => {
    const conexao: Conexao = { ...CONEXAO_INICIAL, canal: "aberto", estado: painel(DESCONECTADO) };
    expect(vistaParaODisparo(conexao, true, true)).toEqual({ canalAberto: true, whatsapp: { fase: "desconectado", acoes: ["conectar"] }, livre: true, visivel: true });
  });

  test("sem snapshot, o WhatsApp é null", () => {
    expect(vistaParaODisparo(CONEXAO_INICIAL, false, true)).toEqual({ canalAberto: false, whatsapp: null, livre: false, visivel: true });
  });
});

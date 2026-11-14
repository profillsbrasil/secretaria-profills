import { describe, expect, test } from "bun:test";
import {
  LEITURA_VELHA_MS,
  decidirSincronizacaoAutomatica,
  type ContaEmailComEstado,
  type EnderecoEmail,
  type EstadoCrm,
  type EstadoEmail,
  type EstadoWhatsapp,
  type IdContaEmail,
  type Instante,
  type LidoEmDasFontes,
  type RetratoDosConectores,
  type Telefone,
} from "./index";

const AGORA = "2026-11-14T12:00:00.000Z" as Instante;
const antesDeAgora = (ms: number) => new Date(Date.parse(AGORA) - ms).toISOString() as Instante;
const MINUTO = 60_000;

const CRM_CONECTADO: EstadoCrm = { fase: "conectado", conexaoExpiraEm: "2027-02-12T12:00:00.000Z" as Instante, verificadoEm: AGORA, ferramentas: 12 };
const CRM_AUTORIZANDO: EstadoCrm = { fase: "autorizando", expiraEm: AGORA, anterior: { fase: "desconectado" } };
const CONTA = { telefone: "+5511912345678" as Telefone };
const WA_CONECTADO: EstadoWhatsapp = { fase: "conectado", conta: CONTA, verificadoEm: AGORA, espelho: "ao_vivo", ultimaAtividade: null };
const EMAIL_CONECTADO: EstadoEmail = { fase: "conectado", verificadoEm: AGORA, caixaDeEntrada: null };
const ID_A = "00000000-0000-4000-8000-00000000000a" as IdContaEmail;
const ID_B = "00000000-0000-4000-8000-00000000000b" as IdContaEmail;

function conta(id: IdContaEmail, estado: EstadoEmail): ContaEmailComEstado {
  return { id, rotulo: id.slice(-1), provedor: "outro", config: { endereco: `${id.slice(-1)}@exemplo.com` as EnderecoEmail, servidor: "imap.exemplo.com", porta: 993, seguranca: "tls" }, janelaDias: 30, estado };
}

function retrato(parcial: { crm?: EstadoCrm; whatsapp?: EstadoWhatsapp; contas?: readonly ContaEmailComEstado[] } = {}): RetratoDosConectores {
  return { crm: parcial.crm ?? { fase: "desconectado" }, whatsapp: parcial.whatsapp ?? { fase: "desconectado" }, email: { pulado: false, contas: parcial.contas ?? [] } };
}

const NADA_LIDO: LidoEmDasFontes = { agenda: null, propostas: null, carteira: null, conversas: null, email: new Map() };
const lidoTudo = (instante: Instante, email: ReadonlyMap<IdContaEmail, Instante> = new Map()): LidoEmDasFontes => ({ agenda: instante, propostas: instante, carteira: instante, conversas: instante, email });

function aoAbrir(conectores: RetratoDosConectores, lidoEm: LidoEmDasFontes, extra: { ultimaRodadaEm?: Instante; esperarAte?: Instante } = {}) {
  return decidirSincronizacaoAutomatica({ gatilho: { tipo: "painel_aberto", conectores, lidoEm }, agora: AGORA, ultimaRodadaEm: extra.ultimaRodadaEm ?? null, esperarAte: extra.esperarAte ?? null });
}

function aoMudar(antes: RetratoDosConectores, depois: RetratoDosConectores, esperarAte: Instante | null = null) {
  return decidirSincronizacaoAutomatica({ gatilho: { tipo: "conectores_mudaram", antes, depois }, agora: AGORA, ultimaRodadaEm: AGORA, esperarAte });
}

describe("decidirSincronizacaoAutomatica: o conector chega a conectado", () => {
  test("pela fase do pedido do vendedor, em cada conector, dispara", () => {
    expect(aoMudar(retrato({ crm: CRM_AUTORIZANDO }), retrato({ crm: CRM_CONECTADO }))).toEqual({ dispara: true, motivo: "conectou", conector: "crm" });
    expect(aoMudar(retrato({ whatsapp: { fase: "confirmar_conta", conta: CONTA } }), retrato({ whatsapp: WA_CONECTADO }))).toEqual({ dispara: true, motivo: "conectou", conector: "whatsapp" });
    const testando: EstadoEmail = { fase: "testando", config: conta(ID_A, EMAIL_CONECTADO).config, expiraEm: AGORA, anterior: { fase: "desconectado" } };
    expect(aoMudar(retrato({ contas: [conta(ID_A, testando)] }), retrato({ contas: [conta(ID_A, EMAIL_CONECTADO)] }))).toEqual({ dispara: true, motivo: "conectou", conector: "email" });
  });

  test("pelo reinício ou pela sondagem, sem a fase do pedido, não dispara", () => {
    const emAtencao: EstadoCrm = { fase: "atencao", problema: { codigo: "crm_conexao_vencida", desde: AGORA } };
    expect(aoMudar(retrato({ crm: emAtencao }), retrato({ crm: CRM_CONECTADO }))).toEqual({ dispara: false, motivo: "sem_conexao_nova" });
    expect(aoMudar(retrato({ crm: CRM_CONECTADO }), retrato({ crm: CRM_CONECTADO }))).toEqual({ dispara: false, motivo: "sem_conexao_nova" });
    const waEmAtencao: EstadoWhatsapp = { fase: "atencao", problema: { codigo: "whatsapp_espelho_caindo", desde: AGORA }, conta: CONTA };
    expect(aoMudar(retrato({ whatsapp: waEmAtencao }), retrato({ whatsapp: WA_CONECTADO }))).toEqual({ dispara: false, motivo: "sem_conexao_nova" });
    const emailEmAtencao: EstadoEmail = { fase: "atencao", problema: { codigo: "email_senha_recusada", desde: AGORA } };
    expect(aoMudar(retrato({ contas: [conta(ID_A, emailEmAtencao)] }), retrato({ contas: [conta(ID_A, EMAIL_CONECTADO)] }))).toEqual({ dispara: false, motivo: "sem_conexao_nova" });
  });

  test("com o CRM pedindo espera, não dispara", () => {
    expect(aoMudar(retrato({ crm: CRM_AUTORIZANDO }), retrato({ crm: CRM_CONECTADO }), "2026-11-14T12:00:30.000Z" as Instante)).toEqual({ dispara: false, motivo: "crm_pediu_espera" });
  });
});

describe("decidirSincronizacaoAutomatica: o painel abre", () => {
  test("sem conector conectado, não dispara", () => {
    expect(aoAbrir(retrato(), NADA_LIDO)).toEqual({ dispara: false, motivo: "nada_conectado" });
  });

  test("fonte conectada sem leitura dispara", () => {
    expect(aoAbrir(retrato({ crm: CRM_CONECTADO }), NADA_LIDO)).toEqual({ dispara: true, motivo: "sem_leitura", fonte: "agenda" });
  });

  test("dispara com a leitura mais velha acima de 30 minutos, e não com 30 minutos ou menos", () => {
    const conectores = retrato({ crm: CRM_CONECTADO, whatsapp: WA_CONECTADO });
    const velha = { ...lidoTudo(antesDeAgora(5 * MINUTO)), conversas: antesDeAgora(LEITURA_VELHA_MS + 1) };
    expect(aoAbrir(conectores, velha)).toEqual({ dispara: true, motivo: "leitura_velha", fonte: "conversas" });
    expect(aoAbrir(conectores, { ...velha, conversas: antesDeAgora(LEITURA_VELHA_MS) })).toEqual({ dispara: false, motivo: "leitura_recente" });
  });

  test("só conta a fonte conectada: a leitura velha de um conector desconectado não dispara", () => {
    const lido = { ...lidoTudo(antesDeAgora(5 * MINUTO)), conversas: antesDeAgora(3 * LEITURA_VELHA_MS) };
    expect(aoAbrir(retrato({ crm: CRM_CONECTADO }), lido)).toEqual({ dispara: false, motivo: "leitura_recente" });
  });

  test("o e-mail vale pela conta conectada lida há mais tempo, e a conta conectada nunca lida dispara", () => {
    const conectores = retrato({ contas: [conta(ID_A, EMAIL_CONECTADO), conta(ID_B, EMAIL_CONECTADO)] });
    const recente = antesDeAgora(5 * MINUTO);
    expect(aoAbrir(conectores, { ...NADA_LIDO, email: new Map([[ID_A, recente]]) })).toEqual({ dispara: true, motivo: "sem_leitura", fonte: "email" });
    expect(aoAbrir(conectores, { ...NADA_LIDO, email: new Map([[ID_A, recente], [ID_B, antesDeAgora(LEITURA_VELHA_MS + MINUTO)]]) })).toEqual({ dispara: true, motivo: "leitura_velha", fonte: "email" });
    expect(aoAbrir(conectores, { ...NADA_LIDO, email: new Map([[ID_A, recente], [ID_B, recente]]) })).toEqual({ dispara: false, motivo: "leitura_recente" });
  });

  test("uma rodada há 30 minutos ou menos segura a próxima, mesmo com fonte sem leitura: o erro não se repete sozinho", () => {
    const conectores = retrato({ crm: CRM_CONECTADO });
    expect(aoAbrir(conectores, NADA_LIDO, { ultimaRodadaEm: antesDeAgora(LEITURA_VELHA_MS) })).toEqual({ dispara: false, motivo: "rodou_ha_pouco" });
    expect(aoAbrir(conectores, NADA_LIDO, { ultimaRodadaEm: antesDeAgora(LEITURA_VELHA_MS + 1) })).toEqual({ dispara: true, motivo: "sem_leitura", fonte: "agenda" });
  });

  test("com o CRM pedindo espera, não dispara, e depois da espera dispara", () => {
    const conectores = retrato({ crm: CRM_CONECTADO });
    expect(aoAbrir(conectores, NADA_LIDO, { esperarAte: "2026-11-14T12:00:01.000Z" as Instante })).toEqual({ dispara: false, motivo: "crm_pediu_espera" });
    expect(aoAbrir(conectores, NADA_LIDO, { esperarAte: AGORA })).toEqual({ dispara: true, motivo: "sem_leitura", fonte: "agenda" });
  });
});

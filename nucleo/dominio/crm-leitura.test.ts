import { describe, expect, test } from "bun:test";
import {
  SEM_LEITURAS,
  diaEm,
  diasEntre,
  faixaDaProposta,
  ignoradosPeloAgente,
  lerMotivo,
  montarBlocosDoCrm,
  propostaAberta,
  soOVendedorIgnora,
  somarAoDia,
  textoExterno,
  type Dia,
  type EstadoCrm,
  type Instante,
  type PropostaEnviada,
} from "./index";

const HOJE = "2026-11-13" as Dia;
const LIDO = "2026-11-13T12:00:00.000Z" as Instante;
const CONECTADO: EstadoCrm = { fase: "conectado", conexaoExpiraEm: LIDO, verificadoEm: LIDO, ferramentas: 18 };

function proposta(enviadaHaDias: number, prazo: Dia | null = null): PropostaEnviada {
  return {
    id: 1,
    codigo: textoExterno("0001/26"),
    versao: 1,
    cliente: { id: 2, nome: textoExterno("CANARIO") },
    valor_total: "10.00",
    moeda: "BRL",
    enviada_em: somarAoDia(HOJE, -enviadaHaDias),
    prazo_retorno: prazo,
    link: null,
  };
}

describe("quem pode ignorar uma proposta", () => {
  // Prazo de retorno em 20/11. Às 23h30 de Brasília do dia 12 já é dia 13 em UTC.
  const prazo = "2026-11-20" as Dia;
  const comPrazo: PropostaEnviada = { ...proposta(0), enviada_em: somarAoDia(prazo, -30), prazo_retorno: prazo };

  test.each([
    ["2026-11-13T02:30:00.000Z", "2026-11-12", false],
    ["2026-11-13T02:59:59.999Z", "2026-11-12", false],
    ["2026-11-13T03:00:00.000Z", "2026-11-13", true],
    ["2026-11-20T12:00:00.000Z", "2026-11-20", true],
    ["2026-11-25T12:00:00.000Z", "2026-11-25", true],
  ])("em %s (dia %s em Brasília), só o vendedor ignora: %p", (instante, dia, soOVendedor) => {
    const hoje = diaEm(instante as Instante);
    expect(hoje).toBe(dia as Dia);
    expect(soOVendedorIgnora(comPrazo, hoje)).toBe(soOVendedor);
  });

  test("sem prazo_retorno, conta do envio mais 30 dias", () => {
    expect(soOVendedorIgnora(proposta(22), HOJE)).toBe(false);
    expect(soOVendedorIgnora(proposta(23), HOJE)).toBe(true);
  });
});

describe("motivo de ignorar", () => {
  test.each([
    ["  Cliente viajando  ", "Cliente viajando"],
    ["Férias", "Férias"],
    ["x".repeat(300), "x".repeat(300)],
  ])("%p vale", (texto, esperado) => {
    expect(lerMotivo(texto)).toBe(esperado);
  });

  test.each([["oi"], ["    abcd    "], ["x".repeat(301)], ["Cliente\nviajando"], ["Cliente\u0007 viajando"], ["Cliente\u200b viajando"]])("%p não vale", (texto) => {
    expect(lerMotivo(texto)).toBeNull();
  });

  test("a lista do agente leva só as marcas dele, das que voltam antes para as que voltam depois", () => {
    const base = { nome: textoExterno("CANARIO"), codigo: null } as const;
    const lista = ignoradosPeloAgente([
      { ...base, tipo: "cliente", id: 3, quem: "agente", motivo: "Cliente viajando", ate: "2026-11-21" as Dia },
      { ...base, tipo: "cliente", id: 2, quem: "vendedor", motivo: null, ate: "2026-11-19" as Dia },
      { ...base, tipo: "proposta", id: 1, quem: "agente", motivo: "Esperando a obra", ate: "2026-11-20" as Dia },
    ]);
    expect(lista.map((item) => [item.tipo, item.id, item.motivo])).toEqual([
      ["proposta", 1, "Esperando a obra"],
      ["cliente", 3, "Cliente viajando"],
    ]);
  });
});

describe("propostas abertas", () => {
  test.each([
    [0, null],
    [6, null],
    [7, 7],
    [13, 7],
    [14, 14],
    [27, 14],
    [28, 28],
    [29, 28],
    [45, 28],
  ])("%i dias desde o envio dá a faixa %p", (dias, faixa) => {
    expect(faixaDaProposta(dias)).toBe(faixa as never);
  });

  test("o prazo vence no dia do prazo de retorno: 30 dias é vencido, 29 não", () => {
    expect(propostaAberta(proposta(29, somarAoDia(HOJE, 1)), HOJE)).toMatchObject({ dias_desde_envio: 29, dias_para_o_prazo: 1, prazo_vencido: false });
    expect(propostaAberta(proposta(30, HOJE), HOJE)).toMatchObject({ dias_desde_envio: 30, dias_para_o_prazo: 0, prazo_vencido: true });
  });

  test("sem prazo_retorno, o prazo é o envio mais 30 dias", () => {
    expect(propostaAberta(proposta(31), HOJE)).toMatchObject({ dias_para_o_prazo: -1, prazo_vencido: true });
  });

  test("dias de calendário atravessam a virada de mês e de ano", () => {
    expect(diasEntre("2026-12-30" as Dia, "2027-01-02" as Dia)).toBe(3);
    expect(somarAoDia("2026-02-27" as Dia, 2)).toBe("2026-03-01" as Dia);
  });
});

describe("motivo do bloco vazio", () => {
  test.each<[EstadoCrm, string]>([
    [{ fase: "desconectado" }, "crm_desconectado"],
    [{ fase: "autorizando", expiraEm: LIDO, anterior: { fase: "desconectado" } }, "crm_autorizando"],
    [{ fase: "atencao", problema: { codigo: "crm_app_nao_liberado", desde: LIDO } }, "crm_app_nao_liberado"],
    [{ fase: "atencao", problema: { codigo: "crm_conexao_vencida", desde: LIDO } }, "crm_em_atencao"],
    [CONECTADO, "sem_leitura"],
  ])("sem leitura, o CRM em %p dá %s", (crm, motivo) => {
    const blocos = montarBlocosDoCrm(SEM_LEITURAS, crm, HOJE);
    for (const bloco of [blocos.compromissos_de_hoje, blocos.propostas_abertas, blocos.clientes_sem_atendimento]) {
      expect(bloco).toEqual({ ...bloco, itens: [], lido_em: null, motivo: motivo as never, cortado: false });
    }
  });

  test("leitura feita e lista vazia é sem_itens, com o lido_em", () => {
    const blocos = montarBlocosDoCrm({ agenda: { dia: HOJE, itens: [], cortado: false, foraPorCadastroIncompleto: 0, lidoEm: LIDO }, propostas: null, carteira: null }, CONECTADO, HOJE);
    expect(blocos.compromissos_de_hoje).toEqual({ itens: [], lido_em: LIDO, motivo: "sem_itens", cortado: false, fora_por_cadastro_incompleto: 0 });
  });

  test("a agenda lida ontem não serve para hoje", () => {
    const ontem = somarAoDia(HOJE, -1);
    const blocos = montarBlocosDoCrm({ agenda: { dia: ontem, itens: [], cortado: false, foraPorCadastroIncompleto: 0, lidoEm: LIDO }, propostas: null, carteira: null }, CONECTADO, HOJE);
    expect(blocos.compromissos_de_hoje.motivo).toBe("sem_leitura");
  });

  test("leitura guardada aparece mesmo com o CRM desconectado depois, com o lido_em dela", () => {
    const blocos = montarBlocosDoCrm({ agenda: null, propostas: { itens: [proposta(10)], cortado: true, foraPorCadastroIncompleto: 0, lidoEm: LIDO }, carteira: null }, { fase: "desconectado" }, HOJE);
    expect(blocos.propostas_abertas).toMatchObject({ lido_em: LIDO, motivo: null, cortado: true });
    expect(blocos.propostas_abertas.itens.map((p) => p.faixa)).toEqual([7]);
  });
});

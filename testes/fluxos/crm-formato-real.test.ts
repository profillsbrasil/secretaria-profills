import { afterEach, beforeEach, expect, test } from "bun:test";
import { Segredo } from "../../nucleo/cofre";
import { criarLeitor, type LeitorDoCrm } from "../../nucleo/conectores/crm/leitura";
import type { Resultado } from "../../nucleo/dominio";
import { iniciarCrmFalso, type CrmFalso } from "../falsos/crm";

/**
 * Cada corpo aqui copia, campo a campo, o que o MCP do CRM devolve, no formato conferido contra o CRM em 14/11/2026
 * e na documentação do MCP: a resposta do CRM vem crua, salvo a proposta, que vem com os nomes da lista (`codigo`,
 * `estagio` e `cliente` com `id` e `nome`). Data e hora vêm em ISO com `-03:00`, e o dia, em `AAAA-MM-DD`.
 * O teste não usa os dados do falso: um falso que se afaste do CRM não esconde a diferença.
 */

let crm: CrmFalso;
let leitor: LeitorDoCrm;

beforeEach(() => {
  crm = iniciarCrmFalso();
  leitor = criarLeitor(
    crm.recurso,
    { token: async () => Segredo.de(crm.emitirAcesso()), origemDasTelas: async () => crm.origem, recusado: () => {}, vencido: () => {} },
    new AbortController().signal,
  );
});

afterEach(async () => {
  await crm.parar();
});

function dados<T>(resultado: Resultado<T>): T {
  if (!resultado.ok) throw new Error(`a leitura falhou: ${JSON.stringify(resultado.erro)}`);
  return resultado.dados;
}

const cliente = { id: 9101, nome: "CANARIO Cliente" };

test("minha_agenda: a lista vem em `compromissos`, com `de`, `ate`, `descricao` e `via_app`", async () => {
  crm.botoes.respostasCruas.set("minha_agenda", {
    de: "2026-11-14",
    ate: "2026-11-14",
    compromissos: [
      { id: 601, titulo: "CANARIO Visita", descricao: "CANARIO texto", inicio: "2026-11-14T15:30:00-03:00", fim: "2026-11-14T16:30:00-03:00", tipo: "client", cliente, via_app: null },
      { id: 602, titulo: "CANARIO Interno", descricao: null, inicio: "2026-11-14T10:00:00-03:00", fim: null, tipo: "internal", cliente: null, via_app: "secretaria" },
    ],
    mais: false,
  });
  const agenda = dados(await leitor.ler("minha_agenda", { de: "2026-11-14", ate: "2026-11-14" }));
  expect(agenda.mais).toBe(false);
  expect(agenda.compromissos).toEqual([
    { id: 601, titulo: "CANARIO Visita", inicio: "2026-11-14T18:30:00.000Z", fim: "2026-11-14T19:30:00.000Z", tipo: "client", cliente },
    { id: 602, titulo: "CANARIO Interno", inicio: "2026-11-14T13:00:00.000Z", fim: null, tipo: "internal", cliente: null },
  ] as never);
});

test("listar_propostas: a lista vem em `propostas`, com `responsavel` e as datas do fechamento", async () => {
  crm.botoes.respostasCruas.set("listar_propostas", {
    propostas: [
      {
        id: 7101,
        codigo: "0071/26",
        versao: 2,
        estagio: "enviada",
        responsavel: { id: 77, nome: "CANARIO Vendedor" },
        valor_total: "1500.00",
        moeda: "BRL",
        data_envio: "2026-11-11T09:00:00-03:00",
        cliente,
        prazo_retorno: "2026-12-11",
        valor_final: null,
        fechada_em: null,
        atualizado_em: "2026-11-11T09:00:00-03:00",
      },
    ],
    mais: true,
  });
  const lista = dados(await leitor.ler("listar_propostas", { escopo: "minhas", estagio: "enviada" }));
  expect(lista.mais).toBe(true);
  expect(lista.propostas).toEqual([
    { id: 7101, codigo: "0071/26", versao: 2, estagio: "enviada", cliente, valor_total: "1500.00", moeda: "BRL", data_envio: "2026-11-11", prazo_retorno: "2026-12-11", responsavel: { id: 77, nome: "CANARIO Vendedor" } },
  ] as never);
});

test("listar_propostas: `responsavel` ausente ou fora do formato vira null, sem tirar a proposta da lista", async () => {
  const base = { codigo: "0072/26", versao: 1, estagio: "enviada", valor_total: null, moeda: null, data_envio: "2026-11-11", cliente, prazo_retorno: null };
  crm.botoes.respostasCruas.set("listar_propostas", { propostas: [{ id: 7102, ...base }, { id: 7103, ...base, responsavel: "Marina" }], mais: false });
  const lista = dados(await leitor.ler("listar_propostas", { escopo: "minhas", estagio: "enviada" }));
  expect(lista.fora_por_cadastro_incompleto).toBe(0);
  expect(lista.propostas.map((proposta) => [proposta.id, proposta.responsavel])).toEqual([
    [7102, null],
    [7103, null],
  ]);
});

test("ver_proposta: os nomes que o MCP dá ao detalhe do CRM", async () => {
  crm.botoes.respostasCruas.set("ver_proposta", {
    id: 7101,
    codigo: "0071/26",
    versao: 2,
    ativa: 1,
    estagio: "cliente_aceitou",
    vendedor_nome: "CANARIO Vendedor",
    data_solicitacao: "2026-11-01T08:00:00-03:00",
    data_envio: "2026-11-11T09:00:00-03:00",
    moeda: "BRL",
    taxa_cambio: "1.0000",
    valor_total: "1500.00",
    forma_escolhida: { nome: "CANARIO À vista", tipo_pagamento: "avista", valor_final: "1350.00", numero_parcelas: null, valor_parcela: null, valor_entrada: null },
    maquinas: [],
    embalagens: [],
    acessorios: [],
    versoes: [{ id: 7101, versao: 2, estagio: "cliente_aceitou", ativa: 1, criada_em: "2026-11-01T08:00:00-03:00" }],
    follow_ups: [],
    link: `${crm.origem}/proposals/7101`,
    cliente,
  });
  expect(dados(await leitor.ler("ver_proposta", { proposta_id: 7101 }))).toEqual({
    id: 7101,
    codigo: "0071/26",
    versao: 2,
    ativa: true,
    estagio: "cliente_aceitou",
    cliente,
    link: `${crm.origem}/proposals/7101`,
    valor_final: "1350.00",
  } as never);
});

test("minha_carteira: a lista vem em `clientes`, com `proximo_cursor`", async () => {
  crm.botoes.respostasCruas.set("minha_carteira", {
    clientes: [
      { id: 8101, nome: "CANARIO Cliente 8101", nome_fantasia: null, cidade: "Curitiba", uf: "PR", ultimo_atendimento_em: null, ultimo_atendimento_aproximado: false },
      { id: 8102, nome: "CANARIO Cliente 8102", nome_fantasia: "CANARIO Fantasia", cidade: null, uf: null, ultimo_atendimento_em: "2026-06-30T11:00:00-03:00", ultimo_atendimento_aproximado: true },
    ],
    mais: true,
    proximo_cursor: "1782828000:8102",
  });
  const carteira = dados(await leitor.ler("minha_carteira", { sem_atendimento_ha_dias: 30 }));
  expect(carteira.proximo_cursor).toBe("1782828000:8102");
  expect(carteira.clientes.map((c) => [c.id, c.ultimo_atendimento_em, c.ultimo_atendimento_aproximado])).toEqual([
    [8101, null, false],
    [8102, "2026-06-30T14:00:00.000Z", true],
  ] as never);
});

test("buscar_clientes: a lista vem em `clientes`, com os rótulos e os contatos do CRM; vazia traz `dica`", async () => {
  crm.botoes.respostasCruas.set("buscar_clientes", {
    clientes: [
      {
        id: 8101,
        nome: "CANARIO Cliente 8101",
        nome_fantasia: null,
        cpf_cnpj: "11222333000181",
        status: "Ativo",
        cidade: "Curitiba",
        uf: "PR",
        vendedor_id: 77,
        vendedor_nome: "CANARIO Vendedor",
        bateu_em: ["contato_telefone"],
        contatos: [{ id: 51, nome: "CANARIO Contato", telefone: "(41) 98888-0001", email: "compras@canario.exemplo.test", cargo: null }],
      },
    ],
    mais: false,
  });
  const busca = dados(await leitor.ler("buscar_clientes", { q: "41988880001" }));
  expect(busca.clientes).toEqual([
    { id: 8101, nome: "CANARIO Cliente 8101", cidade: "Curitiba", uf: "PR", bateu_em: ["contato_telefone"], contatos: [{ telefone: "(41) 98888-0001", email: "compras@canario.exemplo.test" }] },
  ] as never);

  crm.botoes.respostasCruas.set("buscar_clientes", { clientes: [], mais: false, dica: "O termo foi lido como número." });
  expect(dados(await leitor.ler("buscar_clientes", { q: "41988880009" })).clientes).toEqual([]);
});

test("ver_cliente: a ficha do CRM", async () => {
  crm.botoes.respostasCruas.set("ver_cliente", {
    id: 8101,
    nome: "CANARIO Cliente 8101",
    nome_fantasia: null,
    cpf_cnpj: null,
    status: "Ativo",
    telefone: null,
    email: null,
    cidade: "Curitiba",
    uf: "PR",
    segmento: null,
    dono: { id: 77, nome: "CANARIO Vendedor" },
    secundarios: [],
    contatos: [],
    atendimentos: [],
    mais_atendimentos: false,
    propostas: [],
    compromissos: [],
    mais_compromissos: false,
    link: `${crm.origem}/clientes/8101`,
  });
  expect(dados(await leitor.ler("ver_cliente", { cliente_id: 8101 }))).toEqual({ id: 8101, nome: "CANARIO Cliente 8101", cidade: "Curitiba", uf: "PR", link: `${crm.origem}/clientes/8101` } as never);
});

test("meus_atendimentos: a lista vem em `atendimentos`, com a data do instante em Brasília", async () => {
  crm.botoes.respostasCruas.set("meus_atendimentos", {
    // 23h30 de Brasília já é o dia seguinte em UTC: o dia que vale é o de Brasília.
    atendimentos: [{ id: 9501, assunto: "CANARIO Assunto", status: "Pendente", data: "2026-11-13T23:30:00-03:00", cliente }],
    mais: false,
  });
  const lida = dados(await leitor.ler("meus_atendimentos", {}));
  expect(lida.atendimentos.map((a) => [a.id, a.status, a.data, a.cliente])).toEqual([[9501, "Pendente", "2026-11-13", cliente]] as never);
});

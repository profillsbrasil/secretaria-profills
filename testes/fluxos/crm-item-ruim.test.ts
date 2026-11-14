import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { listarTarefas } from "../../nucleo/banco";
import { Segredo } from "../../nucleo/cofre";
import type { Conectores, ResultadoDaFonte, Sincronizacao } from "../../nucleo/conectores";
import { criarLeitor, type LeitorDoCrm } from "../../nucleo/conectores/crm/leitura";
import { diaEm, montarRelatorio, type Dia, type Resultado } from "../../nucleo/dominio";
import { montarMeuDia } from "../../nucleo/tarefas";
import { montarBancada, type Bancada } from "../falsos/bancada";
import { atendimentoFalso, iniciarCrmFalso, propostaFalsa, type CrmFalso } from "../falsos/crm";

/**
 * Um cadastro antigo do CRM pode vir com um campo obrigatório vazio. O item fica de fora e é contado;
 * os outros itens da lista chegam ao vendedor. O texto do item descartado não sai em lugar nenhum.
 */

setDefaultTimeout(30_000);

let crm: CrmFalso;
let bancada: Bancada | null = null;

afterEach(async () => {
  await bancada?.limpar();
  bancada = null;
  await crm.parar();
});

function leitorDireto(): LeitorDoCrm {
  crm = iniciarCrmFalso();
  return criarLeitor(
    crm.recurso,
    { token: async () => Segredo.de(crm.emitirAcesso()), origemDasTelas: async () => crm.origem, recusado: () => {}, vencido: () => {} },
    new AbortController().signal,
  );
}

function dados<T>(resultado: Resultado<T>): T {
  if (!resultado.ok) throw new Error(`a leitura falhou: ${JSON.stringify(resultado.erro)}`);
  return resultado.dados;
}

const cliente = { id: 9101, nome: "CANARIO Cliente" };
const SEGREDO_DO_ITEM = "CANARIO-ITEM-DESCARTADO";

describe("leitura: um item com campo obrigatório vazio fica de fora e é contado", () => {
  test("minha_agenda: compromisso sem título", async () => {
    const leitor = leitorDireto();
    crm.botoes.respostasCruas.set("minha_agenda", {
      compromissos: [
        { id: 601, titulo: "CANARIO Visita", inicio: "2026-11-14T15:30:00-03:00", fim: null, tipo: "client", cliente },
        { id: 602, titulo: null, inicio: "2026-11-14T16:30:00-03:00", fim: null, tipo: SEGREDO_DO_ITEM, cliente },
        { id: 603, titulo: "CANARIO Ligação", inicio: "2026-11-14T17:30:00-03:00", fim: null, tipo: "client", cliente: null },
      ],
      mais: false,
    });
    const agenda = dados(await leitor.ler("minha_agenda", {}));
    expect(agenda.compromissos.map((c) => c.id)).toEqual([601, 603]);
    expect(agenda.fora_por_cadastro_incompleto).toBe(1);
    expect(JSON.stringify(agenda)).not.toContain(SEGREDO_DO_ITEM);
  });

  test("listar_propostas: proposta sem estágio, no meio", async () => {
    const leitor = leitorDireto();
    const { estagio: _estagio, ...semEstagio } = propostaFalsa(7102, "enviada", "2026-11-10" as Dia, { codigo: SEGREDO_DO_ITEM });
    crm.botoes.respostasCruas.set("listar_propostas", { propostas: [propostaFalsa(7103, "enviada", "2026-11-11" as Dia), semEstagio, propostaFalsa(7101, "enviada", "2026-11-09" as Dia)], mais: true });
    const lista = dados(await leitor.ler("listar_propostas", { escopo: "minhas", estagio: "enviada" }));
    expect(lista.propostas.map((p) => p.id)).toEqual([7103, 7101]);
    expect(lista.fora_por_cadastro_incompleto).toBe(1);
    expect(lista.mais).toBe(true);
  });

  test("minha_carteira: cliente sem nome", async () => {
    const leitor = leitorDireto();
    crm.botoes.respostasCruas.set("minha_carteira", {
      clientes: [
        { id: 8101, nome: "CANARIO Cliente 8101", nome_fantasia: null, cidade: null, uf: null, ultimo_atendimento_em: null },
        { id: 8102, nome: null, nome_fantasia: SEGREDO_DO_ITEM, cidade: null, uf: null, ultimo_atendimento_em: null },
      ],
      mais: true,
      proximo_cursor: "c:2",
    });
    const carteira = dados(await leitor.ler("minha_carteira", {}));
    expect(carteira.clientes.map((c) => c.id)).toEqual([8101]);
    expect(carteira.fora_por_cadastro_incompleto).toBe(1);
    expect(carteira.proximo_cursor).toBe("c:2");
  });

  test("buscar_clientes: cliente sem o campo nome", async () => {
    const leitor = leitorDireto();
    crm.botoes.respostasCruas.set("buscar_clientes", {
      clientes: [
        { id: 8101, nome: "CANARIO Cliente 8101", cidade: null, uf: null },
        { id: 8102, cidade: SEGREDO_DO_ITEM, uf: null },
      ],
      mais: false,
    });
    const busca = dados(await leitor.ler("buscar_clientes", { q: "CANARIO" }));
    expect(busca.clientes.map((c) => c.id)).toEqual([8101]);
    expect(busca.fora_por_cadastro_incompleto).toBe(1);
  });

  test("meus_atendimentos: atendimento sem assunto", async () => {
    const leitor = leitorDireto();
    crm.botoes.respostasCruas.set("meus_atendimentos", {
      atendimentos: [
        { id: 9503, assunto: "CANARIO Assunto", status: "Pendente", data: "2026-11-13", cliente },
        { id: 9502, assunto: null, status: "Pendente", data: "2026-11-13", cliente: { id: 1, nome: SEGREDO_DO_ITEM } },
        { id: 9501, assunto: "CANARIO Outro", status: "Pendente", data: "2026-11-12", cliente },
      ],
      mais: false,
    });
    const lida = dados(await leitor.ler("meus_atendimentos", {}));
    expect(lida.atendimentos.map((a) => a.id)).toEqual([9503, 9501]);
    expect(lida.fora_por_cadastro_incompleto).toBe(1);
  });

  test("o item descartado no fim da página ainda é o `antes` da próxima", async () => {
    const leitor = leitorDireto();
    crm.botoes.respostasCruas.set("meus_atendimentos", {
      atendimentos: [
        { id: 9503, assunto: "CANARIO Assunto", status: "Pendente", data: "2026-11-13", cliente },
        { id: 9502, assunto: null, status: "Pendente", data: "2026-11-13", cliente },
      ],
      mais: true,
    });
    const lida = dados(await leitor.ler("meus_atendimentos", {}));
    expect(lida.ultimo_id).toBe(9502);
  });
});

describe("leitura: formato desconhecido continua crm_resposta_inesperada", () => {
  test("todos os itens inválidos", async () => {
    const leitor = leitorDireto();
    crm.botoes.respostasCruas.set("minha_carteira", { clientes: [{ id: 1, nome: null }, { id: 2 }], mais: false, proximo_cursor: null });
    const lida = await leitor.ler("minha_carteira", {});
    expect(!lida.ok && lida.erro.codigo).toBe("crm_resposta_inesperada");
  });

  test("lista ausente, `mais` com tipo errado e corpo que não é objeto", async () => {
    const leitor = leitorDireto();
    for (const corpo of [{ mais: false }, { compromissos: [], mais: "não" }, [1, 2], "texto", { compromissos: "lista", mais: false }]) {
      crm.botoes.respostasCruas.set("minha_agenda", corpo);
      const lida = await leitor.ler("minha_agenda", {});
      expect(!lida.ok && lida.erro.codigo).toBe("crm_resposta_inesperada");
    }
  });

  test("lista vazia é lista vazia, sem nada de fora", async () => {
    const leitor = leitorDireto();
    crm.botoes.respostasCruas.set("minha_agenda", { compromissos: [], mais: false });
    expect(dados(await leitor.ler("minha_agenda", {}))).toMatchObject({ compromissos: [], fora_por_cadastro_incompleto: 0 });
  });

  test("o erro da lista toda ruim não leva o texto dos itens", async () => {
    const leitor = leitorDireto();
    crm.botoes.respostasCruas.set("minha_agenda", { compromissos: [{ id: 1, titulo: null, tipo: SEGREDO_DO_ITEM }], mais: false });
    const lida = await leitor.ler("minha_agenda", {});
    expect(lida.ok).toBe(false);
    expect(JSON.stringify(lida)).not.toContain(SEGREDO_DO_ITEM);
  });
});

async function ligado(): Promise<Conectores> {
  crm = iniciarCrmFalso({ agora: () => Date.parse(bancada?.ambiente.agora() ?? new Date().toISOString()) });
  bancada = montarBancada({ crmRecurso: crm.recurso, crmClientId: crm.clientId, porta: 47_118 });
  const conectores = bancada.ligar();
  await conectores.pronto;
  const pedido = await conectores.agir("crm", "conectar");
  if (!pedido.ok || pedido.dados.urlAutorizacao === null) throw new Error("conectar não devolveu a URL");
  const retorno = await conectores.retornoDoCrm(await crm.autorizar(pedido.dados.urlAutorizacao));
  expect(retorno.ok && retorno.dados.fase).toBe("conectado");
  return conectores;
}

function fonte(rodada: Sincronizacao, nome: ResultadoDaFonte["fonte"]): ResultadoDaFonte {
  const achada = rodada.fontes.find((f) => f.fonte === nome);
  if (achada === undefined) throw new Error(`sem a fonte ${nome}`);
  return achada;
}

describe("sincronização e Meu dia: a contagem chega a quem mostra", () => {
  test("um item ruim em cada fonte do CRM: as fontes leem, contam e o Meu dia mostra os outros", async () => {
    const conectores = await ligado();
    const hoje = crm.dia();
    crm.dados.compromissos.push({ id: 590, titulo: null, inicio: `${hoje}T11:00:00-03:00`, fim: null, tipo: "client", cliente: null });
    crm.dados.propostas.push({ ...propostaFalsa(7050, "enviada", crm.dia(-4)), cliente: { id: 9050, nome: null } });
    crm.dados.carteira.push({ id: 8050, nome: null, cidade: null, uf: null, ultimo_atendimento_em: null });

    const rodada = await conectores.sincronizar();
    expect(fonte(rodada, "agenda")).toMatchObject({ situacao: "leu", itens: 2, foraPorCadastroIncompleto: 1 });
    expect(fonte(rodada, "propostas")).toMatchObject({ situacao: "leu", itens: 5, foraPorCadastroIncompleto: 1 });
    expect(fonte(rodada, "carteira")).toMatchObject({ situacao: "leu", itens: 3, foraPorCadastroIncompleto: 1 });

    const agora = bancada!.ambiente.agora();
    const dia = montarMeuDia(listarTarefas(bancada!.banco, "aberta"), conectores.estado(), agora, diaEm(agora), conectores.leiturasDoCrm());
    expect(dia.compromissos_de_hoje).toMatchObject({ fora_por_cadastro_incompleto: 1 });
    expect(dia.compromissos_de_hoje.itens).toHaveLength(2);
    expect(dia.propostas_abertas).toMatchObject({ fora_por_cadastro_incompleto: 1 });
    expect(dia.propostas_abertas.itens).toHaveLength(5);
    expect(dia.clientes_sem_atendimento).toMatchObject({ fora_por_cadastro_incompleto: 1 });
  });

  test("sem item ruim, a contagem é zero", async () => {
    const conectores = await ligado();
    const rodada = await conectores.sincronizar();
    for (const nome of ["agenda", "propostas", "carteira"] as const) expect(fonte(rodada, nome)).toMatchObject({ situacao: "leu", foraPorCadastroIncompleto: 0 });
  });

  test("proposta ruim no fim da página: a próxima começa depois dela e ela conta uma vez", async () => {
    const conectores = await ligado();
    crm.dados.propostas.splice(0, crm.dados.propostas.length, ...Array.from({ length: 60 }, (_, i) => propostaFalsa(7200 + i, "enviada", crm.dia(-2))));
    // Ordem decrescente de id: a página 1 vai de 7259 a 7210, e 7210 é a última.
    const ultima = crm.dados.propostas.find((p) => p.id === 7210);
    if (ultima === undefined) throw new Error("sem a proposta 7210");
    ultima.codigo = null;
    const rodada = await conectores.sincronizar();
    expect(fonte(rodada, "propostas")).toMatchObject({ situacao: "leu", itens: 59, foraPorCadastroIncompleto: 1, cortado: false });
    const antes = crm.registro().chamadasDeFerramenta.filter((c) => c.nome === "listar_propostas").map((c) => c.argumentos.antes);
    expect(antes).toEqual([undefined, 7210]);
  });
});

describe("relatório: a contagem dos atendimentos de fora", () => {
  test("atendimento ruim no fim da página: o `antes` é o dele, conta uma vez e o relatório diz quantos", async () => {
    const conectores = await ligado();
    const desde: Dia = crm.dia(-1);
    for (let id = 1; id <= 60; id += 1) crm.dados.atendimentos.push(atendimentoFalso(id, "Concluído", desde, id === 11 ? { assunto: null } : {}));
    const lido = await conectores.atendimentosDesde(desde);
    expect(lido).toMatchObject({ tipo: "lido", cortado: false, foraPorCadastroIncompleto: 1 });
    expect(lido.tipo === "lido" && lido.itens).toHaveLength(59);
    const antes = crm.registro().chamadasDeFerramenta.filter((c) => c.nome === "meus_atendimentos" && c.argumentos.status === "Concluído").map((c) => c.argumentos.antes);
    expect(antes).toEqual([undefined, 11]);

    const agora = bancada!.ambiente.agora();
    const relatorio = montarRelatorio({ de: desde, ate: diaEm(agora), padrao: false }, lido, [], agora);
    expect(relatorio.atendimentos.fora_por_cadastro_incompleto).toBe(1);
    expect(relatorio.contagens.atendimentos).toBe(59);
  });
});

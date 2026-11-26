import { describe, expect, test } from "bun:test";
import { ERROS, type Dia, type Instante } from "../dominio";
import type { Tarefa } from "../tarefas";
import { criarApiDeTarefas, type Buscar } from "./api";
import {
  AVISO_DE_MUDANCA,
  PASSO_FECHADO,
  avisoDoErro,
  avisoDoFeito,
  diaPorExtenso,
  formatarDia,
  idadeEmTexto,
  lerNota,
  lerNovaTarefa,
  pedidoDoPasso,
  reduzirPasso,
  rodapeDasFontes,
  rotuloDoPrazo,
  somarDias,
  type Passo,
} from "./tarefas";

const HOJE = "2026-11-11" as Dia;
const ISO = "2026-11-11T12:00:00.000Z" as Instante;

function tarefa(id: string, campos: Partial<Tarefa> = {}): Tarefa {
  return {
    id,
    titulo: `Tarefa ${id}`,
    clienteId: null,
    clienteNome: null,
    clienteConferido: false,
    propostaCodigo: null,
    venceEm: null,
    estado: "aberta",
    origem: "vendedor",
    versao: 3,
    criadaEm: ISO,
    atualizadaEm: ISO,
    conversa: null,
    ...campos,
  };
}

describe("datas em pt-BR", () => {
  test.each([
    ["2026-11-11", "hoje"],
    ["2026-11-12", "amanhã"],
    ["2026-11-10", "ontem"],
    ["2026-11-03", "3 de novembro"],
    ["2026-03-01", "1 de março"],
    ["2027-01-09", "9 de janeiro de 2027"],
  ])("%s é %s", (dia, texto) => {
    expect(formatarDia(dia as Dia, HOJE)).toBe(texto);
  });

  test("dia por extenso para o cabeçalho", () => {
    expect(diaPorExtenso(HOJE)).toBe("Quarta-feira, 11 de novembro");
  });

  test("somar dias atravessa mês e ano", () => {
    expect(somarDias("2026-12-31" as Dia, 1)).toBe("2027-01-01" as Dia);
    expect(somarDias("2026-03-01" as Dia, -1)).toBe("2026-02-28" as Dia);
  });

  test.each([
    [null, "Sem data", "sem_data"],
    ["2026-11-10", "Venceu ontem", "atrasada"],
    ["2026-11-02", "Venceu em 2 de novembro", "atrasada"],
    ["2026-11-11", "Vence hoje", "hoje"],
    ["2026-11-12", "Vence amanhã", "futura"],
    ["2026-11-20", "Vence em 20 de novembro", "futura"],
  ])("prazo %s vira %s", (venceEm, texto, tom) => {
    expect(rotuloDoPrazo(venceEm as Dia | null, HOJE)).toEqual({ texto, tom: tom as never });
  });

  test.each([
    [null, "não conectado"],
    [0, "agora"],
    [5, "há 5 min"],
    [59, "há 59 min"],
    [60, "há 1 h"],
    [23 * 60 + 59, "há 23 h"],
    [24 * 60, "há 1 dia"],
    [3 * 24 * 60, "há 3 dias"],
  ])("idade %s é %s", (minutos, texto) => {
    expect(idadeEmTexto(minutos)).toBe(texto);
  });

  test("rodapé dá nome a cada fonte", () => {
    const fontes = [
      { fonte: "tarefas", lidaEm: ISO, idadeMin: 0 },
      { fonte: "whatsapp", lidaEm: ISO, idadeMin: 3 },
      { fonte: "crm", lidaEm: null, idadeMin: null },
    ] as const;
    expect(rodapeDasFontes(fontes)).toEqual([
      { fonte: "tarefas", nome: "Tarefas", idade: "agora" },
      { fonte: "whatsapp", nome: "WhatsApp", idade: "há 3 min" },
      { fonte: "crm", nome: "CRM", idade: "não conectado" },
    ]);
  });

  test.each<[number, number, number | null, string]>([
    [1, 1, 5, "há 5 min"],
    [1, 0, null, "não conectado"],
    [2, 1, 5, "1 de 2 contas, há 5 min"],
    [2, 2, 60, "2 contas, há 1 h"],
    [2, 0, null, "não conectado"],
  ])("e-mail com %i contas, %i conectadas e idade %p: %s", (total, conectadas, idadeMin, texto) => {
    const [linha] = rodapeDasFontes([{ fonte: "email", lidaEm: idadeMin === null ? null : ISO, idadeMin, conectadas, total }]);
    expect(linha?.idade).toBe(texto);
  });
});

describe("passo de concluir e adiar", () => {
  const t = tarefa("t");
  const aplicar = (...eventos: Parameters<typeof reduzirPasso>[1][]) => eventos.reduce<Passo>(reduzirPasso, PASSO_FECHADO);

  test("abrir de novo o mesmo passo fecha, abrir outro troca", () => {
    expect(aplicar({ tipo: "abrir_concluir" }, { tipo: "abrir_concluir" })).toEqual(PASSO_FECHADO);
    expect(aplicar({ tipo: "abrir_concluir" }, { tipo: "abrir_adiar", sugestao: "2026-11-12" as Dia })).toEqual({ tipo: "adiar", para: "2026-11-12" });
  });

  test("campo de outro passo é ignorado", () => {
    expect(aplicar({ tipo: "abrir_adiar", sugestao: HOJE }, { tipo: "proximo", texto: "x" })).toEqual({ tipo: "adiar", para: HOJE });
    expect(aplicar({ tipo: "para", texto: HOJE })).toEqual(PASSO_FECHADO);
  });

  test("concluir com próximo passo e data", () => {
    const passo = aplicar({ tipo: "abrir_concluir" }, { tipo: "proximo", texto: "  Ligar de novo  " }, { tipo: "vence", texto: "2026-11-13" });
    expect(pedidoDoPasso(passo, t, HOJE)).toEqual({
      ok: true,
      valor: { acao: "concluir", corpo: { versao: 3, proximoPasso: "Ligar de novo", venceEm: "2026-11-13" as Dia } },
    });
  });

  test("concluir com próximo passo sem data deixa a seguinte sem data", () => {
    const passo = aplicar({ tipo: "abrir_concluir" }, { tipo: "proximo", texto: "Mandar proposta" });
    expect(pedidoDoPasso(passo, t, HOJE)).toEqual({ ok: true, valor: { acao: "concluir", corpo: { versao: 3, proximoPasso: "Mandar proposta" } } });
  });

  test("concluir sem próximo passo ignora o que foi digitado", () => {
    const passo = aplicar({ tipo: "abrir_concluir" }, { tipo: "vence", texto: "2026-11-13" });
    expect(pedidoDoPasso(passo, t, HOJE, true)).toEqual({ ok: true, valor: { acao: "concluir", corpo: { versao: 3 } } });
  });

  test.each([
    ["próximo passo vazio", [{ tipo: "abrir_concluir" }], "Escreva o próximo passo"],
    ["data no passado", [{ tipo: "abrir_concluir" }, { tipo: "proximo", texto: "x" }, { tipo: "vence", texto: "2026-11-10" }], "hoje ou depois"],
    ["próximo passo longo", [{ tipo: "abrir_concluir" }, { tipo: "proximo", texto: "x".repeat(501) }], "500"],
    ["adiar para ontem", [{ tipo: "abrir_adiar", sugestao: HOJE }, { tipo: "para", texto: "2026-11-10" }], "hoje ou depois"],
    ["adiar sem data", [{ tipo: "abrir_adiar", sugestao: HOJE }, { tipo: "para", texto: "" }], "Escolha a data"],
  ] as const)("%s é recusado antes de enviar", (_nome, eventos, trecho) => {
    const lido = pedidoDoPasso(aplicar(...eventos), t, HOJE);
    expect(lido.ok).toBe(false);
    if (!lido.ok) expect(lido.mensagem).toContain(trecho);
  });

  test("adiar leva a versão e a data", () => {
    const passo = aplicar({ tipo: "abrir_adiar", sugestao: "2026-11-12" as Dia });
    expect(pedidoDoPasso(passo, t, HOJE)).toEqual({ ok: true, valor: { acao: "adiar", corpo: { versao: 3, para: "2026-11-12" as Dia } } });
  });
});

const ID = "6f1c2f0e-9d5b-4c1e-8a57-3b9e0c4d2a11";

describe("formulários", () => {
  test("nova tarefa limpa espaços e omite o que ficou vazio", () => {
    expect(lerNovaTarefa({ titulo: "  Ligar   para a obra ", vence: "", cliente: " " }, HOJE, ID)).toEqual({ ok: true, valor: { id: ID, titulo: "Ligar para a obra" } });
    expect(lerNovaTarefa({ titulo: "Visita", vence: "2026-11-11", cliente: "Construtora Canário" }, HOJE, ID)).toEqual({
      ok: true,
      valor: { id: ID, titulo: "Visita", venceEm: "2026-11-11" as Dia, clienteNome: "Construtora Canário" },
    });
  });

  test("nova tarefa sem título ou com data passada é recusada", () => {
    expect(lerNovaTarefa({ titulo: " ", vence: "", cliente: "" }, HOJE, ID).ok).toBe(false);
    expect(lerNovaTarefa({ titulo: "x", vence: "2026-11-01", cliente: "" }, HOJE, ID).ok).toBe(false);
    expect(lerNovaTarefa({ titulo: "x".repeat(201), vence: "", cliente: "" }, HOJE, ID).ok).toBe(false);
  });

  test("nota vazia é recusada e a cheia sai aparada", () => {
    expect(lerNota("  \n ").ok).toBe(false);
    expect(lerNota(" linha 1\nlinha 2 ")).toEqual({ ok: true, valor: "linha 1\nlinha 2" });
  });
});

describe("aviso do erro", () => {
  const erro = (codigo: keyof typeof ERROS) => ({ codigo, mensagem: ERROS[codigo].mensagem, acao: ERROS[codigo].acao });

  test.each(["conflito_de_versao", "estado_da_tarefa"] as const)("%s vira 'mudou em outra janela'", (codigo) => {
    expect(avisoDoErro(erro(codigo))).toMatchObject({ tom: "mudou", texto: AVISO_DE_MUDANCA });
  });

  test("outro erro mostra a mensagem e a ação da tabela", () => {
    expect(avisoDoErro(erro("servidor_fora_do_ar"))).toEqual({ tom: "erro", texto: ERROS.servidor_fora_do_ar.mensagem, detalhe: ERROS.servidor_fora_do_ar.acao });
  });
});

describe("aviso do feito", () => {
  const resposta = (campos: Partial<Tarefa>, seguinte: Tarefa | null = null) => ({ tarefa: tarefa("t", campos), notas: [], seguinte });

  test("concluir com próximo passo diz o título e o prazo da seguinte", () => {
    const seguinte = tarefa("s", { titulo: "Ligar de novo", venceEm: "2026-11-12" as Dia });
    expect(avisoDoFeito({ acao: "concluir", corpo: { versao: 3, proximoPasso: "Ligar de novo" } }, resposta({ estado: "concluida" }, seguinte), HOJE)).toEqual({
      tom: "feito",
      texto: "Tarefa concluída.",
      detalhe: "Próximo passo criado, para amanhã: Ligar de novo",
    });
  });

  test("adiar diz a data nova", () => {
    expect(avisoDoFeito({ acao: "adiar", corpo: { versao: 3, para: "2026-11-20" } }, resposta({ venceEm: "2026-11-20" as Dia }), HOJE).texto).toBe(
      "Tarefa adiada para 20 de novembro.",
    );
  });
});

describe("API de tarefas", () => {
  function gravando(resposta: () => Promise<Response>) {
    const pedidos: { url: string; init: RequestInit }[] = [];
    const buscar: Buscar = (url, init) => {
      pedidos.push({ url, init });
      return resposta();
    };
    return { pedidos, api: criarApiDeTarefas(buscar) };
  }

  test("ação vai em POST JSON para /api/tarefas/:id/:acao e devolve os dados", async () => {
    const dados = { tarefa: tarefa("a/b"), notas: [], seguinte: null };
    const { pedidos, api } = gravando(async () => Response.json({ v: 1, ok: true, dados }));
    expect(await api.agir("a/b", { acao: "adiar", corpo: { versao: 3, para: "2026-11-12" } })).toEqual({ ok: true, dados });
    expect(pedidos[0]?.url).toBe("/api/tarefas/a%2Fb/adiar");
    expect(pedidos[0]?.init).toMatchObject({ method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" } });
    expect(JSON.parse(String(pedidos[0]?.init.body))).toEqual({ versao: 3, para: "2026-11-12" });
  });

  test("leitura vai em GET sem corpo", async () => {
    const { pedidos, api } = gravando(async () => Response.json({ v: 1, ok: true, dados: { tarefas: [] } }));
    await api.listar("concluida");
    expect(pedidos[0]).toEqual({ url: "/api/tarefas?estado=concluida", init: { method: "GET", credentials: "same-origin", headers: undefined, body: undefined } });
  });

  test("conflito chega com a tarefa atual", async () => {
    const atual = tarefa("x", { versao: 4 });
    const erro = { codigo: "conflito_de_versao" as const, mensagem: "m", acao: "a", atual };
    const { api } = gravando(async () => Response.json({ v: 1, ok: false, erro }, { status: 409 }));
    expect(await api.agir("x", { acao: "descartar", corpo: { versao: 3 } })).toEqual({ ok: false, erro });
  });

  test("rede caída e resposta fora do envelope viram erro, sem exceção", async () => {
    const caida = gravando(() => Promise.reject(new TypeError("rede")));
    expect(await caida.api.meuDia()).toMatchObject({ ok: false, erro: { codigo: "servidor_fora_do_ar" } });
    const html = gravando(async () => new Response("<html>"));
    expect(await html.api.ver("x")).toMatchObject({ ok: false, erro: { codigo: "interno" } });
  });
});

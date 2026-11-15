import { describe, expect, test } from "bun:test";
import type { Dia, EstadoPainel, Instante, RetratoDosConectores } from "../dominio";
import { montarMeuDia, type MeuDia, type Tarefa } from "../tarefas";
import { montarCena } from "./dev/cenas";
import { conexoesDaLateral, listaLembrada, modeloDoMenu, rotulosDeQuemUsa } from "./lateral";
import { IDS_DOS_BLOCOS } from "./meu-dia";
import { hashDaRota } from "./rota";

const agora = new Date("2026-11-14T12:00:00Z");
const AGORA = agora.toISOString() as Instante;
const HOJE = "2026-11-14" as Dia;

function cena(nome: string): EstadoPainel {
  const estado = montarCena(nome, agora);
  if (estado === null) throw new Error(`cena ${nome} não existe`);
  return estado;
}

function retrato(estado: EstadoPainel): RetratoDosConectores {
  return { whatsapp: estado.conectores.whatsapp.estado, crm: estado.conectores.crm.estado, email: { pulado: estado.email.pulado, contas: estado.email.contas } };
}

function minutosAntes(n: number): Instante {
  return new Date(agora.getTime() - n * 60_000).toISOString() as Instante;
}

function tarefa(id: string, venceEm: Dia | null): Tarefa {
  return { id, titulo: "Ligar", clienteId: null, clienteNome: null, clienteConferido: false, propostaCodigo: null, venceEm, estado: "aberta", origem: "vendedor", criadaEm: AGORA, atualizadaEm: AGORA, versao: 1 } as Tarefa;
}

/** O dia de uma cena, com as conversas do WhatsApp lidas há 5 min e os e-mails há 12 min. */
function diaDe(estado: EstadoPainel, tarefas: readonly Tarefa[] = []): MeuDia {
  const dia = montarMeuDia(tarefas, retrato(estado), AGORA, HOJE);
  return { ...dia, responder: { ...dia.responder, lido_em: minutosAntes(5), email: { ...dia.responder.email, lido_em: minutosAntes(12) } } };
}

describe("cartão das conexões", () => {
  test("tudo de pé: Tudo conectado, cada fonte com a idade da última leitura", () => {
    const estado = cena("tudo-conectado");
    const cartao = conexoesDaLateral(estado, diaDe(estado), agora);
    expect(cartao.tom).toBe("ok");
    expect(cartao.resumo).toBe("Tudo conectado");
    expect(cartao.fontes.map(({ nome, tom, detalhe }) => [nome, tom, detalhe])).toEqual([
      ["WhatsApp", "ok", "há 5 min"],
      ["CRM", "ok", "não sincronizado"],
      ["E-mail Profills", "ok", "há 12 min"],
    ]);
  });

  test("uma conta de e-mail em atenção acende o ponto e vira o resumo, pelo rótulo", () => {
    const estado = cena("email-uma-em-atencao");
    const cartao = conexoesDaLateral(estado, diaDe(estado), agora);
    expect(cartao.tom).toBe("atencao");
    expect(cartao.resumo).toBe("E-mail Profills pede atenção");
    expect(cartao.fontes.find((fonte) => fonte.nome === "E-mail Profills")?.detalhe).toBe("precisa de atenção");
    expect(cartao.fontes.find((fonte) => fonte.nome === "E-mail Pessoal")?.detalhe).toBe("há 12 min");
  });

  test("duas fontes em atenção contam no resumo", () => {
    const estado = cena("email-uma-em-atencao");
    const comCrm = { ...estado, conectores: { ...estado.conectores, crm: cena("meu-dia-crm-nao-liberado").conectores.crm } };
    expect(conexoesDaLateral(comCrm, null, agora).resumo).toBe("2 conexões pedem atenção");
  });

  test("o CRM desconectado não acende o ponto, mas tira o Tudo conectado", () => {
    const cartao = conexoesDaLateral(cena("meu-dia-crm-desconectado"), null, agora);
    expect(cartao.tom).toBe("neutro");
    expect(cartao.resumo).toBe("CRM: não conectado");
  });

  test("sem conta de e-mail, o e-mail não aparece na lista", () => {
    const cartao = conexoesDaLateral(cena("email-sem-conta"), null, agora);
    expect(cartao.fontes.map((fonte) => fonte.nome)).toEqual(["WhatsApp", "CRM"]);
  });
});

describe("menu da lateral", () => {
  test("os sete blocos na ordem do Meu dia, com a contagem; o bloco da rota é o atual, e a linha Meu dia não conta", () => {
    const estado = cena("tudo-conectado");
    const dia = diaDe(estado, [tarefa("a", HOJE), tarefa("b", null), tarefa("c", "2026-11-20" as Dia)]);
    const menu = modeloDoMenu({ tela: "meu-dia", lista: "sem-data" }, dia, estado, "sem-data", agora);
    expect(menu.blocos.map((bloco) => bloco.id)).toEqual([...IDS_DOS_BLOCOS]);
    expect(menu.blocos.find((bloco) => bloco.id === "fazer-hoje")?.contagem?.texto).toBe("1");
    expect(menu.blocos.filter((bloco) => bloco.atual).map((bloco) => bloco.id)).toEqual(["sem-data"]);
    expect(menu.meuDia).toMatchObject({ atual: false, paiDoAtual: true, grupoAberto: true, contagem: null });
    expect(menu.tarefas).toMatchObject({ atual: false, contagem: { texto: "3", falado: "3 abertas" }, dica: "Tarefas · 3" });
  });

  test("Conexões quente leva o resumo na dica", () => {
    const estado = cena("email-uma-em-atencao");
    const menu = modeloDoMenu({ tela: "conexoes" }, null, estado, null, agora);
    expect(menu.conexoes).toMatchObject({ atual: true, quente: true, dica: "Conexões · E-mail Profills pede atenção" });
    expect(menu.meuDia.grupoAberto).toBe(false);
  });

  test("antes da primeira leitura do dia, nenhum número aparece", () => {
    const menu = modeloDoMenu({ tela: "tarefas" }, null, null, null, agora);
    expect(menu.blocos.every((bloco) => bloco.contagem === null)).toBe(true);
    expect(menu.tarefas.contagem).toBeNull();
    expect(menu.cartao).toBeNull();
    expect(menu.blocos[0]?.dica).toBe("Fazer hoje");
  });
});

describe("voltar ao Meu dia", () => {
  test("a lateral lembra o último bloco que a rota mostrou e volta a ele", () => {
    let lembrada = listaLembrada(null, { tela: "meu-dia", lista: "responder" });
    lembrada = listaLembrada(lembrada, { tela: "tarefas" });
    lembrada = listaLembrada(lembrada, { tela: "conexoes" });
    expect(lembrada).toBe("responder");
    const menu = modeloDoMenu({ tela: "conexoes" }, null, null, lembrada, agora);
    expect(hashDaRota(menu.meuDia.destino)).toBe("#/meu-dia/responder");
  });

  test("sem bloco visto, o Meu dia abre sem bloco, e a tela escolhe", () => {
    expect(hashDaRota(modeloDoMenu({ tela: "tarefas" }, null, null, listaLembrada(null, { tela: "meu-dia" }), agora).meuDia.destino)).toBe("#/meu-dia");
  });
});

describe("quem usa, no cartão do pé", () => {
  test("sem nome, o cartão pede o nome", () => {
    expect(rotulosDeQuemUsa(null)).toMatchObject({ rotulo: "Diga seu nome", subtitulo: "Profills" });
  });

  test("o subtítulo diz de onde o nome veio", () => {
    expect(rotulosDeQuemUsa({ nome: "Marina", iniciais: "MC", origem: "crm" })).toMatchObject({ rotulo: "Marina", subtitulo: "Profills · nome do CRM" });
    expect(rotulosDeQuemUsa({ nome: "Mari", iniciais: "M", origem: "vendedor" })).toMatchObject({ rotulo: "Mari", subtitulo: "Profills · só neste computador" });
  });
});

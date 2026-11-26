import { describe, expect, test } from "bun:test";
import { diaEm, lerDia, type ContaEmailComEstado, type Dia, type EnderecoEmail, type IdContaEmail, type Instante, type RetratoDosConectores } from "../dominio";
import {
  comClienteDoCrm,
  conversasTratadas,
  criarTarefa,
  decidir,
  lerComando,
  lerCriacao,
  montarMeuDia,
  situacao,
  type AcaoDaTarefa,
  type Comando,
  type Contexto,
  type EstadoDaTarefa,
  type Papel,
  type Tarefa,
} from "./index";

const AGORA = "2026-11-11T15:00:00.000Z" as Instante;
const HOJE = "2026-11-11" as Dia;

function contexto(papel: Papel, agora: Instante = AGORA): Contexto {
  let n = 0;
  return { papel, agora, hoje: diaEm(agora), novoId: () => `nova-${(n += 1)}` };
}

function tarefa(campos: Partial<Tarefa> = {}): Tarefa {
  return {
    id: "t1",
    titulo: "Ligar",
    clienteId: null,
    clienteNome: null,
    clienteConferido: false,
    propostaCodigo: null,
    venceEm: null,
    estado: "aberta",
    origem: "vendedor",
    versao: 3,
    criadaEm: "2026-11-01T12:00:00.000Z" as Instante,
    atualizadaEm: "2026-11-01T12:00:00.000Z" as Instante,
    conversa: null,
    ...campos,
  };
}

const COMANDOS: { readonly [A in AcaoDaTarefa]: Comando } = {
  concluir: { acao: "concluir", versao: 3 },
  adiar: { acao: "adiar", versao: 3, para: "2026-11-20" as Dia },
  descartar: { acao: "descartar", versao: 3 },
  reabrir: { acao: "reabrir", versao: 3 },
  anotar: { acao: "anotar", texto: "falei com ele" },
};

type Esperado = EstadoDaTarefa | "mesma" | "so_no_painel" | "estado_da_tarefa";

/** Ação × estado de partida × papel. "mesma" é a nota que não muda a linha. */
const TABELA: readonly (readonly [AcaoDaTarefa, EstadoDaTarefa, Papel, Esperado])[] = [
  ["concluir", "aberta", "painel", "concluida"],
  ["concluir", "aberta", "agente", "concluida"],
  ["concluir", "concluida", "painel", "estado_da_tarefa"],
  ["concluir", "concluida", "agente", "estado_da_tarefa"],
  ["concluir", "descartada", "agente", "estado_da_tarefa"],
  ["adiar", "aberta", "painel", "aberta"],
  ["adiar", "aberta", "agente", "aberta"],
  ["adiar", "concluida", "agente", "estado_da_tarefa"],
  ["adiar", "descartada", "painel", "estado_da_tarefa"],
  ["descartar", "aberta", "painel", "descartada"],
  ["descartar", "aberta", "agente", "descartada"],
  ["descartar", "concluida", "agente", "estado_da_tarefa"],
  ["reabrir", "concluida", "painel", "aberta"],
  ["reabrir", "descartada", "painel", "aberta"],
  ["reabrir", "aberta", "painel", "estado_da_tarefa"],
  ["reabrir", "concluida", "agente", "so_no_painel"],
  ["reabrir", "descartada", "agente", "so_no_painel"],
  ["anotar", "aberta", "agente", "mesma"],
  ["anotar", "aberta", "painel", "mesma"],
  ["anotar", "concluida", "painel", "mesma"],
  ["anotar", "concluida", "agente", "estado_da_tarefa"],
  ["anotar", "descartada", "agente", "estado_da_tarefa"],
];

describe("regras da tarefa", () => {
  test.each(TABELA)("%s numa tarefa %s pelo %s dá %s", (acao, estado, papel, esperado) => {
    const atual = tarefa({ estado });
    const resultado = decidir(atual, COMANDOS[acao], contexto(papel));
    if (esperado === "so_no_painel" || esperado === "estado_da_tarefa") {
      expect(resultado.ok ? "ok" : resultado.erro.codigo).toBe(esperado);
      return;
    }
    if (!resultado.ok) throw new Error(`esperava ok, veio ${resultado.erro.codigo}`);
    if (esperado === "mesma") {
      expect(resultado.dados.tarefa).toBeNull();
      expect(resultado.dados.notas).toHaveLength(1);
      return;
    }
    expect(resultado.dados.tarefa).toMatchObject({ estado: esperado, versao: 4, atualizadaEm: AGORA });
  });

  test("a recusa por estado traz a tarefa atual, para quem chamou recarregar", () => {
    const atual = tarefa({ estado: "concluida" });
    const resultado = decidir(atual, COMANDOS.adiar, contexto("agente"));
    expect(resultado.ok ? null : resultado.erro.atual).toEqual(atual);
  });

  test("versão velha dá conflito com a tarefa atual, e repetir com a versão dela passa", () => {
    const atual = tarefa({ versao: 5 });
    const velha = decidir(atual, { acao: "concluir", versao: 4 }, contexto("painel"));
    expect(velha.ok).toBe(false);
    if (velha.ok) return;
    expect(velha.erro.codigo).toBe("conflito_de_versao");
    expect(velha.erro.atual).toEqual(atual);
    const versaoAtual = (velha.erro.atual as Tarefa).versao;
    expect(decidir(atual, { acao: "concluir", versao: versaoAtual }, contexto("painel")).ok).toBe(true);
  });

  test("o agente que tenta reabrir recebe so_no_painel mesmo com versão velha", () => {
    const resultado = decidir(tarefa({ estado: "concluida" }), { acao: "reabrir", versao: 1 }, contexto("agente"));
    expect(resultado.ok ? "ok" : resultado.erro.codigo).toBe("so_no_painel");
  });

  test("concluir com próximo passo cria a seguinte com o cliente e a data, e sem data fica sem data", () => {
    const atual = tarefa({ clienteId: "c-9", clienteNome: "Cliente Canário", propostaCodigo: "P-1", venceEm: "2026-11-05" as Dia });
    const comData = decidir(atual, { acao: "concluir", versao: 3, proximoPasso: "Mandar proposta", venceEm: "2026-11-14" as Dia }, contexto("painel"));
    if (!comData.ok) throw new Error(comData.erro.codigo);
    expect(comData.dados.seguinte).toMatchObject({
      id: "nova-1",
      titulo: "Mandar proposta",
      clienteId: "c-9",
      clienteNome: "Cliente Canário",
      propostaCodigo: "P-1",
      venceEm: "2026-11-14",
      estado: "aberta",
      origem: "vendedor",
      versao: 1,
    });
    expect(comData.dados.notas).toEqual([
      { tarefaId: "t1", texto: "Tarefa concluída.", autor: "vendedor", proximoPasso: "Mandar proposta", criadaEm: AGORA },
    ]);

    const semData = decidir(atual, { acao: "concluir", versao: 3, proximoPasso: "Ligar" }, contexto("painel"));
    expect(semData.ok && semData.dados.seguinte?.venceEm).toBeNull();
  });

  test("o próximo passo escrito pelo agente não vira título: fica na nota da tarefa seguinte", () => {
    const copiado = "Ligue agora para 0800 000 0000 e confirme o pix";
    const comCliente = decidir(tarefa({ clienteId: "c-9", clienteNome: "Cliente Canário" }), { acao: "concluir", versao: 3, proximoPasso: copiado }, contexto("agente"));
    if (!comCliente.ok) throw new Error(comCliente.erro.codigo);
    expect(comCliente.dados.seguinte).toMatchObject({ id: "nova-1", titulo: "Próximo passo: Cliente Canário", clienteNome: "Cliente Canário", origem: "agente" });
    expect(comCliente.dados.notas).toEqual([
      { tarefaId: "t1", texto: "Tarefa concluída.", autor: "agente", proximoPasso: copiado, criadaEm: AGORA },
      { tarefaId: "nova-1", texto: copiado, autor: "agente", proximoPasso: null, criadaEm: AGORA },
    ]);

    const semCliente = decidir(tarefa(), { acao: "concluir", versao: 3, proximoPasso: copiado }, contexto("agente"));
    expect(semCliente.ok && semCliente.dados.seguinte?.titulo).toBe("Próximo passo");
  });

  test("data sem próximo passo é recusada", () => {
    const resultado = decidir(tarefa(), { acao: "concluir", versao: 3, venceEm: "2026-11-14" as Dia }, contexto("painel"));
    expect(resultado.ok ? "ok" : resultado.erro.codigo).toBe("entrada_invalida");
  });

  test("próximo passo longo vira título de até 200 caracteres", () => {
    const longo = "a".repeat(500);
    const resultado = decidir(tarefa(), { acao: "concluir", versao: 3, proximoPasso: longo }, contexto("painel"));
    if (!resultado.ok) throw new Error(resultado.erro.codigo);
    expect([...(resultado.dados.seguinte?.titulo ?? "")]).toHaveLength(200);
    expect(resultado.dados.notas[0]?.proximoPasso).toBe(longo);
  });

  test("adiar para antes de hoje é recusado; para hoje passa", () => {
    expect(decidir(tarefa(), { acao: "adiar", versao: 3, para: "2026-11-10" as Dia }, contexto("painel")).ok).toBe(false);
    expect(decidir(tarefa(), { acao: "adiar", versao: 3, para: HOJE }, contexto("painel")).ok).toBe(true);
  });

  test("criar sem data não inventa prazo, e a origem segue o papel", () => {
    expect(criarTarefa({ titulo: "Ligar" }, contexto("agente")).tarefa).toMatchObject({ venceEm: null, origem: "agente", versao: 1 });
    expect(criarTarefa({ titulo: "Ligar" }, contexto("painel")).tarefa?.origem).toBe("vendedor");
  });
});

describe("dia em Brasília", () => {
  test("23h30 de Brasília ainda é o mesmo dia, mesmo já sendo amanhã em UTC", () => {
    const tardeDaNoite = "2026-11-12T02:30:00.000Z" as Instante;
    expect(diaEm(tardeDaNoite)).toBe("2026-11-11" as Dia);
    expect(diaEm("2026-11-12T03:00:00.000Z" as Instante)).toBe("2026-11-12" as Dia);
    const deHoje = tarefa({ venceEm: "2026-11-11" as Dia });
    const dia = montarMeuDia([deHoje], CONECTORES_PARADOS, tardeDaNoite, diaEm(tardeDaNoite));
    expect(dia.fazer_hoje.map((t) => [t.id, t.situacao])).toEqual([["t1", "hoje"]]);
  });

  test("situação pela data", () => {
    expect(situacao(null, HOJE)).toBe("sem_data");
    expect(situacao("2026-11-10" as Dia, HOJE)).toBe("atrasada");
    expect(situacao(HOJE, HOJE)).toBe("hoje");
    expect(situacao("2026-11-12" as Dia, HOJE)).toBe("futura");
  });

  test("lerDia aceita só dia que existe", () => {
    expect(lerDia("2026-02-28")).toBe("2026-02-28" as Dia);
    expect(lerDia("2026-02-30")).toBeNull();
    expect(lerDia("11/11/2026")).toBeNull();
    expect(lerDia("2026-1-1")).toBeNull();
  });
});

const CONECTORES_PARADOS: RetratoDosConectores = {
  whatsapp: { fase: "desconectado" },
  crm: { fase: "desconectado" },
  email: { pulado: false, contas: [] },
};

function conta(rotulo: string, estado: ContaEmailComEstado["estado"]): ContaEmailComEstado {
  const config = { endereco: `${rotulo.toLowerCase()}@exemplo.com.br` as EnderecoEmail, servidor: "imap.exemplo.com.br", porta: 993, seguranca: "tls" as const };
  return { id: crypto.randomUUID() as IdContaEmail, rotulo, provedor: "outro", config, janelaDias: 30, estado };
}

describe("Meu dia", () => {
  test("fazer hoje junta atrasadas e de hoje pela data; sem data vai à parte; futuras ficam fora", () => {
    const tarefas = [
      tarefa({ id: "futura", venceEm: "2026-11-12" as Dia }),
      tarefa({ id: "hoje", venceEm: HOJE }),
      tarefa({ id: "sem-data" }),
      tarefa({ id: "atrasada-nova", venceEm: "2026-11-09" as Dia }),
      tarefa({ id: "atrasada-velha", venceEm: "2026-11-02" as Dia }),
    ];
    const dia = montarMeuDia(tarefas, CONECTORES_PARADOS, AGORA, HOJE);
    expect(dia.hoje).toBe(HOJE);
    expect(dia.fazer_hoje.map((t) => [t.id, t.situacao])).toEqual([
      ["atrasada-velha", "atrasada"],
      ["atrasada-nova", "atrasada"],
      ["hoje", "hoje"],
    ]);
    expect(dia.sem_data.map((t) => t.id)).toEqual(["sem-data"]);
  });

  test("tarefas_abertas conta toda tarefa aberta, a futura inclusive, e deixa as fechadas de fora", () => {
    const tarefas = [
      tarefa({ id: "futura", venceEm: "2026-11-12" as Dia }),
      tarefa({ id: "hoje", venceEm: HOJE }),
      tarefa({ id: "sem-data" }),
      tarefa({ id: "feita", estado: "concluida" }),
      tarefa({ id: "fora", estado: "descartada" }),
    ];
    expect(montarMeuDia(tarefas, CONECTORES_PARADOS, AGORA, HOJE).tarefas_abertas).toBe(3);
  });

  test("a idade de cada fonte sai da última leitura do conector conectado", () => {
    const conectores: RetratoDosConectores = {
      ...CONECTORES_PARADOS,
      crm: { fase: "conectado", conexaoExpiraEm: AGORA, verificadoEm: "2026-11-11T14:30:00.000Z" as Instante, ferramentas: null },
    };
    const dia = montarMeuDia([], conectores, AGORA, HOJE);
    expect(dia.fontes as unknown[]).toEqual([
      { fonte: "tarefas", lidaEm: AGORA, idadeMin: 0 },
      { fonte: "whatsapp", lidaEm: null, idadeMin: null },
      { fonte: "crm", lidaEm: "2026-11-11T14:30:00.000Z", idadeMin: 30 },
    ]);
  });

  test("sem conta de e-mail, ou com o e-mail pulado, o e-mail fica fora do rodapé", () => {
    for (const email of [CONECTORES_PARADOS.email, { pulado: true, contas: [] }]) {
      const dia = montarMeuDia([], { ...CONECTORES_PARADOS, email }, AGORA, HOJE);
      expect(dia.fontes.map((fonte) => fonte.fonte)).toEqual(["tarefas", "whatsapp", "crm"]);
    }
  });

  test("com contas, a idade do e-mail é a da conta conectada lida há mais tempo, com quantas estão conectadas", () => {
    const velha = conta("Profills", { fase: "conectado", verificadoEm: "2026-11-11T14:00:00.000Z" as Instante, caixaDeEntrada: null });
    const nova = conta("Pessoal", { fase: "conectado", verificadoEm: "2026-11-11T14:50:00.000Z" as Instante, caixaDeEntrada: null });
    const caida = conta("Outra", { fase: "desconectado" });
    const email = (contas: ContaEmailComEstado[]) => montarMeuDia([], { ...CONECTORES_PARADOS, email: { pulado: false, contas } }, AGORA, HOJE).fontes.at(-1) as unknown;
    expect(email([nova, velha])).toEqual({ fonte: "email", lidaEm: "2026-11-11T14:00:00.000Z", idadeMin: 60, conectadas: 2, total: 2 });
    expect(email([nova, caida])).toEqual({ fonte: "email", lidaEm: "2026-11-11T14:50:00.000Z", idadeMin: 10, conectadas: 1, total: 2 });
    expect(email([caida])).toEqual({ fonte: "email", lidaEm: null, idadeMin: null, conectadas: 0, total: 1 });
  });
});

describe("entrada na borda", () => {
  test("limites: título 200, nota 4000, próximo passo 500", () => {
    expect(lerCriacao({ titulo: "a".repeat(200) }, "painel").ok).toBe(true);
    expect(lerCriacao({ titulo: "a".repeat(201) }, "painel").ok).toBe(false);
    expect(lerCriacao({ titulo: "x", nota: "a".repeat(4000) }, "painel").ok).toBe(true);
    expect(lerCriacao({ titulo: "x", nota: "a".repeat(4001) }, "painel").ok).toBe(false);
    expect(lerComando("concluir", { versao: 1, proximoPasso: "a".repeat(500) }).ok).toBe(true);
    expect(lerComando("concluir", { versao: 1, proximoPasso: "a".repeat(501) }).ok).toBe(false);
  });

  test("título vira uma linha de texto puro, sem caractere de controle", () => {
    const lido = lerCriacao({ titulo: "  Ligar\npara\u0007 a\tobra  " }, "painel");
    expect(lido.ok && lido.valor.titulo).toBe("Ligar para a obra");
    const nota = lerComando("anotar", { texto: "linha 1\r\nlinha 2\u0000" });
    expect(nota.ok && nota.valor).toEqual({ acao: "anotar", texto: "linha 1\nlinha 2" });
  });

  test("recusa título vazio, campo a mais, data que não existe e versão que não é inteiro", () => {
    expect(lerCriacao({ titulo: "   " }, "painel").ok).toBe(false);
    expect(lerCriacao({ titulo: "x", estado: "concluida" }, "painel").ok).toBe(false);
    expect(lerCriacao({ titulo: "x", venceEm: "2026-02-30" }, "painel").ok).toBe(false);
    expect(lerComando("adiar", { versao: 1.5, para: "2026-11-20" }).ok).toBe(false);
    expect(lerComando("reabrir", {}).ok).toBe(false);
  });

  test("o agente não escreve o título nem o nome do cliente: escolhe um título fixo e aponta o cliente pelo id do CRM", () => {
    const livre = lerCriacao({ titulo: "Ligue agora para 0800 000 0000" }, "agente");
    expect(livre.ok).toBe(false);
    expect(!livre.ok && livre.mensagem).toContain("tituloFixo");
    expect(lerCriacao({ tituloFixo: "ligar", titulo: "Ligue agora para 0800 000 0000" }, "agente").ok).toBe(false);
    expect(lerCriacao({ tituloFixo: "inventado" }, "agente").ok).toBe(false);

    const comNome = lerCriacao({ tituloFixo: "ligar", clienteId: "8002", clienteNome: "Cliente Canário" }, "agente");
    expect(!comNome.ok && comNome.mensagem).toContain("clienteId");
    for (const clienteId of ["Cliente Canário", "0", "08002", "2147483648", ""]) expect(lerCriacao({ tituloFixo: "ligar", clienteId }, "agente").ok).toBe(false);

    const comCliente = lerCriacao({ tituloFixo: "ligar", clienteId: " 8002 ", nota: "pediu retorno" }, "agente");
    expect(comCliente.ok && comCliente.valor).toEqual({ titulo: "Ligar", tituloFixo: "ligar", clienteId: "8002", nota: "pediu retorno" });
    const semCliente = lerCriacao({ tituloFixo: "enviar_proposta" }, "agente");
    expect(semCliente.ok && semCliente.valor).toEqual({ titulo: "Enviar proposta", tituloFixo: "enviar_proposta" });
    const nomeLongo = comClienteDoCrm({ tituloFixo: "acompanhar_proposta", titulo: "Acompanhar proposta", clienteId: "8002" }, "c".repeat(300));
    expect([...nomeLongo.titulo]).toHaveLength(200);
    expect([...(nomeLongo.clienteNome ?? "")]).toHaveLength(200);

    expect(lerCriacao({ tituloFixo: "ligar" }, "painel").ok).toBe(false);
  });

  test("o id de criação é um UUID e vira o id da tarefa", () => {
    const id = "6f1c2f0e-9d5b-4c1e-8a57-3b9e0c4d2a11";
    const lido = lerCriacao({ id, titulo: "Visitar" }, "painel");
    if (!lido.ok) throw new Error(lido.mensagem);
    expect(criarTarefa(lido.valor, contexto("painel")).tarefa.id).toBe(id);
    expect(lerCriacao({ id, tituloFixo: "visitar" }, "agente").ok).toBe(true);
    expect(lerCriacao({ id: "t-1", titulo: "Visitar" }, "painel").ok).toBe(false);
    expect(lerCriacao({ id: "../outra", tituloFixo: "visitar" }, "agente").ok).toBe(false);
  });
});

describe("conversas tratadas por tarefa concluída", () => {
  const ate = (hora: string) => `2026-11-11T${hora}:00.000Z` as Instante;
  const ligada = (id: string, estado: EstadoDaTarefa, canal: "whatsapp" | "email", chave: string, hora: string) => tarefa({ id, estado, conversa: { canal, chave, ate: ate(hora) } });

  test("só a concluída conta, a maior entre as concluídas vence, e cada canal fica no seu", () => {
    const tarefas = [
      ligada("a", "concluida", "whatsapp", "+5541999990001", "10:00"),
      ligada("b", "concluida", "whatsapp", "+5541999990001", "12:00"),
      ligada("c", "aberta", "whatsapp", "+5541999990001", "14:00"),
      ligada("d", "descartada", "whatsapp", "+5541999990002", "14:00"),
      ligada("e", "concluida", "email", "e-0123456789abcdef", "09:00"),
      tarefa({ id: "f", estado: "concluida" }),
    ];
    expect([...conversasTratadas(tarefas, "whatsapp")]).toEqual([["+5541999990001", ate("12:00")]]);
    expect([...conversasTratadas(tarefas, "email")]).toEqual([["e-0123456789abcdef", ate("09:00")]]);
  });

  test("o próximo passo do concluir nasce sem a conversa", () => {
    const atual = tarefa({ conversa: { canal: "whatsapp", chave: "+5541999990001", ate: ate("10:00") } });
    const decisao = decidir(atual, { acao: "concluir", versao: atual.versao, proximoPasso: "Mandar a tabela" }, contexto("painel"));
    expect(decisao.ok && decisao.dados.tarefa?.conversa).toEqual(atual.conversa);
    expect(decisao.ok && decisao.dados.seguinte?.conversa).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";
import type { AndamentoDaSincronizacao, Sincronizacao } from "../conectores";
import {
  ERROS,
  SEM_CONVERSAS,
  SEM_IGNORADOS,
  SEM_LEITURAS,
  lerTelefone,
  listarNaoClientes,
  montarBlocosDeConversas,
  montarBlocosDoCrm,
  propostaAberta,
  somarAoDia,
  textoExterno,
  type ClienteSemAtendimento,
  type Compromisso,
  type DadosDasConversas,
  type Dia,
  type EstadoCrm,
  type EstadoWhatsapp,
  type IgnoradoDeConversa,
  type MotivoDaDuvida,
  type MotivoDoBlocoDeConversas,
  type VinculoDeContato,
  type ConversaLida,
  type IdContaEmail,
  type IgnoradoPeloAgente,
  type ItemDeEsperando,
  type ItemDeEsperandoDeEmail,
  type ItemDeResponder,
  type ItemDeResponderDeEmail,
  type ItemDeResponderDoWhatsapp,
  type LeituraDoEmailNoBloco,
  type MotivoDoEmailNoBloco,
  type Instante,
  type LeiturasDoCrm,
  type PropostaAberta,
} from "../dominio";
import type { MeuDia, Tarefa, TarefaDoDia } from "../tarefas";
import { resumo } from "./fixtures-da-fila";
import {
  BLOCOS,
  IDS_DOS_BLOCOS,
  SINCRONIZACAO_PARADA,
  atencaoDaProposta,
  blocoEscolhido,
  contador,
  diaVazio,
  horaDe,
  alvoDoIgnorado,
  apoioDoIgnorado,
  explicacaoDoMotivo,
  filtroAplicado,
  itensFiltrados,
  limparFiltros,
  linhasSemLeitura,
  linkDoCrm,
  listaEscolhida,
  montarBlocos,
  reduzirSincronizacao,
  resumoDaSincronizacao,
  rodapeDoDia,
  rotuloDaSincronizacao,
  textoDaFaixa,
  textoDoCompromisso,
  textoDaVolta,
  textoDoEnvio,
  textoDosIgnorados,
  textoSemAtendimento,
  tituloDoIgnorado,
  valorDaProposta,
  type AcaoDoMotivo,
  type EstadoDaSincronizacao,
  type FiltroDeCanal,
} from "./meu-dia";
import { hashDaRota, lerRota } from "./rota";

const HOJE = "2026-11-13" as Dia;
const AGORA = "2026-11-13T15:00:00.000Z" as Instante;
const CONECTADO: EstadoCrm = { fase: "conectado", conexaoExpiraEm: AGORA, verificadoEm: AGORA, ferramentas: 18 };
const NAO_LIBERADO: EstadoCrm = { fase: "atencao", problema: { codigo: "crm_app_nao_liberado", desde: AGORA } as never };

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
    versao: 1,
    criadaEm: AGORA,
    atualizadaEm: AGORA,
    ...campos,
  };
}

const doDia = (id: string, situacao: TarefaDoDia["situacao"]): TarefaDoDia => ({ ...tarefa(id, { venceEm: HOJE }), situacao });

const compromisso = (id: number, hora: string): Compromisso => ({
  id,
  titulo: textoExterno(`Compromisso ${id}`),
  inicio: `${HOJE}T${hora}:00.000Z` as Instante,
  fim: null,
  tipo: textoExterno("client"),
  cliente: null,
});

const enviada = (id: number, diasAtras: number) => ({
  id,
  codigo: textoExterno(`${id}/26`),
  versao: 1,
  cliente: { id: 9000 + id, nome: textoExterno(`Cliente ${id}`) },
  valor_total: "1500.00",
  moeda: "BRL",
  enviada_em: somarAoDia(HOJE, -diasAtras),
  prazo_retorno: somarAoDia(HOJE, 30 - diasAtras),
  link: null,
});

const daCarteira = (id: number, ultimo: Instante | null, aproximado = false) => ({
  id,
  nome: textoExterno(`Cliente ${id}`),
  nome_fantasia: null,
  cidade: textoExterno("Curitiba"),
  uf: textoExterno("PR"),
  ultimo_atendimento_em: ultimo,
  ultimo_atendimento_aproximado: aproximado,
});

function dia(campos: Partial<MeuDia> = {}, leituras: LeiturasDoCrm = SEM_LEITURAS, crm: EstadoCrm = CONECTADO, conversas: DadosDasConversas = SEM_CONVERSAS, whatsapp: EstadoWhatsapp = { fase: "desconectado" }): MeuDia {
  return {
    hoje: HOJE,
    fazer_hoje: [],
    sem_data: [],
    tarefas_abertas: 0,
    aprovar: [],
    fontes: [{ fonte: "tarefas", lidaEm: AGORA, idadeMin: 0 }, { fonte: "whatsapp", lidaEm: AGORA, idadeMin: 0 }, { fonte: "crm", lidaEm: AGORA, idadeMin: 0 }],
    ...montarBlocosDoCrm(leituras, crm, HOJE, SEM_IGNORADOS),
    ...montarBlocosDeConversas(conversas, whatsapp),
    ignorados_pelo_agente: [],
    nao_clientes: listarNaoClientes(conversas),
    ...campos,
  };
}

const LIDO = "2026-11-13T14:53:00.000Z" as Instante;
const TUDO_LIDO: LeiturasDoCrm = {
  agenda: { dia: HOJE, lidoEm: LIDO, cortado: false, foraPorCadastroIncompleto: 0, itens: [compromisso(2, "18:30"), compromisso(1, "12:00")] },
  propostas: { lidoEm: LIDO, cortado: false, foraPorCadastroIncompleto: 0, itens: [enviada(10, 3), enviada(11, 29)] },
  carteira: { lidoEm: "2026-11-13T14:40:00.000Z" as Instante, cortado: true, foraPorCadastroIncompleto: 0, semAtendimentoHaDias: 30, itens: [daCarteira(80, null)] },
};

/** As conversas lidas e sem nada para mostrar: o WhatsApp não tem motivo para aparecer na linha discreta. */
const CONECTADO_WHATSAPP_COM_LEITURA: DadosDasConversas = { ...SEM_CONVERSAS, leitura: { lidoEm: LIDO, itens: [], cortado: false } };

const contagens = (d: MeuDia) => montarBlocos(d).map(({ definicao, conteudo }) => [definicao.id, contador(conteudo).texto]);

describe("tabela de blocos", () => {
  test("os blocos, nesta ordem, com Aprovar em terceiro e a dica dele", () => {
    expect(BLOCOS.map((b) => b.nome)).toEqual(["Fazer hoje", "Sem data", "Aprovar", "Responder", "Propostas abertas", "Esperando cliente", "Sem atendimento"]);
    expect(BLOCOS[2]?.dica(dia())).toBe("O agente redigiu, você decide");
    expect(BLOCOS.map((b) => b.id)).toEqual([...IDS_DOS_BLOCOS]);
  });

  test("as dicas de Responder e Esperando cliente", () => {
    const d = dia();
    expect(BLOCOS.filter((b) => b.id === "responder" || b.id === "esperando-cliente").map((b) => b.dica(d))).toEqual(["Clientes que falaram por último", "Você falou por último"]);
  });

  test("Fazer hoje junta atrasadas, as de hoje e os compromissos do CRM", () => {
    const d = dia({ fazer_hoje: [doDia("h", "hoje"), doDia("a", "atrasada")] }, TUDO_LIDO);
    const [fazer] = montarBlocos(d);
    expect(fazer?.conteudo.leitura === "lido" && fazer.conteudo.itens.map((i) => i.chave)).toEqual(["tarefa:a", "tarefa:h", "compromisso:1", "compromisso:2"]);
    expect(contagens(d)).toEqual([
      ["fazer-hoje", "4"],
      ["sem-data", "0"],
      ["aprovar", "0"],
      ["responder", "–"],
      ["propostas", "2"],
      ["esperando-cliente", "–"],
      ["sem-atendimento", "1"],
    ]);
  });

  test("bloco do CRM sem leitura mostra traço, nunca zero; o lido e vazio mostra 0 apagado", () => {
    const naoLido = dia({}, SEM_LEITURAS, NAO_LIBERADO);
    expect(contagens(naoLido)).toEqual([
      ["fazer-hoje", "0"],
      ["sem-data", "0"],
      ["aprovar", "0"],
      ["responder", "–"],
      ["propostas", "–"],
      ["esperando-cliente", "–"],
      ["sem-atendimento", "–"],
    ]);
    const propostas = montarBlocos(naoLido).find((b) => b.definicao.id === "propostas");
    expect(propostas?.conteudo).toEqual({ leitura: "nao_lido", fonte: "crm", motivo: "crm_app_nao_liberado" });
    expect(contador(propostas!.conteudo)).toEqual({ texto: "–", apagado: true, falado: "não lido" });

    const vazio = dia({}, { agenda: null, propostas: { lidoEm: LIDO, cortado: false, foraPorCadastroIncompleto: 0, itens: [] }, carteira: null });
    const lidasVazias = montarBlocos(vazio).find((b) => b.definicao.id === "propostas");
    expect(contador(lidasVazias!.conteudo)).toEqual({ texto: "0", apagado: true, falado: "0 itens" });
  });

  test("Fazer hoje com a agenda sem leitura conta as tarefas e diz o motivo numa nota", () => {
    const [fazer] = montarBlocos(dia({ fazer_hoje: [doDia("h", "hoje")] }, SEM_LEITURAS, { fase: "desconectado" }));
    expect(fazer?.conteudo).toMatchObject({ leitura: "lido", notas: ["Compromissos do CRM: O CRM não está conectado."] });
    expect(contador(fazer!.conteudo).texto).toBe("1");
  });

  test("propostas e clientes dizem quantos estão ignorados e quando o CRM tinha mais", () => {
    const d = dia({}, TUDO_LIDO);
    const comIgnorados = { ...d, propostas_abertas: { ...d.propostas_abertas, ignorados: 2 } };
    const blocos = montarBlocos(comIgnorados);
    const propostas = blocos.find((b) => b.definicao.id === "propostas");
    const clientes = blocos.find((b) => b.definicao.id === "sem-atendimento");
    expect(propostas?.conteudo).toMatchObject({ notas: ["2 ignoradas por 7 dias."] });
    expect(clientes?.conteudo).toMatchObject({ notas: ["O CRM tem mais do que a Secretária lê de uma vez. Confira a lista completa no CRM."] });
  });
});

describe("bloco escolhido", () => {
  test("o primeiro com item; não lido não conta como item", () => {
    const blocos = montarBlocos(dia({}, { ...SEM_LEITURAS, carteira: TUDO_LIDO.carteira }, CONECTADO));
    expect(blocoEscolhido(null, blocos)).toBe("sem-atendimento");
  });

  test("tudo em zero dá Fazer hoje e o dia vazio", () => {
    const blocos = montarBlocos(dia({}, { agenda: { dia: HOJE, lidoEm: LIDO, cortado: false, foraPorCadastroIncompleto: 0, itens: [] }, propostas: { lidoEm: LIDO, cortado: false, foraPorCadastroIncompleto: 0, itens: [] }, carteira: null }));
    expect(diaVazio(blocos)).toBe(false);
    const lidasVazias = { ...TUDO_LIDO, agenda: { ...TUDO_LIDO.agenda!, itens: [] }, propostas: { ...TUDO_LIDO.propostas!, itens: [] }, carteira: { ...TUDO_LIDO.carteira!, itens: [] } };
    expect(diaVazio(montarBlocos(dia({}, lidasVazias)))).toBe(false);
    const todosLidos = montarBlocos(dia({}, lidasVazias, CONECTADO, CONECTADO_WHATSAPP_COM_LEITURA));
    expect(diaVazio(todosLidos)).toBe(true);
    expect(blocoEscolhido(null, todosLidos)).toBe("fazer-hoje");
  });

  test("o bloco do hash fica escolhido mesmo quando esvazia", () => {
    const blocos = montarBlocos(dia({ sem_data: [tarefa("s")] }));
    expect(blocoEscolhido("propostas", blocos)).toBe("propostas");
  });

  test("o hash leva o bloco ou os ignorados e volta igual; lista desconhecida não é rota", () => {
    for (const lista of ["fazer-hoje", "sem-data", "aprovar", "responder", "propostas", "esperando-cliente", "sem-atendimento", "ignorados"] as const) {
      expect(lerRota(hashDaRota({ tela: "meu-dia", lista }))).toEqual({ tela: "meu-dia", lista });
    }
    expect(hashDaRota({ tela: "meu-dia", lista: "ignorados" })).toBe("#/meu-dia/ignorados");
    expect(lerRota("#/meu-dia")).toEqual({ tela: "meu-dia" });
    expect(hashDaRota({ tela: "meu-dia", lista: "esperando-cliente" })).toBe("#/meu-dia/esperando-cliente");
    expect(hashDaRota({ tela: "meu-dia", lista: "aprovar" })).toBe("#/meu-dia/aprovar");
    expect(lerRota("#/meu-dia/aprovar")).toEqual({ tela: "meu-dia", lista: "aprovar" });
    expect(lerRota("#/meu-dia/desconhecida")).toBeNull();
  });

  test("os ignorados ficam abertos enquanto há item; sem item, a tela volta aos blocos", () => {
    const blocos = montarBlocos(dia({ sem_data: [tarefa("s")] }));
    expect(listaEscolhida("ignorados", blocos, 2)).toBe("ignorados");
    expect(listaEscolhida("ignorados", blocos, 0)).toBe("sem-data");
    expect(listaEscolhida(null, blocos, 2)).toBe("sem-data");
    expect(listaEscolhida("propostas", blocos, 2)).toBe("propostas");
  });
});

describe("ignorados pelo agente", () => {
  const ignorado = (campos: Partial<IgnoradoPeloAgente> = {}): IgnoradoPeloAgente => ({
    tipo: "proposta",
    id: 81,
    nome: textoExterno("Metalúrgica Sabiá"),
    codigo: textoExterno("0081/26"),
    motivo: "Cliente pediu para esperar a obra",
    ate: "2026-11-20" as Dia,
    ...campos,
  });

  test("a linha acima do rodapé no singular e no plural, e nenhuma sem item", () => {
    expect(textoDosIgnorados(0)).toBeNull();
    expect(textoDosIgnorados(1)).toBe("1 item ignorado pelo agente a seu pedido");
    expect(textoDosIgnorados(2)).toBe("2 itens ignorados pelo agente a seu pedido");
  });

  test("a volta diz o dia por extenso, e amanhã quando é amanhã", () => {
    expect(textoDaVolta("2026-11-20" as Dia, HOJE)).toBe("volta em 20 de novembro");
    expect(textoDaVolta("2026-11-14" as Dia, HOJE)).toBe("volta amanhã");
    expect(textoDaVolta("2027-01-02" as Dia, "2026-12-31" as Dia)).toBe("volta em 2 de janeiro de 2027");
  });

  test("título com código e cliente, ou só o cliente; apoio com o motivo entre aspas", () => {
    expect(tituloDoIgnorado(ignorado())).toBe("0081/26 · Metalúrgica Sabiá");
    expect(tituloDoIgnorado(ignorado({ tipo: "cliente", codigo: null, nome: textoExterno("Vidros Jaçanã") }))).toBe("Vidros Jaçanã");
    expect(apoioDoIgnorado(ignorado(), HOJE)).toBe('"Cliente pediu para esperar a obra" · volta em 20 de novembro');
  });
});

describe("textos de dias, faixa e prazo", () => {
  const aberta = (diasAtras: number): PropostaAberta => propostaAberta(enviada(1, diasAtras), HOJE);

  test.each([
    [0, "Enviada hoje"],
    [1, "Enviada ontem"],
    [15, "Enviada há 15 dias"],
  ])("enviada há %i dias: %s", (dias, texto) => {
    expect(textoDoEnvio(dias)).toBe(texto);
  });

  test("faixa de 7, 14 e 28 dias", () => {
    expect([aberta(3), aberta(7), aberta(15), aberta(28)].map((p) => textoDaFaixa(p.faixa))).toEqual([null, "7 dias ou mais", "14 dias ou mais", "28 dias ou mais"]);
  });

  test("o selo de atenção aparece a 2 dias do bloqueio e no prazo vencido", () => {
    expect([27, 28, 29, 30, 31].map((dias) => atencaoDaProposta(aberta(dias)))).toEqual([
      null,
      "Em 2 dias o CRM bloqueia proposta nova",
      "Amanhã o CRM bloqueia proposta nova",
      "Prazo vencido",
      "Prazo vencido",
    ]);
  });

  test("valor em reais, ou o texto do CRM quando não é número", () => {
    expect(valorDaProposta(aberta(3))).toBe("R$ 1.500,00".replace(" ", " "));
    expect(valorDaProposta({ ...aberta(3), valor_total: "a combinar" })).toBe("a combinar");
    expect(valorDaProposta({ ...aberta(3), valor_total: null })).toBeNull();
  });

  test("sem atendimento: nunca, há N dias, e aproximado", () => {
    const cliente = (dias: number | null, aproximado = false): ClienteSemAtendimento => ({ ...daCarteira(1, AGORA, aproximado), dias_sem_atendimento: dias });
    expect(textoSemAtendimento(cliente(null))).toBe("Nunca atendido");
    expect(textoSemAtendimento(cliente(45))).toBe("Sem atendimento há 45 dias");
    expect(textoSemAtendimento(cliente(400, true))).toBe("Sem atendimento há 400 dias ou mais");
  });

  test("hora do compromisso em Brasília", () => {
    expect(horaDe("2026-11-13T12:00:00.000Z" as Instante)).toBe("9h");
    expect(horaDe("2026-11-13T18:30:00.000Z" as Instante)).toBe("15h30");
    expect(textoDoCompromisso({ ...compromisso(1, "13:00"), fim: "2026-11-13T14:00:00.000Z" as Instante })).toBe("Compromisso às 10h até 11h, no CRM");
  });
});

describe("link do CRM", () => {
  test.each([
    ["https://crm.profills.test/propostas/1", "https://crm.profills.test/propostas/1"],
    ["http://crm.profills.test/propostas/1", null],
    ["javascript:alert(1)", null],
    ["https://usuario:senha@crm.profills.test/", null],
    ["não é url", null],
    [null, null],
  ])("%s vira %s", (link, esperado) => {
    expect(linkDoCrm(link)).toBe(esperado);
  });
});

describe("rodapé e motivo do CRM", () => {
  test("a idade do CRM é a da leitura mais velha entre os blocos", () => {
    const linhas = rodapeDoDia(dia({}, TUDO_LIDO));
    expect(linhas.find((l) => l.fonte === "crm")?.idade).toBe("há 20 min");
  });

  test("sem leitura, o rodapé diz por quê, e a linha acima dele dá a ação uma vez só", () => {
    expect(rodapeDoDia(dia({}, SEM_LEITURAS, NAO_LIBERADO)).find((l) => l.fonte === "crm")?.idade).toBe("não liberado");
    expect(linhasSemLeitura(dia({}, SEM_LEITURAS, NAO_LIBERADO, CONECTADO_WHATSAPP_COM_LEITURA), "sem-data")).toEqual([
      { texto: "O CRM ainda não liberou a Secretária. A Profills libera o acesso. Assim que liberar, sincronize.", botao: null },
    ]);
    expect(linhasSemLeitura(dia({}, SEM_LEITURAS, { fase: "desconectado" }, CONECTADO_WHATSAPP_COM_LEITURA), "sem-data").map((l) => l.botao)).toEqual(["conexoes"]);
    expect(linhasSemLeitura(dia({}, SEM_LEITURAS, CONECTADO, CONECTADO_WHATSAPP_COM_LEITURA), "ignorados").map((l) => l.botao)).toEqual(["sincronizar"]);
    expect(linhasSemLeitura(dia({}, TUDO_LIDO, CONECTADO, CONECTADO_WHATSAPP_COM_LEITURA), "sem-data")).toEqual([]);
  });

  test("o cartão que já diz o motivo do CRM não ganha a linha repetida embaixo", () => {
    const naoLiberado = dia({}, SEM_LEITURAS, NAO_LIBERADO, CONECTADO_WHATSAPP_COM_LEITURA);
    for (const lista of ["fazer-hoje", "propostas", "sem-atendimento"] as const) expect(linhasSemLeitura(naoLiberado, lista)).toEqual([]);
  });
});

describe("redutor da sincronização", () => {
  const aplicar = (passos: AndamentoDaSincronizacao[], inicio: EstadoDaSincronizacao = SINCRONIZACAO_PARADA) => passos.reduce(reduzirSincronizacao, inicio);

  test("mostra a fonte que está lendo e quantas já acabaram, e para no fim", () => {
    const rodando = aplicar([
      { id: "r1", etapa: "comecou", fontes: ["agenda", "propostas", "carteira", "conversas", "email"] },
      { id: "r1", etapa: "fonte", fonte: "agenda", situacao: "lendo" },
      { id: "r1", etapa: "fonte", fonte: "agenda", situacao: "leu" },
      { id: "r1", etapa: "fonte", fonte: "propostas", situacao: "lendo" },
    ]);
    expect(rotuloDaSincronizacao(rodando)).toBe("Lendo propostas (2 de 5)");
    expect(reduzirSincronizacao(rodando, { id: "r1", etapa: "terminou" })).toEqual(SINCRONIZACAO_PARADA);
  });

  test("quem abre o painel no meio entra na rodada; passo de outra rodada não mexe", () => {
    const noMeio = aplicar([{ id: "r2", etapa: "fonte", fonte: "propostas", situacao: "lendo" }]);
    expect(rotuloDaSincronizacao(noMeio)).toBe("Lendo propostas (1 de 5)");
    expect(reduzirSincronizacao(noMeio, { id: "velha", etapa: "terminou" })).toBe(noMeio);
    expect(rotuloDaSincronizacao(aplicar([{ id: "r3", etapa: "comecou", fontes: ["agenda", "propostas", "carteira", "conversas", "email"] }], noMeio))).toBe("Sincronizando 0 de 5");
    expect(rotuloDaSincronizacao(SINCRONIZACAO_PARADA)).toBe("Sincronizar");
  });

  test("o resumo diz cada fonte; erro de uma não esconde as outras", () => {
    const limite = { ...ERROS.crm_limite_de_chamadas, codigo: "crm_limite_de_chamadas" as const, esperaS: 30 };
    const rodada: Sincronizacao = {
      id: "r3",
      iniciadaEm: AGORA,
      terminadaEm: AGORA,
      jaEmAndamento: false,
      fontes: [
        { fonte: "agenda", situacao: "leu", itens: 2, lidoEm: AGORA, cortado: false },
        { fonte: "propostas", situacao: "falhou", erro: limite },
        { fonte: "carteira", situacao: "pulada", motivo: "crm_limite_de_chamadas", erro: limite },
      ],
    };
    const resumo = resumoDaSincronizacao({ ...rodada, fontes: [...rodada.fontes, { fonte: "conversas", situacao: "leu", itens: 3, lidoEm: AGORA, cortado: false }] });
    expect(resumo.tom).toBe("erro");
    expect(resumo.texto).toBe("Parte foi lida.");
    expect(resumo.linhas[0]).toBe("Agenda: 2 compromissos hoje.");
    expect(resumo.linhas[1]).toStartWith("Propostas: não leu. ");
    expect(resumo.linhas[1]).toEndWith("Tente de novo em 30 s.");
    expect(resumo.linhas[2]).toBe("Carteira: pulada, porque o CRM pediu uma pausa.");
    expect(resumo.linhas[3]).toBe("WhatsApp: 3 conversas para acompanhar.");

    const tudo = resumoDaSincronizacao({
      ...rodada,
      fontes: [
        rodada.fontes[0]!,
        { fonte: "propostas", situacao: "leu", itens: 0, lidoEm: AGORA, cortado: false },
        { fonte: "carteira", situacao: "leu", itens: 1, lidoEm: AGORA, cortado: true },
        { fonte: "conversas", situacao: "leu", itens: 1, lidoEm: AGORA, cortado: true },
      ],
    });
    expect(tudo).toEqual({
      tom: "feito",
      texto: "CRM e WhatsApp sincronizados.",
      linhas: ["Agenda: 2 compromissos hoje.", "Propostas: nenhum item.", "Carteira: 1 cliente sem atendimento, com mais no CRM.", "WhatsApp: 1 conversa para acompanhar, com conversas por conferir."],
    });
  });

  test("o resumo conta o WhatsApp: pulado, falho e lido sem consultar o CRM", () => {
    const limite = { ...ERROS.crm_limite_de_chamadas, codigo: "crm_limite_de_chamadas" as const, esperaS: 30 };
    const crmLido: Sincronizacao["fontes"] = [
      { fonte: "agenda", situacao: "leu", itens: 0, lidoEm: AGORA, cortado: false },
      { fonte: "propostas", situacao: "leu", itens: 0, lidoEm: AGORA, cortado: false },
      { fonte: "carteira", situacao: "leu", itens: 0, lidoEm: AGORA, cortado: false },
    ];
    const com = (conversas: Sincronizacao["fontes"][number]) => resumoDaSincronizacao({ id: "r4", iniciadaEm: AGORA, terminadaEm: AGORA, jaEmAndamento: false, fontes: [...crmLido, conversas] });

    const pulada = com({ fonte: "conversas", situacao: "pulada", motivo: "whatsapp_desconectado" });
    expect(pulada).toEqual({ tom: "erro", texto: "Parte foi lida.", linhas: expect.arrayContaining(["WhatsApp: pulada, porque o WhatsApp não está conectado."]) });
    expect(com({ fonte: "conversas", situacao: "pulada", motivo: "whatsapp_em_atencao" }).linhas.at(-1)).toBe("WhatsApp: pulada, porque o WhatsApp pede atenção em Conexões.");
    expect(com({ fonte: "conversas", situacao: "falhou", erro: limite }).linhas.at(-1)).toStartWith("WhatsApp: não leu. ");

    const semCrm = com({ fonte: "conversas", situacao: "leu", itens: 2, lidoEm: AGORA, cortado: false, semConsultaAoCrm: { motivo: "crm_limite_de_chamadas", erro: limite } });
    expect(semCrm.tom).toBe("erro");
    expect(semCrm.texto).toBe("Parte foi lida.");
    expect(semCrm.linhas.at(-1)).toBe("WhatsApp: 2 conversas para acompanhar. O CRM não foi consultado porque o CRM pediu uma pausa. Números novos esperam a próxima sincronização.");

    const nenhuma = resumoDaSincronizacao({
      id: "r5",
      iniciadaEm: AGORA,
      terminadaEm: AGORA,
      jaEmAndamento: false,
      fontes: [...crmLido.map((fonte) => ({ fonte: fonte.fonte, situacao: "pulada" as const, motivo: "crm_desconectado" as const })), { fonte: "conversas", situacao: "pulada", motivo: "whatsapp_desconectado" }],
    });
    expect(nenhuma.texto).toBe("Nada foi lido.");
  });

  describe("e-mail no resumo", () => {
    const lidas: Sincronizacao["fontes"] = (["agenda", "propostas", "carteira", "conversas"] as const).map((fonte) => ({ fonte, situacao: "leu", itens: 0, lidoEm: AGORA, cortado: false }));
    const resumo = (email: Sincronizacao["fontes"][number]) =>
      resumoDaSincronizacao({ id: "r6", iniciadaEm: AGORA, terminadaEm: AGORA, jaEmAndamento: false, fontes: [...lidas, email] });
    const conta = { id: "11111111-1111-4111-8111-111111111111" as IdContaEmail, rotulo: "Profills" };

    test("sem conta de e-mail a fonte não conta nem aparece: o vendedor segue lendo a frase de antes", () => {
      const sem = resumo({ fonte: "email", situacao: "pulada", motivo: "email_sem_conta" });
      expect(sem).toEqual({
        tom: "feito",
        texto: "CRM e WhatsApp sincronizados.",
        linhas: ["Agenda: nenhum item.", "Propostas: nenhum item.", "Carteira: nenhum item.", "WhatsApp: nenhum item."],
      });
    });

    test("com a fonte lida, a frase inclui o e-mail e a linha conta os e-mails guardados", () => {
      const lido = resumo({ fonte: "email", situacao: "leu", itens: 42, lidoEm: AGORA, cortado: false, contas: [{ ...conta, situacao: "leu", novos: 3, cortado: false, semEnviados: false, ilegiveis: 0 }] });
      expect(lido).toMatchObject({ tom: "feito", texto: "CRM, WhatsApp e e-mail sincronizados." });
      expect(lido.linhas.at(-1)).toBe("E-mail: 42 e-mails guardados.");
      expect(resumo({ fonte: "email", situacao: "leu", itens: 1, lidoEm: AGORA, cortado: true }).linhas.at(-1)).toBe("E-mail: 1 e-mail guardado, com mais e-mails por ler.");
    });

    test("conta que não leu, ou nenhuma conectada, deixa a rodada pela metade e diz isso", () => {
      const erro = { ...ERROS.interno, codigo: "email_senha_recusada" as const, mensagem: "x", acao: "y" };
      const parcial = resumo({
        fonte: "email",
        situacao: "leu",
        itens: 5,
        lidoEm: AGORA,
        cortado: false,
        contas: [
          { ...conta, situacao: "leu", novos: 5, cortado: false, semEnviados: false, ilegiveis: 0 },
          { id: "22222222-2222-4222-8222-222222222222" as IdContaEmail, rotulo: "Pessoal", situacao: "falhou", erro },
        ],
      });
      expect(parcial).toMatchObject({ tom: "erro", texto: "Parte foi lida." });
      expect(parcial.linhas.at(-1)).toBe("E-mail: 5 e-mails guardados. Uma conta não foi lida.");
      const nenhuma = resumo({ fonte: "email", situacao: "pulada", motivo: "email_sem_conta_conectada" });
      expect(nenhuma).toMatchObject({ tom: "erro", texto: "Parte foi lida." });
      expect(nenhuma.linhas.at(-1)).toBe("E-mail: pulada, porque nenhuma conta de e-mail está conectada.");
      expect(resumo({ fonte: "email", situacao: "falhou", erro }).linhas.at(-1)).toStartWith("E-mail: não leu. ");
    });

    test("conta em atenção ou testando não foi lida; só a desconectada de propósito fica fora da conta", () => {
      const lida = { ...conta, situacao: "leu" as const, novos: 1, cortado: false, semEnviados: false, ilegiveis: 0 };
      const outra = { id: "22222222-2222-4222-8222-222222222222" as IdContaEmail, rotulo: "Pessoal" };
      const com = (motivo: "em_atencao" | "testando" | "desconectado") =>
        resumo({ fonte: "email", situacao: "leu", itens: 1, lidoEm: AGORA, cortado: false, contas: [lida, { ...outra, situacao: "pulada", motivo }] });
      for (const motivo of ["em_atencao", "testando"] as const) {
        const parcial = com(motivo);
        expect({ motivo, tom: parcial.tom, texto: parcial.texto, linha: parcial.linhas.at(-1) }).toEqual({
          motivo,
          tom: "erro",
          texto: "Parte foi lida.",
          linha: "E-mail: 1 e-mail guardado. Uma conta não foi lida.",
        });
      }
      expect(com("desconectado")).toMatchObject({ tom: "feito", texto: "CRM, WhatsApp e e-mail sincronizados." });
    });
  });
});

describe("conversas do WhatsApp no Meu dia", () => {
  const telefone = (final: number) => `+554199999${String(final).padStart(4, "0")}`;
  const lida = (final: number, situacao: ConversaLida["situacao"], nome: string | null = `Nome Canário ${final}`): ConversaLida => ({
    conversa: `${telefone(final).slice(1)}@s.whatsapp.net`,
    telefone: lerTelefone(telefone(final))!,
    nome: nome === null ? null : textoExterno(nome),
    ultimaMensagemEm: situacao.tipo === "nada" ? LIDO : situacao.desde,
    contaFalouEm: situacao.tipo === "esperando" ? situacao.desde : null,
    situacao,
  });
  const responder = (desde: string, novas: number, extra: Partial<Extract<ConversaLida["situacao"], { tipo: "responder" }>> = {}): ConversaLida["situacao"] => ({
    tipo: "responder",
    desde: desde as Instante,
    novas,
    em_quarentena: false,
    mensagens_em_quarentena: [],
    sinais: [],
    tem_ilegiveis: false,
    mais_que_o_lido: false,
    ...extra,
  });
  const comCliente = (final: number, id: number, estado: "auto" | "confirmado" = "auto"): VinculoDeContato =>
    ({ canal: "whatsapp", chave: telefone(final), conferidoEm: LIDO, estado, cliente: { id, nome: textoExterno(`CANARIO Cliente ${id}`), cidade: textoExterno("Curitiba") }, decididoEm: estado === "auto" ? null : LIDO }) as VinculoDeContato;
  const ambiguo = (final: number, motivo: MotivoDaDuvida, ids: number[]): VinculoDeContato => ({
    canal: "whatsapp",
    chave: telefone(final),
    conferidoEm: LIDO,
    estado: "ambiguo",
    motivo,
    candidatos: ids.map((id) => ({ id, nome: textoExterno(`CANARIO Cliente ${id}`), cidade: textoExterno("Curitiba"), uf: textoExterno("PR") })),
    decididoEm: null,
  });

  const conversas = (itens: ConversaLida[], vinculos: VinculoDeContato[], resto: Partial<DadosDasConversas> = {}, cortado = false): DadosDasConversas => ({
    leitura: { lidoEm: LIDO, itens, cortado },
    vinculos: new Map(vinculos.map((v) => [v.chave, v])),
    ignoradas: [],
    ...resto,
  });

  const ANTES = (minutos: number) => new Date(Date.parse(AGORA) - minutos * 60_000).toISOString();
  const cheio = conversas(
    [
      lida(1, responder(ANTES(2 * 24 * 60), 3)),
      lida(2, responder(ANTES(5 * 60), 1), "Marcos"),
      lida(3, responder(ANTES(3 * 60), 2, { em_quarentena: true, mensagens_em_quarentena: ["3EB0CANARIO0001"] })),
      lida(5, { tipo: "esperando", desde: ANTES(6 * 24 * 60) as Instante, dias_uteis: 4 }),
    ],
    [comCliente(1, 9201), ambiguo(2, "varios_clientes", [9202, 9203]), comCliente(3, 9206), comCliente(5, 9205, "confirmado")],
  );

  const doDia = (dados: DadosDasConversas, whatsapp: EstadoWhatsapp = { fase: "desconectado" }, leituras: LeiturasDoCrm = TUDO_LIDO) => dia({}, leituras, CONECTADO, dados, whatsapp);
  const bloco = (d: MeuDia, id: string) => montarBlocos(d).find((b) => b.definicao.id === id)!;

  test("os contadores ficam na ordem do dono, com Responder e Esperando cliente entre os outros", () => {
    expect(contagens(doDia(cheio))).toEqual([
      ["fazer-hoje", "2"],
      ["sem-data", "0"],
      ["aprovar", "0"],
      ["responder", "3"],
      ["propostas", "2"],
      ["esperando-cliente", "1"],
      ["sem-atendimento", "1"],
    ]);
  });

  test("a linha de Responder: título, apoio com as mensagens novas, e nada de texto de mensagem", () => {
    const { conteudo } = bloco(doDia(cheio), "responder");
    if (conteudo.leitura !== "lido") throw new Error("era para estar lido");
    expect(conteudo.itens.map((i) => i.tipo === "responder" && [i.chave, i.titulo, i.apoio])).toEqual([
      [`conversa:whatsapp:${telefone(1)}`, "CANARIO Cliente 9201", "3 mensagens novas. A mais antiga é de 2 dias atrás"],
      [`conversa:whatsapp:${telefone(2)}`, "(41) 99999-0002 · Marcos", "1 mensagem nova, de 5 horas atrás"],
      [`conversa:whatsapp:${telefone(3)}`, "CANARIO Cliente 9206", "2 mensagens novas. A mais antiga é de 3 horas atrás"],
    ]);
    expect(JSON.stringify(conteudo)).not.toContain("CANARIO-TEXTO");
  });

  test("o apoio usa mais_que_o_lido e tem_ilegiveis do item, e não a contagem", () => {
    const d = doDia(
      conversas(
        [lida(1, responder(ANTES(60), 20)), lida(2, responder(ANTES(60), 20, { mais_que_o_lido: true })), lida(3, responder(ANTES(60), 1, { tem_ilegiveis: true }))],
        [comCliente(1, 9201), comCliente(2, 9202), comCliente(3, 9203)],
      ),
    );
    const { conteudo } = bloco(d, "responder");
    expect(conteudo.leitura === "lido" && conteudo.itens.map((i) => i.tipo === "responder" && i.apoio)).toEqual([
      "20 mensagens novas. A mais antiga é de 1 hora atrás",
      "20 ou mais mensagens novas. A mais antiga é de 1 hora atrás",
      "1 mensagem nova, de 1 hora atrás. Há mensagem que a Secretária não conseguiu ler. Confira no WhatsApp.",
    ]);
  });

  test("a conversa sem cliente leva só o telefone quando o nome no WhatsApp é nulo", () => {
    const d = doDia(conversas([lida(2, responder(ANTES(60), 1), null)], [ambiguo(2, "variante_do_9", [9204])]));
    const { conteudo } = bloco(d, "responder");
    expect(conteudo.leitura === "lido" && conteudo.itens[0]).toMatchObject({ tipo: "responder", titulo: "(41) 99999-0002", conversa: { vinculo: "ambiguo", motivo_da_duvida: "variante_do_9" } });
  });

  test("Esperando cliente: nome do cliente e dias úteis", () => {
    const { conteudo } = bloco(doDia(cheio), "esperando-cliente");
    expect(conteudo.leitura === "lido" && conteudo.itens.map((i) => i.tipo === "esperando" && [i.titulo, i.apoio])).toEqual([["CANARIO Cliente 9205", "Você falou por último há 4 dias úteis"]]);
  });

  test("lido e vazio mostra 0 apagado, com a frase do bloco", () => {
    const d = doDia(conversas([], []));
    for (const id of ["responder", "esperando-cliente"]) expect(contador(bloco(d, id).conteudo)).toEqual({ texto: "0", apagado: true, falado: "0 itens" });
    expect(BLOCOS.find((b) => b.id === "responder")?.vazio).toBe("Nenhuma conversa esperando resposta.");
  });

  test("o corte e os ignorados viram nota discreta no cartão", () => {
    const d = doDia(conversas(cheio.leitura!.itens as ConversaLida[], [...cheio.vinculos.values()], { ignoradas: [{ tipo: "conversa", id: telefone(1), nome: textoExterno("x"), quem: "vendedor", motivo: null, ate: "2026-11-20" as Dia }] }, true));
    const responderNotas = bloco(d, "responder").conteudo;
    expect(responderNotas.leitura === "lido" && responderNotas.notas).toEqual(["Ainda há conversas para conferir. Sincronize de novo.", "1 conversa ignorada por 7 dias."]);
    const esperando = bloco(d, "esperando-cliente").conteudo;
    expect(esperando.leitura === "lido" && esperando.notas).toEqual(["Ainda há conversas para conferir. Sincronize de novo."]);
    const doisIgnorados = { ...d, responder: { ...d.responder, ignorados: 2, cortado: false } };
    expect(bloco(doisIgnorados, "responder").conteudo).toMatchObject({ notas: ["2 conversas ignoradas por 7 dias."] });
  });

  test("com leitura guardada, os itens aparecem mesmo com o WhatsApp desconectado depois", () => {
    const d = doDia(cheio, { fase: "desconectado" });
    expect(contador(bloco(d, "responder").conteudo).texto).toBe("3");
    expect(linhasSemLeitura(d, "responder")).toEqual([]);
  });

  test.each<[EstadoWhatsapp, Exclude<MotivoDoBlocoDeConversas, "sem_itens">, string, AcaoDoMotivo]>([
    [{ fase: "desconectado" } as EstadoWhatsapp, "whatsapp_desconectado", "O WhatsApp não está conectado. Conecte o WhatsApp em Conexões.", "conexoes"],
    [{ fase: "atencao", problema: { codigo: "whatsapp_espelho_caindo", desde: AGORA }, conta: null } as unknown as EstadoWhatsapp, "whatsapp_em_atencao", "O WhatsApp pede atenção. Veja o que fazer em Conexões.", "conexoes"],
    [{ fase: "conectado", conta: { telefone: "+5511900004321" }, verificadoEm: AGORA, espelho: "ao_vivo", ultimaAtividade: null } as unknown as EstadoWhatsapp, "sem_leitura", "As conversas do WhatsApp ainda não foram lidas. Sincronize para ler agora.", "sincronizar"],
  ])("bloco de conversas sem leitura (%#): traço, motivo %s e a ação", (whatsapp, motivo, frase, botao) => {
    const d = doDia(SEM_CONVERSAS, whatsapp);
    for (const id of ["responder", "esperando-cliente"]) {
      const { conteudo } = bloco(d, id);
      expect(conteudo).toEqual({ leitura: "nao_lido", fonte: "whatsapp", motivo });
      expect(contador(conteudo)).toEqual({ texto: "–", apagado: true, falado: "não lido" });
      if (conteudo.leitura === "nao_lido") expect(`${explicacaoDoMotivo(conteudo).texto} ${explicacaoDoMotivo(conteudo).acao}`).toBe(frase);
    }
    // Longe de Responder e de Esperando cliente, a linha discreta diz o motivo; dentro deles, o cartão já diz.
    expect(linhasSemLeitura(d, "sem-data")).toEqual([{ texto: frase, botao }]);
    expect(linhasSemLeitura(d, "responder")).toEqual([]);
    expect(linhasSemLeitura(d, "esperando-cliente")).toEqual([]);
    expect(diaVazio(montarBlocos(d))).toBe(false);
  });

  test("CRM e WhatsApp sem leitura pelo mesmo motivo dão uma linha só; por motivos diferentes, duas", () => {
    const conectado = { fase: "conectado", conta: { telefone: "+5511900004321" }, verificadoEm: AGORA, espelho: "ao_vivo", ultimaAtividade: null } as unknown as EstadoWhatsapp;
    expect(linhasSemLeitura(dia({}, SEM_LEITURAS, CONECTADO, SEM_CONVERSAS, conectado), "sem-data")).toEqual([
      { texto: "O CRM e as conversas do WhatsApp ainda não foram lidos. Sincronize para ler agora.", botao: "sincronizar" },
    ]);
    expect(linhasSemLeitura(dia({}, SEM_LEITURAS, NAO_LIBERADO, SEM_CONVERSAS, { fase: "desconectado" }), "sem-data").map((l) => l.botao)).toEqual([null, "conexoes"]);
    // Em Responder, o cartão diz o do WhatsApp, e o CRM continua na linha.
    expect(linhasSemLeitura(dia({}, SEM_LEITURAS, NAO_LIBERADO, SEM_CONVERSAS, { fase: "desconectado" }), "responder").map((l) => l.texto)).toEqual([
      "O CRM ainda não liberou a Secretária. A Profills libera o acesso. Assim que liberar, sincronize.",
    ]);
  });

  test("o rodapé mede o WhatsApp pela leitura das conversas, não pelo espelho", () => {
    const idade = (d: MeuDia) => rodapeDoDia(d).find((l) => l.fonte === "whatsapp")?.idade;
    // O espelho diz "agora" (idadeMin 0), a leitura das conversas é de 7 min atrás.
    expect(idade(doDia(cheio, { fase: "desconectado" }, SEM_LEITURAS))).toBe("há 7 min");
    expect(idade(doDia(SEM_CONVERSAS, { fase: "desconectado" }))).toBe("não conectado");
    expect(idade(doDia(SEM_CONVERSAS, { fase: "atencao", problema: { codigo: "whatsapp_espelho_caindo", desde: AGORA }, conta: null } as unknown as EstadoWhatsapp))).toBe("pede atenção");
    expect(idade(doDia(SEM_CONVERSAS, { fase: "conectado", conta: { telefone: "+5511900004321" }, verificadoEm: AGORA, espelho: "ao_vivo", ultimaAtividade: null } as unknown as EstadoWhatsapp))).toBe("não sincronizado");
  });

  test("conversa entre os ignorados pelo agente: título com o canal, motivo entre aspas e o alvo do Desfazer", () => {
    const ignorada: IgnoradoDeConversa = { tipo: "conversa", canal: "whatsapp", id: telefone(1), nome: textoExterno("CANARIO Cliente 9201"), codigo: null, motivo: "Ele pediu para esperar.", ate: "2026-11-20" as Dia };
    expect(tituloDoIgnorado(ignorada)).toBe("WhatsApp · CANARIO Cliente 9201");
    expect(tituloDoIgnorado({ ...ignorada, nome: textoExterno(telefone(2)) })).toBe("WhatsApp · (41) 99999-0002");
    expect(apoioDoIgnorado(ignorada, HOJE)).toBe('"Ele pediu para esperar." · volta em 20 de novembro');
    expect(alvoDoIgnorado(ignorada)).toEqual({ tipo: "conversa", canal: "whatsapp", id: telefone(1) });
    const doEmail: IgnoradoDeConversa = { ...ignorada, canal: "email", id: "e-0123456789abcdef", nome: textoExterno("compras@cliente.exemplo.test") };
    expect(tituloDoIgnorado(doEmail)).toBe("E-mail · compras@cliente.exemplo.test");
    expect(alvoDoIgnorado(doEmail)).toEqual({ tipo: "conversa", canal: "email", id: "e-0123456789abcdef" });
    expect(alvoDoIgnorado({ tipo: "proposta", id: 81, nome: textoExterno("x"), codigo: null, motivo: "motivo certo", ate: "2026-11-20" as Dia })).toEqual({ tipo: "proposta", id: 81 });
  });
});

describe("e-mail nos blocos de conversas", () => {
  const CONTA = { id: "11111111-1111-4111-8111-111111111111" as IdContaEmail, rotulo: "Profills" };
  const leitura = (campos: Partial<LeituraDoEmailNoBloco> = {}): LeituraDoEmailNoBloco => ({ lido_em: LIDO, motivo: null, cortado: false, contas_lidas: 1, contas: 1, contas_sem_enviados: [], ...campos });
  const SEM_EMAIL_NO_BLOCO = leitura({ lido_em: null, motivo: "email_sem_conta", contas_lidas: 0, contas: 0 });
  const cliente = (id: number) => ({ id, nome: textoExterno(`CANARIO Cliente ${id}`), cidade: textoExterno("Curitiba") });
  const emailDeResponder = (id: string, desde: string, extra: Partial<ItemDeResponderDeEmail> = {}): ItemDeResponderDeEmail =>
    ({
      canal: "email",
      id,
      conta: CONTA,
      endereco: "compras@cliente.exemplo.test",
      nome_do_remetente: textoExterno("Compras Canário"),
      assunto: textoExterno("Pedido de orçamento"),
      ultimo_email: `entrada-${id}`,
      em_quarentena: false,
      mensagens_em_quarentena: [],
      desde: desde as Instante,
      novas: 1,
      vinculo: "auto",
      cliente: cliente(9301),
      ...extra,
    }) as ItemDeResponderDeEmail;
  const emailEsperando = (id: string, desde: string): ItemDeEsperandoDeEmail => ({
    canal: "email",
    id,
    conta: CONTA,
    endereco: "vidros@cliente.exemplo.test",
    nome_do_remetente: null,
    assunto: textoExterno("Tabela de preços"),
    ultimo_email: `entrada-${id}`,
    em_quarentena: false,
    vinculo: "auto",
    cliente: cliente(9302),
    desde: desde as Instante,
    dias_uteis: 6,
  });
  const whatsappDeResponder = (final: number, desde: string): ItemDeResponderDoWhatsapp => ({
    canal: "whatsapp",
    conversa: `554199990000${final}@s.whatsapp.net`,
    telefone: `+55419999000${final}`,
    nome_no_whatsapp: null,
    desde: desde as Instante,
    novas: 3,
    em_quarentena: false,
    mensagens_em_quarentena: [],
    tem_ilegiveis: false,
    mais_que_o_lido: false,
    vinculo: "auto",
    cliente: cliente(9200 + final),
  });
  const NO_WA = { lido_em: LIDO, motivo: null, cortado: false, ignorados: 0 } as const;
  const SEM_WA = { lido_em: null, motivo: "whatsapp_desconectado", cortado: false, ignorados: 0 } as const;

  /** Responder com os itens dados; o WhatsApp lido por padrão. */
  const comResponder = (itens: ItemDeResponder[], email: LeituraDoEmailNoBloco, whatsapp: Omit<MeuDia["responder"], "itens" | "email"> = NO_WA): MeuDia => {
    const d = dia();
    return { ...d, responder: { ...whatsapp, itens, email } };
  };
  const comEsperando = (itens: ItemDeEsperando[], email: LeituraDoEmailNoBloco, whatsapp: Omit<MeuDia["esperando_cliente"], "itens" | "email"> = NO_WA): MeuDia => {
    const d = dia();
    return { ...d, esperando_cliente: { ...whatsapp, itens, email } };
  };
  const bloco = (d: MeuDia, id: string) => montarBlocos(d).find((b) => b.definicao.id === id)!.conteudo;
  const lido = (d: MeuDia, id: string) => {
    const conteudo = bloco(d, id);
    if (conteudo.leitura !== "lido") throw new Error("era para estar lido");
    return conteudo;
  };

  const ITENS = [whatsappDeResponder(1, "2026-11-11T12:00:00.000Z"), emailDeResponder("e-0000000000000001", "2026-11-12T13:00:00.000Z"), whatsappDeResponder(2, "2026-11-13T09:00:00.000Z")];

  test("os itens dos dois canais ficam na ordem do servidor, com o canal na chave, e o contador conta os dois", () => {
    const d = comResponder(ITENS, leitura());
    const { itens } = lido(d, "responder");
    expect(itens.map((i) => i.chave)).toEqual(["conversa:whatsapp:+554199990001", "conversa:email:e-0000000000000001", "conversa:whatsapp:+554199990002"]);
    expect(itens.map((i) => i.tipo === "responder" && i.conversa.canal)).toEqual(["whatsapp", "email", "whatsapp"]);
    expect(contador(bloco(d, "responder")).texto).toBe("3");
  });

  test("Esperando cliente traz o e-mail, com o título do cliente e o apoio em dias úteis", () => {
    const d = comEsperando([emailEsperando("e-0000000000000002", "2026-11-03T12:00:00.000Z")], leitura());
    const { itens } = lido(d, "esperando-cliente");
    expect(itens.map((i) => i.tipo === "esperando" && [i.chave, i.titulo, i.apoio])).toEqual([["conversa:email:e-0000000000000002", "CANARIO Cliente 9302", "Tabela de preços · Você respondeu por último há 6 dias úteis"]]);
  });

  test("WhatsApp sem leitura e e-mail lido: o bloco é lido, só com os itens de e-mail", () => {
    for (const motivo of [null, "sem_itens"] as const) {
      const itens = motivo === null ? [emailDeResponder("e-0000000000000001", "2026-11-12T13:00:00.000Z")] : [];
      const d = comResponder(itens, leitura({ motivo }), SEM_WA);
      const conteudo = lido(d, "responder");
      expect(conteudo.itens).toHaveLength(itens.length);
      expect(contador(bloco(d, "responder")).apagado).toBe(itens.length === 0);
    }
    const esperando = comEsperando([emailEsperando("e-0000000000000002", "2026-11-03T12:00:00.000Z")], leitura(), SEM_WA);
    expect(lido(esperando, "esperando-cliente").itens).toHaveLength(1);
  });

  test.each<MotivoDoEmailNoBloco>(["email_sem_conta", "email_sem_conta_conectada", "sem_leitura"])("os dois sem leitura (e-mail %s): o bloco é nao_lido pelo WhatsApp", (motivo) => {
    const d = comResponder([], leitura({ lido_em: null, motivo, contas_lidas: 0 }), SEM_WA);
    expect(bloco(d, "responder")).toEqual({ leitura: "nao_lido", fonte: "whatsapp", motivo: "whatsapp_desconectado" });
    expect(contador(bloco(d, "responder"))).toEqual({ texto: "–", apagado: true, falado: "não lido" });
  });

  test("vendedor sem e-mail: o WhatsApp lido dá a lista de antes, sem filtro, e sem leitura dá o traço de antes", () => {
    const lidoSo = comResponder([ITENS[0]!, ITENS[2]!], SEM_EMAIL_NO_BLOCO);
    expect(lido(lidoSo, "responder").itens.map((i) => i.chave)).toEqual(["conversa:whatsapp:+554199990001", "conversa:whatsapp:+554199990002"]);
    expect(lido(lidoSo, "responder").filtro).toBeUndefined();
    expect(bloco(comResponder([], SEM_EMAIL_NO_BLOCO, SEM_WA), "responder")).toEqual({ leitura: "nao_lido", fonte: "whatsapp", motivo: "whatsapp_desconectado" });
  });

  test("notas: e-mail cortado, conta sem enviados e ignorados dos dois canais", () => {
    const d = comResponder([], leitura({ cortado: true, contas_sem_enviados: ["Pessoal", "Profills"] }), { ...NO_WA, cortado: true, ignorados: 3 });
    expect(lido(d, "responder").notas).toEqual([
      "Ainda há conversas para conferir. Sincronize de novo.",
      "Ainda há e-mails para conferir. Sincronize de novo.",
      'A conta "Pessoal" não mostrou a pasta de enviados. O e-mail que você já respondeu por ela continua em Responder.',
      'A conta "Profills" não mostrou a pasta de enviados. O e-mail que você já respondeu por ela continua em Responder.',
      "3 conversas ignoradas por 7 dias.",
    ]);
    const esperando = comEsperando([], leitura({ cortado: true }), { ...NO_WA, ignorados: 1 });
    expect(lido(esperando, "esperando-cliente").notas).toEqual(["Ainda há e-mails para conferir. Sincronize de novo.", "1 conversa ignorada por 7 dias."]);
    expect(lido(comResponder([], leitura()), "responder").notas).toEqual([]);
  });

  describe("filtro por canal", () => {
    const comItemDeEmail = [ITENS[0]!, ITENS[1]!];
    const motivos: [MotivoDoEmailNoBloco | null, boolean][] = [
      [null, true],
      ["sem_itens", true],
      ["sem_leitura", true],
      ["email_sem_conta_conectada", false],
      ["email_sem_conta", false],
    ];

    test.each(motivos)("com email.motivo %p o filtro aparece: %p", (motivo, aparece) => {
      const itens = motivo === null ? comItemDeEmail : [ITENS[0]!];
      const conteudo = lido(comResponder(itens, leitura({ motivo })), "responder");
      expect(conteudo.filtro !== undefined).toBe(aparece);
    });

    test("só Responder e Esperando cliente têm filtro", () => {
      const d = comResponder(comItemDeEmail, leitura());
      for (const id of ["fazer-hoje", "sem-data", "propostas", "sem-atendimento"]) {
        const conteudo = bloco(d, id);
        expect(conteudo.leitura === "lido" && conteudo.filtro).toBeFalsy();
      }
    });

    test("as contagens saem dos itens da lista: Tudo, WhatsApp e E-mail", () => {
      const conteudo = lido(comResponder(ITENS, leitura()), "responder");
      expect(conteudo.filtro).toEqual({ tudo: 3, whatsapp: 2, email: 1 });
      expect(lido(comResponder([], leitura({ motivo: "sem_itens" })), "responder").filtro).toEqual({ tudo: 0, whatsapp: 0, email: 0 });
    });

    test("filtrar não muda o contador, e o filtro devolve os itens do canal na ordem da lista", () => {
      const d = comResponder(ITENS, leitura());
      const conteudo = lido(d, "responder");
      const antes = contador(conteudo);
      expect(itensFiltrados(conteudo.itens, "email").map((i) => i.chave)).toEqual(["conversa:email:e-0000000000000001"]);
      expect(itensFiltrados(conteudo.itens, "whatsapp").map((i) => i.chave)).toEqual(["conversa:whatsapp:+554199990001", "conversa:whatsapp:+554199990002"]);
      expect(itensFiltrados(conteudo.itens, "tudo")).toHaveLength(3);
      expect(contador(conteudo)).toEqual(antes);
    });

    test("o filtro que vale é o escolhido, só quando o bloco tem filtro", () => {
      const comFiltro = lido(comResponder(ITENS, leitura()), "responder");
      const semFiltro = lido(comResponder([ITENS[0]!], SEM_EMAIL_NO_BLOCO), "responder");
      expect(filtroAplicado(comFiltro, "email")).toBe("email");
      expect(filtroAplicado(comFiltro, undefined)).toBe("tudo");
      expect(filtroAplicado(semFiltro, "email")).toBe("tudo");
    });

    test("a escolha de um bloco não muda a do outro, e o filtro que some volta a mostrar tudo", () => {
      const d = { ...comResponder(ITENS, leitura()), esperando_cliente: { ...dia().esperando_cliente, itens: [], email: leitura({ motivo: "sem_itens" }) } };
      const blocos = montarBlocos(d);
      const escolhas: Partial<Record<string, FiltroDeCanal>> = { responder: "email", "esperando-cliente": "whatsapp" };
      expect(limparFiltros(escolhas, blocos)).toBe(escolhas);

      const semEmail = montarBlocos({ ...d, responder: { ...d.responder, email: SEM_EMAIL_NO_BLOCO, itens: [ITENS[0]!] } });
      expect(limparFiltros(escolhas, semEmail)).toEqual({ "esperando-cliente": "whatsapp" });
    });

    test("a frase do canal sem item, e a do canal que não foi lido", () => {
      expect(lido(comResponder([], leitura({ motivo: "sem_itens" })), "responder").vazioDoFiltro).toEqual({
        whatsapp: "Nenhuma conversa do WhatsApp aqui agora.",
        email: "Nenhum e-mail aqui agora.",
      });
      expect(lido(comResponder([ITENS[1]!], leitura(), SEM_WA), "responder").vazioDoFiltro?.whatsapp).toBe("O WhatsApp não está conectado.");
      expect(lido(comEsperando([], leitura({ motivo: "sem_leitura" })), "esperando-cliente").vazioDoFiltro?.email).toBe("Os e-mails ainda não foram lidos.");
    });
  });
});

describe("e-mail na linha discreta, no rodapé e no resumo", () => {
  const leitura = (campos: Partial<LeituraDoEmailNoBloco> = {}): LeituraDoEmailNoBloco => ({ lido_em: null, motivo: "sem_itens", cortado: false, contas_lidas: 1, contas: 1, contas_sem_enviados: [], ...campos });
  const comEmail = (email: LeituraDoEmailNoBloco, base: MeuDia = dia({}, TUDO_LIDO, CONECTADO, CONECTADO_WHATSAPP_COM_LEITURA)): MeuDia => ({
    ...base,
    responder: { ...base.responder, email },
    esperando_cliente: { ...base.esperando_cliente, email },
  });
  const SEM_LEITURA = { texto: "Os e-mails ainda não foram lidos. Sincronize para ler agora.", botao: "sincronizar" } as const;

  test.each<[MotivoDoEmailNoBloco | null, { texto: string; botao: AcaoDoMotivo }[]]>([
    ["sem_leitura", [SEM_LEITURA]],
    ["email_sem_conta_conectada", [{ texto: "Nenhuma conta de e-mail está conectada. Conecte em Conexões.", botao: "conexoes" }]],
    ["email_sem_conta", []],
    ["sem_itens", []],
    [null, []],
  ])("e-mail %p dá %j", (motivo, esperado) => {
    expect(linhasSemLeitura(comEmail(leitura({ motivo })), "sem-data")).toEqual(esperado);
  });

  test("duas ou mais fontes sem leitura saem numa linha só, com as quatro frases", () => {
    const semCrm = dia({}, SEM_LEITURAS, CONECTADO, CONECTADO_WHATSAPP_COM_LEITURA);
    const semWhatsapp = dia({}, TUDO_LIDO, CONECTADO, SEM_CONVERSAS, { fase: "conectado", conta: { telefone: "+5511900004321" }, verificadoEm: AGORA, espelho: "ao_vivo", ultimaAtividade: null } as unknown as EstadoWhatsapp);
    const nenhumLido = dia({}, SEM_LEITURAS, CONECTADO, SEM_CONVERSAS, { fase: "conectado", conta: { telefone: "+5511900004321" }, verificadoEm: AGORA, espelho: "ao_vivo", ultimaAtividade: null } as unknown as EstadoWhatsapp);
    const sincronizar = (texto: string) => [{ texto, botao: "sincronizar" as const }];
    const email = leitura({ motivo: "sem_leitura" });
    expect(linhasSemLeitura(nenhumLido, "sem-data")).toEqual(sincronizar("O CRM e as conversas do WhatsApp ainda não foram lidos. Sincronize para ler agora."));
    expect(linhasSemLeitura(comEmail(email, nenhumLido), "sem-data")).toEqual(sincronizar("O CRM, as conversas do WhatsApp e os e-mails ainda não foram lidos. Sincronize para ler agora."));
    expect(linhasSemLeitura(comEmail(email, semCrm), "sem-data")).toEqual(sincronizar("O CRM e os e-mails ainda não foram lidos. Sincronize para ler agora."));
    expect(linhasSemLeitura(comEmail(email, semWhatsapp), "sem-data")).toEqual(sincronizar("As conversas do WhatsApp e os e-mails ainda não foram lidos. Sincronize para ler agora."));
  });

  test("o WhatsApp sem leitura aparece na linha discreta quando o bloco aberto só tem e-mail", () => {
    const d = comEmail(leitura({ motivo: null, lido_em: LIDO }), dia({}, TUDO_LIDO, CONECTADO, SEM_CONVERSAS, { fase: "desconectado" }));
    expect(linhasSemLeitura(d, "responder")).toEqual([{ texto: "O WhatsApp não está conectado. Conecte o WhatsApp em Conexões.", botao: "conexoes" }]);
    const semEmail = comEmail(leitura({ motivo: "email_sem_conta", contas: 0, contas_lidas: 0 }), dia({}, TUDO_LIDO, CONECTADO, SEM_CONVERSAS, { fase: "desconectado" }));
    expect(linhasSemLeitura(semEmail, "responder")).toEqual([]);
  });

  describe("rodapé", () => {
    const comFonte = (email: LeituraDoEmailNoBloco | null): MeuDia => {
      const base = dia({}, TUDO_LIDO, CONECTADO, CONECTADO_WHATSAPP_COM_LEITURA);
      if (email === null) return base;
      return { ...comEmail(email, base), fontes: [...base.fontes, { fonte: "email", lidaEm: AGORA, idadeMin: 0, conectadas: 1, total: email.contas }] };
    };
    const idadeDoEmail = (d: MeuDia) => rodapeDoDia(d).find((l) => l.fonte === "email");
    const LIDO_HA_7 = "2026-11-13T14:53:00.000Z" as Instante;

    test("a idade é a da leitura dos cabeçalhos, com as contas só quando alguma não foi lida", () => {
      expect(idadeDoEmail(comFonte(leitura({ lido_em: LIDO_HA_7 })))).toMatchObject({ nome: "E-mail", idade: "há 7 min" });
      expect(idadeDoEmail(comFonte(leitura({ lido_em: LIDO_HA_7, contas: 2, contas_lidas: 2 })))?.idade).toBe("há 7 min");
      expect(idadeDoEmail(comFonte(leitura({ lido_em: LIDO_HA_7, contas: 2, contas_lidas: 1 })))?.idade).toBe("há 7 min, 1 de 2 contas");
    });

    test("sem leitura: não conectado, ou não sincronizado", () => {
      expect(idadeDoEmail(comFonte(leitura({ motivo: "email_sem_conta_conectada", contas_lidas: 0 })))?.idade).toBe("não conectado");
      expect(idadeDoEmail(comFonte(leitura({ motivo: "sem_leitura", contas_lidas: 0 })))?.idade).toBe("não sincronizado");
    });

    test("sem conta nenhuma o e-mail não está no rodapé", () => {
      expect(rodapeDoDia(comFonte(null)).map((l) => l.fonte)).toEqual(["tarefas", "whatsapp", "crm"]);
    });
  });

  test("o resumo avisa sobre remetentes na fonte de e-mail e continua falando de números nas conversas", () => {
    const erro = { ...ERROS.crm_limite_de_chamadas, codigo: "crm_limite_de_chamadas" as const, esperaS: 30 };
    const semConsulta = { motivo: "crm_limite_de_chamadas" as const, erro };
    const rodada = (fonte: "conversas" | "email"): string[] =>
      resumoDaSincronizacao({ id: "r7", iniciadaEm: AGORA, terminadaEm: AGORA, jaEmAndamento: false, fontes: [{ fonte, situacao: "leu", itens: 2, lidoEm: AGORA, cortado: false, semConsultaAoCrm: semConsulta }] }).linhas as string[];
    expect(rodada("email")[0]).toBe("E-mail: 2 e-mails guardados. O CRM não foi consultado porque o CRM pediu uma pausa. Remetentes novos esperam a próxima sincronização.");
    expect(rodada("conversas")[0]).toBe("WhatsApp: 2 conversas para acompanhar. O CRM não foi consultado porque o CRM pediu uma pausa. Números novos esperam a próxima sincronização.");
  });
});

describe("bloco Aprovar", () => {
  const blocoAprovar = (d: MeuDia) => montarBlocos(d).find((b) => b.definicao.id === "aprovar");

  test("o item leva a chave, o resumo, o título e o apoio prontos", () => {
    const r = resumo({ confiraOCliente: true, criadaEm: "2026-11-13T12:12:00.000Z" as Instante });
    const bloco = blocoAprovar(dia({ aprovar: [r] }));
    if (bloco?.conteudo.leitura !== "lido") throw new Error("era para estar lido");
    expect(bloco.conteudo.notas).toEqual([]);
    expect(bloco.conteudo.itens).toEqual([
      { tipo: "aprovar", chave: `escrita:${r.id}`, escrita: r, titulo: "Registrar atendimento · CANARIO Cliente 9201", apoio: "Curitiba · Redigido pelo agente hoje às 9h12" },
    ]);
    expect(contador(bloco.conteudo)).toEqual({ texto: "1", apagado: false, falado: "1 item" });
  });

  test("sem cartão o bloco segue lido, com 0 apagado, mesmo com o CRM sem leitura", () => {
    const bloco = blocoAprovar(dia({}, SEM_LEITURAS, NAO_LIBERADO));
    expect(bloco?.conteudo.leitura).toBe("lido");
    expect(bloco && contador(bloco.conteudo)).toEqual({ texto: "0", apagado: true, falado: "0 itens" });
    expect(bloco?.definicao.vazio).toBe("Nada para aprovar. Quando o agente redigir algo para o CRM, aparece aqui.");
  });

  test("ao abrir sem hash vale o primeiro bloco com item: Aprovar vem depois de Fazer hoje e de Sem data", () => {
    expect(blocoEscolhido(null, montarBlocos(dia({ aprovar: [resumo()] })))).toBe("aprovar");
    expect(blocoEscolhido(null, montarBlocos(dia({ aprovar: [resumo()], sem_data: [tarefa("s")] })))).toBe("sem-data");
  });

  test("os cartões vêm na ordem do servidor", () => {
    const bloco = blocoAprovar(dia({ aprovar: [resumo({ id: "a" }), resumo({ id: "b" })] }));
    expect(bloco?.conteudo.leitura === "lido" && bloco.conteudo.itens.map((i) => i.chave)).toEqual(["escrita:a", "escrita:b"]);
  });
});

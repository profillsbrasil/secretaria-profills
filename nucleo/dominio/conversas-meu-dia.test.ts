import { describe, expect, test } from "bun:test";
import {
  conversaNoMeuDia,
  conversasIgnoradasPeloAgente,
  decidirIgnorar,
  listarNaoClientes,
  montarBlocosDeConversas,
  textoExterno,
  vinculoDe,
  SEM_CONVERSAS,
  type ConversaDeEmail,
  type ConversaLida,
  type DadosDasConversas,
  type DadosDoEmail,
  type EnderecoEmail,
  type IdContaEmail,
  type SituacaoDoEmail,
  type EstadoWhatsapp,
  type Instante,
  type MarcaDeConversaIgnorada,
  type Dia,
  type Telefone,
  type VinculoDeContato,
} from "./index";

const LIDO = "2026-11-13T12:00:00.000Z" as Instante;
const CONECTADO: EstadoWhatsapp = { fase: "conectado", conta: { telefone: "+5511912345678" as Telefone }, verificadoEm: LIDO, espelho: "ao_vivo", ultimaAtividade: LIDO };
const telefone = (n: number) => `+55119000000${String(n).padStart(2, "0")}` as Telefone;
/** Só o item do WhatsApp tem telefone: estes testes não têm e-mail. */
const telefoneDe = (item: { readonly canal: string }) => (item as unknown as { readonly telefone: string }).telefone;
const cliente = (id: number) => ({ id, nome: textoExterno(`Cliente ${id}`), cidade: textoExterno("Curitiba"), uf: textoExterno("PR") });

function responder(n: number, desde: string, extras: Partial<Extract<ConversaLida["situacao"], { tipo: "responder" }>> = {}): ConversaLida {
  return {
    conversa: `${telefone(n).slice(1)}@s.whatsapp.net`,
    telefone: telefone(n),
    nome: textoExterno(`Nome ${n}`),
    ultimaMensagemEm: desde as Instante,
    contaFalouEm: null,
    situacao: { tipo: "responder", desde: desde as Instante, novas: 1, em_quarentena: false, mensagens_em_quarentena: [], sinais: [], tem_ilegiveis: false, mais_que_o_lido: false, ...extras },
  };
}

function esperando(n: number, desde: string, diasUteis = 3): ConversaLida {
  return {
    conversa: `${telefone(n).slice(1)}@s.whatsapp.net`,
    telefone: telefone(n),
    nome: null,
    ultimaMensagemEm: desde as Instante,
    contaFalouEm: desde as Instante,
    situacao: { tipo: "esperando", desde: desde as Instante, dias_uteis: diasUteis },
  };
}

const auto = (n: number) => vinculoDe("whatsapp", telefone(n), { estado: "auto", cliente: cliente(n) }, LIDO);
const ambiguo = (n: number) => vinculoDe("whatsapp", telefone(n), { estado: "ambiguo", motivo: "variante_do_9", candidatos: [cliente(n), cliente(n + 50)] }, LIDO);
const semCliente = (n: number) => vinculoDe("whatsapp", telefone(n), { estado: "sem_cliente" }, LIDO);
const naoCliente = (n: number, decididoEm: Instante = LIDO): VinculoDeContato => ({
  canal: "whatsapp",
  chave: telefone(n),
  conferidoEm: LIDO,
  estado: "nao_cliente",
  decididoEm,
  motivo: "varios_clientes",
  candidatos: [cliente(n), cliente(n + 50)],
});
const confirmado = (n: number): VinculoDeContato => ({ canal: "whatsapp", chave: telefone(n), conferidoEm: LIDO, estado: "confirmado", cliente: cliente(n), decididoEm: LIDO });

function dados(itens: ConversaLida[], vinculos: VinculoDeContato[], ignoradas: MarcaDeConversaIgnorada[] = [], cortado = false): DadosDasConversas {
  return { leitura: { lidoEm: LIDO, itens, cortado }, vinculos: new Map(vinculos.map((v) => [v.chave, v])), ignoradas };
}

const marca = (n: number): MarcaDeConversaIgnorada => ({ tipo: "conversa", id: telefone(n), nome: textoExterno("x"), quem: "vendedor", motivo: null, ate: "2026-11-20" as Dia });

describe("blocos de conversas do Meu dia", () => {
  test("Responder: auto, confirmado e ambíguo entram; não cliente, sem cliente e sem vínculo, não", () => {
    const blocos = montarBlocosDeConversas(
      dados(
        [1, 2, 3, 4, 5, 6].map((n) => responder(n, `2026-11-13T1${n}:00:00Z`)),
        [auto(1), confirmado(2), ambiguo(3), naoCliente(4), semCliente(5)],
      ),
      CONECTADO,
    );
    expect(blocos.responder.itens.map((i) => [telefoneDe(i), i.vinculo])).toEqual([
      [telefone(1), "auto"],
      [telefone(2), "confirmado"],
      [telefone(3), "ambiguo"],
    ]);
    expect(blocos.responder.motivo).toBeNull();
    expect(blocos.responder.lido_em).toBe(LIDO);
  });

  test("o item ambíguo traz candidatos e motivo da dúvida, sem cliente; os outros não têm essas chaves", () => {
    const [ok, duvida] = montarBlocosDeConversas(dados([responder(1, "2026-11-13T10:00:00Z"), responder(3, "2026-11-13T11:00:00Z")], [auto(1), ambiguo(3)]), CONECTADO).responder.itens;
    expect(ok).toMatchObject({ cliente: { id: 1, nome: "Cliente 1", cidade: "Curitiba" }, nome_no_whatsapp: "Nome 1", novas: 1, em_quarentena: false, mensagens_em_quarentena: [] });
    expect(ok && "candidatos" in ok).toBe(false);
    expect(ok && "motivo_da_duvida" in ok).toBe(false);
    expect(duvida).toMatchObject({ vinculo: "ambiguo", cliente: null, motivo_da_duvida: "variante_do_9", candidatos: [{ id: 3 }, { id: 53 }] });
  });

  test("Responder vai da mais antiga para a mais nova", () => {
    const blocos = montarBlocosDeConversas(dados([responder(1, "2026-11-13T15:00:00Z"), responder(2, "2026-11-10T15:00:00Z"), responder(3, "2026-11-12T15:00:00Z")], [auto(1), auto(2), auto(3)]), CONECTADO);
    expect(blocos.responder.itens.map((i) => telefoneDe(i))).toEqual([telefone(2), telefone(3), telefone(1)]);
  });

  test("Esperando cliente: auto, confirmado e ambíguo, da mais antiga para a mais nova, com o vínculo como em Responder", () => {
    const blocos = montarBlocosDeConversas(
      dados(
        [esperando(1, "2026-11-09T15:00:00Z"), esperando(2, "2026-11-06T15:00:00Z", 5), esperando(3, "2026-11-03T15:00:00Z"), esperando(4, "2026-11-02T15:00:00Z")],
        [auto(1), confirmado(2), ambiguo(3), naoCliente(4)],
      ),
      CONECTADO,
    );
    const base = (n: number) => ({ canal: "whatsapp", conversa: `${telefone(n).slice(1)}@s.whatsapp.net`, telefone: telefone(n), nome_no_whatsapp: null });
    const esperado = [
      { ...base(3), desde: "2026-11-03T15:00:00Z", dias_uteis: 3, vinculo: "ambiguo", cliente: null, candidatos: [cliente(3), cliente(53)], motivo_da_duvida: "variante_do_9" },
      { ...base(2), desde: "2026-11-06T15:00:00Z", dias_uteis: 5, vinculo: "confirmado", cliente: { id: 2, nome: "Cliente 2", cidade: "Curitiba" } },
      { ...base(1), desde: "2026-11-09T15:00:00Z", dias_uteis: 3, vinculo: "auto", cliente: { id: 1, nome: "Cliente 1", cidade: "Curitiba" } },
    ];
    expect(JSON.parse(JSON.stringify(blocos.esperando_cliente.itens))).toEqual(esperado);
  });

  test("a escolha do vendedor vale na hora: ambíguo vira confirmado, e não cliente some, sem nova leitura", () => {
    const leitura = [responder(3, "2026-11-13T10:00:00Z"), responder(4, "2026-11-13T11:00:00Z")];
    const antes = montarBlocosDeConversas(dados(leitura, [ambiguo(3), ambiguo(4)]), CONECTADO);
    expect(antes.responder.itens.map((i) => i.vinculo)).toEqual(["ambiguo", "ambiguo"]);
    const depois = montarBlocosDeConversas(dados(leitura, [confirmado(3), naoCliente(4)]), CONECTADO);
    expect(depois.responder.itens.map((i) => [telefoneDe(i), i.vinculo, i.cliente?.id])).toEqual([[telefone(3), "confirmado", 3]]);
  });

  test("conversa ignorada sai da lista e entra na contagem; só a do bloco onde ela estava", () => {
    const blocos = montarBlocosDeConversas(
      dados([responder(1, "2026-11-13T10:00:00Z"), responder(2, "2026-11-13T11:00:00Z"), esperando(3, "2026-11-05T10:00:00Z"), responder(4, "2026-11-13T12:00:00Z")], [auto(1), auto(2), auto(3), naoCliente(4)], [marca(1), marca(3), marca(4)]),
      CONECTADO,
    );
    expect(blocos.responder.itens.map((i) => telefoneDe(i))).toEqual([telefone(2)]);
    expect(blocos.responder.ignorados).toBe(1);
    expect(blocos.esperando_cliente.itens).toEqual([]);
    expect(blocos.esperando_cliente.ignorados).toBe(1);
    expect(blocos.esperando_cliente.motivo).toBe("sem_itens");
  });

  test("sem leitura, o motivo vem do estado do WhatsApp", () => {
    const desconectado = montarBlocosDeConversas(SEM_CONVERSAS, { fase: "desconectado" });
    expect(desconectado.responder).toEqual({ itens: [], lido_em: null, motivo: "whatsapp_desconectado", cortado: false, ignorados: 0, tratados: 0, email: { lido_em: null, motivo: "email_sem_conta", cortado: false, contas_lidas: 0, contas: 0, contas_sem_enviados: [] } });
    expect(desconectado.esperando_cliente.motivo).toBe("whatsapp_desconectado");
    const atencao = montarBlocosDeConversas(SEM_CONVERSAS, { fase: "atencao", problema: { codigo: "whatsapp_sessao_revogada" } as never, conta: null });
    expect(atencao.responder.motivo).toBe("whatsapp_em_atencao");
    expect(montarBlocosDeConversas(SEM_CONVERSAS, CONECTADO).responder.motivo).toBe("sem_leitura");
  });

  test("leitura sem itens é sem_itens, e o corte da leitura vai aos dois blocos", () => {
    const blocos = montarBlocosDeConversas(dados([], [], [], true), CONECTADO);
    expect(blocos.responder).toMatchObject({ itens: [], motivo: "sem_itens", cortado: true, lido_em: LIDO });
    expect(blocos.esperando_cliente).toMatchObject({ motivo: "sem_itens", cortado: true });
  });

  test("a quarentena da conversa vai ao item, só com os ids", () => {
    const [item] = montarBlocosDeConversas(dados([responder(1, "2026-11-13T10:00:00Z", { em_quarentena: true, mensagens_em_quarentena: ["ID9"], sinais: ["fala_com_o_agente"] })], [auto(1)]), CONECTADO).responder.itens;
    expect(item).toMatchObject({ em_quarentena: true, mensagens_em_quarentena: ["ID9"] });
    expect(item && "sinais" in item).toBe(false);
  });
});

describe("decidirIgnorar, a regra única de proposta, cliente e conversa", () => {
  const base = { quem: "vendedor", motivo: null, trouxeMotivo: false, semItem: null, marcaDoVendedor: false, pertoDoBloqueio: null } as const;
  const codigo = (r: ReturnType<typeof decidirIgnorar>) => (r.ok ? "ok" : r.erro.codigo);

  test("o vendedor ignora com um clique, sem motivo", () => {
    expect(decidirIgnorar(base)).toEqual({ ok: true, dados: { quem: "vendedor", motivo: null } });
  });

  test("motivo fora da forma é recusado, mesmo para o vendedor", () => {
    expect(codigo(decidirIgnorar({ ...base, trouxeMotivo: true }))).toBe("entrada_invalida");
  });

  test("o agente só ignora com motivo", () => {
    expect(codigo(decidirIgnorar({ ...base, quem: "agente" }))).toBe("entrada_invalida");
    expect(decidirIgnorar({ ...base, quem: "agente", motivo: "o vendedor pediu" })).toEqual({ ok: true, dados: { quem: "agente", motivo: "o vendedor pediu" } });
  });

  test("item fora do Meu dia é nao_encontrado, antes de qualquer regra do agente", () => {
    expect(codigo(decidirIgnorar({ ...base, semItem: "não está" }))).toBe("nao_encontrado");
    expect(codigo(decidirIgnorar({ ...base, quem: "agente", motivo: "o vendedor pediu", semItem: "não está", marcaDoVendedor: true }))).toBe("nao_encontrado");
  });

  test("marca do vendedor: o agente recebe so_no_painel e o vendedor passa", () => {
    expect(codigo(decidirIgnorar({ ...base, quem: "agente", motivo: "o vendedor pediu", marcaDoVendedor: true }))).toBe("so_no_painel");
    expect(codigo(decidirIgnorar({ ...base, marcaDoVendedor: true }))).toBe("ok");
  });

  test("perto do bloqueio recusa o agente, depois da marca do vendedor", () => {
    expect(codigo(decidirIgnorar({ ...base, quem: "agente", motivo: "o vendedor pediu", pertoDoBloqueio: "vence em 2 dias" }))).toBe("perto_do_bloqueio");
    expect(codigo(decidirIgnorar({ ...base, quem: "agente", motivo: "o vendedor pediu", pertoDoBloqueio: "x", marcaDoVendedor: true }))).toBe("so_no_painel");
    expect(codigo(decidirIgnorar({ ...base, pertoDoBloqueio: "vence em 2 dias" }))).toBe("ok");
  });
});

describe("números marcados como não cliente", () => {
  test("do mais novo para o mais antigo, com o nome da conversa lida ou null, sem depender do CRM", () => {
    const lidas = [{ ...responder(1, "2026-11-13T11:00:00Z"), nome: textoExterno("Nome Canário Um") }, { ...responder(2, "2026-11-13T12:00:00Z"), nome: null }];
    const lista = listarNaoClientes(
      dados(lidas, [naoCliente(1, "2026-11-13T10:00:00.000Z" as Instante), naoCliente(2, "2026-11-13T13:00:00.000Z" as Instante), naoCliente(3, "2026-11-12T09:00:00.000Z" as Instante), auto(4), confirmado(5)]),
    );
    expect<unknown>(lista).toEqual([
      { canal: "whatsapp", telefone: telefone(2), nome_no_whatsapp: null, decidido_em: "2026-11-13T13:00:00.000Z" },
      { canal: "whatsapp", telefone: telefone(1), nome_no_whatsapp: "Nome Canário Um", decidido_em: "2026-11-13T10:00:00.000Z" },
      { canal: "whatsapp", telefone: telefone(3), nome_no_whatsapp: null, decidido_em: "2026-11-12T09:00:00.000Z" },
    ]);
    expect(listarNaoClientes(SEM_CONVERSAS)).toEqual([]);
  });
});

describe("blocos com e-mail", () => {
  const CONTA = "11111111-1111-4111-8111-111111111111" as IdContaEmail;
  const OUTRA = "22222222-2222-4222-8222-222222222222" as IdContaEmail;
  const endereco = (n: number) => `cliente${n}@cliente.exemplo.test` as EnderecoEmail;
  const conversa = (n: number, desde: string, situacao: Partial<Extract<SituacaoDoEmail, { tipo: "responder" }>> = {}, contaId: IdContaEmail = CONTA): ConversaDeEmail => ({
    contaId,
    conversa: `m:${n}`,
    id: `e-${String(n).padStart(16, "0")}`,
    ultimaEm: desde as Instante,
    situacao: {
      tipo: "responder",
      desde: desde as Instante,
      novas: 1,
      endereco: endereco(n),
      nome: textoExterno(`Nome ${n}`),
      assunto: textoExterno(`Assunto ${n}`),
      ultimo_email: `entrada-1-${n}`,
      em_quarentena: false,
      mensagens_em_quarentena: [],
      sinais: [],
      ...situacao,
    },
  });
  const esperaDeEmail = (n: number, desde: string): ConversaDeEmail => ({ ...conversa(n, desde), situacao: { ...conversa(n, desde).situacao, tipo: "esperando", desde: desde as Instante, dias_uteis: 4 } as SituacaoDoEmail });
  const vinculoDeEmail = (n: number, estado: "auto" | "ambiguo" | "sem_cliente" | "nao_cliente" | "confirmado"): VinculoDeContato => {
    const chave = endereco(n);
    if (estado === "auto") return vinculoDe("email", chave, { estado, cliente: cliente(n) }, LIDO);
    if (estado === "ambiguo") return vinculoDe("email", chave, { estado, motivo: "sem_prova_do_email", candidatos: [cliente(n)] }, LIDO);
    if (estado === "sem_cliente") return vinculoDe("email", chave, { estado }, LIDO);
    if (estado === "confirmado") return { canal: "email", chave, conferidoEm: LIDO, estado: "confirmado", cliente: cliente(n), decididoEm: LIDO };
    return { canal: "email", chave, conferidoEm: LIDO, estado: "nao_cliente", decididoEm: LIDO, motivo: "sem_prova_do_email", candidatos: [cliente(n)] };
  };
  const contas = [{ id: CONTA, rotulo: "Profills", conectada: true }];
  const comEmail = (email: Partial<DadosDoEmail>, whatsapp: Partial<DadosDasConversas> = {}): DadosDasConversas => ({
    leitura: null,
    vinculos: new Map(),
    ignoradas: [],
    ...whatsapp,
    email: { contas, conversas: [], vinculos: new Map(), ignoradas: [], lidoEm: new Map([[CONTA, LIDO]]), semEnviados: new Set(), ...email },
  });
  const vinculos = (...lista: VinculoDeContato[]) => new Map(lista.map((v) => [v.chave, v]));
  const DESCONECTADO: EstadoWhatsapp = { fase: "desconectado" };

  test("entram auto, confirmado e ambíguo, nos dois blocos; não cliente, sem cliente e sem vínculo ficam fora", () => {
    const blocos = montarBlocosDeConversas(
      comEmail({
        conversas: [1, 2, 3, 4, 5, 6].map((n) => conversa(n, `2026-11-13T0${n}:00:00Z`)).concat([esperaDeEmail(7, "2026-11-01T10:00:00Z"), esperaDeEmail(8, "2026-11-02T10:00:00Z")]),
        vinculos: vinculos(vinculoDeEmail(1, "auto"), vinculoDeEmail(2, "confirmado"), vinculoDeEmail(3, "ambiguo"), vinculoDeEmail(4, "nao_cliente"), vinculoDeEmail(5, "sem_cliente"), vinculoDeEmail(7, "auto"), vinculoDeEmail(8, "ambiguo")),
      }),
      DESCONECTADO,
    );
    expect(blocos.responder.itens.map((i) => (i.canal === "email" ? [i.endereco, i.vinculo] : []))).toEqual([
      [endereco(1), "auto"],
      [endereco(2), "confirmado"],
      [endereco(3), "ambiguo"],
    ]);
    expect(blocos.esperando_cliente.itens.map((i) => (i.canal === "email" ? [i.endereco, i.vinculo] : []))).toEqual([
      [endereco(7), "auto"],
      [endereco(8), "ambiguo"],
    ]);
    expect(blocos.esperando_cliente.itens[1]).toMatchObject({ canal: "email", cliente: null, motivo_da_duvida: "sem_prova_do_email", candidatos: [{ id: 8 }] });
    const [, , duvida] = blocos.responder.itens;
    expect(duvida).toMatchObject({ canal: "email", cliente: null, motivo_da_duvida: "sem_prova_do_email", candidatos: [{ id: 3 }] });
  });

  test("conversa de conta fora de conectado não entra, e o e-mail dela não conta como lido", () => {
    const blocos = montarBlocosDeConversas(
      comEmail({
        contas: [{ id: CONTA, rotulo: "Profills", conectada: true }, { id: OUTRA, rotulo: "Pessoal", conectada: false }],
        conversas: [conversa(1, "2026-11-13T10:00:00Z"), conversa(2, "2026-11-13T11:00:00Z", {}, OUTRA)],
        vinculos: vinculos(vinculoDeEmail(1, "auto"), vinculoDeEmail(2, "auto")),
        lidoEm: new Map([[CONTA, LIDO], [OUTRA, "2026-11-01T00:00:00.000Z" as Instante]]),
      }),
      DESCONECTADO,
    );
    expect(blocos.responder.itens.map((i) => i.canal === "email" && i.conta.rotulo)).toEqual(["Profills"]);
    expect(blocos.responder.email).toEqual({ lido_em: LIDO, motivo: null, cortado: false, contas_lidas: 1, contas: 2, contas_sem_enviados: [] });
  });

  test("conta conectada lida sem a pasta de enviados sai em contas_sem_enviados, pelo rótulo; a desconectada não", () => {
    const blocos = montarBlocosDeConversas(
      comEmail({
        contas: [{ id: CONTA, rotulo: "Profills", conectada: true }, { id: OUTRA, rotulo: "Pessoal", conectada: false }],
        semEnviados: new Set([CONTA, OUTRA]),
      }),
      DESCONECTADO,
    );
    expect(blocos.responder.email.contas_sem_enviados).toEqual(["Profills"]);
    expect(blocos.esperando_cliente.email.contas_sem_enviados).toEqual(["Profills"]);
  });

  test("os dois canais numa lista só pelo desde; empate: WhatsApp antes, depois a chave", () => {
    const blocos = montarBlocosDeConversas(
      comEmail(
        {
          conversas: [conversa(2, "2026-11-13T11:00:00Z"), conversa(1, "2026-11-13T11:00:00Z"), conversa(3, "2026-11-13T09:00:00Z")],
          vinculos: vinculos(vinculoDeEmail(1, "auto"), vinculoDeEmail(2, "auto"), vinculoDeEmail(3, "auto")),
        },
        { ...dados([responder(1, "2026-11-13T11:00:00Z"), responder(2, "2026-11-13T10:00:00Z")], [auto(1), auto(2)]) },
      ),
      CONECTADO,
    );
    expect(blocos.responder.itens.map((i) => (i.canal === "email" ? i.endereco : telefoneDe(i)))).toEqual([endereco(3), telefone(2), telefone(1), endereco(1), endereco(2)]);
  });

  test("lido_em, motivo e cortado do bloco são do WhatsApp; os do e-mail ficam em email", () => {
    const so = comEmail({ conversas: [conversa(1, "2026-11-13T10:00:00Z")], vinculos: vinculos(vinculoDeEmail(1, "auto")) });
    const comLeitura = montarBlocosDeConversas({ ...so, leitura: { lidoEm: "2026-11-13T09:00:00.000Z" as Instante, itens: [], cortado: true } }, CONECTADO);
    expect(comLeitura.responder).toMatchObject({ lido_em: "2026-11-13T09:00:00.000Z", motivo: "sem_itens", cortado: true, ignorados: 0 });
    expect(comLeitura.responder.itens).toHaveLength(1);
    expect(comLeitura.responder.email).toEqual({ lido_em: LIDO, motivo: null, cortado: false, contas_lidas: 1, contas: 1, contas_sem_enviados: [] });
    const semWhatsapp = montarBlocosDeConversas(so, DESCONECTADO);
    expect(semWhatsapp.responder).toMatchObject({ motivo: "whatsapp_desconectado", lido_em: null, itens: [expect.objectContaining({ canal: "email" })] });
  });

  test.each([
    ["sem conta nenhuma", [], new Map(), [], "email_sem_conta"],
    ["com contas e nenhuma conectada", [{ id: CONTA, rotulo: "Profills", conectada: false }], new Map(), [], "email_sem_conta_conectada"],
    ["conta conectada e nenhuma lida", contas, new Map(), [], "sem_leitura"],
    ["leitura e nenhum item de e-mail", contas, new Map([[CONTA, LIDO]]), [], "sem_itens"],
  ] as const)("email.motivo %s é %s", (_nome, contasDoCaso, lidoEm, conversas, motivo) => {
    const bloco = montarBlocosDeConversas(comEmail({ contas: contasDoCaso, lidoEm, conversas }), DESCONECTADO).responder;
    expect(bloco.email.motivo).toBe(motivo);
    expect(bloco.email.contas).toBe(contasDoCaso.length);
  });

  test("email.cortado: conta conectada ainda não lida inteira, ou remetente candidato sem vínculo; endereço grande demais não conta", () => {
    const um = (extra: Partial<DadosDoEmail>) => montarBlocosDeConversas(comEmail(extra), DESCONECTADO).responder.email.cortado;
    const c1 = conversa(1, "2026-11-13T10:00:00Z");
    expect(um({ conversas: [c1], vinculos: vinculos(vinculoDeEmail(1, "auto")) })).toBe(false);
    expect(um({ conversas: [c1], vinculos: vinculos() })).toBe(true);
    expect(um({ conversas: [c1], vinculos: vinculos(vinculoDeEmail(1, "sem_cliente")) })).toBe(false);
    expect(um({ conversas: [], lidoEm: new Map() })).toBe(true);
    const grande = conversa(2, "2026-11-13T10:00:00Z", { endereco: `${"a".repeat(200)}@cliente.exemplo.test` as EnderecoEmail });
    expect(um({ conversas: [grande], vinculos: vinculos() })).toBe(false);
    const soDeConta = { ...c1, situacao: { tipo: "nada", de_fora: null } as SituacaoDoEmail };
    expect(um({ conversas: [soDeConta], vinculos: vinculos() })).toBe(false);
  });

  test("conversa ignorada sai da lista e conta nos ignorados do bloco onde estaria", () => {
    const ignorada: MarcaDeConversaIgnorada = { tipo: "conversa", id: conversa(1, "2026-11-13T10:00:00Z").id, nome: textoExterno("x"), quem: "agente", motivo: "pediu para esperar", ate: "2026-11-20" as Dia };
    const dadosDoCaso = comEmail({
      conversas: [conversa(1, "2026-11-13T10:00:00Z"), esperaDeEmail(2, "2026-11-01T10:00:00Z"), conversa(3, "2026-11-13T12:00:00Z")],
      vinculos: vinculos(vinculoDeEmail(1, "auto"), vinculoDeEmail(2, "auto"), vinculoDeEmail(3, "auto")),
      ignoradas: [ignorada, { ...ignorada, id: esperaDeEmail(2, "2026-11-01T10:00:00Z").id }],
    });
    const blocos = montarBlocosDeConversas(dadosDoCaso, DESCONECTADO);
    expect(blocos.responder.itens.map((i) => i.canal === "email" && i.endereco)).toEqual([endereco(3)]);
    expect(blocos.responder.ignorados).toBe(1);
    expect(blocos.esperando_cliente).toMatchObject({ itens: [], ignorados: 1 });
    expect(conversaNoMeuDia(dadosDoCaso, "email", ignorada.id)).toMatchObject({ bloco: "responder", item: { canal: "email", endereco: endereco(1) } });
    expect(conversaNoMeuDia(dadosDoCaso, "whatsapp", ignorada.id)).toBeNull();
    expect(conversasIgnoradasPeloAgente([ignorada], "email")).toEqual([{ tipo: "conversa", canal: "email", id: ignorada.id, nome: textoExterno("x"), codigo: null, motivo: "pediu para esperar", ate: "2026-11-20" as Dia }]);
  });

  test("nao_clientes lista endereços e números juntos, do mais novo para o mais antigo, sem depender das contas nem do WhatsApp", () => {
    const doEmail: VinculoDeContato = { canal: "email", chave: endereco(1), conferidoEm: LIDO, estado: "nao_cliente", decididoEm: "2026-11-13T13:00:00.000Z" as Instante, motivo: "sem_prova_do_email", candidatos: [cliente(1)] };
    const doWhatsapp = naoCliente(3, "2026-11-13T14:00:00.000Z" as Instante);
    const lista = listarNaoClientes(comEmail({ contas: [], vinculos: vinculos(doEmail) }, { vinculos: vinculos(doWhatsapp) }));
    expect<unknown>(lista).toEqual([
      { canal: "whatsapp", telefone: telefone(3), nome_no_whatsapp: null, decidido_em: "2026-11-13T14:00:00.000Z" },
      { canal: "email", endereco: endereco(1), decidido_em: "2026-11-13T13:00:00.000Z" },
    ]);
  });
});

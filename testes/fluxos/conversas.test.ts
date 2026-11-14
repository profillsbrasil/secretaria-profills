import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { listarVinculos, decidirVinculoDoVendedor, lerConversasLidas } from "../../nucleo/banco";
import type { Conectores, ResultadoDaFonte, Sincronizacao } from "../../nucleo/conectores";
import { CONSULTAS_DE_NUMERO_POR_RODADA } from "../../nucleo/conectores/sincronizacao";
import { escolherNoVinculo } from "../../nucleo/dominio";
import { esperar, montarBancada, type Bancada } from "../falsos/bancada";
import { conectarWhatsapp } from "../falsos/conectar";
import { ALVO, CANARIO, GRUPO, LID, TEL, UM_DIA_MS, antes, cadastrarClientes, cenario, jid, movidasParaAgora, msg } from "../falsos/conversas";
import { clienteFalso, iniciarCrmFalso, type CrmFalso } from "../falsos/crm";
import { chatDoWacli, type ChatDoWacli, type LeiturasDoWacliFalso, type MensagemDoWacli } from "../falsos/wacli";

setDefaultTimeout(30_000);

let bancada: Bancada;
let crm: CrmFalso;

function nova(): Bancada {
  crm = iniciarCrmFalso({ agora: () => Date.parse(bancada.ambiente.agora()) });
  bancada = montarBancada({ crmRecurso: crm.recurso, crmClientId: crm.clientId, porta: 47_117 });
  bancada.avancar(Date.parse(ALVO) - Date.now());
  return bancada;
}

afterEach(async () => {
  await bancada.limpar();
  await crm.parar();
});

async function ligado(leituras: LeiturasDoWacliFalso = cenario()): Promise<Conectores> {
  const conectores = nova().ligar();
  cadastrarClientes(crm);
  await conectores.pronto;
  const pedido = await conectores.agir("crm", "conectar");
  if (!pedido.ok || pedido.dados.urlAutorizacao === null) throw new Error("o CRM não devolveu a URL de login");
  await conectores.retornoDoCrm(await crm.autorizar(pedido.dados.urlAutorizacao));
  await conectarWhatsapp(bancada, conectores, leituras);
  return conectores;
}

function daFonte(rodada: Sincronizacao): ResultadoDaFonte {
  const fonte = rodada.fontes.find((f) => f.fonte === "conversas");
  if (fonte === undefined) throw new Error("a rodada não trouxe a fonte conversas");
  return fonte;
}

const consultasAoCrm = () => crm.registro().chamadasDeFerramenta.filter((c) => c.nome === "buscar_clientes").map((c) => String(c.argumentos.q));
const estados = () => Object.fromEntries([...listarVinculos(bancada.banco, "whatsapp")].map(([chave, v]) => [chave, v.estado]));

describe("fonte conversas da sincronização", () => {
  test("vincula cada número direto com atividade recente e lê a situação das conversas com cliente", async () => {
    const conectores = await ligado();
    const rodada = await conectores.sincronizar();
    expect(daFonte(rodada)).toMatchObject({ fonte: "conversas", situacao: "leu", itens: 5, cortado: false });
    expect("semConsultaAoCrm" in daFonte(rodada)).toBe(false);

    expect(estados()).toEqual({
      [`+${TEL.unico}`]: "auto",
      [`+${TEL.doisClientes}`]: "ambiguo",
      [`+${TEL.variante}`]: "ambiguo",
      [`+${TEL.lid}`]: "auto",
      [`+${TEL.suspeito}`]: "auto",
      [`+${TEL.semCliente}`]: "sem_cliente",
      [`+${TEL.confirmacao}`]: "auto",
    });
    const vinculos = listarVinculos(bancada.banco, "whatsapp");
    expect(vinculos.get(`+${TEL.doisClientes}`)).toMatchObject({ motivo: "varios_clientes", candidatos: [{ id: 9202 }, { id: 9203 }] });
    expect(vinculos.get(`+${TEL.variante}`)).toMatchObject({ motivo: "variante_do_9", candidatos: [{ id: 9204 }] });

    const lidas = conectores.leituraDeConversas();
    expect(lidas?.cortado).toBe(false);
    expect(lidas?.itens.map((item): string[] => [item.telefone, item.situacao.tipo])).toEqual([
      [`+${TEL.unico}`, "responder"],
      [`+${TEL.doisClientes}`, "responder"],
      [`+${TEL.variante}`, "responder"],
      [`+${TEL.suspeito}`, "responder"],
      // Lida e sem nada a fazer: fica no cache para não ser relida enquanto não mudar.
      [`+${TEL.confirmacao}`, "nada"],
      [`+${TEL.lid}`, "esperando"],
    ]);
    const suspeita = lidas?.itens.find((item) => item.telefone === `+${TEL.suspeito}`);
    expect(suspeita?.situacao).toMatchObject({ tipo: "responder", em_quarentena: true, sinais: expect.arrayContaining(["fala_com_o_agente"]) });
    expect(lidas?.itens.find((item) => item.telefone === `+${TEL.lid}`)).toMatchObject({ conversa: LID, situacao: { tipo: "esperando", dias_uteis: 5 } });
    expect(String(lidas?.itens.find((item) => item.telefone === `+${TEL.unico}`)?.nome)).toBe("Nome Canário Um");
  });

  test("ao CRM vão só os dígitos do telefone, a variante do 9 só quando o número exato não achou, e nunca o nome do contato", async () => {
    const conectores = await ligado();
    await conectores.sincronizar();
    const consultas = consultasAoCrm();
    // `554199990003` é a variante sem o 9 do número que não achou cliente pelo número exato.
    expect(consultas.toSorted()).toEqual([TEL.unico, TEL.doisClientes, TEL.variante, "554199990003", TEL.lid, TEL.suspeito, TEL.semCliente, TEL.confirmacao].toSorted());
    for (const q of consultas) expect(q).toMatch(/^\d{10,15}$/);
    const argumentos = JSON.stringify(crm.registro().chamadasDeFerramenta.filter((c) => c.nome === "buscar_clientes"));
    expect(argumentos).not.toContain("Canário");
  });

  test("grupo, conversa com mais de 30 dias e @lid sem par não geram vínculo, e nada vai ao CRM por eles", async () => {
    const leituras = cenario();
    const conectores = await ligado({ ...leituras, identidades: [] });
    await conectores.sincronizar();
    expect(Object.keys(estados())).not.toContain(`+${TEL.lid}`);
    expect(Object.keys(estados())).not.toContain(`+${TEL.antigo}`);
    expect(Object.keys(estados()).length).toBe(6);
    expect(consultasAoCrm()).not.toContain(TEL.antigo);
    expect(conectores.leituraDeConversas()?.itens.some((item) => item.conversa === LID || item.conversa === GRUPO)).toBe(false);
  });

  test("número já vinculado e dentro da validade não volta ao CRM", async () => {
    const conectores = await ligado();
    await conectores.sincronizar();
    const primeira = consultasAoCrm().length;
    await conectores.sincronizar();
    expect(consultasAoCrm().length).toBe(primeira);
  });

  test("sem_cliente volta ao CRM depois de 7 dias; auto e ambíguo, depois de 30", async () => {
    const leituras = cenario();
    const conectores = await ligado(leituras);
    await conectores.sincronizar();
    const primeira = consultasAoCrm();
    expect(primeira.length).toBe(8);

    bancada.avancar(7 * UM_DIA_MS);
    bancada.roteiro({ auth: [], sync: [], leituras: movidasParaAgora(leituras, bancada.ambiente.agora()) });
    await conectores.sincronizar();
    expect(consultasAoCrm().slice(primeira.length)).toEqual([TEL.semCliente]);

    const ateAqui = consultasAoCrm().length;
    bancada.avancar(23 * UM_DIA_MS);
    bancada.roteiro({ auth: [], sync: [], leituras: movidasParaAgora(leituras, bancada.ambiente.agora()) });
    await conectores.sincronizar();
    expect(consultasAoCrm().slice(ateAqui).toSorted()).toEqual(primeira.toSorted());
  });

  test("a decisão do vendedor não é sobrescrita pela sincronização, nem depois de 30 dias", async () => {
    const leituras = cenario();
    const conectores = await ligado(leituras);
    await conectores.sincronizar();
    const escolha = decidirVinculoDoVendedor(bancada.banco, "whatsapp", `+${TEL.doisClientes}`, (atual) => escolherNoVinculo(atual, { tipo: "cliente", clienteId: 9203 }, bancada.ambiente.agora()));
    expect(escolha.ok).toBe(true);
    decidirVinculoDoVendedor(bancada.banco, "whatsapp", `+${TEL.variante}`, (atual) => escolherNoVinculo(atual, { tipo: "nao_cliente" }, bancada.ambiente.agora()));
    const consultas = consultasAoCrm().length;

    bancada.avancar(40 * UM_DIA_MS);
    bancada.roteiro({ auth: [], sync: [], leituras: movidasParaAgora(leituras, bancada.ambiente.agora()) });
    await conectores.sincronizar();
    const vinculos = listarVinculos(bancada.banco, "whatsapp");
    expect(vinculos.get(`+${TEL.doisClientes}`)).toMatchObject({ estado: "confirmado", cliente: { id: 9203 } });
    expect(vinculos.get(`+${TEL.variante}`)?.estado).toBe("nao_cliente");
    const novas = consultasAoCrm().slice(consultas);
    // Os outros números venceram e voltaram ao CRM; os dois decididos, não.
    expect(novas).toContain(TEL.unico);
    expect(novas).not.toContain(TEL.doisClientes);
    expect(novas).not.toContain(TEL.variante);
  });

  test("nenhum texto de mensagem vai ao cache nem ao banco, só ids, instantes, contagens e sinais", async () => {
    const conectores = await ligado();
    await conectores.sincronizar();
    const guardado = JSON.stringify(lerConversasLidas(bancada.banco));
    expect(guardado).toContain("em_quarentena");
    expect(guardado).not.toContain(CANARIO);
    expect(guardado).not.toContain("curl");
    expect(bancada.textoDaPastaDeDados()).not.toContain(CANARIO);
    expect(JSON.stringify(conectores.leituraDeConversas())).not.toContain(CANARIO);
    expect(bancada.linhasDoRegistro.join("\n")).not.toContain(CANARIO);
  });
});

describe("prova do telefone no vínculo", () => {
  const contato = (telefone: string | null) => ({ nome: "CANARIO Nome do Contato", telefone, email: "canario.contato@exemplo.test", cargo: "Compras" });
  const trocarContatos = (id: number, contatos: unknown[]) => {
    const cliente = crm.dados.carteira.find((c) => c.id === id);
    if (cliente === undefined) throw new Error(`o falso não tem o cliente ${id}`);
    delete cliente.telefones;
    cliente.contatos = contatos;
  };

  test("telefone do contato guardado com máscara, com ou sem 55, prova o vínculo", async () => {
    const conectores = await ligado();
    trocarContatos(9201, [contato("(41) 99999-0001")]);
    trocarContatos(9205, [contato(null), contato("+55 41 99999-0005")]);
    await conectores.sincronizar();
    expect(estados()).toMatchObject({ [`+${TEL.unico}`]: "auto", [`+${TEL.lid}`]: "auto" });
  });

  test("um cliente que a busca achou pelo CNPJ com os mesmos dígitos, sem contato com o número, fica para o vendedor", async () => {
    const conectores = await ligado();
    crm.dados.carteira.push(clienteFalso(9301, null, { cnpj: TEL.semCliente, contatos: [contato("41 3333-4444")] }));
    await conectores.sincronizar();
    expect(listarVinculos(bancada.banco, "whatsapp").get(`+${TEL.semCliente}`)).toMatchObject({ estado: "ambiguo", motivo: "sem_prova_do_telefone", candidatos: [{ id: 9301 }] });
  });

  test("busca sem contatos: nenhum vínculo nasce auto", async () => {
    const conectores = await ligado();
    crm.botoes.buscaSemContatos = true;
    await conectores.sincronizar();
    expect(Object.values(estados()).filter((estado) => estado === "auto")).toEqual([]);
    expect(listarVinculos(bancada.banco, "whatsapp").get(`+${TEL.unico}`)).toMatchObject({ estado: "ambiguo", motivo: "sem_prova_do_telefone", candidatos: [{ id: 9201 }] });
  });

  test("a busca traz um candidato com campo obrigatório vazio: o número não ganha vínculo sem ele e espera o cadastro", async () => {
    const conectores = await ligado();
    crm.dados.carteira.push(clienteFalso(9301, crm.dia(), { telefones: [TEL.unico], nome: null }));
    const rodada = await conectores.sincronizar();
    expect(daFonte(rodada)).toMatchObject({ situacao: "leu", cortado: true });
    expect(estados()[`+${TEL.unico}`]).toBeUndefined();
    expect(estados()[`+${TEL.doisClientes}`]).toBe("ambiguo");
  });

  test("nome, e-mail e telefone dos contatos não chegam ao banco", async () => {
    const conectores = await ligado();
    trocarContatos(9202, [contato("41 3333-0001")]);
    trocarContatos(9203, [contato("41 3333-0002"), contato(TEL.doisClientes)]);
    await conectores.sincronizar();
    const pasta = bancada.textoDaPastaDeDados();
    expect(pasta).not.toContain("CANARIO Nome do Contato");
    expect(pasta).not.toContain("canario.contato@exemplo.test");
    expect(pasta).not.toContain("3333-000");
  });
});

describe("releitura", () => {
  const leiturasDeMensagens = () => bancada.chamadas().filter((c) => c.args.includes("messages") && c.args.includes("list")).length;

  test("conversa sem mensagem nova desde a leitura guardada não é lida de novo; a espera anda com o relógio", async () => {
    const leituras = cenario();
    // A conta respondeu ao cliente único hoje: ainda não é espera.
    const conectores = await ligado({
      ...leituras,
      chats: leituras.chats?.map((c) => (c.jid === jid(TEL.unico) ? { ...c, last_message_ts: antes(0, "14:30:00") } : c)),
      mensagens: [...(leituras.mensagens ?? []), msg(jid(TEL.unico), true, antes(0, "14:30:00"), `${CANARIO} segue a proposta`)],
    });
    await conectores.sincronizar();
    expect(conectores.leituraDeConversas()?.itens.find((item) => item.telefone === `+${TEL.unico}`)?.situacao).toEqual({ tipo: "nada" });
    const lidasNaPrimeira = leiturasDeMensagens();
    expect(lidasNaPrimeira).toBeGreaterThan(0);

    // Sexta mais 5 dias é quarta: 3 dias úteis.
    bancada.avancar(5 * UM_DIA_MS);
    const rodada = await conectores.sincronizar();
    expect(leiturasDeMensagens()).toBe(lidasNaPrimeira);
    expect(daFonte(rodada)).toMatchObject({ situacao: "leu", cortado: false });
    const itens = conectores.leituraDeConversas()?.itens ?? [];
    expect(itens.find((item) => item.telefone === `+${TEL.unico}`)?.situacao).toEqual({ tipo: "esperando", desde: new Date(antes(0, "14:30:00")).toISOString(), dias_uteis: 3 } as never);
    expect(itens.find((item) => item.telefone === `+${TEL.lid}`)?.situacao).toMatchObject({ tipo: "esperando", dias_uteis: 8 });
    expect(itens.find((item) => item.telefone === `+${TEL.doisClientes}`)?.situacao).toMatchObject({ tipo: "responder" });
  });

  test("conversa com mensagem nova é lida de novo", async () => {
    const leituras = cenario();
    const conectores = await ligado(leituras);
    await conectores.sincronizar();
    const lidasNaPrimeira = leiturasDeMensagens();
    bancada.roteiro({
      auth: [],
      sync: [],
      leituras: {
        ...leituras,
        chats: leituras.chats?.map((c) => (c.jid === jid(TEL.unico) ? { ...c, last_message_ts: antes(0, "14:40:00") } : c)),
        mensagens: [...(leituras.mensagens ?? []), msg(jid(TEL.unico), true, antes(0, "14:40:00"), `${CANARIO} segue`)],
      },
    });
    await conectores.sincronizar();
    expect(leiturasDeMensagens()).toBe(lidasNaPrimeira + 1);
    expect(conectores.leituraDeConversas()?.itens.find((item) => item.telefone === `+${TEL.unico}`)?.situacao).toEqual({ tipo: "nada" });
  });

  test("mensagem nova no mesmo segundo da anterior é lida de novo: o instante do chats list não mudou, a contagem de não lidas mudou", async () => {
    const leituras = cenario();
    const comNaoLidas = (n: number) => leituras.chats?.map((c) => (c.jid === jid(TEL.unico) ? { ...c, unread: true, unread_count: n } : c));
    const conectores = await ligado({ ...leituras, chats: comNaoLidas(1) });
    await conectores.sincronizar();
    const situacao = () => conectores.leituraDeConversas()?.itens.find((item) => item.telefone === `+${TEL.unico}`)?.situacao;
    expect(situacao()).toMatchObject({ tipo: "responder", novas: 1 });
    const lidasNaPrimeira = leiturasDeMensagens();

    bancada.roteiro({
      auth: [],
      sync: [],
      leituras: { ...leituras, chats: comNaoLidas(2), mensagens: [...(leituras.mensagens ?? []), msg(jid(TEL.unico), false, antes(0, "14:00:00"), `${CANARIO} e o frete?`)] },
    });
    await conectores.sincronizar();
    expect(leiturasDeMensagens()).toBe(lidasNaPrimeira + 1);
    expect(situacao()).toMatchObject({ tipo: "responder", novas: 2 });
  });
});

describe("limite de consultas por rodada", () => {
  function muitas(total: number): LeiturasDoWacliFalso {
    const chats: ChatDoWacli[] = [];
    const mensagens: MensagemDoWacli[] = [];
    for (let i = 0; i < total; i += 1) {
      const telefone = `55119000${String(10_000 + i)}`;
      // A conversa 0 é a mais recente; a última, a mais velha.
      const quando = new Date(Date.parse(ALVO) - (i + 1) * 60_000).toISOString();
      chats.push(chatDoWacli({ jid: jid(telefone), name: `Nome ${i}`, last_message_ts: quando }));
      mensagens.push(msg(jid(telefone), false, quando, `${CANARIO} pergunta ${i}`));
    }
    return { chats, mensagens };
  }

  test("no máximo 30 consultas de número novo por rodada, das conversas mais recentes; o resto fica para a próxima, com cortado", async () => {
    const conectores = await ligado(muitas(35));
    const primeira = daFonte(await conectores.sincronizar());
    expect(consultasAoCrm().length).toBe(CONSULTAS_DE_NUMERO_POR_RODADA);
    expect(consultasAoCrm()).toEqual(Array.from({ length: 30 }, (_, i) => `55119000${String(10_000 + i)}`));
    expect(primeira).toMatchObject({ situacao: "leu", cortado: true });
    expect(conectores.leituraDeConversas()?.cortado).toBe(true);
    expect(Object.keys(estados()).length).toBe(30);

    const segunda = daFonte(await conectores.sincronizar());
    expect(consultasAoCrm().slice(30)).toEqual(Array.from({ length: 5 }, (_, i) => `55119000${String(10_030 + i)}`));
    expect(segunda).toMatchObject({ situacao: "leu", cortado: false });
    expect(conectores.leituraDeConversas()?.cortado).toBe(false);
  });
});

describe("teto de 200 conversas do chats list", () => {
  const grupos = (total: number) =>
    Array.from({ length: total }, (_, i) => chatDoWacli({ jid: `1203630000${String(10_000 + i)}@g.us`, kind: "group", name: `Grupo ${i}`, last_message_ts: new Date(Date.parse(ALVO) - (i + 1) * 60_000).toISOString() }));

  test("200 conversas recentes, grupos inclusos: pode ter ficado conversa de fora, e a fonte sai cortada", async () => {
    const conectores = await ligado({ chats: grupos(200), mensagens: [] });
    expect(daFonte(await conectores.sincronizar())).toMatchObject({ situacao: "leu", cortado: true });
    expect(conectores.leituraDeConversas()?.cortado).toBe(true);
  });

  test("200 conversas com uma de mais de 30 dias no fim: a lista cobre todas as ativas", async () => {
    const velha = chatDoWacli({ jid: jid(TEL.antigo), name: "Nome Canário Oito", last_message_ts: antes(31) });
    const conectores = await ligado({ chats: [...grupos(199), velha], mensagens: [] });
    expect(daFonte(await conectores.sincronizar())).toMatchObject({ situacao: "leu", cortado: false });
  });

  test("menos de 200: não corta", async () => {
    const conectores = await ligado({ chats: grupos(199), mensagens: [] });
    expect(daFonte(await conectores.sincronizar())).toMatchObject({ situacao: "leu", cortado: false });
  });
});

describe("falhas no meio da fonte", () => {
  test("429 do CRM no meio das consultas: a fonte termina com o que tem, sem apagar vínculo antigo", async () => {
    const conectores = await ligado();
    await conectores.sincronizar();
    const antigos = estados();
    expect(Object.keys(antigos).length).toBe(7);

    // Passam 30 dias: auto e ambíguo vencem e o número é consultado de novo. O CRM deixa passar uma consulta e responde 429.
    bancada.avancar(30 * UM_DIA_MS);
    bancada.roteiro({ auth: [], sync: [], leituras: movidasParaAgora(cenario(), bancada.ambiente.agora()) });
    const chamadas = crm.registro().chamadasDeFerramenta.length;
    crm.botoes.chamadasAntesDoLimite = chamadas + 1;
    crm.botoes.limiteHttpS = 45;
    const rodada = await conectores.sincronizar();
    const fonte = daFonte(rodada);
    expect(fonte).toMatchObject({ situacao: "leu", semConsultaAoCrm: { motivo: "crm_limite_de_chamadas", erro: { esperaS: 45 } } });
    // Uma consulta passou e a seguinte levou o 429: as outras cinco nem foram feitas.
    expect(crm.registro().chamadasDeFerramenta.length).toBe(chamadas + 2);
    // Nenhum vínculo sumiu nem mudou de estado.
    expect(estados()).toEqual(antigos);
  });

  test("CRM desconectado: usa os vínculos que existem, não consulta número novo e diz isso", async () => {
    const conectores = nova().ligar();
    cadastrarClientes(crm);
    await conectarWhatsapp(bancada, conectores, cenario());
    const rodada = await conectores.sincronizar();
    expect(daFonte(rodada)).toMatchObject({ situacao: "leu", itens: 0, cortado: true, semConsultaAoCrm: { motivo: "crm_desconectado" } });
    expect(consultasAoCrm()).toEqual([]);
    expect(estados()).toEqual({});
  });

  test("CRM desconectado depois de vincular: as conversas com vínculo seguem lidas", async () => {
    const conectores = await ligado();
    await conectores.sincronizar();
    await conectores.agir("crm", "desconectar");
    await esperar(conectores, (e) => e.crm.fase === "desconectado", "CRM desconectado");
    const rodada = await conectores.sincronizar();
    expect(daFonte(rodada)).toMatchObject({ situacao: "leu", itens: 5, cortado: false, semConsultaAoCrm: { motivo: "crm_desconectado" } });
  });

  test("WhatsApp fora de conectado: a fonte é pulada com o motivo, e o cache anterior fica", async () => {
    const conectores = await ligado();
    await conectores.sincronizar();
    const antes = lerConversasLidas(bancada.banco);
    await conectores.agir("whatsapp", "desconectar");
    await esperar(conectores, (e) => e.whatsapp.fase === "desconectado", "WhatsApp desconectado");
    const rodada = await conectores.sincronizar();
    expect(daFonte(rodada)).toEqual({ fonte: "conversas", situacao: "pulada", motivo: "whatsapp_desconectado" });
    expect(lerConversasLidas(bancada.banco)).toEqual(antes);
  });

  test("mensagem ilegível não tira a conversa de Responder nem a deixa fora: tem_ilegiveis e cortado, sem texto no registro", async () => {
    const leituras = cenario();
    const conectores = await ligado(leituras);
    await conectores.sincronizar();
    // A conta responde ao cliente único e o cliente manda uma mensagem com id fora da regra; o mesmo no @lid, que estava em Esperando.
    const ilegivel = (conversa: string, em: string) => msg(conversa, false, em, `${CANARIO} pergunta que não dá para ler`, { MsgID: "id fora da regra!" });
    const depois = {
      ...leituras,
      chats: leituras.chats?.map((c) => (c.jid === jid(TEL.unico) || c.jid === LID ? { ...c, last_message_ts: antes(0, "14:45:00") } : c)),
      mensagens: [...(leituras.mensagens ?? []), msg(jid(TEL.unico), true, antes(0, "14:30:00"), `${CANARIO} segue`), ilegivel(jid(TEL.unico), antes(0, "14:45:00")), ilegivel(LID, antes(0, "14:45:00"))],
    };
    bancada.roteiro({ auth: [], sync: [], leituras: depois });
    const rodada = await conectores.sincronizar();
    expect(daFonte(rodada)).toMatchObject({ situacao: "leu", cortado: true });
    const itens = conectores.leituraDeConversas()?.itens ?? [];
    expect(itens.find((item) => item.telefone === `+${TEL.unico}`)?.situacao).toMatchObject({ tipo: "responder", desde: new Date(antes(0, "14:00:00")).toISOString(), tem_ilegiveis: true });
    expect(itens.find((item) => item.telefone === `+${TEL.lid}`)?.situacao).toMatchObject({ tipo: "responder", novas: 0, tem_ilegiveis: true });
    expect(itens.find((item) => item.telefone === `+${TEL.doisClientes}`)?.situacao).toMatchObject({ tipo: "responder", tem_ilegiveis: false });
    const registro = bancada.linhasDoRegistro.join("\n");
    expect(registro).toContain("sincronizacao.mensagens_ilegiveis");
    expect(registro).not.toContain(CANARIO);
  });

  test("cliente com mais mensagens do que as 20 lidas, sem a da conta entre elas: mais_que_o_lido", async () => {
    const leituras = cenario();
    const muitas = Array.from({ length: 25 }, (_, i) => msg(jid(TEL.unico), false, new Date(Date.parse(antes(0, "13:00:00")) + i * 60_000).toISOString(), `${CANARIO} pergunta ${i}`));
    const conectores = await ligado({ ...leituras, mensagens: [...(leituras.mensagens ?? []), ...muitas] });
    await conectores.sincronizar();
    const itens = conectores.leituraDeConversas()?.itens ?? [];
    expect(itens.find((item) => item.telefone === `+${TEL.unico}`)?.situacao).toMatchObject({ tipo: "responder", novas: 20, mais_que_o_lido: true });
    expect(itens.find((item) => item.telefone === `+${TEL.doisClientes}`)?.situacao).toMatchObject({ tipo: "responder", novas: 1, mais_que_o_lido: false });
  });

  test("a leitura de uma conversa que falha mantém a situação anterior dela e marca cortado", async () => {
    const leituras = cenario();
    const conectores = await ligado(leituras);
    await conectores.sincronizar();
    // A data que não é data ainda derruba a leitura inteira da conversa (`whatsapp_resposta_inesperada`); id fora da regra só tira a mensagem.
    const quebrada = leituras.mensagens?.map((m) => (m.ChatJID === jid(TEL.unico) ? { ...m, Timestamp: "isto não é data" } : m));
    // A conversa ganha mensagem nova, senão o cache bastaria e ela nem seria lida.
    const chats = leituras.chats?.map((c) => (c.jid === jid(TEL.unico) ? { ...c, last_message_ts: antes(0, "14:50:00") } : c));
    bancada.roteiro({ auth: [], sync: [], leituras: { ...leituras, chats, mensagens: quebrada } });
    const rodada = await conectores.sincronizar();
    expect(daFonte(rodada)).toMatchObject({ situacao: "leu", cortado: true, itens: 5 });
    expect(conectores.leituraDeConversas()?.itens.find((item) => item.telefone === `+${TEL.unico}`)?.situacao.tipo).toBe("responder");
  });
});

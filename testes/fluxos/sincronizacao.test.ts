import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { apagarCache, inserirTarefa, listarTarefas } from "../../nucleo/banco";
import type { Conectores, ResultadoDaFonte, Sincronizacao } from "../../nucleo/conectores";
import { diaEm } from "../../nucleo/dominio";
import { criarTarefa, montarMeuDia } from "../../nucleo/tarefas";
import { esperar, montarBancada, type Bancada } from "../falsos/bancada";
import { iniciarCrmFalso, propostaFalsa, type CrmFalso } from "../falsos/crm";

setDefaultTimeout(30_000);

let bancada: Bancada;
let crm: CrmFalso;

function nova(opcoes: { readonly semClientId?: boolean } = {}): Bancada {
  crm = iniciarCrmFalso({ agora: () => Date.parse(bancada.ambiente.agora()) });
  bancada = montarBancada({ crmRecurso: crm.recurso, crmClientId: opcoes.semClientId ? null : crm.clientId, porta: 47_116 });
  return bancada;
}

afterEach(async () => {
  await bancada.limpar();
  await crm.parar();
});

async function conectar(conectores: Conectores): Promise<void> {
  const pedido = await conectores.agir("crm", "conectar");
  if (!pedido.ok || pedido.dados.urlAutorizacao === null) throw new Error(`conectar não devolveu URL: ${JSON.stringify(pedido)}`);
  const retorno = await conectores.retornoDoCrm(await crm.autorizar(pedido.dados.urlAutorizacao));
  expect(retorno.ok && retorno.dados.fase).toBe("conectado");
}

/**
 * O CRM conectado e o cache vazio. Conectar dispara uma rodada: ela termina, o cache que ela gravou sai
 * e o CRM falso esquece as chamadas dela, e o teste começa do zero.
 */
async function ligado(): Promise<Conectores> {
  const conectores = nova().ligar();
  await conectores.pronto;
  const terminou = new Promise<void>((resolver) => conectores.assinarSincronizacao((andamento) => andamento.etapa === "terminou" && resolver()));
  await conectar(conectores);
  await terminou;
  apagarCache(bancada.banco);
  crm.zerarChamadas();
  return conectores;
}

function situacoes(rodada: Sincronizacao): Record<string, string> {
  return Object.fromEntries(rodada.fontes.map((fonte) => [fonte.fonte, fonte.situacao]));
}

function fonte(rodada: Sincronizacao, nome: ResultadoDaFonte["fonte"]): ResultadoDaFonte {
  const achada = rodada.fontes.find((f) => f.fonte === nome);
  if (achada === undefined) throw new Error(`sem a fonte ${nome}`);
  return achada;
}

const nomesChamados = () => crm.registro().chamadasDeFerramenta.map((c) => c.nome);

describe("sincronização sob demanda", () => {
  test("lê as fontes do CRM, guarda no cache e diz quantos itens cada uma trouxe", async () => {
    const conectores = await ligado();
    expect(conectores.leiturasDoCrm()).toEqual({ agenda: null, propostas: null, carteira: null });

    const rodada = await conectores.sincronizar();
    expect(rodada.jaEmAndamento).toBe(false);
    expect(rodada.fontes.map((f) => (f.situacao === "leu" ? [f.fonte, f.itens, f.cortado] : [f.fonte, f.situacao]))).toEqual([
      ["agenda", 2, false],
      ["propostas", 5, false],
      ["carteira", 3, false],
      ["conversas", "pulada"],
      ["email", "pulada"],
    ]);
    const leituras = conectores.leiturasDoCrm();
    expect(leituras.agenda?.dia).toBe(diaEm(bancada.ambiente.agora()));
    expect(leituras.carteira?.semAtendimentoHaDias).toBe(30);
    expect(leituras.propostas?.itens.map((p) => [p.id, p.link])).toEqual([
      [7005, `${crm.origem}/propostas/7005`],
      [7004, `${crm.origem}/propostas/7004`],
      [7003, `${crm.origem}/propostas/7003`],
      [7002, `${crm.origem}/propostas/7002`],
      [7001, `${crm.origem}/propostas/7001`],
    ]);
    expect(nomesChamados().filter((n) => n === "ver_proposta")).toHaveLength(5);

    // O link de uma versão não muda: a segunda rodada não pede `ver_proposta` de novo.
    await conectores.sincronizar();
    expect(nomesChamados().filter((n) => n === "ver_proposta")).toHaveLength(5);
  });

  test("percorre todas as páginas de propostas e da carteira", async () => {
    const conectores = await ligado();
    crm.dados.propostas.splice(0, crm.dados.propostas.length, ...Array.from({ length: 60 }, (_, i) => propostaFalsa(7200 + i, "enviada", crm.dia(-2))));
    const rodada = await conectores.sincronizar();
    expect(fonte(rodada, "propostas")).toMatchObject({ situacao: "leu", itens: 60, cortado: false });
    const pedidos = crm.registro().chamadasDeFerramenta.filter((c) => c.nome === "listar_propostas");
    expect(pedidos.map((c) => c.argumentos)).toEqual([
      { escopo: "minhas", estagio: "enviada", limite: 50 },
      { escopo: "minhas", estagio: "enviada", limite: 50, antes: 7210 },
    ]);
  });

  test("`semAtendimentoHaDias` vai ao CRM e fica para a próxima rodada", async () => {
    const conectores = await ligado();
    await conectores.sincronizar({ semAtendimentoHaDias: 60 });
    expect(conectores.leiturasDoCrm().carteira?.itens.map((c) => c.id)).toEqual([8001, 8003]);
    await conectores.sincronizar();
    const carteiras = crm.registro().chamadasDeFerramenta.filter((c) => c.nome === "minha_carteira");
    expect(carteiras.map((c) => c.argumentos.sem_atendimento_ha_dias)).toEqual([60, 60]);
  });

  test("cada fonte falha sozinha: a carteira malformada não apaga a agenda nem as propostas", async () => {
    const conectores = await ligado();
    await conectores.sincronizar();
    const antes = conectores.leiturasDoCrm().carteira;
    bancada.avancar(60_000);
    crm.botoes.ferramentasMalformadas.add("minha_carteira");

    const rodada = await conectores.sincronizar();
    expect(situacoes(rodada)).toEqual({ agenda: "leu", propostas: "leu", carteira: "falhou", conversas: "pulada", email: "pulada" });
    const carteira = fonte(rodada, "carteira");
    expect(carteira.situacao === "falhou" && carteira.erro.codigo).toBe("crm_resposta_inesperada");
    const depois = conectores.leiturasDoCrm();
    expect(depois.carteira).toEqual(antes);
    expect(depois.agenda?.lidoEm).not.toBe(antes?.lidoEm);
  });

  test("429 no meio: a fonte falha com a espera, e as seguintes não chamam o CRM", async () => {
    const conectores = await ligado();
    crm.botoes.chamadasAntesDoLimite = 1;
    crm.botoes.limiteHttpS = 30;
    const rodada = await conectores.sincronizar();
    expect(situacoes(rodada)).toEqual({ agenda: "leu", propostas: "falhou", carteira: "pulada", conversas: "pulada", email: "pulada" });
    expect(fonte(rodada, "propostas")).toMatchObject({ erro: { codigo: "crm_limite_de_chamadas", esperaS: 30 } });
    expect(fonte(rodada, "carteira")).toMatchObject({ motivo: "crm_limite_de_chamadas", erro: { esperaS: 30 } });
    expect(nomesChamados()).toEqual(["minha_agenda", "listar_propostas"]);
  });

  test("duas sincronizações ao mesmo tempo: a segunda recebe a que está rodando", async () => {
    const conectores = await ligado();
    let soltar: () => void = () => {};
    crm.botoes.segurar = new Promise<void>((resolver) => (soltar = resolver));
    const chegou = new Promise<void>((resolver) => (crm.botoes.aoChamar = () => resolver()));
    const primeira = conectores.sincronizar();
    await chegou;
    const segunda = conectores.sincronizar();
    const comOMesmoCorte = conectores.sincronizar({ semAtendimentoHaDias: 30 });
    crm.botoes.segurar = null;
    soltar();
    const [a, b, c] = await Promise.all([primeira, segunda, comOMesmoCorte]);
    expect([b.id, c.id]).toEqual([a.id, a.id]);
    expect([a.jaEmAndamento, b.jaEmAndamento, c.jaEmAndamento]).toEqual([false, true, true]);
    expect(b.fontes).toEqual(a.fontes);
    expect(nomesChamados().filter((n) => n === "minha_agenda")).toHaveLength(1);
  });

  test("outro corte no meio de uma rodada: a carteira é lida de novo com o corte pedido", async () => {
    const conectores = await ligado();
    let soltar: () => void = () => {};
    crm.botoes.segurar = new Promise<void>((resolver) => (soltar = resolver));
    const chegou = new Promise<void>((resolver) => (crm.botoes.aoChamar = () => resolver()));
    const primeira = conectores.sincronizar();
    await chegou;
    const comOutroCorte = conectores.sincronizar({ semAtendimentoHaDias: 60 });
    crm.botoes.segurar = null;
    soltar();
    const [a, b] = await Promise.all([primeira, comOutroCorte]);

    expect(b.id).not.toBe(a.id);
    expect([a.jaEmAndamento, b.jaEmAndamento]).toEqual([false, false]);
    expect(situacoes(b)).toEqual({ agenda: "leu", propostas: "leu", carteira: "leu", conversas: "pulada", email: "pulada" });
    const cortes = crm.registro().chamadasDeFerramenta.filter((ch) => ch.nome === "minha_carteira").map((ch) => ch.argumentos.sem_atendimento_ha_dias);
    expect(cortes).toEqual([30, 60]);
    const carteira = conectores.leiturasDoCrm().carteira;
    expect(carteira?.semAtendimentoHaDias).toBe(60);
    expect(carteira?.itens.map((cliente) => cliente.id)).toEqual([8001, 8003]);
  });

  test("outro corte no meio de uma rodada que bateu no limite: não chama o CRM de novo antes da espera", async () => {
    const conectores = await ligado();
    crm.botoes.chamadasAntesDoLimite = 1;
    crm.botoes.limiteHttpS = 30;
    let soltar: () => void = () => {};
    crm.botoes.segurar = new Promise<void>((resolver) => (soltar = resolver));
    const chegou = new Promise<void>((resolver) => (crm.botoes.aoChamar = () => resolver()));
    const primeira = conectores.sincronizar();
    await chegou;
    const comOutroCorte = conectores.sincronizar({ semAtendimentoHaDias: 60 });
    crm.botoes.segurar = null;
    soltar();
    const [a, b] = await Promise.all([primeira, comOutroCorte]);

    expect(b.id).toBe(a.id);
    expect(b.jaEmAndamento).toBe(true);
    expect(fonte(b, "carteira")).toMatchObject({ situacao: "pulada", motivo: "crm_limite_de_chamadas", erro: { esperaS: 30 } });
    expect(nomesChamados()).toEqual(["minha_agenda", "listar_propostas"]);
    expect(conectores.leiturasDoCrm().carteira).toBeNull();
  });

  test("CRM desconectado: as fontes do CRM pulam com o motivo, sem chamar o MCP", async () => {
    const conectores = nova().ligar();
    await conectores.pronto;
    const antes = crm.registro().chamadasAoMcp;
    const rodada = await conectores.sincronizar();
    expect(rodada.fontes).toEqual([
      { fonte: "agenda", situacao: "pulada", motivo: "crm_desconectado" },
      { fonte: "propostas", situacao: "pulada", motivo: "crm_desconectado" },
      { fonte: "carteira", situacao: "pulada", motivo: "crm_desconectado" },
      { fonte: "conversas", situacao: "pulada", motivo: "whatsapp_desconectado" },
      { fonte: "email", situacao: "pulada", motivo: "email_sem_conta" },
    ]);
    expect(crm.registro().chamadasAoMcp).toBe(antes);
  });

  test("CRM não liberado: as fontes pulam com crm_app_nao_liberado, sem erro", async () => {
    const conectores = nova({ semClientId: true }).ligar();
    await conectores.pronto;
    await conectores.agir("crm", "conectar");
    await esperar(conectores, (e) => e.crm.fase === "atencao", "CRM em atenção");
    const rodada = await conectores.sincronizar();
    expect(rodada.fontes.map((f) => [f.situacao, f.situacao === "pulada" ? f.motivo : null, "erro" in f])).toEqual([
      ["pulada", "crm_app_nao_liberado", false],
      ["pulada", "crm_app_nao_liberado", false],
      ["pulada", "crm_app_nao_liberado", false],
      ["pulada", "whatsapp_desconectado", false],
      ["pulada", "email_sem_conta", false],
    ]);
  });

  test("nenhum token no cache, no banco nem no registro", async () => {
    const conectores = await ligado();
    await conectores.sincronizar();
    const pasta = bancada.textoDaPastaDeDados();
    const registro = bancada.linhasDoRegistro.join("\n");
    expect(crm.registro().segredos.length).toBeGreaterThan(0);
    for (const segredo of crm.registro().segredos) {
      expect(pasta).not.toContain(segredo);
      expect(registro).not.toContain(segredo);
    }
    expect(pasta).toContain("CANARIO Cliente 8002");
  });

  test("apagar o cache não perde tarefa do vendedor: o Meu dia volta a dizer sem leitura", async () => {
    const conectores = await ligado();
    const agora = bancada.ambiente.agora();
    const ctx = { papel: "painel" as const, agora, hoje: diaEm(agora), novoId: () => crypto.randomUUID() };
    inserirTarefa(bancada.banco, criarTarefa({ titulo: "Ligar para a CANARIO", nota: "nota do vendedor" }, ctx));
    await conectores.sincronizar();
    expect(montarMeuDia(listarTarefas(bancada.banco, "aberta"), conectores.estado(), agora, diaEm(agora), conectores.leiturasDoCrm()).propostas_abertas.itens).toHaveLength(5);

    apagarCache(bancada.banco);
    const dia = montarMeuDia(listarTarefas(bancada.banco, "aberta"), conectores.estado(), agora, diaEm(agora), conectores.leiturasDoCrm());
    expect(dia.sem_data.map((t) => t.titulo)).toEqual(["Ligar para a CANARIO"]);
    for (const bloco of [dia.compromissos_de_hoje, dia.propostas_abertas, dia.clientes_sem_atendimento]) {
      expect(bloco).toMatchObject({ itens: [], lido_em: null, motivo: "sem_leitura" });
    }
  });
});

describe("conferir o cliente de uma tarefa", () => {
  test("com o CRM conectado: o nome vem do CRM; id que o CRM não acha é nao_encontrado", async () => {
    const conectores = await ligado();
    expect(await conectores.conferirCliente(8002)).toMatchObject({ tipo: "conferido", ficha: { id: 8002, nome: "CANARIO Cliente 8002" } });
    expect(await conectores.conferirCliente(99_999)).toEqual({ tipo: "nao_encontrado" });
  });

  test("sem CRM: não confere e não chama o MCP", async () => {
    const conectores = nova().ligar();
    await conectores.pronto;
    const antes = crm.registro().chamadasAoMcp;
    expect(await conectores.conferirCliente(8002)).toEqual({ tipo: "nao_conferido", motivo: "crm_desconectado" });
    expect(crm.registro().chamadasAoMcp).toBe(antes);
  });

  test("CRM fora do ar: não conferido, com o motivo", async () => {
    const conectores = await ligado();
    crm.botoes.ferramentasForaDoAr.add("ver_cliente");
    expect(await conectores.conferirCliente(8002)).toEqual({ tipo: "nao_conferido", motivo: "crm_fora_do_ar" });
  });
});

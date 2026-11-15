import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { textoExterno, type Instante } from "../dominio";
import { novoCartao, type CartaoDaEscrita, type ComandoDaEscrita, type Escrita } from "../escritas";
import {
  PASTA_DO_NUCLEO,
  abrirBanco,
  cartaoTemEdicao,
  clienteJaTemEscritaAprovada,
  decisoesDoCartao,
  inserirCartao,
  lerCartao,
  listarCartoes,
  migrar,
  mudarCartao,
  mudarCartaoEmSequencia,
  prepararBanco,
  type BancoAberto,
} from "./index";

const T0 = "2026-11-14T12:00:00.000Z" as Instante;
const T1 = "2026-11-14T12:05:00.000Z" as Instante;
const pastas: string[] = [];
const abertos: BancoAberto[] = [];

function preparar(): { banco: BancoAberto; pasta: string } {
  const pasta = mkdtempSync(join(tmpdir(), "secretaria-escritas-"));
  pastas.push(pasta);
  const banco = prepararBanco({
    caminho: join(pasta, "secretaria.db"),
    caminhoDoVendedor: join(pasta, "meu.db"),
    dirBackups: join(pasta, "backups"),
    pastaDoVendedor: join(pasta, "meu"),
    agora: T0,
  });
  abertos.push(banco);
  return { banco, pasta };
}

afterEach(() => {
  for (const banco of abertos.splice(0)) banco.fechar();
  for (const pasta of pastas.splice(0)) rmSync(pasta, { recursive: true, force: true });
});

const ESCRITA: Escrita = { tool: "registrar_atendimento", dados: { cliente_id: 9201, assunto: "Ligação sobre o pedido", status: "Pendente", descricao: "Combinou retorno na sexta." } };
const CLIENTE = { id: 9201, conferido: true, nome: textoExterno("CANARIO Cliente 9201"), cidade: textoExterno("Curitiba") } as const;

function cartao(id: string, extra: Partial<{ escrita: Escrita; cliente: CartaoDaEscrita["cliente"]; criadaEm: Instante; confiraOCliente: boolean }> = {}): CartaoDaEscrita {
  return novoCartao({ id, escrita: extra.escrita ?? ESCRITA, cliente: extra.cliente === undefined ? CLIENTE : extra.cliente, confiraOCliente: extra.confiraOCliente ?? false, agora: extra.criadaEm ?? T0 });
}

const aprovar = (c: CartaoDaEscrita): ComandoDaEscrita => ({ acao: "aprovar", hash: c.hash, versao: c.versao });

describe("cartão no banco", () => {
  test("grava e lê de volta o que foi proposto, nos três formatos de cliente", () => {
    const { banco } = preparar();
    const compromisso: Escrita = { tool: "criar_compromisso", dados: { titulo: "Visita", inicio: "2026-11-16 09:00" } };
    const cartoes = [
      cartao("a", { confiraOCliente: true }),
      cartao("b", { cliente: { id: 9202, conferido: false } }),
      cartao("c", { escrita: compromisso, cliente: null }),
      cartao("d", { cliente: { id: 9203, conferido: true, nome: textoExterno("CANARIO Sem Cidade"), cidade: null } }),
    ];
    for (const c of cartoes) expect(inserirCartao(banco, c)).toEqual({ inserido: true, cartao: c });
    for (const c of cartoes) expect(lerCartao(banco, c.id)).toEqual(c);
    expect(lerCartao(banco, "nao-existe")).toBeNull();
  });

  test("o payload fica na forma canônica", () => {
    const { banco } = preparar();
    inserirCartao(banco, cartao("a"));
    const linha = banco.sqlite.query("SELECT payload, tool, sinais FROM escrita_crm").get() as { payload: string; tool: string; sinais: string };
    expect(linha.payload).toBe('{"assunto":"Ligação sobre o pedido","cliente_id":9201,"descricao":"Combinou retorno na sexta.","status":"Pendente"}');
    expect(linha.sinais).toBe("{}");
  });

  test("inserir de novo com o mesmo id não grava outro e devolve o que existe", () => {
    const { banco } = preparar();
    const primeiro = cartao("a");
    inserirCartao(banco, primeiro);
    const outro = cartao("a", { escrita: { tool: "registrar_atendimento", dados: { cliente_id: 1, assunto: "Outro", status: "Concluído" } }, cliente: null });
    expect(inserirCartao(banco, outro)).toEqual({ inserido: false, cartao: primeiro });
    expect(listarCartoes(banco)).toEqual([primeiro]);
  });

  test("listar do mais antigo para o mais novo e, no mesmo instante, na ordem de chegada, com filtro de estado", () => {
    const { banco } = preparar();
    inserirCartao(banco, cartao("c", { criadaEm: "2026-11-14T12:00:00.000Z" as Instante }));
    inserirCartao(banco, cartao("b", { criadaEm: "2026-11-14T12:00:00.000Z" as Instante }));
    inserirCartao(banco, cartao("a", { criadaEm: "2026-11-14T13:00:00.000Z" as Instante }));
    inserirCartao(banco, cartao("0", { criadaEm: "2026-11-14T11:00:00.000Z" as Instante }));
    expect(listarCartoes(banco).map((c) => c.id)).toEqual(["0", "c", "b", "a"]);
    const b = lerCartao(banco, "b");
    if (b === null) throw new Error("b sumiu");
    mudarCartao(banco, "b", { acao: "descartar", hash: b.hash, versao: 1 }, "painel", T1);
    expect(listarCartoes(banco, "descartado").map((c) => c.id)).toEqual(["b"]);
    expect(listarCartoes(banco, "rascunho").map((c) => c.id)).toEqual(["0", "c", "a"]);
    expect(listarCartoes(banco, "gravado")).toEqual([]);
  });

  test("mudar grava o cartão e a decisão juntos", () => {
    const { banco } = preparar();
    const c = cartao("a");
    inserirCartao(banco, c);
    const r = mudarCartao(banco, "a", aprovar(c), "painel", T1);
    expect(r.ok).toBe(true);
    expect(lerCartao(banco, "a")).toMatchObject({ estado: "aprovado", versao: 2, atualizadaEm: T1, hash: c.hash });
    expect(decisoesDoCartao(banco, "a")).toEqual([{ acao: "aprovou", hash: c.hash, em: T1 }]);
  });

  test("mudar sem decisão (conferir cliente) só grava o cartão", () => {
    const { banco } = preparar();
    const c = cartao("a", { cliente: { id: 9201, conferido: false } });
    inserirCartao(banco, c);
    expect(mudarCartao(banco, "a", { acao: "conferir_cliente", ficha: { nome: textoExterno("CANARIO"), cidade: null } }, "servidor", T1).ok).toBe(true);
    expect(lerCartao(banco, "a")?.cliente).toEqual({ id: 9201, conferido: true, nome: textoExterno("CANARIO"), cidade: null });
    expect(decisoesDoCartao(banco, "a")).toEqual([]);
  });

  test("queda simulada no INSERT de decisao não deixa o cartão mudado", () => {
    const { banco } = preparar();
    const c = cartao("a");
    inserirCartao(banco, c);
    banco.sqlite.run("CREATE TEMP TRIGGER queda BEFORE INSERT ON decisao BEGIN SELECT RAISE(ABORT, 'queda simulada'); END;");
    expect(() => mudarCartao(banco, "a", aprovar(c), "painel", T1)).toThrow("queda simulada");
    expect(lerCartao(banco, "a")).toEqual(c);
    expect(decisoesDoCartao(banco, "a")).toEqual([]);
    banco.sqlite.run("DROP TRIGGER queda");
    expect(mudarCartao(banco, "a", aprovar(c), "painel", T1).ok).toBe(true);
  });

  test("versão velha não grava e devolve o cartão atual", () => {
    const { banco } = preparar();
    const c = cartao("a");
    inserirCartao(banco, c);
    mudarCartao(banco, "a", { acao: "editar", hash: c.hash, versao: 1, campos: { assunto: "Assunto novo" } }, "painel", T1);
    const velha = mudarCartao(banco, "a", aprovar(c), "painel", T1);
    expect(velha.ok).toBe(false);
    if (velha.ok) return;
    expect(velha.erro.codigo).toBe("conflito_da_escrita");
    expect(velha.erro.atual).toMatchObject({ id: "a", versao: 2, estado: "rascunho" });
    expect(lerCartao(banco, "a")?.versao).toBe(2);
    expect(decisoesDoCartao(banco, "a").map((d) => d.acao)).toEqual(["editou"]);
  });

  test("cartão que não existe é nao_encontrado, sem gravar", () => {
    const { banco } = preparar();
    expect(mudarCartao(banco, "nada", { acao: "retirar" }, "agente", T1)).toMatchObject({ ok: false, erro: { codigo: "nao_encontrado" } });
  });

  test("decisões em ordem, edição visível e retirar depois de editar recusado dentro da transação", () => {
    const { banco } = preparar();
    const c = cartao("a");
    inserirCartao(banco, c);
    expect(cartaoTemEdicao(banco, "a")).toBe(false);
    const editado = mudarCartao(banco, "a", { acao: "editar", hash: c.hash, versao: 1, campos: { descricao: "Texto do vendedor" } }, "painel", T1);
    if (!editado.ok) throw new Error(editado.erro.codigo);
    expect(cartaoTemEdicao(banco, "a")).toBe(true);
    expect(mudarCartao(banco, "a", { acao: "retirar" }, "agente", T1)).toMatchObject({ ok: false, erro: { codigo: "so_no_painel" } });
    const novo = editado.dados.cartao;
    mudarCartao(banco, "a", { acao: "descartar", hash: novo.hash, versao: novo.versao }, "painel", T1);
    expect(decisoesDoCartao(banco, "a").map((d) => [d.acao, d.hash])).toEqual([["editou", c.hash], ["descartou", novo.hash]]);
  });

  test("cliente que já tem escrita com decisão aprovou, mesmo descartada depois", () => {
    const { banco } = preparar();
    const a = cartao("a");
    inserirCartao(banco, a);
    inserirCartao(banco, cartao("b", { cliente: { id: 9202, conferido: false } }));
    expect(clienteJaTemEscritaAprovada(banco, 9201)).toBe(false);
    mudarCartao(banco, "a", aprovar(a), "painel", T1);
    expect(clienteJaTemEscritaAprovada(banco, 9201)).toBe(true);
    expect(clienteJaTemEscritaAprovada(banco, 9202)).toBe(false);
    const aprovado = lerCartao(banco, "a");
    if (aprovado === null) throw new Error("sumiu");
    mudarCartao(banco, "a", { acao: "descartar", hash: aprovado.hash, versao: aprovado.versao }, "painel", T1);
    expect(clienteJaTemEscritaAprovada(banco, 9201)).toBe(true);
  });

  test("os estados de falha guardam código e detalhe; o recibo só em gravado", () => {
    const { banco } = preparar();
    const c = cartao("a");
    inserirCartao(banco, c);
    const passo = (comando: ComandoDaEscrita, quem: "painel" | "servidor") => {
      const r = mudarCartao(banco, "a", comando, quem, T1);
      if (!r.ok) throw new Error(r.erro.codigo);
    };
    passo(aprovar(c), "painel");
    passo({ acao: "comecar_gravacao" }, "servidor");
    passo({ acao: "ficou_incerto", erro: { codigo: "crm_escrita_incerta", detalhe: textoExterno("CANARIO detalhe") } }, "servidor");
    expect(lerCartao(banco, "a")).toMatchObject({ estado: "falhou_incerto", erro: { codigo: "crm_escrita_incerta", detalhe: "CANARIO detalhe" }, recibo: null });
    const incerto = lerCartao(banco, "a");
    if (incerto === null) throw new Error("sumiu");
    passo({ acao: "ja_esta_no_crm", hash: incerto.hash, versao: incerto.versao }, "painel");
    expect(lerCartao(banco, "a")).toMatchObject({ estado: "gravado", erro: null, recibo: { id: null, link: null } });
  });

  test("código de erro que esta versão não conhece (banco de uma versão mais nova) se lê como incerto, e a lista não quebra", () => {
    const { banco } = preparar();
    for (const id of ["a", "b"]) inserirCartao(banco, cartao(id));
    banco.sqlite.run("UPDATE escrita_crm SET estado = 'falhou', erro_codigo = 'codigo_de_uma_versao_futura', erro_detalhe = 'CANARIO futuro' WHERE id = 'a'");
    expect(listarCartoes(banco).map((c) => [c.id, c.estado, c.erro?.codigo ?? null])).toEqual([
      ["a", "falhou", "crm_escrita_incerta"],
      ["b", "rascunho", null],
    ]);
    expect(lerCartao(banco, "a")?.erro).toEqual({ codigo: "crm_escrita_incerta", detalhe: textoExterno("CANARIO futuro") });
  });
});

describe("sequência de comandos numa transação", () => {
  test("aprovar e começar a gravação: o cartão sai em gravando, versão 3, com uma decisão aprovou", () => {
    const { banco } = preparar();
    const c = cartao("a");
    inserirCartao(banco, c);
    const feito = mudarCartaoEmSequencia(banco, "a", [{ comando: aprovar(c), quem: "painel" }, { comando: { acao: "comecar_gravacao" }, quem: "servidor" }], T1);
    expect(feito.ok && feito.dados.map((d) => d.cartao.estado)).toEqual(["aprovado", "gravando"]);
    expect(lerCartao(banco, "a")).toMatchObject({ estado: "gravando", versao: 3, atualizadaEm: T1 });
    expect(decisoesDoCartao(banco, "a")).toEqual([{ acao: "aprovou", hash: c.hash, em: T1 }]);
  });

  test("segundo passo recusado: nada do primeiro fica, nem a decisão", () => {
    const { banco } = preparar();
    const c = cartao("a");
    inserirCartao(banco, c);
    // `gravou` só sai de gravando: depois do aprovar, o cartão está aprovado e a regra recusa.
    const feito = mudarCartaoEmSequencia(
      banco,
      "a",
      [{ comando: aprovar(c), quem: "painel" }, { comando: { acao: "gravou", recibo: { id: 1, link: null } }, quem: "servidor" }],
      T1,
    );
    expect(feito.ok).toBe(false);
    expect(!feito.ok && feito.erro.codigo).toBe("estado_da_escrita");
    // O cartão em erro.atual é o gravado depois do desfazer, não o do passo intermediário.
    expect(!feito.ok && feito.erro.atual).toEqual(c);
    expect(lerCartao(banco, "a")).toMatchObject({ estado: "rascunho", versao: 1 });
    expect(decisoesDoCartao(banco, "a")).toEqual([]);
  });

  test("primeiro passo recusado: devolve a recusa sem mexer no cartão", () => {
    const { banco } = preparar();
    const c = cartao("a");
    inserirCartao(banco, c);
    const feito = mudarCartaoEmSequencia(banco, "a", [{ comando: { acao: "aprovar", hash: c.hash, versao: 9 }, quem: "painel" }, { comando: { acao: "comecar_gravacao" }, quem: "servidor" }], T1);
    expect(!feito.ok && feito.erro.codigo).toBe("conflito_da_escrita");
    expect(lerCartao(banco, "a")).toEqual(c);
    const semCartao = mudarCartaoEmSequencia(banco, "nao-existe", [{ comando: { acao: "comecar_gravacao" }, quem: "servidor" }], T1);
    expect(!semCartao.ok && semCartao.erro.codigo).toBe("nao_encontrado");
  });

  test("mudarCartao é o caso de um passo", () => {
    const { banco } = preparar();
    const c = cartao("a");
    inserirCartao(banco, c);
    const feito = mudarCartao(banco, "a", aprovar(c), "painel", T1);
    expect(feito.ok && feito.dados.cartao).toMatchObject({ estado: "aprovado", versao: 2 });
    expect(decisoesDoCartao(banco, "a")).toHaveLength(1);
  });
});

const VALIDA = {
  id: "'x'",
  tool: "'registrar_atendimento'",
  payload: "'{}'",
  hash: `'${"a".repeat(64)}'`,
  cliente_id: "9201",
  cliente_conferido: "1",
  cliente_nome: "'CANARIO'",
  cliente_cidade: "NULL",
  confira_cliente: "0",
  sinais: "'{}'",
  estado: "'rascunho'",
  crm_id: "NULL",
  crm_link: "NULL",
  erro_codigo: "NULL",
  erro_detalhe: "NULL",
  versao: "1",
  criada_em: `'${T0}'`,
  atualizada_em: `'${T0}'`,
  ordem: "(SELECT coalesce(max(ordem), 0) + 1 FROM escrita_crm)",
};

function inserirCru(banco: BancoAberto, mudancas: Record<string, string> = {}): void {
  const campos = { ...VALIDA, ...mudancas };
  banco.sqlite.run(`INSERT INTO escrita_crm (${Object.keys(campos).join(", ")}) VALUES (${Object.values(campos).join(", ")})`);
}

describe("CHECKs de escrita_crm", () => {
  test("a linha de base é válida", () => {
    const { banco } = preparar();
    expect(() => inserirCru(banco)).not.toThrow();
  });

  test.each<[string, Record<string, string>, string]>([
    ["tool fora da lista", { tool: "'editar_atendimento'" }, "escrita_crm_tool"],
    ["estado fora da lista", { estado: "'pausado'" }, "escrita_crm_estado"],
    ["payload que não é JSON", { payload: "'{nao'" }, "escrita_crm_payload"],
    ["sinais que não é JSON", { sinais: "'x'" }, "escrita_crm_sinais"],
    ["hash curto", { hash: "'abc'" }, "escrita_crm_hash"],
    ["hash comprido", { hash: `'${"a".repeat(65)}'` }, "escrita_crm_hash"],
    ["cliente_id zero", { cliente_id: "0" }, "escrita_crm_cliente_id"],
    ["versão zero", { versao: "0" }, "escrita_crm_versao"],
    ["cliente conferido sem nome", { cliente_nome: "NULL" }, "escrita_crm_cliente"],
    ["cliente conferido sem id", { cliente_id: "NULL", confira_cliente: "0" }, "escrita_crm_cliente"],
    ["nome sem conferência", { cliente_conferido: "0" }, "escrita_crm_cliente"],
    ["cidade sem conferência", { cliente_conferido: "0", cliente_nome: "NULL", cliente_cidade: "'Curitiba'" }, "escrita_crm_cliente"],
    ["marca de conferir sem cliente", { cliente_id: "NULL", cliente_conferido: "0", cliente_nome: "NULL", confira_cliente: "1" }, "escrita_crm_confira_cliente"],
    ["marca fora de 0 e 1", { confira_cliente: "2" }, "escrita_crm_confira_cliente"],
    ["recibo fora de gravado", { crm_id: "5" }, "escrita_crm_recibo"],
    ["link fora de gravado", { crm_link: "'https://crm.invalid/1'" }, "escrita_crm_recibo"],
    ["falhou sem código de erro", { estado: "'falhou'" }, "escrita_crm_erro"],
    ["falhou_incerto sem código de erro", { estado: "'falhou_incerto'" }, "escrita_crm_erro"],
    ["código de erro fora de falhou", { erro_codigo: "'x'" }, "escrita_crm_erro"],
    ["código de erro em gravado", { estado: "'gravado'", erro_codigo: "'x'" }, "escrita_crm_erro"],
    ["detalhe sem código", { erro_detalhe: "'x'" }, "escrita_crm_erro"],
  ])("recusa %s", (_nome, mudancas, regra) => {
    const { banco } = preparar();
    expect(() => inserirCru(banco, mudancas)).toThrow(regra);
  });

  test("aceita o que as regras permitem: gravado com recibo e falhou com código e detalhe", () => {
    const { banco } = preparar();
    inserirCru(banco, { id: "'g'", estado: "'gravado'", crm_id: "5", crm_link: "'https://crm.invalid/5'" });
    inserirCru(banco, { id: "'i'", estado: "'gravado'" });
    inserirCru(banco, { id: "'f'", estado: "'falhou'", erro_codigo: "'crm_recusou'", erro_detalhe: "'texto'" });
    inserirCru(banco, { id: "'n'", cliente_id: "NULL", cliente_conferido: "0", cliente_nome: "NULL" });
  });

  test("a chave primária recusa id repetido", () => {
    const { banco } = preparar();
    inserirCru(banco);
    expect(() => inserirCru(banco)).toThrow(/UNIQUE|PRIMARY/);
  });
});

describe("decisao", () => {
  function comCartao() {
    const resultado = preparar();
    inserirCartao(resultado.banco, cartao("a"));
    return resultado.banco;
  }
  const hash = "a".repeat(64);
  const inserir = (banco: BancoAberto, campos = "'a', 'aprovou'", h = hash) => banco.sqlite.run(`INSERT INTO decisao (escrita_id, acao, hash, em) VALUES (${campos}, '${h}', '${T0}')`);

  test("recusa ação fora da lista, hash que não tem 64 caracteres e escrita que não existe", () => {
    const banco = comCartao();
    expect(() => inserir(banco, "'a', 'cancelou'")).toThrow("decisao_acao");
    expect(() => inserir(banco, "'a', 'aprovou'", "curto")).toThrow("decisao_hash");
    expect(() => inserir(banco, "'nao-existe', 'aprovou'")).toThrow(/FOREIGN KEY/);
    for (const acao of ["aprovou", "editou", "descartou", "retirou", "ja_esta_no_crm", "tentou_de_novo"]) expect(() => inserir(banco, `'a', '${acao}'`)).not.toThrow();
  });

  test("UPDATE e DELETE em decisao falham com 'decisao só aceita inserção'", () => {
    const banco = comCartao();
    inserir(banco);
    expect(() => banco.sqlite.run("UPDATE decisao SET acao = 'descartou'")).toThrow("decisao só aceita inserção");
    expect(() => banco.sqlite.run("DELETE FROM decisao")).toThrow("decisao só aceita inserção");
    expect(decisoesDoCartao(banco, "a").map((d) => d.acao)).toEqual(["aprovou"]);
  });

  test("não há cascata: apagar o cartão com decisão é recusado", () => {
    const banco = comCartao();
    inserir(banco);
    expect(() => banco.sqlite.run("DELETE FROM escrita_crm WHERE id = 'a'")).toThrow(/FOREIGN KEY/);
  });
});

describe("migrações 0011 e 0012", () => {
  test("aplicam sobre uma base que parou na 0010, com dado, sem tocar no dado", () => {
    const pasta = mkdtempSync(join(tmpdir(), "secretaria-migracao-escritas-"));
    pastas.push(pasta);
    const antigas = join(pasta, "migracoes-antigas");
    mkdirSync(antigas);
    for (const nome of readdirSync(PASTA_DO_NUCLEO).filter((nome) => nome.endsWith(".sql") && nome < "0011")) copyFileSync(join(PASTA_DO_NUCLEO, nome), join(antigas, nome));
    // A trilha até a 0012: as migrações depois dela mudam colunas da `conector`, fora do que este teste compara.
    const ate0012 = join(pasta, "migracoes-ate-0012");
    mkdirSync(ate0012);
    for (const nome of readdirSync(PASTA_DO_NUCLEO).filter((nome) => nome.endsWith(".sql") && nome < "0013")) copyFileSync(join(PASTA_DO_NUCLEO, nome), join(ate0012, nome));
    const banco = abrirBanco(join(pasta, "secretaria.db"));
    abertos.push(banco);
    const comum = { trilha: "nucleo", dirBackups: join(pasta, "backups"), agora: T0 } as const;
    migrar(banco.sqlite, { ...comum, pasta: antigas });
    banco.sqlite.run(`INSERT INTO tarefa (id, titulo, estado, origem, criada_em, atualizada_em) VALUES ('t', 'Ligar', 'aberta', 'vendedor', '${T0}', '${T0}')`);
    banco.sqlite.run(`INSERT INTO nota (tarefa_id, texto, autor, criada_em) VALUES ('t', 'oi', 'vendedor', '${T0}')`);
    const antes = JSON.stringify([banco.sqlite.query("SELECT * FROM tarefa").all(), banco.sqlite.query("SELECT * FROM nota").all(), banco.sqlite.query("SELECT * FROM conector").all()]);
    const tabelasAntes = (banco.sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    expect(tabelasAntes).not.toContain("escrita_crm");

    const resultado = migrar(banco.sqlite, { ...comum, pasta: ate0012 });
    expect(resultado.aplicadas).toEqual(["0011_fila_de_aprovacao", "0012_decisao_so_insercao"]);
    const depois = JSON.stringify([banco.sqlite.query("SELECT * FROM tarefa").all(), banco.sqlite.query("SELECT * FROM nota").all(), banco.sqlite.query("SELECT * FROM conector").all()]);
    expect(depois).toBe(antes);
    const novas = (banco.sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('escrita_crm', 'decisao')").all() as { name: string }[]).map((t) => t.name).sort();
    expect(novas).toEqual(["decisao", "escrita_crm"]);
    const gatilhos = (banco.sqlite.query("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'decisao_%'").all() as { name: string }[]).map((t) => t.name).sort();
    expect(gatilhos).toEqual(["decisao_sem_delete", "decisao_sem_update"]);
    expect(() => banco.sqlite.run("UPDATE nota SET texto = 'x'")).toThrow("nota só aceita inserção");
  });
});

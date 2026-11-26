import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Dia, Instante } from "../dominio";
import { criarTarefa, decidir, type Contexto } from "../tarefas";
import { backupDoDia, backupValido, inserirTarefa, lerTarefa, listarTarefas, mudarTarefa, prepararBanco, type BancoAberto } from "./index";

const AGORA = "2026-11-11T12:00:00.000Z" as Instante;
const HOJE = "2026-11-11" as Dia;
const pastas: string[] = [];
const abertos: BancoAberto[] = [];

function preparar(): { banco: BancoAberto; pasta: string } {
  const pasta = mkdtempSync(join(tmpdir(), "secretaria-tarefas-"));
  pastas.push(pasta);
  const banco = prepararBanco({
    caminho: join(pasta, "secretaria.db"),
    caminhoDoVendedor: join(pasta, "meu.db"),
    dirBackups: join(pasta, "backups"),
    pastaDoVendedor: join(pasta, "meu"),
    agora: AGORA,
  });
  abertos.push(banco);
  return { banco, pasta };
}

function contexto(papel: Contexto["papel"] = "painel"): Contexto {
  let n = 0;
  return { papel, agora: AGORA, hoje: HOJE, novoId: () => `t-${papel}-${(n += 1)}` };
}

afterEach(() => {
  for (const banco of abertos.splice(0)) banco.fechar();
  for (const pasta of pastas.splice(0)) rmSync(pasta, { recursive: true, force: true });
});

describe("tarefas no banco", () => {
  test("criar, ler com notas e listar por estado", () => {
    const { banco } = preparar();
    const ctx = contexto();
    inserirTarefa(banco, criarTarefa({ titulo: "Ligar para a obra", clienteNome: "Cliente Canário", nota: "pediu orçamento" }, ctx));
    inserirTarefa(banco, criarTarefa({ titulo: "Sem data" }, ctx));
    const lida = lerTarefa(banco, "t-painel-1");
    expect(lida?.tarefa).toMatchObject({ titulo: "Ligar para a obra", clienteNome: "Cliente Canário", venceEm: null, estado: "aberta", versao: 1, origem: "vendedor" });
    expect(lida?.notas.map((n) => [n.texto, n.autor])).toEqual([["pediu orçamento", "vendedor"]]);
    expect(listarTarefas(banco, "aberta").map((t) => t.id)).toEqual(["t-painel-1", "t-painel-2"]);
    expect(listarTarefas(banco, "concluida")).toEqual([]);
    expect(lerTarefa(banco, "inexistente")).toBeNull();
  });

  test("criar de novo com o mesmo id não grava outra tarefa nem repete a nota", () => {
    const { banco } = preparar();
    const id = "6f1c2f0e-9d5b-4c1e-8a57-3b9e0c4d2a11";
    expect(inserirTarefa(banco, criarTarefa({ id, titulo: "Visitar", nota: "primeira" }, contexto()))).toBe(true);
    expect(inserirTarefa(banco, criarTarefa({ id, titulo: "Outro título", nota: "repetida" }, contexto()))).toBe(false);
    expect(listarTarefas(banco).map((t) => [t.id, t.titulo])).toEqual([[id, "Visitar"]]);
    expect(lerTarefa(banco, id)?.notas.map((n) => n.texto)).toEqual(["primeira"]);
  });

  test("concluir com próximo passo grava a conclusão, a nota e a tarefa seguinte juntas", () => {
    const { banco } = preparar();
    const ctx = contexto();
    inserirTarefa(banco, criarTarefa({ titulo: "Visitar", clienteId: "c-1", clienteNome: "Cliente Canário" }, ctx));
    const resultado = mudarTarefa(banco, "t-painel-1", (atual) =>
      decidir(atual, { acao: "concluir", versao: 1, proximoPasso: "Mandar a proposta", venceEm: "2026-11-13" as Dia }, ctx),
    );
    expect(resultado.ok).toBe(true);
    expect(lerTarefa(banco, "t-painel-1")?.tarefa).toMatchObject({ estado: "concluida", versao: 2 });
    expect(lerTarefa(banco, "t-painel-1")?.notas[0]).toMatchObject({ proximoPasso: "Mandar a proposta" });
    expect(lerTarefa(banco, "t-painel-2")?.tarefa).toMatchObject({ titulo: "Mandar a proposta", clienteId: "c-1", venceEm: "2026-11-13", estado: "aberta" });
  });

  test("queda no meio do concluir com próximo passo não deixa metade gravada", () => {
    const { banco } = preparar();
    const ctx = contexto();
    inserirTarefa(banco, criarTarefa({ titulo: "Visitar" }, ctx));
    // A inserção da tarefa seguinte é o último passo antes das notas: cair ali precisa desfazer a conclusão.
    banco.sqlite.run("CREATE TEMP TRIGGER queda BEFORE INSERT ON tarefa WHEN NEW.id = 't-painel-2' BEGIN SELECT RAISE(ABORT, 'queda simulada'); END;");
    expect(() => mudarTarefa(banco, "t-painel-1", (atual) => decidir(atual, { acao: "concluir", versao: 1, proximoPasso: "Ligar de novo" }, ctx))).toThrow(
      "queda simulada",
    );
    const depois = lerTarefa(banco, "t-painel-1");
    expect(depois?.tarefa).toMatchObject({ estado: "aberta", versao: 1 });
    expect(depois?.notas).toEqual([]);
    expect(listarTarefas(banco).map((t) => t.id)).toEqual(["t-painel-1"]);
  });

  test("versão velha não grava e devolve a tarefa atual", () => {
    const { banco } = preparar();
    const ctx = contexto();
    inserirTarefa(banco, criarTarefa({ titulo: "Visitar" }, ctx));
    mudarTarefa(banco, "t-painel-1", (atual) => decidir(atual, { acao: "adiar", versao: 1, para: "2026-11-20" as Dia }, ctx));
    const velha = mudarTarefa(banco, "t-painel-1", (atual) => decidir(atual, { acao: "descartar", versao: 1 }, ctx));
    expect(velha.ok).toBe(false);
    if (velha.ok) return;
    expect(velha.erro.codigo).toBe("conflito_de_versao");
    expect(velha.erro.atual).toMatchObject({ id: "t-painel-1", versao: 2, venceEm: "2026-11-20", estado: "aberta" });
    expect(lerTarefa(banco, "t-painel-1")?.tarefa.estado).toBe("aberta");
  });

  test("o banco recusa estado, origem, autor e data fora da lista", () => {
    const { banco } = preparar();
    const inserir = (campos: string) =>
      banco.sqlite.run(
        `INSERT INTO tarefa (id, titulo, estado, origem, vence_em, criada_em, atualizada_em) VALUES (${campos}, '${AGORA}', '${AGORA}')`,
      );
    expect(() => inserir("'a', 'x', 'pausada', 'vendedor', NULL")).toThrow(/CHECK/);
    expect(() => inserir("'b', 'x', 'aberta', 'cliente', NULL")).toThrow(/CHECK/);
    expect(() => inserir("'c', 'x', 'aberta', 'vendedor', '2026-02-30'")).toThrow(/CHECK/);
    expect(() => inserir("'d', 'x', 'aberta', 'vendedor', '11/11/2026'")).toThrow(/CHECK/);
    expect(() => inserir("'e', '', 'aberta', 'vendedor', NULL")).toThrow(/CHECK/);
    inserir("'f', 'x', 'aberta', 'vendedor', '2026-11-30'");
    expect(() =>
      banco.sqlite.run(`INSERT INTO nota (tarefa_id, texto, autor, criada_em) VALUES ('f', 'oi', 'cliente', '${AGORA}')`),
    ).toThrow(/CHECK/);
  });

  test("nota só aceita inserção", () => {
    const { banco } = preparar();
    const ctx = contexto();
    inserirTarefa(banco, criarTarefa({ titulo: "Visitar", nota: "primeira" }, ctx));
    expect(() => banco.sqlite.run("UPDATE nota SET texto = 'trocada'")).toThrow("nota só aceita inserção");
    expect(() => banco.sqlite.run("DELETE FROM nota")).toThrow("nota só aceita inserção");
    expect(lerTarefa(banco, "t-painel-1")?.notas.map((n) => n.texto)).toEqual(["primeira"]);
  });

  test("a conversa da tarefa vai e volta inteira, leva os três campos juntos e não muda depois", () => {
    const { banco } = preparar();
    const ctx = contexto();
    const conversa = { canal: "whatsapp", chave: "+5541999990001", ate: "2026-11-11T11:00:00.000Z" as Instante } as const;
    inserirTarefa(banco, criarTarefa({ titulo: "Responder", conversa }, ctx));
    expect(lerTarefa(banco, "t-painel-1")?.tarefa.conversa).toEqual(conversa);
    mudarTarefa(banco, "t-painel-1", (atual) => decidir(atual, { acao: "concluir", versao: 1 }, ctx));
    expect(lerTarefa(banco, "t-painel-1")?.tarefa).toMatchObject({ estado: "concluida", conversa });

    const inserir = (canal: string, chave: string, ate: string) =>
      banco.sqlite.run(
        `INSERT INTO tarefa (id, titulo, origem, criada_em, atualizada_em, conversa_canal, conversa_chave, conversa_ate) VALUES ('${crypto.randomUUID()}', 'x', 'vendedor', '${AGORA}', '${AGORA}', ${canal}, ${chave}, ${ate})`,
      );
    expect(() => inserir("'whatsapp'", "'+5541999990001'", "NULL")).toThrow("a conversa da tarefa leva canal, chave e ate juntos");
    expect(() => inserir("NULL", "'+5541999990001'", `'${AGORA}'`)).toThrow("a conversa da tarefa leva canal, chave e ate juntos");
    expect(() => inserir("'sms'", "'+5541999990001'", `'${AGORA}'`)).toThrow("a conversa da tarefa leva canal, chave e ate juntos");
    expect(() => banco.sqlite.run(`UPDATE tarefa SET conversa_ate = '${AGORA}' WHERE id = 't-painel-1'`)).toThrow("a conversa da tarefa não muda");
    expect(() => banco.sqlite.run("UPDATE tarefa SET conversa_canal = NULL, conversa_chave = NULL, conversa_ate = NULL WHERE id = 't-painel-1'")).toThrow("a conversa da tarefa não muda");
    inserir("NULL", "NULL", "NULL");
  });
});

describe("backup diário", () => {
  const dias = (n: number) => Array.from({ length: n }, (_, i) => `2026-11-${String(i + 1).padStart(2, "0")}` as Dia);

  test("cria a cópia do dia num arquivo SQLite inteiro e não copia de novo no mesmo dia", () => {
    const { banco, pasta } = preparar();
    inserirTarefa(banco, criarTarefa({ titulo: "Visitar" }, contexto()));
    const dir = join(pasta, "backups");
    const primeiro = backupDoDia(banco, dir, HOJE);
    expect(primeiro).toEqual({ arquivo: join(dir, "secretaria-2026-11-11.db"), criado: true, removidos: [] });
    expect(backupValido(primeiro.arquivo)).toBe(true);
    const copia = new Database(primeiro.arquivo, { readonly: true });
    expect(copia.query("SELECT titulo FROM tarefa").all()).toEqual([{ titulo: "Visitar" }]);
    copia.close();
    expect(backupDoDia(banco, dir, HOJE).criado).toBe(false);
    if (process.platform !== "win32") expect(statSync(primeiro.arquivo).mode & 0o777).toBe(0o600);
  });

  test("guarda os 7 mais novos e não toca no backup de migração", () => {
    const { banco, pasta } = preparar();
    const dir = join(pasta, "backups");
    for (const dia of dias(9)) backupDoDia(banco, dir, dia);
    writeFileSync(join(dir, "antes-de-nucleo-0002_tarefas.db"), "");
    const ultimo = backupDoDia(banco, dir, "2026-11-10" as Dia);
    expect(ultimo.removidos).toEqual(["secretaria-2026-11-03.db"]);
    expect(readdirSync(dir).sort()).toEqual([
      "antes-de-nucleo-0002_tarefas.db",
      ...["04", "05", "06", "07", "08", "09", "10"].map((d) => `secretaria-2026-11-${d}.db`),
    ]);
  });

  test("arquivo cortado não conta como backup: o do dia é refeito e o antigo sai sem tomar vaga", () => {
    const { banco, pasta } = preparar();
    const dir = join(pasta, "backups");
    for (const dia of dias(7)) backupDoDia(banco, dir, dia);
    const cortadoAntigo = join(dir, "secretaria-2026-11-07.db");
    truncateSync(cortadoAntigo, Math.floor(statSync(cortadoAntigo).size / 2));
    expect(backupValido(cortadoAntigo)).toBe(false);

    const hoje = backupDoDia(banco, dir, "2026-11-08" as Dia);
    truncateSync(hoje.arquivo, 4096 + 100);
    expect(backupValido(hoje.arquivo)).toBe(false);
    const refeito = backupDoDia(banco, dir, "2026-11-08" as Dia);
    expect(refeito.criado).toBe(true);
    expect(backupValido(refeito.arquivo)).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(["01", "02", "03", "04", "05", "06", "08"].map((d) => `secretaria-2026-11-${d}.db`));
  });

  test("sobra .tmp de uma cópia que caiu é apagada e não impede a próxima", () => {
    const { banco, pasta } = preparar();
    const dir = join(pasta, "backups");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "secretaria-2026-11-11.db.tmp"), "cópia pela metade");
    writeFileSync(join(dir, "secretaria-2026-11-10.db.tmp"), "outra");
    const resultado = backupDoDia(banco, dir, HOJE);
    expect(resultado.criado).toBe(true);
    expect(readdirSync(dir)).toEqual(["secretaria-2026-11-11.db"]);
  });

  test("texto com o cabeçalho certo mas tamanho errado não é backup", () => {
    const { banco, pasta } = preparar();
    const dir = join(pasta, "backups");
    const { arquivo } = backupDoDia(banco, dir, HOJE);
    appendFileSync(arquivo, Buffer.alloc(10));
    expect(backupValido(arquivo)).toBe(false);
    expect(backupValido(join(pasta, "nao-existe.db"))).toBe(false);
  });
});

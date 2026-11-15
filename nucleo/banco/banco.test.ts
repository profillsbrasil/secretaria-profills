import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONECTORES_UNICOS, textoExterno, type EstadoDuravel, type IdConectorUnico, type Instante, type Telefone } from "../dominio";
import {
  BancoEmUso,
  MigracaoRecusada,
  PASTA_DO_NUCLEO,
  abrirBanco,
  garantirInstalacao,
  gravarConector,
  historico,
  lerConector,
  lerMigracoes,
  migrar,
  prepararBanco,
  type BancoAberto,
} from "./index";

const AGORA = "2026-11-11T12:00:00.000Z" as Instante;
const pastas: string[] = [];
const abertos: BancoAberto[] = [];

function pastaTemporaria(): string {
  const pasta = mkdtempSync(join(tmpdir(), "secretaria-banco-"));
  pastas.push(pasta);
  return pasta;
}

function preparar(pasta: string, pastaDoVendedor = join(pasta, "meu")): BancoAberto {
  const banco = prepararBanco({ caminho: join(pasta, "secretaria.db"), caminhoDoVendedor: join(pasta, "meu.db"), dirBackups: join(pasta, "backups"), pastaDoVendedor, agora: AGORA });
  abertos.push(banco);
  return banco;
}

function migracaoDoVendedor(pasta: string, nome: string, sql: string): string {
  const dir = join(pasta, "meu");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, nome), sql);
  return dir;
}

afterEach(() => {
  for (const banco of abertos.splice(0)) banco.fechar();
  for (const pasta of pastas.splice(0)) rmSync(pasta, { recursive: true, force: true });
});

describe("migrações", () => {
  test("rodar duas vezes aplica cada migração uma vez só", () => {
    const pasta = pastaTemporaria();
    preparar(pasta).fechar();
    abertos.pop();
    const banco = preparar(pasta);
    const linhas = banco.sqlite.query<{ tag: string }, []>("SELECT tag FROM __migracoes_nucleo ORDER BY tag").all();
    expect(linhas.map(({ tag }) => tag)).toEqual([
      "0000_fundacao",
      "0001_sementes",
      "0002_tarefas",
      "0003_nota_so_insercao",
      "0004_email_contas",
      "0005_email_conta_unica",
      "0006_crm_cache",
      "0007_item_ignorado",
      "0008_quem_ignorou",
      "0009_vinculo_de_conversa",
      "0010_cabecalho_de_email",
      "0011_fila_de_aprovacao",
      "0012_decisao_so_insercao",
      "0013_nome_de_quem_usa",
    ]);
    expect(banco.sqlite.query("SELECT id FROM conector ORDER BY id").all()).toEqual(
      [...CONECTORES_UNICOS].sort().map((id) => ({ id })),
    );
  });

  test("banco novo não ganha backup e migração pendente num banco existente ganha", () => {
    const pasta = pastaTemporaria();
    const nucleo = join(pasta, "nucleo-migracoes");
    cpSync(PASTA_DO_NUCLEO, nucleo, { recursive: true });
    const banco = abrirBanco(join(pasta, "secretaria.db"));
    abertos.push(banco);
    const opcoes = { trilha: "nucleo" as const, pasta: nucleo, dirBackups: join(pasta, "backups"), agora: AGORA };
    expect(migrar(banco.sqlite, opcoes).backup).toBeNull();

    writeFileSync(join(nucleo, "0002_extra.sql"), "CREATE TABLE extra (x INTEGER);");
    const resultado = migrar(banco.sqlite, opcoes);
    expect(resultado.aplicadas).toEqual(["0002_extra"]);
    expect(resultado.backup).toBe(join(pasta, "backups", "antes-de-nucleo-0002_extra.db"));
    const copia = new Database(resultado.backup as string, { readonly: true });
    expect(copia.query("SELECT name FROM sqlite_master WHERE name = 'extra'").get()).toBeNull();
    expect(copia.query("SELECT count(*) AS n FROM conector").get()).toEqual({ n: 2 });
    copia.close();
  });

  test("o backup é escrito num .tmp e só ganha o nome final depois de pronto", () => {
    const pasta = pastaTemporaria();
    const nucleo = join(pasta, "nucleo-migracoes");
    cpSync(PASTA_DO_NUCLEO, nucleo, { recursive: true });
    const banco = abrirBanco(join(pasta, "secretaria.db"));
    abertos.push(banco);
    const opcoes = { trilha: "nucleo" as const, pasta: nucleo, dirBackups: join(pasta, "backups"), agora: AGORA };
    migrar(banco.sqlite, opcoes);
    writeFileSync(join(nucleo, "0002_extra.sql"), "CREATE TABLE extra (x INTEGER);");
    const final = join(pasta, "backups", "antes-de-nucleo-0002_extra.db");
    // Sobra de uma cópia que caiu no meio: não é um backup e não pode impedir o próximo.
    mkdirSync(join(pasta, "backups"), { recursive: true });
    writeFileSync(`${final}.tmp`, "cópia pela metade");

    const destinos: { readonly destino: unknown; readonly finalJaExistia: boolean }[] = [];
    const espiao = new Proxy(banco.sqlite, {
      get(alvo, nome) {
        if (nome === "run") {
          return (sql: string, parametros?: unknown[]) => {
            if (sql.startsWith("VACUUM INTO")) destinos.push({ destino: parametros?.[0], finalJaExistia: existsSync(final) });
            return parametros === undefined ? alvo.run(sql) : alvo.run(sql, parametros as never);
          };
        }
        const valor: unknown = Reflect.get(alvo, nome, alvo);
        return typeof valor === "function" ? valor.bind(alvo) : valor;
      },
    });

    expect(migrar(espiao, opcoes).backup).toBe(final);
    expect(destinos).toEqual([{ destino: `${final}.tmp`, finalJaExistia: false }]);
    expect(existsSync(`${final}.tmp`)).toBe(false);
    const copia = new Database(final, { readonly: true });
    expect(copia.query("SELECT count(*) AS n FROM conector").get()).toEqual({ n: 2 });
    copia.close();
  });

  test("migração aplicada cujo arquivo mudou é recusada", () => {
    const pasta = pastaTemporaria();
    const meu = migracaoDoVendedor(pasta, "0000_visitas.sql", "CREATE TABLE meu_visitas (id INTEGER PRIMARY KEY);");
    preparar(pasta, meu).fechar();
    abertos.pop();
    writeFileSync(join(meu, "0000_visitas.sql"), "CREATE TABLE meu_visitas (id INTEGER PRIMARY KEY, nome TEXT);");
    expect(() => preparar(pasta, meu)).toThrow(MigracaoRecusada);
  });

  test("o mesmo arquivo com fim de linha do Windows não conta como migração mudada", () => {
    const pasta = pastaTemporaria();
    const sql = "CREATE TABLE visitas (\n  id INTEGER PRIMARY KEY\n);\n";
    const meu = migracaoDoVendedor(pasta, "0000_visitas.sql", sql);
    preparar(pasta, meu).fechar();
    abertos.pop();
    writeFileSync(join(meu, "0000_visitas.sql"), sql.replaceAll("\n", "\r\n"));
    expect(lerMigracoes(meu).map(({ sha256 }) => sha256)).toEqual([new Bun.CryptoHasher("sha256").update(sql).digest("hex")]);
    expect(() => preparar(pasta, meu)).not.toThrow();
  });

  test("a trilha do vendedor cria as tabelas dele em meu.db, com a própria tabela de controle", () => {
    const pasta = pastaTemporaria();
    const meu = migracaoDoVendedor(
      pasta,
      "0000_visitas.sql",
      "CREATE TABLE visitas (id INTEGER PRIMARY KEY, cliente TEXT); CREATE INDEX visitas_cliente ON visitas (cliente);",
    );
    const banco = preparar(pasta, meu);
    const noNucleo = banco.sqlite.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE name LIKE '%visitas%'").all();
    expect(noNucleo).toEqual([]);
    const doVendedor = new Database(join(pasta, "meu.db"), { readonly: true });
    expect(doVendedor.query("SELECT tag FROM __migracoes_meu").all()).toEqual([{ tag: "0000_visitas" }]);
    expect(doVendedor.query("SELECT name FROM sqlite_master WHERE name LIKE 'visitas%' ORDER BY name").all()).toEqual([
      { name: "visitas" },
      { name: "visitas_cliente" },
    ]);
    doVendedor.close();
  });

  test("sem migração do vendedor, meu.db não é criado", () => {
    const pasta = pastaTemporaria();
    preparar(pasta);
    expect(existsSync(join(pasta, "meu.db"))).toBe(false);
  });

  test.each([
    ["dado do núcleo, seguido de uma tabela boa", "UPDATE conector SET identidade = 'trocada' WHERE id = 'whatsapp'; CREATE TABLE meu_a (x);"],
    ["tabela do núcleo", "ALTER TABLE conector ADD COLUMN apelido TEXT;"],
    ["índice numa tabela do núcleo", "CREATE INDEX meu_por_fase ON conector (fase);"],
    ["o arquivo do núcleo por ATTACH", "ATTACH DATABASE '$NUCLEO' AS n; UPDATE n.conector SET identidade = 'trocada';"],
    ["o arquivo do núcleo por ATTACH fora da transação", "COMMIT; ATTACH DATABASE '$NUCLEO' AS n; UPDATE n.conector SET identidade = 'trocada'; BEGIN;"],
    ["outro arquivo por attach em minúsculas", "CREATE TABLE meu_a (x); attach database '$OUTRO' as o; CREATE TABLE o.t (x);"],
  ])("a migração do vendedor não alcança %s", (_nome, sql) => {
    const pasta = pastaTemporaria();
    const outro = join(pasta, "outro.db");
    const meu = migracaoDoVendedor(pasta, "0000_vendedor.sql", sql.replace("$NUCLEO", join(pasta, "secretaria.db")).replace("$OUTRO", outro));
    expect(() => preparar(pasta, meu)).toThrow(MigracaoRecusada);
    expect(existsSync(outro)).toBe(false);

    const banco = abrirBanco(join(pasta, "secretaria.db"));
    abertos.push(banco);
    expect(banco.sqlite.query("SELECT id, identidade FROM conector ORDER BY id").all()).toEqual(
      [...CONECTORES_UNICOS].sort().map((id) => ({ id, identidade: null })),
    );
    expect(banco.sqlite.query<{ name: string }, []>("PRAGMA table_info(conector)").all().map((c) => c.name)).not.toContain("apelido");
    expect(banco.sqlite.query("SELECT name FROM sqlite_master WHERE name LIKE 'meu\\_%' ESCAPE '\\'").all()).toEqual([]);
    const doVendedor = new Database(join(pasta, "meu.db"), { readonly: true });
    expect(doVendedor.query("SELECT name FROM sqlite_master WHERE name = 'meu_a'").all()).toEqual([]);
    expect(doVendedor.query("SELECT count(*) AS n FROM __migracoes_meu").get()).toEqual({ n: 0 });
    doVendedor.close();
  });
});

describe("CHECKs da tabela conector", () => {
  const casos: readonly (readonly [string, string, boolean])[] = [
    ["fase transitória", "UPDATE conector SET fase = 'pareando' WHERE id = 'whatsapp'", false],
    ["atenção sem código", "UPDATE conector SET fase = 'atencao' WHERE id = 'crm'", false],
    ["código fora da atenção", "UPDATE conector SET codigo_problema = 'crm_inacessivel' WHERE id = 'crm'", false],
    ["WhatsApp conectado sem identidade", "UPDATE conector SET fase = 'conectado', verificado_em = 'v' WHERE id = 'whatsapp'", false],
    ["conectado sem verificação", "UPDATE conector SET fase = 'conectado', identidade = '+5511912345678' WHERE id = 'whatsapp'", false],
    ["CRM conectado sem prazo da conexão", "UPDATE conector SET fase = 'conectado', verificado_em = 'v' WHERE id = 'crm'", false],
    ["config que não é JSON", "UPDATE conector SET config = 'x' WHERE id = 'whatsapp'", false],
    ["quarto conector", "INSERT INTO conector (id, atualizado_em) VALUES ('telegram', 'x')", false],
    ["CRM conectado sem identidade", "UPDATE conector SET fase = 'conectado', verificado_em = 'v', conexao_expira_em = 'c' WHERE id = 'crm'", true],
    ["atenção com código", "UPDATE conector SET fase = 'atencao', codigo_problema = 'crm_inacessivel' WHERE id = 'crm'", true],
  ];

  test.each(casos)("%s", (_nome, sql, aceito) => {
    const banco = preparar(pastaTemporaria());
    if (aceito) expect(() => banco.sqlite.run(sql)).not.toThrow();
    else expect(() => banco.sqlite.run(sql)).toThrow(/CHECK constraint failed/);
  });

  test("evento de conector inexistente é recusado pela chave estrangeira", () => {
    const banco = preparar(pastaTemporaria());
    expect(() => banco.sqlite.run("INSERT INTO evento_conector (conector, tipo, em) VALUES ('telegram', 't', 'x')")).toThrow();
  });
});

describe("escritor único", () => {
  test("segundo processo que abre o banco recebe BancoEmUso", () => {
    const pasta = pastaTemporaria();
    const caminho = join(pasta, "secretaria.db");
    const primeiro = abrirBanco(caminho);
    const filho = Bun.spawnSync([
      process.execPath,
      "-e",
      `import { abrirBanco } from ${JSON.stringify(join(import.meta.dir, "abrir.ts"))};
       try { abrirBanco(${JSON.stringify(caminho)}); console.log("abriu"); } catch (e) { console.log(e.name); }`,
    ]);
    primeiro.fechar();
    expect(filho.stdout.toString().trim()).toBe("BancoEmUso");
    expect(() => abrirBanco(caminho).fechar()).not.toThrow();
  });

  test("segunda conexão no mesmo processo também é recusada", () => {
    const pasta = pastaTemporaria();
    const caminho = join(pasta, "secretaria.db");
    abertos.push(abrirBanco(caminho));
    expect(() => abrirBanco(caminho)).toThrow(BancoEmUso);
  });
});

describe("estado durável dos conectores", () => {
  const casos: readonly (readonly [IdConectorUnico, EstadoDuravel<IdConectorUnico>])[] = [
    [
      "whatsapp",
      {
        fase: "conectado",
        conta: { telefone: "+5511912345678" as Telefone },
        verificadoEm: AGORA,
        espelho: "parado",
        ultimaAtividade: null,
      },
    ],
    [
      "whatsapp",
      {
        fase: "atencao",
        problema: { codigo: "whatsapp_espelho_caindo", desde: AGORA },
        conta: { telefone: "+5511912345678" as Telefone },
      },
    ],
    ["crm", { fase: "conectado", conexaoExpiraEm: "2027-02-09T12:00:00.000Z" as Instante, verificadoEm: AGORA, ferramentas: null }],
    ["crm", { fase: "atencao", problema: { codigo: "crm_app_nao_liberado", desde: AGORA } }],
  ];

  test.each(casos.map(([id, estado]) => [`${id} ${estado.fase}`, id, estado] as const))(
    "%s sobrevive a gravar, fechar e abrir",
    (_nome, id, estado) => {
      const pasta = pastaTemporaria();
      gravarConector(preparar(pasta), id, estado, "teste", AGORA);
      abertos.pop()?.fechar();
      expect(lerConector(preparar(pasta), id)).toEqual(estado);
    },
  );

  test("a trilha registra o problema com o detalhe e guarda só as 500 mais novas", () => {
    const banco = preparar(pastaTemporaria());
    const estado: EstadoDuravel<"crm"> = {
      fase: "atencao",
      problema: { codigo: "crm_inacessivel", desde: AGORA, detalhe: textoExterno("ECONNREFUSED") },
    };
    // A trilha antiga entra numa transação só: cada `gravarConector` é um commit com fsync, lento no disco do runner do Windows.
    const antiga = banco.sqlite.prepare("INSERT INTO evento_conector (conector, tipo, detalhe, em) VALUES ('crm', 'desconectado', '{}', ?) RETURNING id");
    const ids = banco.sqlite.transaction(() => Array.from({ length: 508 }, () => (antiga.get(AGORA) as { id: number }).id))();
    gravarConector(banco, "crm", estado, "autorizacao_recusada", AGORA);
    gravarConector(banco, "crm", estado, "autorizacao_recusada", AGORA);
    gravarConector(banco, "whatsapp", { fase: "desconectado" }, "pedido_desconectar", AGORA);
    expect(banco.sqlite.query("SELECT count(*) AS n FROM evento_conector WHERE conector = 'crm'").get()).toEqual({ n: 500 });
    const restantes = (banco.sqlite.query("SELECT id FROM evento_conector WHERE conector = 'crm' ORDER BY id").all() as { id: number }[]).map((linha) => linha.id);
    expect(restantes.slice(0, 498)).toEqual(ids.slice(10));
    const [ultimo] = historico(banco, "crm", 1);
    expect(ultimo).toMatchObject({ tipo: "crm_inacessivel", detalhe: { causa: "autorizacao_recusada", detalhe: "ECONNREFUSED" } });
    expect(historico(banco, "whatsapp", 10)).toHaveLength(1);
  });

  test("linha que não forma estado válido é lida como desconectado", () => {
    const banco = preparar(pastaTemporaria());
    banco.sqlite.run("UPDATE conector SET fase = 'atencao', codigo_problema = 'email_senha_recusada' WHERE id = 'crm'");
    expect(lerConector(banco, "crm")).toEqual({ fase: "desconectado" });
  });
});

describe("instalação", () => {
  test("a linha única é criada uma vez e mantém o id", () => {
    const pasta = pastaTemporaria();
    const primeira = garantirInstalacao(preparar(pasta), AGORA, () => "id-1");
    abertos.pop()?.fechar();
    const segunda = garantirInstalacao(preparar(pasta), AGORA, () => "id-2");
    expect(primeira).toEqual({ id: "id-1", criadaEm: AGORA, cofreBackend: null });
    expect(segunda).toEqual(primeira);
    expect(existsSync(join(pasta, "backups"))).toBe(false);
  });
});

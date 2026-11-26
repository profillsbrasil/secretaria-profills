import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { textoExterno, type Instante } from "../dominio";
import { abrirBanco, garantirInstalacao, gravarConector, gravarNomeDigitado, gravarNomeNoCrm, lerNomesGuardados, marcarNomePerguntado, migrar, PASTA_DO_NUCLEO, type BancoAberto } from "./index";

const T0 = "2026-11-14T12:00:00.000Z" as Instante;
const T1 = "2026-11-14T13:00:00.000Z" as Instante;
const pastas: string[] = [];
const abertos: BancoAberto[] = [];

afterEach(() => {
  for (const banco of abertos.splice(0)) banco.fechar();
  for (const pasta of pastas.splice(0)) rmSync(pasta, { recursive: true, force: true });
});

function bancoNovo(): BancoAberto {
  const pasta = mkdtempSync(join(tmpdir(), "secretaria-quem-usa-"));
  pastas.push(pasta);
  const banco = abrirBanco(join(pasta, "secretaria.db"));
  abertos.push(banco);
  migrar(banco.sqlite, { trilha: "nucleo", dirBackups: join(pasta, "backups"), agora: T0, pasta: PASTA_DO_NUCLEO });
  garantirInstalacao(banco, T0);
  return banco;
}

describe("nome de quem usa no banco", () => {
  test("a 0013 aplica sobre uma base na 0012 e deixa os nomes vazios, sem tocar na instalação", () => {
    const pasta = mkdtempSync(join(tmpdir(), "secretaria-migracao-quem-usa-"));
    pastas.push(pasta);
    const antigas = join(pasta, "ate-0012");
    mkdirSync(antigas);
    for (const nome of readdirSync(PASTA_DO_NUCLEO).filter((nome) => nome.endsWith(".sql") && nome < "0013")) copyFileSync(join(PASTA_DO_NUCLEO, nome), join(antigas, nome));
    const banco = abrirBanco(join(pasta, "secretaria.db"));
    abertos.push(banco);
    const comum = { trilha: "nucleo", dirBackups: join(pasta, "backups"), agora: T0 } as const;
    migrar(banco.sqlite, { ...comum, pasta: antigas });
    banco.sqlite.run(`INSERT INTO instalacao (id, id_instalacao, criada_em) VALUES (1, 'base-antiga', '${T0}')`);

    expect(migrar(banco.sqlite, { ...comum, pasta: PASTA_DO_NUCLEO }).aplicadas).toEqual(["0013_nome_de_quem_usa", "0014_conferencia_de_versao", "0015_conversa_da_tarefa", "0016_conversa_da_tarefa_fixa"]);
    expect(garantirInstalacao(banco, T1).id).toBe("base-antiga");
    expect(lerNomesGuardados(banco)).toEqual({ digitado: null, perguntadoEm: null, doCrm: null, doCrmLidoEm: null });
  });

  test("o digitado guarda a primeira resposta; Agora não depois dele não a muda", () => {
    const banco = bancoNovo();
    marcarNomePerguntado(banco, T0);
    gravarNomeDigitado(banco, "Mari", T1);
    marcarNomePerguntado(banco, T1);
    expect(lerNomesGuardados(banco)).toMatchObject({ digitado: "Mari", perguntadoEm: T0 });
  });

  test("leitura sem nome mantém o nome do CRM, e o CRM desconectado o apaga", () => {
    const banco = bancoNovo();
    gravarNomeNoCrm(banco, textoExterno("Marina Costa"), T0);
    gravarNomeNoCrm(banco, null, T1);
    expect(lerNomesGuardados(banco)).toMatchObject({ doCrm: "Marina Costa", doCrmLidoEm: T1 });

    gravarConector(banco, "crm", { fase: "atencao", problema: { codigo: "crm_conexao_vencida", desde: T1 } }, "teste", T1);
    expect(lerNomesGuardados(banco).doCrm).toBe(textoExterno("Marina Costa"));
    gravarConector(banco, "crm", { fase: "desconectado" }, "teste", T1);
    expect(lerNomesGuardados(banco)).toMatchObject({ doCrm: null, doCrmLidoEm: null });
  });
});

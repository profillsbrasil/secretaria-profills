import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { caminhosDosDados } from "../../nucleo/ambiente";
import { montarPacote } from "../../nucleo/atualizacao";
import { caminhosDoAtualizador, efeitosReais, unidadeDaTroca } from "../../nucleo/atualizador";
import { horaDeInicio } from "../../nucleo/processos";

const REPO = join(import.meta.dir, "..", "..");

describe("o atualizador roda sozinho", () => {
  test("o main.ts só importa do Bun e do node:", () => {
    const fonte = readFileSync(join(REPO, "nucleo", "atualizador", "main.ts"), "utf8");
    const imports = [...fonte.matchAll(/\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\bimport\s*["']([^"']+)["']|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)].map(
      (casamento) => casamento[1] ?? casamento[2] ?? casamento[3] ?? casamento[4] ?? "",
    );
    expect(imports.length).toBeGreaterThan(2);
    expect(imports.filter((alvo) => !alvo.startsWith("node:") && !alvo.startsWith("bun:"))).toEqual([]);
  });

  test("o entrada.ts só importa do Bun e do node:, e o CLI só depois de recompor a pasta", () => {
    const fonte = readFileSync(join(REPO, "entrada.ts"), "utf8");
    const estaticos = [...fonte.matchAll(/^import\s[^;]*?from\s*["']([^"']+)["']/gm)].map((casamento) => casamento[1] ?? "");
    expect(estaticos.length).toBeGreaterThan(1);
    expect(estaticos.filter((alvo) => !alvo.startsWith("node:") && !alvo.startsWith("bun:"))).toEqual([]);
    expect((JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts.secretaria).toBe("bun entrada.ts");
    expect(unidadeDaTroca("entrada.ts")).toBe("entrada.ts");
  });

  test("a lista de troca do atualizador é a do pacote, arquivo por arquivo do repo", () => {
    const git = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: REPO });
    const versionados = git.stdout.toString().split("\0").filter((caminho) => caminho !== "");
    expect(versionados.length).toBeGreaterThan(100);
    const { lista } = montarPacote({ raiz: REPO, caminhos: versionados, versao: "9.9.9" });
    const noPacote = new Set(lista.arquivos.map(({ caminho }) => caminho));
    expect(versionados.filter((caminho) => noPacote.has(caminho) !== (unidadeDaTroca(caminho) !== null))).toEqual([]);
  });

  test("os caminhos da pasta de dados são os mesmos que o núcleo usa", () => {
    const dirDados = join(REPO, "..", "dados-de-conferencia");
    const doNucleo = caminhosDosDados({ dirDados, plataforma: process.platform });
    const doAtualizador = caminhosDoAtualizador(REPO, dirDados);
    expect({ banco: doAtualizador.banco, bancoDoVendedor: doAtualizador.bancoDoVendedor, wacli: doAtualizador.wacli, servidor: doAtualizador.servidor }).toEqual({
      banco: doNucleo.banco,
      bancoDoVendedor: doNucleo.bancoDoVendedor,
      wacli: doNucleo.wacli,
      servidor: doNucleo.servidor,
    });
    expect(doAtualizador.saidaDoServidor).toBe(join(doNucleo.logs, "servidor-saida.log"));
  });

  test("a hora de início de um processo é a mesma que o núcleo lê", () => {
    const doNucleo = horaDeInicio(process.pid);
    expect(doNucleo).not.toBeNull();
    expect(efeitosReais().inicioDoProcesso(process.pid)).toBe(doNucleo);
  });
});

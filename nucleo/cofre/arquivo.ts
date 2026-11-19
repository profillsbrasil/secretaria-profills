import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { trocarPorRename } from "../atualizador";
import { ehChaveDoCofre, type ChaveDoCofre, type Cofre } from "./contrato";
import { Segredo } from "./segredo";

interface Conteudo {
  readonly v: 1;
  readonly valores: Partial<Record<ChaveDoCofre, string>>;
}

const formato: z.ZodType<Conteudo> = z.object({
  v: z.literal(1),
  valores: z.record(z.string(), z.string()).refine((valores) => Object.keys(valores).every(ehChaveDoCofre)),
});

/**
 * Backend para máquina sem chaveiro do sistema. Grava `<dados>/cofre.json` com modo 0600
 * por arquivo temporário e `rename`, então uma queda no meio não deixa o cofre pela metade.
 * As operações são síncronas: dentro do único processo dono, uma leitura e uma escrita
 * nunca se intercalam com outra.
 */
export function cofreEmArquivo(dirDados: string): Cofre {
  const caminho = join(dirDados, "cofre.json");

  function ler(): Conteudo {
    let texto: string;
    try {
      texto = readFileSync(caminho, "utf8");
    } catch (erro) {
      if ((erro as NodeJS.ErrnoException).code === "ENOENT") return { v: 1, valores: {} };
      throw erro;
    }
    // Arquivo ilegível não é tratado como vazio: gravar por cima apagaria segredos.
    return formato.parse(JSON.parse(texto));
  }

  function escrever(conteudo: Conteudo): void {
    mkdirSync(dirname(caminho), { recursive: true });
    const temporario = `${caminho}.${process.pid}.tmp`;
    writeFileSync(temporario, JSON.stringify(conteudo), { mode: 0o600 });
    trocarPorRename(temporario, caminho);
  }

  return {
    backend: "arquivo",
    async ler(chave: ChaveDoCofre) {
      const valor = ler().valores[chave];
      return valor === undefined ? null : Segredo.de(valor);
    },
    async gravar(chave: ChaveDoCofre, valor: Segredo) {
      const atual = ler();
      escrever({ v: 1, valores: { ...atual.valores, [chave]: valor.revelar() } });
    },
    async apagar(chave: ChaveDoCofre) {
      const atual = ler();
      if (atual.valores[chave] === undefined) return;
      const { [chave]: _removido, ...resto } = atual.valores;
      if (Object.keys(resto).length === 0) {
        rmSync(caminho, { force: true });
        return;
      }
      escrever({ v: 1, valores: resto });
    },
  };
}

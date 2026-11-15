/**
 * Por onde o `bun secretaria` começa. Fica fora de `nucleo/` e só importa do Bun e do `node:`: uma
 * atualização que morreu no meio da troca pode deixar `nucleo/` ou `node_modules/` fora do lugar, e
 * aí o CLI nem carrega. Antes dele, a cópia do atualizador guardada em `.atualizacao/` põe as pastas
 * de volta.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

type Parada = { readonly tipo: "em_andamento" } | { readonly tipo: "falhou"; readonly detalhe: string };
type Recomposicao = { readonly tipo: "nada" } | { readonly tipo: "recomposta" } | Parada;

const atualizacao = path.join(import.meta.dir, ".atualizacao");
const guardado = path.join(atualizacao, "atualizador.ts");
let recomposicao: Recomposicao = { tipo: "nada" };
if (existsSync(path.join(atualizacao, "andamento.json")) && existsSync(guardado)) {
  const { recomporArvore } = (await import(pathToFileURL(guardado).href)) as { recomporArvore(raizDoRepo: string): Promise<Recomposicao> };
  recomposicao = await recomporArvore(import.meta.dir);
  if (recomposicao.tipo === "recomposta") {
    // O Bun guarda o que viu da pasta ao começar: um `node_modules/` que voltou agora só é achado por um processo novo.
    const cli = spawnSync(process.execPath, [path.join(import.meta.dir, "nucleo", "cli", "main.ts"), ...process.argv.slice(2)], { stdio: "inherit", windowsHide: true });
    process.exit(cli.status ?? 1);
  }
}

/**
 * A pasta não foi recomposta e o CLI não carregou: a resposta sai daqui, no formato do CLI. Os
 * textos de `atualizacao_em_andamento` são os de `nucleo/dominio/erros.ts`, que este arquivo não
 * pode importar: `testes/fluxos/atualizador.test.ts` cobra que sejam iguais.
 */
function recusar(parada: Parada): never {
  const erro =
    parada.tipo === "em_andamento"
      ? {
          codigo: "atualizacao_em_andamento",
          mensagem: "A Secretária está se atualizando.",
          acao: "Espere um minuto e rode `bun secretaria abrir` de novo. Não rode `parar --forcar` nem mexa na pasta enquanto isso.",
        }
      : {
          codigo: "interno",
          mensagem: `Uma atualização da Secretária parou no meio e não deu para devolver a pasta ao lugar: ${parada.detalhe}`,
          acao: "Rode `bun secretaria abrir` de novo. Se repetir, peça ao vendedor para reiniciar o computador e rode `bun secretaria abrir` depois.",
        };
  if (process.argv.includes("--json")) console.log(JSON.stringify({ v: 1, ok: false, erro }));
  else console.error(`${erro.mensagem}\n${erro.acao}`);
  process.exit(1);
}

const carregarCli = () => import("./nucleo/cli/main.ts");
let cli: Awaited<ReturnType<typeof carregarCli>>;
try {
  cli = await carregarCli();
} catch (erro) {
  if (recomposicao.tipo !== "em_andamento" && recomposicao.tipo !== "falhou") throw erro;
  recusar(recomposicao);
}
process.exit(await cli.principal(process.argv.slice(2)));

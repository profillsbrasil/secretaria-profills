/**
 * O CLI de uma instalação mínima (`instalacao-minima.ts`): `instalar --json`, `servidor --json` e
 * `abrir --sem-navegador --json`. O `nucleo/cli/main.ts` da instalação chama `principal` com a raiz
 * dela. O servidor abre o banco como único dono, aplica as migrações do código que está na raiz,
 * anuncia o `servidor.json` e responde a versão do `package.json` em `/api/info`. O `abrir` é o de
 * verdade, apontado para a instalação.
 *
 * Arquivos na raiz da instalação mudam o comportamento: `instalar-falha`, `servidor-mudo`,
 * `instalar-espera` (com `antes` ou `com-o-banco`: o `instalar` anuncia o pid em
 * `<dados>/instalar-comecou` e para, antes de abrir o banco ou com ele na mão, até existir
 * `<dados>/instalar-siga`), `instalar-com-neto` (o `instalar` sobe um processo, anuncia o pid dele
 * em `<dados>/neto` e não termina) e `servidor-espera` (o servidor anuncia o pid em
 * `<dados>/servidor-comecou` e só abre o banco quando existir `<dados>/servidor-siga`).
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { migrarInstalacao } from "./instalacao-minima";

/** Um servidor esquecido por um teste que falhou no meio não fica vivo no CI. */
const VIDA_MAXIMA_MS = 120_000;

const INTERVALO_DA_ESPERA_MS = 20;

function escrever(envelope: unknown): void {
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

function lerMarca(raiz: string, nome: string): string | null {
  try {
    return readFileSync(path.join(raiz, nome), "utf8");
  } catch {
    return null;
  }
}

/** Diz ao teste, na pasta de dados, o pid de um processo que chegou a um ponto. O arquivo só aparece inteiro. */
function anunciar(dirDados: string, nome: string, pid: number): void {
  const arquivo = path.join(dirDados, nome);
  writeFileSync(`${arquivo}.tmp`, String(pid));
  renameSync(`${arquivo}.tmp`, arquivo);
}

/** Para o processo num ponto até o teste criar o arquivo. Sem o arquivo, o processo sai sozinho no fim da vida máxima. */
async function esperarArquivo(caminho: string): Promise<void> {
  const fim = Date.now() + VIDA_MAXIMA_MS;
  while (!existsSync(caminho)) {
    if (Date.now() >= fim) process.exit(0);
    await Bun.sleep(INTERVALO_DA_ESPERA_MS);
  }
}

async function abrir(raiz: string, dirDados: string): Promise<number> {
  const [{ resolverAmbiente }, { COMANDOS }] = await Promise.all([import("../../nucleo/ambiente"), import("../../nucleo/cli/comandos")]);
  const comando = COMANDOS.find((candidato) => candidato.nome === "abrir");
  if (comando === undefined) throw new Error("o comando abrir sumiu");
  const resultado = await comando.executar(
    { semNavegador: true },
    {
      ambiente: () => resolverAmbiente({ plataforma: process.platform, env: { SECRETARIA_DADOS: dirDados }, home: dirDados }, raiz),
      raizDoRepo: raiz,
      subida: { argv: [process.execPath, path.join(raiz, "nucleo", "cli", "main.ts"), "servidor", "--json", "--dados", dirDados], prazoMs: 20_000 },
      manterVivo: () => {},
    },
    null,
  );
  escrever(resultado);
  return resultado.ok ? 0 : 1;
}

export async function principal(raiz: string, argumentos: readonly string[]): Promise<number> {
  const indiceDosDados = argumentos.indexOf("--dados");
  const dirDados = indiceDosDados === -1 ? (process.env.SECRETARIA_DADOS ?? "") : (argumentos[indiceDosDados + 1] ?? "");
  const versao = (JSON.parse(readFileSync(path.join(raiz, "package.json"), "utf8")) as { version: string }).version;
  const sairComErro = (codigo: string, mensagem: string) => {
    escrever({ v: 1, ok: false, erro: { codigo, mensagem, acao: "" } });
    return 1;
  };
  const abrirBanco = () => {
    try {
      return migrarInstalacao(raiz, dirDados);
    } catch (erro) {
      return erro instanceof Error ? erro.message : String(erro);
    }
  };

  if (argumentos[0] === "abrir") return abrir(raiz, dirDados);

  if (argumentos[0] === "instalar") {
    const espera = lerMarca(raiz, "instalar-espera");
    if (existsSync(path.join(raiz, "instalar-com-neto"))) {
      const neto = Bun.spawn([process.execPath, "-e", `setTimeout(() => {}, ${VIDA_MAXIMA_MS})`], { stdio: ["ignore", "ignore", "ignore"] });
      anunciar(dirDados, "neto", neto.pid);
      await esperarArquivo(path.join(dirDados, "nunca"));
    }
    if (espera === "antes") {
      anunciar(dirDados, "instalar-comecou", process.pid);
      await esperarArquivo(path.join(dirDados, "instalar-siga"));
    }
    const banco = abrirBanco();
    if (typeof banco === "string") return sairComErro("interno", banco);
    if (espera === "com-o-banco") {
      anunciar(dirDados, "instalar-comecou", process.pid);
      await esperarArquivo(path.join(dirDados, "instalar-siga"));
    }
    banco.close(true);
    // A migração já rodou quando o passo seguinte falha: é o pior caso para a volta.
    if (existsSync(path.join(raiz, "instalar-falha"))) return sairComErro("instalacao_incompleta", "Passos pendentes: saude.");
    escrever({ v: 1, ok: true, dados: { pronto: true, passos: [] } });
    return 0;
  }

  if (argumentos[0] === "servidor") {
    if (existsSync(path.join(raiz, "servidor-espera"))) {
      anunciar(dirDados, "servidor-comecou", process.pid);
      await esperarArquivo(path.join(dirDados, "servidor-siga"));
    }
    const banco = abrirBanco();
    if (typeof banco === "string") return sairComErro("interno", banco);
    setInterval(() => banco.filename, 60_000);
    setTimeout(() => process.exit(0), VIDA_MAXIMA_MS);
    if (!existsSync(path.join(raiz, "servidor-mudo"))) {
      const idInstalacao = "instalacao-minima";
      const servidor = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (pedido) =>
          new URL(pedido.url).pathname === "/api/info"
            ? Response.json({ v: 1, ok: true, dados: { app: "secretaria-profills", versaoNucleo: versao, idInstalacao } })
            : new Response("não existe", { status: 404 }),
      });
      const arquivo = path.join(dirDados, "servidor.json");
      writeFileSync(`${arquivo}.tmp`, JSON.stringify({ v: 1, origem: `http://127.0.0.1:${servidor.port}`, pid: process.pid, idInstalacao, token: "x".repeat(32) }));
      renameSync(`${arquivo}.tmp`, arquivo);
      escrever({ v: 1, ok: true, dados: { origem: `http://127.0.0.1:${servidor.port}`, pid: process.pid } });
    }
    return new Promise<number>(() => {});
  }

  return sairComErro("uso_invalido", `a instalação mínima não tem ${argumentos[0] ?? "comando"}`);
}

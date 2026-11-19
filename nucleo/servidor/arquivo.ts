import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { trocarPorRename } from "../atualizador";
import { horaDeInicio, vivo } from "../processos";

/** `<dados>/servidor.json`: como o CLI acha o servidor no ar. Novo a cada boot, apagado no `parar`. */
const formato = z.object({
  v: z.literal(1),
  origem: z.string().regex(/^http:\/\/127\.0\.0\.1:\d+$/),
  pid: z.number().int().positive(),
  idInstalacao: z.string().min(1),
  /** Bearer do agente nesta execução do servidor. */
  token: z.string().min(32),
});

export type ArquivoDoServidor = z.infer<typeof formato>;

/** Ausente, ilegível ou de outro formato: `null`. Quem chama trata como servidor parado. */
export function lerArquivoDoServidor(caminho: string): ArquivoDoServidor | null {
  try {
    return formato.parse(JSON.parse(readFileSync(caminho, "utf8")));
  } catch {
    return null;
  }
}

export function gravarArquivoDoServidor(caminho: string, conteudo: ArquivoDoServidor): void {
  const temporario = `${caminho}.${process.pid}.tmp`;
  writeFileSync(temporario, JSON.stringify(conteudo), { mode: 0o600 });
  trocarPorRename(temporario, caminho);
}

/** Só apaga o arquivo que este servidor gravou: um servidor novo pode já ter escrito o dele. */
export function apagarArquivoDoServidor(caminho: string, token: string): void {
  if (lerArquivoDoServidor(caminho)?.token === token) rmSync(caminho, { force: true });
}

/**
 * `<dados>/servidor.pid`: o pid do servidor e a hora de início dele, desde antes de ele abrir o banco.
 * Um servidor que trava antes de gravar o `servidor.json` segura o banco, e é por este arquivo que
 * `parar --forcar` o acha. A hora separa o servidor de outro processo que recebeu o mesmo pid.
 */
const formatoDoPid = z.object({ v: z.literal(1), pid: z.number().int().positive(), inicio: z.string().min(1).nullable() });

/**
 * O que o `servidor.pid` aponta agora. `outro`: o pid vive, mas a hora dele não é a anotada, ou o
 * arquivo não tem hora (formato antigo, ou o sistema não a deu na gravação). `incerto`: o pid vive e
 * o sistema não deixou ler a hora dele agora.
 */
export type PidAnotado =
  | { readonly tipo: "nenhum" }
  | { readonly tipo: "servidor"; readonly pid: number }
  | { readonly tipo: "outro"; readonly pid: number }
  | { readonly tipo: "incerto"; readonly pid: number };

export function lerPidDoServidor(caminho: string): PidAnotado {
  let texto: string;
  try {
    texto = readFileSync(caminho, "utf8").trim();
  } catch {
    return { tipo: "nenhum" };
  }
  let anotado: { pid: number; inicio: string | null } | null = null;
  try {
    const lido = formatoDoPid.parse(JSON.parse(texto));
    anotado = { pid: lido.pid, inicio: lido.inicio };
  } catch {
    const pid = Number(texto);
    if (Number.isInteger(pid) && pid > 0) anotado = { pid, inicio: null };
  }
  if (anotado === null || !vivo(anotado.pid)) return { tipo: "nenhum" };
  const inicio = horaDeInicio(anotado.pid);
  if (inicio === null) return { tipo: "incerto", pid: anotado.pid };
  return { tipo: inicio === anotado.inicio ? "servidor" : "outro", pid: anotado.pid };
}

function gravarPid(caminho: string): void {
  const inicio = horaDeInicio(process.pid);
  const temporario = `${caminho}.${process.pid}.tmp`;
  writeFileSync(temporario, JSON.stringify({ v: 1, pid: process.pid, inicio }), { mode: 0o600 });
  trocarPorRename(temporario, caminho);
}

/**
 * Antes de abrir o banco. Não troca o pid do servidor vivo nem o de um processo vivo cuja hora não
 * deu para ler: ele pode ser o dono do banco, e este processo vai sair com `BancoEmUso`.
 */
export function anunciarPid(caminho: string): void {
  const anotado = lerPidDoServidor(caminho);
  if (anotado.tipo === "nenhum" || anotado.tipo === "outro" || anotado.pid === process.pid) gravarPid(caminho);
}

/** Depois de abrir o banco: quem tem o banco é o servidor desta pasta, seja qual for o pid anotado. */
export function assumirPid(caminho: string): void {
  gravarPid(caminho);
}

export function apagarPid(caminho: string): void {
  const anotado = lerPidDoServidor(caminho);
  if (anotado.tipo !== "nenhum" && anotado.pid === process.pid) rmSync(caminho, { force: true });
}

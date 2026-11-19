/**
 * O atualizador troca o código da Secretária pela versão nova já extraída em `.atualizacao/nova/`,
 * com o servidor parado, e desfaz tudo se algo falhar.
 *
 * Este arquivo só importa do Bun e do `node:`. Ele roda enquanto as pastas do repo mudam de lugar:
 * um import resolvido depois da troca leria código de outra versão.
 */
import { Database } from "bun:sqlite";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, closeSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Os passos, na ordem em que rodam. O `andamento.json` diz em qual o atualizador está. */
export const PASSOS = ["esperar_banco", "preparar", "copiar", "trocar", "instalar", "subir"] as const;
export type Passo = (typeof PASSOS)[number];

/**
 * `preparado`: o servidor gravou o arquivo e o atualizador ainda não começou. `desfazer`: a volta
 * começou. `concluido` e `desfeito` são os finais: só neles a pasta está inteira numa versão só.
 */
export const FASES = ["preparado", ...PASSOS, "desfazer", "concluido", "desfeito"] as const;
export type Fase = (typeof FASES)[number];

export const MOTIVOS = [
  "banco_em_uso",
  "versao_nova_invalida",
  "copia_falhou",
  "troca_falhou",
  "instalar_falhou",
  "servidor_nao_subiu",
  /** O atualizador morreu no meio (queda de luz, processo encerrado) e a volta foi feita depois. */
  "interrompida",
] as const;
export type Motivo = (typeof MOTIVOS)[number];

/**
 * Uma entrada da troca: pasta ou arquivo que sai inteiro para `.atualizacao/anterior/` e dá lugar
 * ao de `.atualizacao/nova/`. Os dois campos dizem o que existia antes do primeiro rename, e é por
 * eles que a volta sabe o que devolver e o que tirar.
 */
export interface Troca {
  readonly caminho: string;
  readonly tinhaAntiga: boolean;
  readonly temNova: boolean;
}

/**
 * O `instalar` ou o servidor que o atualizador subiu e que pode seguir vivo depois de ele morrer.
 * `inicio` é a hora de início que o sistema dá ao pid, em texto opaco: o sistema reaproveita o pid,
 * e só os dois juntos dizem que o processo é o mesmo. `null`: a hora ainda não foi lida, ou não deu.
 * Sem ela, a volta confere se o processo do pid nasceu durante a atualização: ver `estadoDoProcesso`.
 */
export interface ProcessoDaAtualizacao {
  readonly papel: "instalar" | "servidor";
  readonly pid: number;
  readonly inicio: string | null;
}

/** O que a volta sabe do pid anotado. Só `nosso` é encerrado. */
export type EstadoDoProcesso = "nosso" | "nenhum" | "incerto";

/** Erro de relógio entre a hora que o sistema dá ao processo e a que o andamento gravou: o `btime` do Linux e o `lstart` do macOS vêm em segundos inteiros. */
const FOLGA_DO_NASCIMENTO_MS = 2_000;
const MESES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A hora de início de `inicioDoProcesso`, em milissegundos de relógio. `null`: o texto não está no formato do sistema. */
export function msDoInicio(inicio: string, plataforma: NodeJS.Platform): number | null {
  if (plataforma === "win32") return /^\d+$/.test(inicio) ? Number((BigInt(inicio) - 621_355_968_000_000_000n) / 10_000n) : null;
  if (plataforma === "linux") {
    if (!/^\d+$/.test(inicio)) return null;
    try {
      const boot = /^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"))?.[1];
      // O starttime conta em tiques de 1/100 s desde o boot: o USER_HZ do Linux é 100 nos processadores de mesa.
      return boot === undefined ? null : Number(boot) * 1_000 + Number(inicio) * 10;
    } catch {
      return null;
    }
  }
  const partes = /^\w{3} (\w{3}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(inicio);
  const mes = MESES.indexOf(partes?.[1] ?? "");
  if (partes === null || mes === -1) return null;
  const [dia, hora, minuto, segundo, ano] = partes.slice(2).map(Number) as [number, number, number, number, number];
  return new Date(ano, mes, dia, hora, minuto, segundo).getTime();
}

/** `<repo>/.atualizacao/andamento.json`. Gravado por arquivo temporário e rename, a cada mudança de fase. */
export interface Andamento {
  readonly v: 1;
  /** Versão instalada antes. `null` quando o `package.json` não deu a versão. */
  readonly de: string | null;
  readonly para: string | null;
  readonly iniciadoEm: string;
  readonly atualizadoEm: string;
  readonly fase: Fase;
  /** O plano da troca, gravado antes do primeiro rename. */
  readonly trocas: readonly Troca[];
  /** Verdadeiro desde que o `instalar` da versão nova pôde migrar o banco: a volta devolve as cópias. */
  readonly restaurarDados: boolean;
  /** Arquivos do núcleo que não batiam com a lista da versão instalada. `null`: sem lista para comparar. */
  readonly mudados: { readonly quantos: number; readonly caminhos: readonly string[] } | null;
  readonly falha: { readonly passo: Passo; readonly motivo: Motivo; readonly detalhe: string } | null;
  /** Gravado logo depois de o processo nascer e apagado quando ele termina. A volta só mexe na pasta sem ele vivo. */
  readonly processo: ProcessoDaAtualizacao | null;
}

export interface Prazos {
  readonly bancoMs: number;
  /** Quanto a volta espera o lock do banco soltar: o Windows o solta depois que o processo morto some. */
  readonly soltarBancoMs: number;
  readonly instalarMs: number;
  readonly servidorMs: number;
  readonly intervaloMs: number;
  /** Esperas entre as tentativas de um rename que o Windows recusou por arquivo em uso. */
  readonly esperasDoRenameMs: readonly number[];
}

const ESPERAS_DO_RENAME_MS = [100, 200, 400, 800, 1_500];

export const PRAZOS: Prazos = { bancoMs: 30_000, soltarBancoMs: 10_000, instalarMs: 900_000, servidorMs: 60_000, intervaloMs: 250, esperasDoRenameMs: ESPERAS_DO_RENAME_MS };

export interface ServidorSubindo {
  readonly pid: number | undefined;
  saiu(): boolean;
  encerrar(): Promise<void>;
}

export type Instalado = { readonly ok: true } | { readonly ok: false; readonly detalhe: string };

export interface Instalando {
  readonly pid: number | undefined;
  /** Resolve quando o processo do `instalar` sai, também quando foi encerrado. */
  readonly fim: Promise<Instalado>;
}

/** O que o atualizador faz fora da própria pasta de trabalho. O teste troca um por vez para injetar a falha. */
export interface Efeitos {
  readonly plataforma: NodeJS.Platform;
  renomear(de: string, para: string): void;
  /** Copia arquivo ou pasta inteira. */
  copiar(de: string, para: string): void;
  /** Ninguém segura este SQLite agora. Arquivo que não existe está livre. */
  bancoLivre(caminho: string): boolean;
  /** Sobe o `instalar` do código que está em `raizDoRepo`. O prazo é de quem chama. */
  iniciarInstalar(raizDoRepo: string, dirDados: string): Instalando;
  subirServidor(raizDoRepo: string, dirDados: string): ServidorSubindo;
  /** A hora de início do processo, como o sistema a registra. `null`: ele não existe, ou o sistema não deixou ler. */
  inicioDoProcesso(pid: number): string | null;
  /** Há um processo com este pid, de qualquer dono. Não diz se é o que o atualizador subiu. */
  existe(pid: number): boolean;
  /** Encerra à força o processo e os que ele subiu. Verdadeiro quando o processo não existe mais. */
  encerrarArvore(pid: number): Promise<boolean>;
  /** A versão que o servidor de pid `pid` responde em `/api/info`, ou `null` enquanto ele não responde. */
  versaoNoAr(dirDados: string, pid: number | undefined): Promise<string | null>;
  /** Chamado depois de cada gravação do andamento. */
  observar(andamento: Andamento): void;
}

const LISTA_DO_PACOTE = "arquivos-da-versao.json";
const PADRAO_DE_VERSAO = /^\d+\.\d+\.\d+$/;
const SEGMENTO = /^[A-Za-z0-9._-]+$/;
const PASTAS_DA_PROFILLS = ["nucleo", "docs", "testes", "novidades"];
const FORA_DA_RAIZ = ["meu", "node_modules", ".git", ".atualizacao", ".agents", ".claude"];
const TETO_DE_CAMINHOS_MUDADOS = 100;

export function caminhosDoAtualizador(raizDoRepo: string, dirDados: string) {
  const pasta = path.join(raizDoRepo, ".atualizacao");
  return {
    pasta,
    nova: path.join(pasta, "nova"),
    anterior: path.join(pasta, "anterior"),
    andamento: path.join(pasta, "andamento.json"),
    /** Cópia deste arquivo, fora das pastas trocadas: o `entrada.ts` a roda quando a troca parou no meio. */
    atualizadorGuardado: path.join(pasta, "atualizador.ts"),
    /** SQLite vazio que o atualizador segura enquanto vive. O sistema solta o lock quando o processo morre. */
    trava: path.join(pasta, "trava.db"),
    banco: path.join(dirDados, "secretaria.db"),
    bancoDoVendedor: path.join(dirDados, "meu.db"),
    wacli: path.join(dirDados, "bin", process.platform === "win32" ? "wacli.exe" : "wacli"),
    servidor: path.join(dirDados, "servidor.json"),
    saidaDoServidor: path.join(dirDados, "logs", "servidor-saida.log"),
    /** O que o `instalar` da versão nova escreveu, da última vez que o atualizador o rodou. */
    saidaDoInstalar: path.join(pasta, "instalar-saida.log"),
    /** Cópia dos bancos, do `meu/` e do wacli de antes da troca para `versao`. */
    copias: (versao: string) => path.join(dirDados, "atualizacoes", versao, "antes"),
  } as const;
}

/**
 * A entrada da troca a que um caminho do pacote pertence, ou `null` quando ele está fora da lista
 * de troca. É a mesma regra de `entraNaTroca`, do pacote: `testes/conferencias/atualizador.test.ts`
 * cobra que as duas concordem.
 */
export function unidadeDaTroca(caminho: string): string | null {
  const partes = caminho.split("/");
  if (partes.some((parte) => !SEGMENTO.test(parte) || parte.endsWith("."))) return null;
  const [primeira = "", segunda, terceira = ""] = partes;
  if (partes.length === 1) return FORA_DA_RAIZ.includes(primeira.toLowerCase()) ? null : caminho;
  if (PASTAS_DA_PROFILLS.includes(primeira)) return primeira;
  if (caminho === ".claude/settings.json") return caminho;
  if (primeira === ".agents" && segunda === "skills" && partes.length >= 4 && !terceira.toLowerCase().startsWith("meu-")) return `.agents/skills/${terceira}`;
  return null;
}

function ehUnidade(caminho: string): boolean {
  if (caminho === "node_modules") return true;
  // Um arquivo qualquer dentro da entrada cai nela mesma: é assim que se reconhece uma entrada.
  return unidadeDaTroca(caminho) === caminho || unidadeDaTroca(`${caminho}/x`) === caminho;
}

function ehFinal(fase: Fase): boolean {
  return fase === "concluido" || fase === "desfeito";
}

function sha256De(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function mensagem(erro: unknown): string {
  return erro instanceof Error ? erro.message : String(erro);
}

function ehObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === "object" && valor !== null && !Array.isArray(valor);
}

function versaoDe(pasta: string): string | null {
  try {
    const lido: unknown = JSON.parse(readFileSync(path.join(pasta, "package.json"), "utf8"));
    return ehObjeto(lido) && typeof lido.version === "string" && PADRAO_DE_VERSAO.test(lido.version) ? lido.version : null;
  } catch {
    return null;
  }
}

function versaoMaior(candidata: string, instalada: string): boolean {
  const a = candidata.split(".").map(Number);
  const b = instalada.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diferenca = (a[i] ?? 0) - (b[i] ?? 0);
    if (diferenca !== 0) return diferenca > 0;
  }
  return false;
}

interface Lista {
  readonly versao: string;
  readonly arquivos: readonly { readonly caminho: string; readonly sha256: string }[];
}

function lerLista(pasta: string): Lista | null {
  try {
    const lido: unknown = JSON.parse(readFileSync(path.join(pasta, LISTA_DO_PACOTE), "utf8"));
    if (!ehObjeto(lido) || typeof lido.versao !== "string" || !Array.isArray(lido.arquivos)) return null;
    const arquivos: { caminho: string; sha256: string }[] = [];
    for (const item of lido.arquivos as unknown[]) {
      if (!ehObjeto(item) || typeof item.caminho !== "string" || typeof item.sha256 !== "string") return null;
      arquivos.push({ caminho: item.caminho, sha256: item.sha256 });
    }
    return { versao: lido.versao, arquivos };
  } catch {
    return null;
  }
}

export type AndamentoLido = { readonly tipo: "ausente" } | { readonly tipo: "ilegivel" } | { readonly tipo: "lido"; readonly andamento: Andamento };

/** Lê o andamento como dado de fora: o plano dele manda em renames, então cada caminho precisa ser uma entrada da troca. */
export function lerAndamento(caminho: string): AndamentoLido {
  let texto: string;
  try {
    texto = readFileSync(caminho, "utf8");
  } catch {
    return { tipo: "ausente" };
  }
  let lido: unknown;
  try {
    lido = JSON.parse(texto);
  } catch {
    return { tipo: "ilegivel" };
  }
  const versaoOuNada = (valor: unknown): valor is string | null => valor === null || (typeof valor === "string" && PADRAO_DE_VERSAO.test(valor));
  if (!ehObjeto(lido) || lido.v !== 1 || !versaoOuNada(lido.de) || !versaoOuNada(lido.para)) return { tipo: "ilegivel" };
  const { de, para, iniciadoEm, atualizadoEm, fase, trocas, restaurarDados, mudados, falha, processo } = lido;
  if (typeof iniciadoEm !== "string" || typeof atualizadoEm !== "string" || typeof restaurarDados !== "boolean") return { tipo: "ilegivel" };
  if (!(FASES as readonly unknown[]).includes(fase) || !Array.isArray(trocas)) return { tipo: "ilegivel" };
  const plano: Troca[] = [];
  for (const troca of trocas as unknown[]) {
    if (!ehObjeto(troca) || typeof troca.caminho !== "string" || !ehUnidade(troca.caminho)) return { tipo: "ilegivel" };
    if (typeof troca.tinhaAntiga !== "boolean" || typeof troca.temNova !== "boolean") return { tipo: "ilegivel" };
    plano.push({ caminho: troca.caminho, tinhaAntiga: troca.tinhaAntiga, temNova: troca.temNova });
  }
  let contagem: Andamento["mudados"] = null;
  if (mudados !== null) {
    if (!ehObjeto(mudados) || !Number.isSafeInteger(mudados.quantos) || (mudados.quantos as number) < 0 || !Array.isArray(mudados.caminhos)) return { tipo: "ilegivel" };
    contagem = { quantos: mudados.quantos as number, caminhos: (mudados.caminhos as unknown[]).filter((item): item is string => typeof item === "string") };
  }
  let motivoDaFalha: Andamento["falha"] = null;
  if (falha !== null) {
    if (!ehObjeto(falha) || !(PASSOS as readonly unknown[]).includes(falha.passo) || !(MOTIVOS as readonly unknown[]).includes(falha.motivo)) return { tipo: "ilegivel" };
    motivoDaFalha = { passo: falha.passo as Passo, motivo: falha.motivo as Motivo, detalhe: typeof falha.detalhe === "string" ? falha.detalhe : "" };
  }
  // O andamento gravado antes de existir o campo não o traz: é o mesmo que nenhum processo.
  let filho: ProcessoDaAtualizacao | null = null;
  if (processo !== undefined && processo !== null) {
    if (!ehObjeto(processo) || (processo.papel !== "instalar" && processo.papel !== "servidor")) return { tipo: "ilegivel" };
    if (!Number.isSafeInteger(processo.pid) || (processo.pid as number) <= 1) return { tipo: "ilegivel" };
    if (processo.inicio !== null && typeof processo.inicio !== "string") return { tipo: "ilegivel" };
    filho = { papel: processo.papel, pid: processo.pid as number, inicio: processo.inicio };
  }
  return {
    tipo: "lido",
    andamento: { v: 1, de, para, iniciadoEm, atualizadoEm, fase: fase as Fase, trocas: plano, restaurarDados, mudados: contagem, falha: motivoDaFalha, processo: filho },
  };
}

export function gravarAndamento(caminho: string, andamento: Andamento, renomeador: Renomeador = RENOMEADOR_DO_SISTEMA): void {
  mkdirSync(path.dirname(caminho), { recursive: true });
  const temporario = `${caminho}.${process.pid}.tmp`;
  writeFileSync(temporario, JSON.stringify(andamento));
  trocarPorRename(temporario, caminho, renomeador);
}

/** O andamento que o servidor grava antes de subir o atualizador e pedir a própria parada. */
export function andamentoPreparado(de: string, para: string): Andamento {
  const agora = new Date().toISOString();
  return { v: 1, de, para, iniciadoEm: agora, atualizadoEm: agora, fase: "preparado", trocas: [], restaurarDados: false, mudados: null, falha: null, processo: null };
}

/** Há uma atualização que não chegou a um fim? Não muda nada: é a pergunta barata que o `abrir` faz. */
export function haAtualizacaoPendente(raizDoRepo: string): boolean {
  const lido = lerAndamento(caminhosDoAtualizador(raizDoRepo, "").andamento);
  return lido.tipo === "ilegivel" || (lido.tipo === "lido" && !ehFinal(lido.andamento.fase));
}

/** Abre o SQLite como único dono, do jeito que o servidor abre o banco. `null`: outro processo o segura. */
function abrirExclusivo(caminho: string): Database | null {
  const sqlite = new Database(caminho, { create: true, strict: true });
  try {
    sqlite.run("PRAGMA busy_timeout = 0");
    sqlite.run("PRAGMA locking_mode = EXCLUSIVE");
    sqlite.run("PRAGMA journal_mode = WAL");
    sqlite.run("BEGIN IMMEDIATE");
    sqlite.run("COMMIT");
    return sqlite;
  } catch (erro) {
    sqlite.close();
    if ((erro as { code?: string }).code === "SQLITE_BUSY") return null;
    throw erro;
  }
}

/** Um atualizador ou uma volta por vez nesta pasta. `null`: outro processo vivo já segura a trava. */
function segurarTrava(caminho: string): { soltar(): void } | null {
  mkdirSync(path.dirname(caminho), { recursive: true });
  const sqlite = abrirExclusivo(caminho);
  return sqlite === null ? null : { soltar: () => sqlite.close() };
}

async function esperarAte(condicao: () => boolean | Promise<boolean>, prazoMs: number, intervaloMs: number): Promise<boolean> {
  const fim = Date.now() + prazoMs;
  for (;;) {
    if (await condicao()) return true;
    if (Date.now() >= fim) return false;
    await Bun.sleep(intervaloMs);
  }
}

/** `null` quando o prazo acaba antes da promessa. */
async function comPrazo<T>(promessa: Promise<T>, prazoMs: number): Promise<T | null> {
  let relogio: ReturnType<typeof setTimeout> | undefined;
  const venceu = new Promise<null>((resolver) => (relogio = setTimeout(() => resolver(null), prazoMs)));
  try {
    return await Promise.race([promessa, venceu]);
  } finally {
    clearTimeout(relogio);
  }
}

class Falha extends Error {
  constructor(
    readonly motivo: Motivo,
    detalhe: string,
  ) {
    super(detalhe);
    this.name = "Falha";
  }
}

const USO_NO_WINDOWS = ["EPERM", "EBUSY", "EACCES"];

/** Como `trocarPorRename` renomeia. O teste troca o sistema e encurta as esperas. */
export interface Renomeador {
  readonly plataforma: NodeJS.Platform;
  renomear(de: string, para: string): void;
  readonly esperasMs: readonly number[];
}

export const RENOMEADOR_DO_SISTEMA: Renomeador = { plataforma: process.platform, renomear: renameSync, esperasMs: ESPERAS_DO_RENAME_MS };

/**
 * Põe `de` no lugar de `para` num rename só. Mora aqui porque o atualizador não importa nada do
 * núcleo; o resto do núcleo troca arquivo por aqui também. Esgotadas as esperas, relança o erro.
 */
export function trocarPorRename(de: string, para: string, renomeador: Renomeador = RENOMEADOR_DO_SISTEMA): void {
  for (let tentativa = 0; ; tentativa++) {
    try {
      renomeador.renomear(de, para);
      return;
    } catch (erro) {
      // No Windows, quem tem o arquivo aberto (outro processo lendo, o antivírus) faz o rename falhar por instantes: esperar e tentar de novo é o tratamento padrão, o mesmo do graceful-fs.
      const espera = renomeador.esperasMs[tentativa];
      const emUso = renomeador.plataforma === "win32" && USO_NO_WINDOWS.includes((erro as NodeJS.ErrnoException).code ?? "");
      if (!emUso || espera === undefined) throw erro;
      Bun.sleepSync(espera);
    }
  }
}

function tipoDe(caminho: string): "arquivo" | "link" | "outro" | null {
  try {
    const estado = lstatSync(caminho);
    return estado.isSymbolicLink() ? "link" : estado.isFile() ? "arquivo" : "outro";
  } catch {
    return null;
  }
}

const ehArquivo = (caminho: string) => tipoDe(caminho) === "arquivo";
const ehLink = (caminho: string) => tipoDe(caminho) === "link";

/** As operações sobre uma instalação. Tudo aqui chega ao mesmo fim se rodar de novo. */
function operacoes(raizDoRepo: string, dirDados: string, prazos: Prazos, efeitos: Efeitos) {
  const caminhos = caminhosDoAtualizador(raizDoRepo, dirDados);
  const em = (base: string, caminho: string) => path.join(base, ...caminho.split("/"));

  const renomeador: Renomeador = { plataforma: efeitos.plataforma, renomear: efeitos.renomear, esperasMs: prazos.esperasDoRenameMs };
  const renomear = (de: string, para: string) => trocarPorRename(de, para, renomeador);

  /** Copia o arquivo por um nome temporário: `destino` só aparece inteiro. */
  function copiarArquivo(de: string, destino: string): void {
    const parcial = `${destino}.parcial`;
    mkdirSync(path.dirname(destino), { recursive: true });
    efeitos.copiar(de, parcial);
    renomear(parcial, destino);
  }

  /**
   * Arquivo no lugar de arquivo troca sem buraco: a cópia da antiga vai para `anterior/` e a nova
   * entra por cima, num rename só. Assim o `package.json` e o `entrada.ts`, por onde o
   * `bun secretaria` começa, nunca faltam. Pasta não entra por cima de pasta: ela sai e a nova
   * entra, e o buraco entre os dois renames é o que o `entrada.ts` sabe recompor.
   */
  function trocar(troca: Troca): void {
    const noRepo = em(raizDoRepo, troca.caminho);
    const naNova = em(caminhos.nova, troca.caminho);
    const naAnterior = em(caminhos.anterior, troca.caminho);
    if (ehLink(naNova)) throw new Falha("troca_falhou", `${troca.caminho} da versão nova é um link`);
    if (troca.tinhaAntiga && !existsSync(naAnterior)) {
      if (ehArquivo(noRepo) && ehArquivo(naNova)) copiarArquivo(noRepo, naAnterior);
      else {
        mkdirSync(path.dirname(naAnterior), { recursive: true });
        renomear(noRepo, naAnterior);
      }
    }
    if (troca.temNova && existsSync(naNova)) {
      mkdirSync(path.dirname(noRepo), { recursive: true });
      renomear(naNova, noRepo);
    }
  }

  /** Verdadeiro quando moveu alguma coisa. */
  function destrocar(troca: Troca): boolean {
    const noRepo = em(raizDoRepo, troca.caminho);
    const naNova = em(caminhos.nova, troca.caminho);
    const naAnterior = em(caminhos.anterior, troca.caminho);
    // O que está no repo só é da versão nova se a antiga já saiu (ou nunca existiu) e a nova não está mais em `nova/`.
    let moveu = false;
    if (troca.temNova && !existsSync(naNova) && existsSync(noRepo) && (!troca.tinhaAntiga || existsSync(naAnterior))) {
      if (troca.tinhaAntiga && ehArquivo(noRepo) && ehArquivo(naAnterior)) copiarArquivo(noRepo, naNova);
      else {
        mkdirSync(path.dirname(naNova), { recursive: true });
        renomear(noRepo, naNova);
      }
      moveu = true;
    }
    if (troca.tinhaAntiga && existsSync(naAnterior)) {
      mkdirSync(path.dirname(noRepo), { recursive: true });
      renomear(naAnterior, noRepo);
      moveu = true;
    }
    return moveu;
  }

  /** Quantas entradas voltaram de lugar. */
  function desfazerTrocas(andamento: Andamento): number {
    let movidas = 0;
    for (const troca of [...andamento.trocas].reverse()) if (destrocar(troca)) movidas += 1;
    return movidas;
  }

  /**
   * Quem tem hoje o pid anotado. `nosso`: o mesmo processo, pela hora de início anotada ou, sem ela,
   * por ter nascido entre o começo da atualização e a última gravação do andamento. `incerto`: o pid
   * existe e não há como confirmar. Passado o prazo do papel, o incerto conta como `nenhum`: o
   * atualizador não deixaria o processo dele viver tanto.
   */
  function estadoDoProcesso(processo: ProcessoDaAtualizacao | null, andamento: Andamento): EstadoDoProcesso {
    if (processo === null || !efeitos.existe(processo.pid)) return "nenhum";
    const agora = efeitos.inicioDoProcesso(processo.pid);
    if (agora !== null && processo.inicio !== null) return agora === processo.inicio ? "nosso" : "nenhum";
    const nasceu = agora === null ? null : msDoInicio(agora, efeitos.plataforma);
    if (nasceu !== null) {
      const [desde, ate] = [Date.parse(andamento.iniciadoEm), Date.parse(andamento.atualizadoEm)];
      return nasceu >= desde - FOLGA_DO_NASCIMENTO_MS && nasceu <= ate + FOLGA_DO_NASCIMENTO_MS ? "nosso" : "nenhum";
    }
    if (!efeitos.existe(processo.pid)) return "nenhum";
    const prazo = processo.papel === "instalar" ? prazos.instalarMs : prazos.servidorMs;
    return Date.now() <= Date.parse(andamento.atualizadoEm) + prazo ? "incerto" : "nenhum";
  }

  const BANCOS = ["secretaria.db", "meu.db"];
  const SUFIXOS = ["", "-wal", "-shm"];

  return {
    caminhos,
    renomeador,

    /** Os dois bancos, o do núcleo e o do vendedor, porque a volta devolve as cópias dos dois. */
    bancosLivres: () => efeitos.bancoLivre(caminhos.banco) && efeitos.bancoLivre(caminhos.bancoDoVendedor),

    estadoDoProcesso,

    /**
     * A volta renomeia pastas e devolve os bancos: antes dela, o `instalar` ou o servidor que ficou
     * vivo é encerrado, com os processos que subiu. Processo incerto não é encerrado: o pid pode ser
     * de outro programa. `preso`: era o nosso e não encerrou.
     */
    async semProcesso(processo: ProcessoDaAtualizacao | null, andamento: Andamento): Promise<"livre" | "incerto" | "preso"> {
      const estado = estadoDoProcesso(processo, andamento);
      if (estado === "nenhum" || processo === null) return "livre";
      if (estado === "incerto") return "incerto";
      return (await efeitos.encerrarArvore(processo.pid)) ? "livre" : "preso";
    },

    /** Confere a versão nova, monta o plano e conta o que o agente do vendedor mudou no núcleo. Não muda nada além de limpar `anterior/`. */
    preparar(): Pick<Andamento, "trocas" | "mudados"> {
      const instalada = versaoDe(raizDoRepo);
      const nova = versaoDe(caminhos.nova);
      const lista = lerLista(caminhos.nova);
      if (instalada === null) throw new Falha("versao_nova_invalida", "o package.json da instalação não diz a versão");
      if (nova === null || lista === null || lista.versao !== nova) throw new Falha("versao_nova_invalida", "a pasta da versão nova não tem package.json e lista da mesma versão");
      if (!versaoMaior(nova, instalada)) throw new Falha("versao_nova_invalida", `a ${nova} não é maior que a ${instalada}`);
      if (!existsSync(path.join(caminhos.nova, "node_modules"))) throw new Falha("versao_nova_invalida", "a versão nova veio sem as dependências instaladas");
      if (!existsSync(path.join(caminhos.nova, "nucleo", "cli", "main.ts"))) throw new Falha("versao_nova_invalida", "a versão nova veio sem o CLI");

      const unidades = new Set<string>(["node_modules", LISTA_DO_PACOTE]);
      for (const { caminho } of lista.arquivos) {
        const unidade = unidadeDaTroca(caminho);
        if (unidade === null) throw new Falha("versao_nova_invalida", `${JSON.stringify(caminho)} está fora do que a atualização troca`);
        unidades.add(unidade);
      }
      // O que a versão instalada trazia e a nova não traz sai junto: é assim que arquivo removido some.
      const daInstalada = lerLista(raizDoRepo);
      for (const { caminho } of daInstalada?.arquivos ?? []) {
        const unidade = unidadeDaTroca(caminho);
        if (unidade !== null) unidades.add(unidade);
      }

      let mudados: Andamento["mudados"] = null;
      if (daInstalada !== null) {
        const diferentes = daInstalada.arquivos.filter(({ caminho, sha256 }) => {
          if (unidadeDaTroca(caminho) === null) return false;
          const completo = em(raizDoRepo, caminho);
          return !existsSync(completo) || sha256De(readFileSync(completo)) !== sha256;
        });
        mudados = { quantos: diferentes.length, caminhos: diferentes.slice(0, TETO_DE_CAMINHOS_MUDADOS).map(({ caminho }) => caminho) };
      }

      // Sobra da atualização anterior, que já chegou ao fim: só a mais recente fica guardada.
      rmSync(caminhos.anterior, { recursive: true, force: true });
      // `node_modules` vai primeiro: é a entrada com mais chance de estar em uso, e falhar nela não deixa nada para desfazer.
      const ordem = ["node_modules", ...[...unidades].filter((unidade) => unidade !== "node_modules").sort()];
      const trocas = ordem.map((caminho) => ({ caminho, tinhaAntiga: existsSync(em(raizDoRepo, caminho)), temNova: existsSync(em(caminhos.nova, caminho)) }));
      return { trocas, mudados };
    },

    /**
     * Guarda este arquivo fora das pastas trocadas e copia os bancos, o `meu/` e, se a trava mudou,
     * o wacli. A pasta `antes/` só aparece com a cópia inteira.
     */
    copiar(versao: string): void {
      copiarArquivo(import.meta.path, caminhos.atualizadorGuardado);
      const antes = caminhos.copias(versao);
      const parcial = `${antes}.parcial`;
      rmSync(parcial, { recursive: true, force: true });
      rmSync(antes, { recursive: true, force: true });
      mkdirSync(parcial, { recursive: true, mode: 0o700 });
      for (const banco of BANCOS) {
        for (const sufixo of SUFIXOS) {
          const origem = path.join(dirDados, banco + sufixo);
          if (existsSync(origem)) efeitos.copiar(origem, path.join(parcial, banco + sufixo));
        }
      }
      const meu = path.join(raizDoRepo, "meu");
      if (existsSync(meu)) efeitos.copiar(meu, path.join(parcial, "meu"));
      const trava = (pasta: string) => {
        try {
          return readFileSync(path.join(pasta, "ferramentas.lock.json"));
        } catch {
          return null;
        }
      };
      const [atual, nova] = [trava(raizDoRepo), trava(caminhos.nova)];
      if ((atual === null || nova === null || !atual.equals(nova)) && existsSync(caminhos.wacli)) {
        mkdirSync(path.join(parcial, "bin"), { recursive: true });
        efeitos.copiar(caminhos.wacli, path.join(parcial, "bin", path.basename(caminhos.wacli)));
      }
      renomear(parcial, antes);
    },

    trocarTudo(trocas: readonly Troca[]): void {
      for (const troca of trocas) trocar(troca);
    },

    desfazerTrocas,

    /** A volta: devolve cada entrada na ordem inversa e, se o banco pôde ter migrado, as cópias de `antes/`. */
    desfazer(andamento: Andamento): void {
      desfazerTrocas(andamento);
      if (!andamento.restaurarDados || andamento.para === null) return;
      const antes = caminhos.copias(andamento.para);
      if (!existsSync(antes)) return;
      for (const banco of BANCOS) {
        for (const sufixo of SUFIXOS) rmSync(path.join(dirDados, banco + sufixo), { force: true });
        for (const sufixo of SUFIXOS) {
          const copia = path.join(antes, banco + sufixo);
          if (!existsSync(copia)) continue;
          copyFileSync(copia, path.join(dirDados, banco + sufixo));
          if (process.platform !== "win32") chmodSync(path.join(dirDados, banco + sufixo), 0o600);
        }
      }
      const wacli = path.join(antes, "bin", path.basename(caminhos.wacli));
      if (existsSync(wacli)) {
        copyFileSync(wacli, caminhos.wacli);
        if (process.platform !== "win32") chmodSync(caminhos.wacli, 0o755);
      }
    },

    async servidorResponde(servidor: ServidorSubindo, versao: string | null): Promise<boolean> {
      let saiu = false;
      const respondeu = await esperarAte(
        async () => {
          saiu = servidor.saiu();
          return saiu || (await efeitos.versaoNoAr(dirDados, servidor.pid)) === versao;
        },
        prazos.servidorMs,
        prazos.intervaloMs,
      );
      return respondeu && !saiu;
    },
  };
}

export type Desfecho =
  /** Nada foi gravado nem mudado. */
  | { readonly tipo: "recusada"; readonly motivo: "pasta_de_desenvolvimento" | "outra_em_andamento" | "atualizacao_interrompida" }
  | { readonly tipo: "concluida"; readonly andamento: Andamento }
  | { readonly tipo: "desfeita"; readonly andamento: Andamento; readonly servidorNoAr: boolean }
  /** A volta parou no meio. O andamento fica em `desfazer`, e o próximo `abrir` a termina. */
  | { readonly tipo: "volta_incompleta"; readonly andamento: Andamento; readonly detalhe: string };

const MOTIVO_DO_PASSO: { readonly [P in Passo]: Motivo } = {
  esperar_banco: "banco_em_uso",
  preparar: "versao_nova_invalida",
  copiar: "copia_falhou",
  trocar: "troca_falhou",
  instalar: "instalar_falhou",
  subir: "servidor_nao_subiu",
};

/**
 * Roda os passos com o servidor parado. Falha depois de o banco ficar livre desfaz o que foi
 * feito e sobe o servidor antigo. Pasta com `.git` nunca é tocada.
 */
export async function atualizar(
  opcoes: { readonly raizDoRepo: string; readonly dirDados: string; readonly prazos?: Partial<Prazos> },
  efeitos: Efeitos = efeitosReais(),
): Promise<Desfecho> {
  const { raizDoRepo, dirDados } = opcoes;
  if (existsSync(path.join(raizDoRepo, ".git"))) return { tipo: "recusada", motivo: "pasta_de_desenvolvimento" };
  const prazos = { ...PRAZOS, ...opcoes.prazos };
  const ops = operacoes(raizDoRepo, dirDados, prazos, efeitos);
  const { caminhos } = ops;
  const trava = segurarTrava(caminhos.trava);
  if (trava === null) return { tipo: "recusada", motivo: "outra_em_andamento" };
  try {
    const anterior = lerAndamento(caminhos.andamento);
    // Uma atualização que parou no meio se resolve pela volta do `abrir`, nunca por cima.
    if (anterior.tipo === "ilegivel" || (anterior.tipo === "lido" && !ehFinal(anterior.andamento.fase) && anterior.andamento.fase !== "preparado")) {
      return { tipo: "recusada", motivo: "atualizacao_interrompida" };
    }

    const agora = new Date().toISOString();
    let andamento: Andamento = {
      v: 1,
      de: versaoDe(raizDoRepo),
      para: versaoDe(caminhos.nova),
      iniciadoEm: agora,
      atualizadoEm: agora,
      fase: "esperar_banco",
      trocas: [],
      restaurarDados: false,
      mudados: null,
      falha: null,
      processo: null,
    };
    const gravar = (mudanca: Partial<Andamento>): Andamento => {
      andamento = { ...andamento, ...mudanca, atualizadoEm: new Date().toISOString() };
      gravarAndamento(caminhos.andamento, andamento, ops.renomeador);
      efeitos.observar(andamento);
      return andamento;
    };
    /** O pid vai para o disco na hora, antes da hora de início: no Windows, ler a hora leva perto de um segundo. */
    const registrar = (papel: ProcessoDaAtualizacao["papel"], pid: number | undefined): void => {
      if (pid === undefined) return;
      gravar({ processo: { papel, pid, inicio: null } });
      const inicio = efeitos.inicioDoProcesso(pid);
      if (inicio !== null) gravar({ processo: { papel, pid, inicio } });
    };
    const falhaEm = (passo: Passo, erro: unknown): NonNullable<Andamento["falha"]> => ({
      passo,
      motivo: erro instanceof Falha ? erro.motivo : MOTIVO_DO_PASSO[passo],
      detalhe: mensagem(erro),
    });

    gravar({});
    if (!(await esperarAte(ops.bancosLivres, prazos.bancoMs, prazos.intervaloMs))) {
      const detalhe = `o banco seguiu em uso por ${Math.round(prazos.bancoMs / 1000)} s`;
      return { tipo: "desfeita", andamento: gravar({ fase: "desfeito", falha: { passo: "esperar_banco", motivo: "banco_em_uso", detalhe } }), servidorNoAr: false };
    }

    let passo: Passo = "preparar";
    /** Pelo processo que este atualizador subiu e ainda segura, não pelo pid: enquanto ele não sai, o sistema não dá o pid a outro. */
    let filhoSaiu = () => true;
    try {
      gravar({ fase: passo });
      const plano = ops.preparar();
      const versao = andamento.para;
      if (versao === null) throw new Falha("versao_nova_invalida", "a versão nova não diz a versão");
      gravar({ fase: (passo = "copiar"), ...plano });
      ops.copiar(versao);
      gravar({ fase: (passo = "trocar") });
      ops.trocarTudo(andamento.trocas);
      gravar({ fase: (passo = "instalar"), restaurarDados: true });
      const instalando = efeitos.iniciarInstalar(raizDoRepo, dirDados);
      let instalarSaiu = false;
      void instalando.fim.then(() => (instalarSaiu = true));
      filhoSaiu = () => instalarSaiu;
      registrar("instalar", instalando.pid);
      const instalado = await comPrazo(instalando.fim, prazos.instalarMs);
      if (instalado === null) throw new Falha("instalar_falhou", `o instalar não terminou em ${Math.round(prazos.instalarMs / 1000)} s`);
      if (!instalado.ok) throw new Falha("instalar_falhou", instalado.detalhe);
      gravar({ fase: (passo = "subir"), processo: null });
      const servidor = efeitos.subirServidor(raizDoRepo, dirDados);
      filhoSaiu = servidor.saiu;
      registrar("servidor", servidor.pid);
      if (!(await ops.servidorResponde(servidor, versao))) {
        await servidor.encerrar();
        throw new Falha("servidor_nao_subiu", `o servidor não respondeu a ${versao} em ${Math.round(prazos.servidorMs / 1000)} s`);
      }
      gravar({ fase: "concluido", processo: null });
    } catch (erro) {
      const vivo = filhoSaiu() ? null : andamento.processo;
      gravar({ fase: "desfazer", falha: falhaEm(passo, erro), processo: vivo });
      try {
        if (vivo !== null) {
          if (!(await efeitos.encerrarArvore(vivo.pid))) throw new Error(`o processo ${vivo.pid} da atualização não encerrou`);
          gravar({ processo: null });
        }
        if (!(await esperarAte(ops.bancosLivres, prazos.bancoMs, prazos.intervaloMs))) throw new Error("o banco seguiu em uso");
        ops.desfazer(andamento);
      } catch (naVolta) {
        return { tipo: "volta_incompleta", andamento, detalhe: mensagem(naVolta) };
      }
      const desfeito = gravar({ fase: "desfeito" });
      const antigo = efeitos.subirServidor(raizDoRepo, dirDados);
      const servidorNoAr = await ops.servidorResponde(antigo, andamento.de);
      if (!servidorNoAr) await antigo.encerrar();
      return { tipo: "desfeita", andamento: desfeito, servidorNoAr };
    }
    try {
      // Só o núcleo antigo interessa a quem mudou arquivo nele. As dependências antigas só ocupam disco.
      rmSync(path.join(caminhos.anterior, "node_modules"), { recursive: true, force: true });
    } catch {
      // Fica para a atualização seguinte, que limpa `anterior/` inteira: a versão nova já está no ar.
    }
    return { tipo: "concluida", andamento };
  } finally {
    trava.soltar();
  }
}

export type Recuperacao =
  | { readonly tipo: "nada" }
  /** Um atualizador vivo segura a trava, ou o pid anotado existe e não deu para confirmar que é o processo que ele subiu: ninguém o encerra. */
  | { readonly tipo: "em_andamento" }
  /** O servidor da versão nova responde, agora ou depois de a volta esperar por ele: só faltava gravar o fim. */
  | { readonly tipo: "concluida"; readonly de: string | null; readonly para: string | null }
  | { readonly tipo: "desfeita"; readonly de: string | null; readonly para: string | null }
  | { readonly tipo: "banco_em_uso" }
  /** O `instalar` ou o servidor que o atualizador subiu segue vivo e não encerrou. Nada foi mexido. */
  | { readonly tipo: "processo_preso"; readonly papel: ProcessoDaAtualizacao["papel"]; readonly pid: number }
  /** Um servidor responde sobre uma pasta que a atualização pode ter deixado pela metade. A volta só roda com ele parado. */
  | { readonly tipo: "servidor_no_meio"; readonly versaoNoAr: string }
  | { readonly tipo: "falhou"; readonly detalhe: string };

/** Nas fases antes da troca, a pasta e os bancos ainda são os da versão antiga. */
const ANTES_DA_TROCA: readonly Fase[] = ["esperar_banco", "preparar", "copiar"];
/** As fases em que a pasta pode estar rasgada, com uma entrada fora do lugar. */
const RASGAM: readonly Fase[] = ["trocar", "desfazer"];

function falhaDaQueda(andamento: Andamento): NonNullable<Andamento["falha"]> {
  const passo: Passo = (PASSOS as readonly string[]).includes(andamento.fase) ? (andamento.fase as Passo) : "esperar_banco";
  return andamento.falha ?? { passo, motivo: "interrompida", detalhe: "o atualizador parou antes de terminar" };
}

function regravar(caminho: string, andamento: Andamento, mudanca: Partial<Andamento>, efeitos: Efeitos, renomeador: Renomeador): Andamento {
  const novo = { ...andamento, ...mudanca, atualizadoEm: new Date().toISOString() };
  gravarAndamento(caminho, novo, renomeador);
  efeitos.observar(novo);
  return novo;
}

/**
 * A volta de uma atualização que morreu no meio. Com o servidor parado, desfaz o que estiver em
 * `.atualizacao/anterior/`, devolve as cópias e grava `desfeito`: quem chama sobe o servidor,
 * que é o da versão antiga. `versaoNoAr` é a versão que o servidor responde agora, ou `null`.
 */
export async function recuperar(
  opcoes: { readonly raizDoRepo: string; readonly dirDados: string; readonly versaoNoAr: string | null; readonly prazos?: Partial<Prazos> },
  efeitos: Efeitos = efeitosReais(),
): Promise<Recuperacao> {
  const { raizDoRepo, dirDados } = opcoes;
  if (existsSync(path.join(raizDoRepo, ".git")) || !haAtualizacaoPendente(raizDoRepo)) return { tipo: "nada" };
  const prazos = { ...PRAZOS, ...opcoes.prazos };
  const ops = operacoes(raizDoRepo, dirDados, prazos, efeitos);
  const { caminhos } = ops;
  const trava = segurarTrava(caminhos.trava);
  if (trava === null) return { tipo: "em_andamento" };
  try {
    const lido = lerAndamento(caminhos.andamento);
    if (lido.tipo === "ilegivel") return { tipo: "falhou", detalhe: "o andamento.json da atualização não está num formato que esta versão lê" };
    if (lido.tipo === "ausente" || ehFinal(lido.andamento.fase)) return { tipo: "nada" };
    let andamento = lido.andamento;
    const { de, para, processo } = andamento;
    const gravar = (mudanca: Partial<Andamento>) => (andamento = regravar(caminhos.andamento, andamento, mudanca, efeitos, ops.renomeador));
    const falha = falhaDaQueda(andamento);
    if (opcoes.versaoNoAr !== null) {
      // O servidor grava o `preparado` ainda no ar, antes de subir o atualizador e parar.
      if (andamento.fase === "preparado") return { tipo: "nada" };
      if (andamento.fase === "subir" && opcoes.versaoNoAr === para) {
        gravar({ fase: "concluido", processo: null });
        return { tipo: "concluida", de, para };
      }
      // Antes da troca nada mudou de lugar: o servidor no ar é o da versão antiga, e só falta gravar o fim.
      if (ANTES_DA_TROCA.includes(andamento.fase)) {
        gravar({ fase: "desfeito", falha });
        return { tipo: "desfeita", de, para };
      }
      return { tipo: "servidor_no_meio", versaoNoAr: opcoes.versaoNoAr };
    }
    if (processo !== null && processo.papel === "servidor" && andamento.fase === "subir" && ops.estadoDoProcesso(processo, andamento) !== "nenhum") {
      // O servidor que o atualizador subiu ainda está nascendo: desfazer agora tiraria a pasta de baixo dele.
      let respondeu = false;
      await esperarAte(
        async () => {
          // Quem ele é já foi visto: a cada volta basta o pid existir, sem abrir um powershell por volta no Windows.
          if (!efeitos.existe(processo.pid)) return true;
          respondeu = (await efeitos.versaoNoAr(dirDados, processo.pid)) === para;
          return respondeu;
        },
        prazos.servidorMs,
        prazos.intervaloMs,
      );
      if (respondeu) {
        gravar({ fase: "concluido", processo: null });
        return { tipo: "concluida", de, para };
      }
    }
    const semProcesso = await ops.semProcesso(processo, andamento);
    if (semProcesso === "incerto") return { tipo: "em_andamento" };
    if (semProcesso === "preso" && processo !== null) return { tipo: "processo_preso", papel: processo.papel, pid: processo.pid };
    if (!(await esperarAte(ops.bancosLivres, prazos.soltarBancoMs, prazos.intervaloMs))) return { tipo: "banco_em_uso" };
    if (andamento.fase !== "desfazer" || processo !== null) gravar({ fase: "desfazer", falha, processo: null });
    ops.desfazer(andamento);
    gravar({ fase: "desfeito", falha });
    return { tipo: "desfeita", de, para };
  } catch (erro) {
    return { tipo: "falhou", detalhe: mensagem(erro) };
  } finally {
    trava.soltar();
  }
}

/**
 * `recomposta`: alguma entrada voltou de lugar. `nada`: a pasta já estava inteira. `em_andamento`:
 * um atualizador vivo segura a trava, ou o processo que ele subiu segue vivo ou não deu para
 * descartar, e nada foi movido.
 */
export type Recomposicao = { readonly tipo: "nada" } | { readonly tipo: "em_andamento" } | { readonly tipo: "recomposta" } | { readonly tipo: "falhou"; readonly detalhe: string };

/**
 * Põe de volta as entradas de uma troca que morreu no meio, sem tocar na pasta de dados. O
 * `entrada.ts` roda isto da cópia em `.atualizacao/` antes de carregar o CLI, porque com `nucleo/`
 * ou `node_modules/` fora do lugar o CLI nem carrega. O andamento fica em `desfazer`: devolver os
 * bancos e gravar o fim é do `recuperar`, no `abrir`.
 */
export async function recomporArvore(raizDoRepo: string, efeitos: Efeitos = efeitosReais()): Promise<Recomposicao> {
  if (existsSync(path.join(raizDoRepo, ".git"))) return { tipo: "nada" };
  const ops = operacoes(raizDoRepo, "", PRAZOS, efeitos);
  const { caminhos } = ops;
  const rasgada = () => {
    const lido = lerAndamento(caminhos.andamento);
    return lido.tipo === "lido" && RASGAM.includes(lido.andamento.fase) ? lido.andamento : null;
  };
  if (rasgada() === null) return { tipo: "nada" };
  const trava = segurarTrava(caminhos.trava);
  if (trava === null) return { tipo: "em_andamento" };
  try {
    const andamento = rasgada();
    if (andamento === null) return { tipo: "nada" };
    // Com o processo ainda anotado, a volta não moveu nada: a pasta está inteira, e encerrá-lo é do `recuperar`.
    if (ops.estadoDoProcesso(andamento.processo, andamento) !== "nenhum") return { tipo: "em_andamento" };
    if (andamento.fase !== "desfazer") regravar(caminhos.andamento, andamento, { fase: "desfazer", falha: falhaDaQueda(andamento), processo: null }, efeitos, ops.renomeador);
    return ops.desfazerTrocas(andamento) > 0 ? { tipo: "recomposta" } : { tipo: "nada" };
  } catch (erro) {
    return { tipo: "falhou", detalhe: mensagem(erro) };
  } finally {
    trava.soltar();
  }
}

const PRAZO_DA_SONDA_MS = 3_000;
const PRAZO_DO_ENCERRAMENTO_MS = 5_000;
const PRAZO_DA_HORA_MS = 10_000;

function existe(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (erro) {
    // EPERM: o processo existe e é de outro usuário.
    return (erro as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A mesma leitura de `horaDeInicio`, de `nucleo/processos`: `testes/conferencias/atualizador.test.ts` cobra que as duas concordem. */
function inicioDoProcesso(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    try {
      // O nome do processo vem entre parênteses e pode ter espaço; o campo 22, starttime, conta depois dele.
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
    } catch {
      return null;
    }
  }
  const [programa, argumentos, env] =
    process.platform === "win32"
      ? (["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`], process.env] as const)
      : (["ps", ["-o", "lstart=", "-p", String(pid)], { PATH: process.env.PATH ?? "/bin:/usr/bin", LC_ALL: "C" }] as const);
  try {
    const feito = spawnSync(programa, argumentos, { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: PRAZO_DA_HORA_MS, windowsHide: true });
    const texto = (feito.stdout ?? "").trim();
    return feito.status === 0 && texto !== "" ? texto : null;
  } catch {
    return null;
  }
}

export function efeitosReais(): Efeitos {
  const ambienteDosFilhos = (dirDados: string) => ({ ...process.env, SECRETARIA_DADOS: dirDados });
  const cli = (raizDoRepo: string) => path.join(raizDoRepo, "nucleo", "cli", "main.ts");
  return {
    plataforma: process.platform,
    renomear: renameSync,
    copiar: (de, para) => cpSync(de, para, { recursive: true }),
    bancoLivre(caminho) {
      if (!existsSync(caminho)) return true;
      const sqlite = abrirExclusivo(caminho);
      sqlite?.close();
      return sqlite !== null;
    },
    iniciarInstalar(raizDoRepo, dirDados) {
      const saida = caminhosDoAtualizador(raizDoRepo, dirDados).saidaDoInstalar;
      mkdirSync(path.dirname(saida), { recursive: true });
      // A saída vai para um arquivo: um processo que o `instalar` subiu e que herdasse um pipe seguraria a leitura aberta.
      const arquivo = openSync(saida, "w", 0o600);
      const filho = spawn(process.execPath, [cli(raizDoRepo), "instalar", "--json"], {
        cwd: raizDoRepo,
        env: ambienteDosFilhos(dirDados),
        // Fora do Windows, o `instalar` nasce líder de um grupo: é pelo grupo que `encerrarArvore` alcança o que ele subiu.
        detached: process.platform !== "win32",
        stdio: ["ignore", arquivo, arquivo],
        windowsHide: true,
      });
      closeSync(arquivo);
      const fim = new Promise<Instalado>((resolver) => {
        filho.on("error", (erro) => resolver({ ok: false, detalhe: `o instalar não começou. ${mensagem(erro)}` }));
        filho.on("exit", (codigo) => {
          let escrito = "";
          try {
            escrito = readFileSync(saida, "utf8").trim();
          } catch {
            escrito = "";
          }
          let envelope: unknown = null;
          try {
            envelope = JSON.parse(escrito.split("\n").at(-1) ?? "");
          } catch {
            envelope = null;
          }
          if (codigo === 0 && ehObjeto(envelope) && envelope.ok === true) return resolver({ ok: true });
          const erro = ehObjeto(envelope) && ehObjeto(envelope.erro) ? `${String(envelope.erro.codigo)}: ${String(envelope.erro.mensagem)}` : escrito.slice(-500);
          resolver({ ok: false, detalhe: `o instalar saiu com ${codigo ?? "um sinal"}. ${erro}`.trim() });
        });
      });
      return { pid: filho.pid, fim };
    },
    inicioDoProcesso,
    existe,
    async encerrarArvore(pid) {
      // `kill` com 0, -1 ou 1 alcança o grupo de quem chama, todos os processos do usuário ou o init.
      if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return false;
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", timeout: PRAZO_DO_ENCERRAMENTO_MS, windowsHide: true });
      } else {
        for (const alvo of [-pid, pid]) {
          try {
            process.kill(alvo, "SIGKILL");
            break;
          } catch {
            // Sem grupo com esse número, o sinal vai só para o processo.
          }
        }
      }
      return esperarAte(() => !existe(pid), PRAZO_DO_ENCERRAMENTO_MS, 25);
    },
    subirServidor(raizDoRepo, dirDados) {
      const saida = caminhosDoAtualizador(raizDoRepo, dirDados).saidaDoServidor;
      mkdirSync(path.dirname(saida), { recursive: true, mode: 0o700 });
      const arquivo = openSync(saida, "a", 0o600);
      // `detached` tira o servidor do grupo deste processo: ele segue vivo depois que o atualizador sai.
      const filho = spawn(process.execPath, [cli(raizDoRepo), "servidor", "--json"], {
        cwd: raizDoRepo,
        env: ambienteDosFilhos(dirDados),
        detached: true,
        stdio: ["ignore", arquivo, arquivo],
        windowsHide: true,
      });
      closeSync(arquivo);
      let saiu = false;
      filho.on("exit", () => (saiu = true));
      filho.on("error", () => (saiu = true));
      filho.unref();
      const matar = async (sinal: NodeJS.Signals) => {
        try {
          filho.kill(sinal);
        } catch {
          return;
        }
        await esperarAte(() => saiu, PRAZO_DO_ENCERRAMENTO_MS, 25);
      };
      return {
        pid: filho.pid,
        saiu: () => saiu,
        async encerrar() {
          // No Windows todo sinal é o encerramento forçado; fora dele, o servidor ganha a chance de fechar o banco.
          if (!saiu && process.platform !== "win32") await matar("SIGINT");
          if (!saiu) await matar("SIGKILL");
        },
      };
    },
    async versaoNoAr(dirDados, pid) {
      try {
        const arquivo: unknown = JSON.parse(readFileSync(caminhosDoAtualizador("", dirDados).servidor, "utf8"));
        if (!ehObjeto(arquivo) || arquivo.pid !== pid || typeof arquivo.origem !== "string" || !/^http:\/\/127\.0\.0\.1:\d+$/.test(arquivo.origem)) return null;
        const resposta = await fetch(`${arquivo.origem}/api/info`, { signal: AbortSignal.timeout(PRAZO_DA_SONDA_MS) });
        const corpo: unknown = await resposta.json();
        if (!ehObjeto(corpo) || corpo.ok !== true || !ehObjeto(corpo.dados)) return null;
        const { app, idInstalacao, versaoNucleo } = corpo.dados;
        return app === "secretaria-profills" && idInstalacao === arquivo.idInstalacao && typeof versaoNucleo === "string" ? versaoNucleo : null;
      } catch {
        return null;
      }
    },
    observar() {},
  };
}

const USO = "uso: bun nucleo/atualizador/main.ts --repo <raiz da instalação> --dados <pasta de dados>\n";

if (import.meta.main) {
  const valorDe = (opcao: string) => {
    const indice = process.argv.indexOf(opcao);
    return indice === -1 ? undefined : process.argv[indice + 1];
  };
  const [repo, dados] = [valorDe("--repo"), valorDe("--dados")];
  if (repo === undefined || dados === undefined) {
    process.stderr.write(USO);
    process.exit(2);
  }
  const raizDoRepo = path.resolve(repo);
  // O Windows não renomeia a pasta em que um processo está: a raiz não muda de lugar, o resto muda.
  process.chdir(raizDoRepo);
  const desfecho = await atualizar({ raizDoRepo, dirDados: path.resolve(dados) });
  process.stdout.write(`${JSON.stringify(desfecho)}\n`);
  process.exit(desfecho.tipo === "concluida" ? 0 : 1);
}

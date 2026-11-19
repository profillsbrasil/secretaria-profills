import { chmodSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { z } from "zod";
import { trocarPorRename } from "../atualizador";

/** `plataforma-arquitetura` com os nomes do Node: `linux-x64`, `darwin-arm64`, `win32-x64`. */
export type Alvo = `${NodeJS.Platform}-${NodeJS.Architecture}`;

/** O repo é público: um PR que troque a URL da trava não leva o instalador a baixar de outro lugar. */
const ORIGEM_DO_DOWNLOAD = "https://github.com/openclaw/wacli/releases/download/";

const urlDeDownload = z.url().refine((texto) => {
  const url = new URL(texto);
  return url.href.startsWith(ORIGEM_DO_DOWNLOAD) && /\.(tar\.gz|zip)$/.test(url.pathname);
}, `precisa começar com ${ORIGEM_DO_DOWNLOAD} e terminar em .tar.gz ou .zip`);

const ferramentaTravada = z.strictObject({
  versao: z.string().regex(/^\d+\.\d+\.\d+$/),
  licenca: z.string().min(1),
  origem: z.url(),
  checksums: z.url(),
  /** macOS mais antigo que este não roda o binário oficial. */
  macosMinimo: z.number().int().positive(),
  artefatos: z.record(z.string(), z.strictObject({ url: urlDeDownload, sha256: z.string().regex(/^[0-9a-f]{64}$/) })),
});

const travaDeFerramentas = z.strictObject({ wacli: ferramentaTravada });

export type FerramentaTravada = z.infer<typeof ferramentaTravada>;
export type TravaDeFerramentas = z.infer<typeof travaDeFerramentas>;

export function lerTrava(raizDoRepo: string): TravaDeFerramentas {
  return travaDeFerramentas.parse(JSON.parse(readFileSync(path.join(raizDoRepo, "ferramentas.lock.json"), "utf8")));
}

/** Prefixo dos arquivos de trabalho em `<dados>/bin`. Nenhum deles é o binário final. */
const PREFIXO_TEMPORARIO = ".baixando-";

/** Apaga sobras de uma instalação que caiu no meio. */
export function limparTemporarios(dirBin: string): void {
  for (const nome of readdirSync(dirBin)) {
    if (nome.startsWith(PREFIXO_TEMPORARIO)) rmSync(path.join(dirBin, nome), { force: true, recursive: true });
  }
}

/** Teto do download inteiro, do pedido ao último byte. Servidor que para de responder não segura a instalação. */
const PRAZO_DO_DOWNLOAD_MS = 600_000;

/**
 * Baixa para um arquivo temporário calculando o sha256 enquanto grava. Corpo menor que o
 * `Content-Length`, conexão que cai ou hash diferente apagam o arquivo e lançam erro.
 */
export async function baixarConferido(url: string, sha256: string, destino: string, prazoMs: number = PRAZO_DO_DOWNLOAD_MS): Promise<void> {
  const resposta = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(prazoMs) });
  if (!resposta.ok || resposta.body === null) throw new Error(`o download de ${url} respondeu ${resposta.status}`);
  const esperado = Number(resposta.headers.get("content-length") ?? Number.NaN);
  const hash = new Bun.CryptoHasher("sha256");
  const escritor = Bun.file(destino).writer();
  let recebidos = 0;
  try {
    for await (const bloco of resposta.body) {
      hash.update(bloco);
      escritor.write(bloco);
      recebidos += bloco.byteLength;
    }
    await escritor.end();
    if (Number.isFinite(esperado) && recebidos !== esperado) {
      throw new Error(`o download de ${url} parou em ${recebidos} de ${esperado} bytes`);
    }
    const obtido = hash.digest("hex");
    if (obtido !== sha256) throw new Error(`o sha256 de ${url} não confere: veio ${obtido}, a trava pede ${sha256}`);
  } catch (erro) {
    await Promise.resolve(escritor.end()).catch(() => undefined);
    rmSync(destino, { force: true });
    throw erro;
  }
}

/** Lê um arquivo de um `.zip` sem programa externo: o Windows é o único alvo em zip e o `tar` dele varia. */
export function lerDoZip(zip: Uint8Array, nome: string): Uint8Array {
  const visao = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let fim = -1;
  for (let i = zip.byteLength - 22; i >= Math.max(0, zip.byteLength - 22 - 65_535); i--) {
    if (visao.getUint32(i, true) === 0x06054b50) {
      fim = i;
      break;
    }
  }
  if (fim === -1) throw new Error("o zip não tem diretório central");
  const entradas = visao.getUint16(fim + 10, true);
  let cursor = visao.getUint32(fim + 16, true);
  for (let n = 0; n < entradas; n++) {
    if (visao.getUint32(cursor, true) !== 0x02014b50) throw new Error("o diretório central do zip está corrompido");
    const metodo = visao.getUint16(cursor + 10, true);
    const crc = visao.getUint32(cursor + 16, true);
    const comprimido = visao.getUint32(cursor + 20, true);
    const tamanho = visao.getUint32(cursor + 24, true);
    const tamanhoDoNome = visao.getUint16(cursor + 28, true);
    const extra = visao.getUint16(cursor + 30, true);
    const comentario = visao.getUint16(cursor + 32, true);
    const local = visao.getUint32(cursor + 42, true);
    const nomeDaEntrada = new TextDecoder().decode(zip.subarray(cursor + 46, cursor + 46 + tamanhoDoNome));
    cursor += 46 + tamanhoDoNome + extra + comentario;
    if (path.posix.basename(nomeDaEntrada) !== nome || nomeDaEntrada.endsWith("/")) continue;
    if (comprimido === 0xffffffff || tamanho === 0xffffffff) throw new Error("zip64 não é aceito");
    if (visao.getUint32(local, true) !== 0x04034b50) throw new Error("o cabeçalho local do zip está corrompido");
    const inicio = local + 30 + visao.getUint16(local + 26, true) + visao.getUint16(local + 28, true);
    const bruto = zip.subarray(inicio, inicio + comprimido);
    const dados = metodo === 0 ? bruto : metodo === 8 ? new Uint8Array(inflateRawSync(bruto)) : null;
    if (dados === null) throw new Error(`método de compressão ${metodo} não é aceito`);
    if (dados.byteLength !== tamanho || Bun.hash.crc32(dados) !== crc) throw new Error(`${nome} saiu do zip corrompido`);
    return dados;
  }
  throw new Error(`${nome} não está no zip`);
}

async function lerDoTarGz(tarGz: Uint8Array, nome: string): Promise<Uint8Array> {
  for (const [caminho, arquivo] of await new Bun.Archive(tarGz).files()) {
    if (path.posix.basename(caminho) === nome) return new Uint8Array(await arquivo.arrayBuffer());
  }
  throw new Error(`${nome} não está no tar.gz`);
}

export function extrairExecutavel(arquivo: Uint8Array, url: string, nome: string): Promise<Uint8Array> {
  return url.endsWith(".zip") ? Promise.resolve(lerDoZip(arquivo, nome)) : lerDoTarGz(arquivo, nome);
}

/**
 * Baixa, confere, extrai e só então põe o executável no lugar com um `rename`. Até o
 * `rename`, tudo mora em arquivos `.baixando-*`, então uma queda no meio não deixa
 * binário pela metade em `destino`. `conferir` roda o executável novo antes do `rename`.
 */
export async function instalarExecutavel(opcoes: {
  readonly url: string;
  readonly sha256: string;
  readonly destino: string;
  readonly plataforma: NodeJS.Platform;
  readonly conferir: (executavel: string) => Promise<void>;
}): Promise<void> {
  const dirBin = path.dirname(opcoes.destino);
  const nome = path.basename(opcoes.destino);
  const id = crypto.randomUUID();
  const pacote = path.join(dirBin, `${PREFIXO_TEMPORARIO}${id}${opcoes.url.endsWith(".zip") ? ".zip" : ".tar.gz"}`);
  // Mantém a extensão: o Windows só executa `.exe`.
  const novo = path.join(dirBin, `${PREFIXO_TEMPORARIO}${id}-${nome}`);
  try {
    await baixarConferido(opcoes.url, opcoes.sha256, pacote);
    const executavel = await extrairExecutavel(await Bun.file(pacote).bytes(), opcoes.url, nome);
    await Bun.write(novo, executavel);
    if (opcoes.plataforma !== "win32") chmodSync(novo, 0o755);
    await opcoes.conferir(novo);
    trocarPorRename(novo, opcoes.destino);
  } finally {
    rmSync(pacote, { force: true });
    rmSync(novo, { force: true });
  }
}

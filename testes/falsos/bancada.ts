/**
 * Bancada dos testes de conector: uma pasta de dados temporária, o banco e o cofre de verdade,
 * e um `Ambiente` que aponta para os falsos. O código de produção não sabe que está em teste.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { caminhosDosDados, type Ambiente } from "../../nucleo/ambiente";
import { garantirInstalacao, prepararBanco, type BancoAberto } from "../../nucleo/banco";
import { abrirCofre, type Cofre } from "../../nucleo/cofre";
import { criarConectores, type Conectores, type OpcoesDosConectores } from "../../nucleo/conectores";
import { instante, type IdConectorUnico, type Instante, type RetratoDosConectores } from "../../nucleo/dominio";
import { criarSupervisor, type PoliticaDoPapel } from "../../nucleo/processos";
import { criarRegistro, type Registro } from "../../nucleo/registro";
import type { PedidoAoHospedeiro } from "./hospedeiro";
import type { ChamadaDoWacliFalso, RoteiroDoWacliFalso } from "./wacli";

export const WACLI_FALSO = join(import.meta.dir, "wacli.ts");
const HOSPEDEIRO = join(import.meta.dir, "hospedeiro.ts");
const REPO = join(import.meta.dir, "..", "..");
const LIMITE_DA_ESPERA_MS = 15_000;

/** Reinício rápido do espelho: o teste não espera os 2 s da política de produção. */
export const POLITICA_RAPIDA: Partial<PoliticaDoPapel> = { esperaInicialMs: 5, esperaMaximaMs: 20, quedasParaDesistir: 5 };

export interface Alvos {
  readonly crmRecurso?: URL;
  readonly crmClientId?: URL | null;
  readonly caExtra?: string | null;
  readonly porta?: number;
}

export interface Bancada {
  readonly dirDados: string;
  /** Pasta do roteiro e das chamadas do wacli falso. Fica fora da pasta de dados. */
  readonly dirFalso: string;
  readonly ambiente: Ambiente;
  readonly banco: BancoAberto;
  readonly cofre: Cofre;
  readonly registro: Registro;
  /** Linhas JSON que o código de produção mandou ao registro. */
  readonly linhasDoRegistro: string[];
  /** Adianta o relógio do `Ambiente`. */
  avancar(ms: number): void;
  roteiro(roteiro: RoteiroDoWacliFalso): void;
  /** Solta um passo `aguardar` do roteiro: é o vendedor com o celular na mão. */
  celular(sinal: string): void;
  chamadas(): readonly ChamadaDoWacliFalso[];
  /**
   * Sobe os conectores de produção sobre esta bancada. `outroCofre` troca o cofre, para simular um chaveiro com defeito.
   * A sincronização automática vem desligada: conectar é preparação nos outros testes, e só o teste dela a liga.
   */
  ligar(opcoes?: OpcoesDosConectores, outroCofre?: Cofre): Conectores;
  /**
   * Sobe os conectores em outro processo, executa `acoes`, espera o retrato satisfazer `quando`
   * e mata o processo sem aviso. É a queda do servidor: nenhum `parar()` roda.
   */
  quedaEm(acoes: PedidoAoHospedeiro["acoes"], quando: (estados: RetratoDosConectores) => boolean): Promise<RetratoDosConectores>;
  /** Todo o texto gravado na pasta de dados, menos o cofre. */
  textoDaPastaDeDados(): string;
  limpar(): Promise<void>;
}

export function abrirOBanco(dirDados: string, dirVazio: string, agora: Instante): BancoAberto {
  const caminhos = caminhosDosDados({ dirDados, plataforma: process.platform });
  const banco = prepararBanco({ caminho: caminhos.banco, caminhoDoVendedor: caminhos.bancoDoVendedor, dirBackups: caminhos.backups, pastaDoVendedor: dirVazio, agora });
  garantirInstalacao(banco, agora);
  return banco;
}

export function montarAmbiente(dirDados: string, dirFalso: string, alvos: Alvos, agora: () => Instante): Ambiente {
  return {
    plataforma: process.platform,
    dirRepo: REPO,
    dirDados,
    porta: alvos.porta ?? 47_115,
    wacli: [process.execPath, WACLI_FALSO, `--falso=${dirFalso}`],
    navegador: null,
    crmRecurso: alvos.crmRecurso ?? new URL("http://127.0.0.1:9/mcp"),
    crmClientId: alvos.crmClientId ?? null,
    caExtra: alvos.caExtra ?? null,
    agora,
  };
}

function lerArvore(dir: string, pular: (caminho: string) => boolean): string {
  let texto = "";
  for (const nome of readdirSync(dir)) {
    const caminho = join(dir, nome);
    if (pular(caminho)) continue;
    texto += statSync(caminho).isDirectory() ? lerArvore(caminho, pular) : `\n${caminho}\n${readFileSync(caminho).toString("latin1")}`;
  }
  return texto;
}

export function montarBancada(alvos: Alvos = {}): Bancada {
  const raiz = mkdtempSync(join(tmpdir(), "secretaria-conectores-"));
  const dirDados = join(raiz, "dados");
  const dirFalso = join(raiz, "falso");
  const dirVazio = join(raiz, "sem-migracoes");
  for (const dir of [dirDados, dirFalso, dirVazio]) mkdirSync(dir, { recursive: true });

  let adiantado = 0;
  const agora = () => instante(new Date(Date.now() + adiantado));
  const ambiente = montarAmbiente(dirDados, dirFalso, alvos, agora);
  const linhasDoRegistro: string[] = [];
  const registro = criarRegistro({ escrever: (linha) => linhasDoRegistro.push(linha), agora });
  const cofre = abrirCofre({ backend: "arquivo", idInstalacao: "bancada", dirDados });
  const ligados: Conectores[] = [];
  let banco = abrirOBanco(dirDados, dirVazio, agora());
  writeFileSync(join(dirFalso, "roteiro.json"), JSON.stringify({ auth: [], sync: [] }));

  return {
    dirDados,
    dirFalso,
    ambiente,
    get banco() {
      return banco;
    },
    cofre,
    registro,
    linhasDoRegistro,
    avancar: (ms) => {
      adiantado += ms;
    },
    roteiro: (roteiro) => writeFileSync(join(dirFalso, "roteiro.json"), JSON.stringify(roteiro)),
    celular: (sinal) => writeFileSync(join(dirFalso, sinal), ""),
    chamadas() {
      const arquivo = join(dirFalso, "chamadas.ndjson");
      if (!existsSync(arquivo)) return [];
      return readFileSync(arquivo, "utf8")
        .split("\n")
        .filter((linha) => linha !== "")
        .map((linha) => JSON.parse(linha) as ChamadaDoWacliFalso);
    },
    ligar(opcoes = {}, outroCofre = cofre) {
      const supervisor =
        opcoes.supervisor ??
        criarSupervisor({ registro, politica: { "whatsapp.espelho": POLITICA_RAPIDA, "whatsapp.pareamento": POLITICA_RAPIDA } });
      const conectores = criarConectores(ambiente, banco, outroCofre, { registro, sincronizacaoAutomatica: false, ...opcoes, supervisor });
      ligados.push(conectores);
      return conectores;
    },
    async quedaEm(acoes, quando) {
      // O banco tem um dono só: o hospedeiro só abre depois de esta bancada soltar.
      banco.fechar();
      const pedido: PedidoAoHospedeiro = {
        dirDados,
        dirFalso,
        dirVazio,
        crmRecurso: alvos.crmRecurso?.href ?? null,
        crmClientId: alvos.crmClientId?.href ?? null,
        caExtra: alvos.caExtra ?? null,
        acoes,
      };
      const arquivo = join(dirFalso, "pedido-ao-hospedeiro.json");
      writeFileSync(arquivo, JSON.stringify(pedido));
      const hospedeiro = Bun.spawn([process.execPath, HOSPEDEIRO, arquivo], { stdin: "ignore", stdout: "pipe", stderr: "inherit" });
      try {
        const decodificador = new TextDecoder();
        let resto = "";
        for await (const bloco of hospedeiro.stdout) {
          resto += decodificador.decode(bloco, { stream: true });
          const linhas = resto.split("\n");
          resto = linhas.pop() ?? "";
          for (const linha of linhas) {
            const estados = JSON.parse(linha) as RetratoDosConectores;
            if (quando(estados)) return estados;
          }
        }
        throw new Error("o hospedeiro saiu antes de chegar ao estado esperado");
      } finally {
        if (process.platform === "win32") hospedeiro.kill();
        else hospedeiro.kill("SIGKILL");
        await hospedeiro.exited;
        banco = abrirOBanco(dirDados, dirVazio, agora());
      }
    },
    textoDaPastaDeDados: () => lerArvore(dirDados, (caminho) => caminho === join(dirDados, "cofre.json")),
    async limpar() {
      await Promise.all(ligados.splice(0).map((conectores) => conectores.parar()));
      banco.fechar();
      rmSync(raiz, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

/**
 * Espera o retrato dos conectores satisfazer `quando`. Não é um sleep: resolve na mudança de
 * estado que satisfaz a condição, e o limite só existe para o teste falhar com o estado na mão.
 */
export function esperar(conectores: Conectores, quando: (estados: RetratoDosConectores) => boolean, descricao: string): Promise<RetratoDosConectores> {
  return new Promise((resolver, rejeitar) => {
    const conferir = (estados: RetratoDosConectores) => {
      if (!quando(estados)) return false;
      clearTimeout(limite);
      cancelar();
      resolver(estados);
      return true;
    };
    const cancelar = conectores.assinar(conferir);
    const limite = setTimeout(() => {
      cancelar();
      rejeitar(new Error(`não chegou a "${descricao}". Estado: ${JSON.stringify(conectores.estado())}`));
    }, LIMITE_DA_ESPERA_MS);
    conferir(conectores.estado());
  });
}

/**
 * Resolve quando os efeitos pendentes do conector terminaram (cofre, banco, processos).
 * O retrato muda antes de os efeitos rodarem; `cancelar` numa fase durável não muda nada e
 * responde só depois de a fila esvaziar, então serve de ponto de espera.
 */
export async function efeitosAssentados(conectores: Conectores, id: IdConectorUnico): Promise<void> {
  const fase = conectores.estado()[id].fase;
  if (fase !== "desconectado" && fase !== "conectado" && fase !== "atencao") throw new Error(`"${fase}" não é fase durável`);
  await conectores.agir(id, "cancelar");
}

/** O mesmo para uma conta de e-mail, pelo id. */
export async function contaAssentada(conectores: Conectores, id: string): Promise<void> {
  const conta = conectores.estado().email.contas.find((c) => c.id === id);
  if (conta === undefined) throw new Error(`a conta ${id} não existe`);
  const fase = conta.estado.fase;
  if (fase !== "desconectado" && fase !== "conectado" && fase !== "atencao") throw new Error(`"${fase}" não é fase durável`);
  await conectores.email.agir(id, "cancelar");
}

/** O resultado cru de `process.kill(pid, 0)`: é o que o log do CI precisa mostrar quando um assert de vida falha. */
export function sondar(pid: number): { readonly pid: number; readonly vivo: boolean; readonly erro: string | null } {
  try {
    process.kill(pid, 0);
    return { pid, vivo: true, erro: null };
  } catch (erro) {
    return { pid, vivo: false, erro: (erro as NodeJS.ErrnoException).code ?? String(erro) };
  }
}

export function vivo(pid: number): boolean {
  return sondar(pid).vivo;
}


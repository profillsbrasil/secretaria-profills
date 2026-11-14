import type { Server } from "bun";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, rmSync } from "node:fs";
import { release } from "node:os";
import { join } from "node:path";
import pacote from "../../package.json";
import { caminhosDosDados, fecharPastaDeDados, type Ambiente } from "../ambiente";
import { backupDoDia, definirBackendDoCofre, garantirInstalacao, prepararBanco, type BancoAberto } from "../banco";
import { PRAZO_DO_COFRE_MS, abrirCofre, comPrazo, escolherBackend, sondarCofreDoSistema, type Cofre } from "../cofre";
import { criarConectores, type Conectores } from "../conectores";
import { CONECTORES_UNICOS, diaEm, falha, montarEstadoPainel, saida, type EstadoPainel, type Instalacao } from "../dominio";
import { criarSupervisor, type Supervisor } from "../processos";
import { criarRegistro, type Registro } from "../registro";
import { anunciarPid, apagarArquivoDoServidor, apagarPid, assumirPid, gravarArquivoDoServidor } from "./arquivo";
import { encerrarGravacoesInterrompidas } from "./escritas";
import { criarPublicador, type Publicador } from "./eventos";
import { construirPainel } from "./painel";
import { criarAtendimento, montarRotas, type Atender, type Diagnostico, type EstadoDoBackup, type Info } from "./rotas";
import { criarSessoes } from "./sessoes";
import { lerTravas } from "./travas";

export { BancoEmUso } from "../banco";
export { CofreIndisponivel } from "../cofre";
export { lerArquivoDoServidor, lerPidDoServidor, type ArquivoDoServidor } from "./arquivo";
export { LIMITE_DO_CORPO } from "./guarda";
export { INTERVALO_MINIMO_MS, criarPublicador, type Relogio } from "./eventos";
export type { ContaNoDiagnostico, Diagnostico, EstadoDoBackup, Info, ItemIgnorado, RespostaDaTarefa } from "./rotas";

export const VERSAO_DO_NUCLEO: string = pacote.version;

/** Sistema operacional e Bun, lidos sem a pasta de dados: o `diagnostico` sem servidor também os devolve. */
export function lerSistema(): Diagnostico["sistema"] {
  return { plataforma: process.platform, arquitetura: process.arch, versao: release(), bun: Bun.version };
}
/** Porta preferida ocupada por outro programa: tenta as seguintes. */
const PORTAS_DE_RESERVA = 9;

export interface ServidorRodando {
  readonly origem: string;
  readonly porta: number;
  readonly idInstalacao: string;
  /** Resolve quando a reconciliação de boot dos conectores terminou. */
  readonly pronto: Promise<void>;
  /** Resolve quando o servidor terminou de parar, por `parar()` ou por pedido do agente. */
  readonly parado: Promise<void>;
  /** Encerra conectores, processos filhos, SSE e banco, nessa ordem. Idempotente. */
  parar(): Promise<void>;
}

export interface OpcoesDoServidor {
  readonly registro?: Registro;
  readonly supervisor?: Supervisor;
  /** Troca o cofre, para o teste simular um chaveiro que não responde. */
  readonly abrirCofre?: typeof abrirCofre;
  readonly prazoDoCofreMs?: number;
  /** Só o teste desliga. Ver `OpcoesDosConectores.sincronizacaoAutomatica`. */
  readonly sincronizacaoAutomatica?: boolean;
}

/** O servidor escreve uma linha JSON por evento em `<dados>/logs/servidor.log`. */
function registroEmArquivo(dirLogs: string): Registro {
  const arquivo = join(dirLogs, "servidor.log");
  return criarRegistro({ escrever: (linha) => appendFileSync(arquivo, `${linha}\n`, { mode: 0o600 }), agora: () => new Date().toISOString() });
}

function abrirPorta(porta: number, atender: Atender): Server<unknown> {
  const tentativas = porta === 0 ? [0] : Array.from({ length: PORTAS_DE_RESERVA + 1 }, (_, i) => porta + i);
  let ultimoErro: unknown = null;
  for (const tentativa of tentativas) {
    try {
      // Com `development: false`, o Bun 1.4.4 sem `reusePort` divide a porta com outro servidor que a escuta, ao contrário do que a doc diz.
      return Bun.serve({ hostname: "127.0.0.1", port: tentativa, development: false, reusePort: false, fetch: atender });
    } catch (erro) {
      if ((erro as { code?: string }).code !== "EADDRINUSE") throw erro;
      ultimoErro = erro;
    }
  }
  throw ultimoErro;
}

/**
 * Sobe tudo, nesta ordem: pid, banco (é a trava de instância), instalação, cofre, painel, porta,
 * conectores e `servidor.json`. Outra instância na mesma pasta de dados falha em `BancoEmUso`
 * antes de tocar em porta ou arquivo, então a primeira segue de pé. Toda chamada ao cofre tem
 * prazo: chaveiro que não responde no boot vira `CofreIndisponivel`, e o banco é solto.
 */
export async function iniciarServidor(ambiente: Ambiente, opcoes: OpcoesDoServidor = {}): Promise<ServidorRodando> {
  const caminhos = caminhosDosDados(ambiente);
  fecharPastaDeDados(ambiente);
  const registro = opcoes.registro ?? registroEmArquivo(caminhos.logs);
  const prazoDoCofreMs = opcoes.prazoDoCofreMs ?? PRAZO_DO_COFRE_MS;
  anunciarPid(caminhos.pid);
  let banco: BancoAberto;
  try {
    banco = prepararBanco({
      caminho: caminhos.banco,
      caminhoDoVendedor: caminhos.bancoDoVendedor,
      dirBackups: caminhos.backups,
      pastaDoVendedor: join(ambiente.dirRepo, "meu", "migracoes"),
      agora: ambiente.agora(),
    });
  } catch (erro) {
    apagarPid(caminhos.pid);
    throw erro;
  }
  assumirPid(caminhos.pid);
  // Com o banco, nenhum outro servidor desta pasta está vivo. O `servidor.json` que sobrou de um que
  // morreu sem `parar` faria o CLI achar este servidor com o pid e o Bearer do morto.
  rmSync(caminhos.servidor, { force: true });

  let servidor: Server<unknown> | null = null;
  let conectores: Conectores | null = null;
  let publicador: Publicador | null = null;
  let atender: Atender | null = null;
  try {
    const dados = garantirInstalacao(banco, ambiente.agora());
    const aberto = banco;
    let backup: EstadoDoBackup = { dia: null, arquivo: null, aviso: null };
    const garantirBackup = (): void => {
      const hoje = diaEm(ambiente.agora());
      if (backup.dia === hoje && backup.aviso === null) return;
      try {
        backup = { dia: hoje, arquivo: backupDoDia(aberto, caminhos.backups, hoje).arquivo, aviso: null };
      } catch (erro) {
        const motivo = erro instanceof Error ? erro.message : String(erro);
        backup = { ...backup, aviso: `O backup de ${hoje} falhou: ${motivo}` };
        registro.aviso("servidor.backup_falhou", { dia: hoje, erro: erro instanceof Error ? erro.name : typeof erro });
      }
    };
    garantirBackup();
    const interrompidas = encerrarGravacoesInterrompidas(banco, ambiente.agora());
    if (interrompidas > 0) registro.aviso("servidor.escrita_interrompida", { cartoes: interrompidas });
    let backend = dados.cofreBackend;
    if (backend === null) {
      backend = await escolherBackend(sondarCofreDoSistema, prazoDoCofreMs);
      definirBackendDoCofre(banco, backend);
    }
    const cofre: Cofre = comPrazo((opcoes.abrirCofre ?? abrirCofre)({ backend, idInstalacao: dados.id, dirDados: ambiente.dirDados }), prazoDoCofreMs);
    const sessoes = await criarSessoes(cofre);
    const painel = await construirPainel();
    const token = randomBytes(32).toString("base64url");
    const instalacao: Instalacao = { id: dados.id, versaoNucleo: VERSAO_DO_NUCLEO, criadaEm: dados.criadaEm };

    servidor = abrirPorta(ambiente.porta, (req, server) => {
      if (atender === null) return Promise.resolve(Response.json(saida(falha("servidor_fora_do_ar")), { status: 503 }));
      return atender(req, server).catch((erro: unknown) => {
        registro.erro("servidor.pedido_falhou", { erro: erro instanceof Error ? erro.name : typeof erro });
        return Response.json(saida(falha("interno")), { status: 500, headers: { "Cache-Control": "no-store" } });
      });
    });
    const porta = servidor.port ?? ambiente.porta;
    const origem = `http://127.0.0.1:${porta}`;
    const supervisor = opcoes.supervisor ?? criarSupervisor({ plataforma: ambiente.plataforma, registro });
    const ligados = criarConectores({ ...ambiente, porta }, banco, cofre, {
      registro,
      supervisor,
      ...(opcoes.sincronizacaoAutomatica === undefined ? {} : { sincronizacaoAutomatica: opcoes.sincronizacaoAutomatica }),
    });
    conectores = ligados;
    const retrato = (): EstadoPainel => montarEstadoPainel(instalacao, ligados.estado());
    const publicando = criarPublicador(retrato);
    publicador = publicando;
    ligados.assinar(() => publicando.mudou());
    ligados.assinarSincronizacao((andamento) => publicando.sincronizacao(andamento));

    const guarda = { origem, token, sessoes };
    const info: Info = { app: "secretaria-profills", versaoNucleo: VERSAO_DO_NUCLEO, idInstalacao: dados.id };
    const diagnostico = (): Diagnostico => {
      const estados = ligados.estado();
      const painelAtual = retrato();
      const executavel = ambiente.wacli[0] ?? "";
      return {
        instalacao,
        servidor: { origem, pid: process.pid, dirDados: ambiente.dirDados },
        cofre: cofre.backend,
        wacli: { executavel, existe: existsSync(executavel) },
        processos: supervisor.pids(),
        conectores: Object.fromEntries(
          CONECTORES_UNICOS.map((id) => [id, { fase: estados[id].fase, acoes: painelAtual.conectores[id].acoes }]),
        ) as Diagnostico["conectores"],
        email: {
          pulado: painelAtual.email.pulado,
          contas: painelAtual.email.contas.map((conta) => ({
            id: conta.id,
            rotulo: conta.rotulo,
            provedor: conta.provedor,
            endereco: conta.config.endereco,
            servidor: conta.config.servidor,
            porta: conta.config.porta,
            janelaDias: conta.janelaDias,
            fase: conta.estado.fase,
            acoes: conta.acoes,
          })),
        },
        backup,
        travas: lerTravas(ambiente.dirRepo),
        sistema: lerSistema(),
      };
    };

    let parando: Promise<void> | null = null;
    let avisarParado: () => void = () => {};
    const parado = new Promise<void>((resolver) => {
      avisarParado = resolver;
    });
    const ouvindo = servidor;
    const parar = (): Promise<void> => {
      parando ??= (async () => {
        registro.info("servidor.parando", {});
        await ligados.parar();
        publicando.fechar();
        // Parada educada deixa a última resposta (a do pedido de parada) sair; depois de 2 s, força.
        let limite: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([ouvindo.stop(), new Promise<void>((resolver) => (limite = setTimeout(resolver, 2_000)))]);
        clearTimeout(limite);
        await ouvindo.stop(true);
        banco.fechar();
        apagarArquivoDoServidor(caminhos.servidor, token);
        apagarPid(caminhos.pid);
        registro.info("servidor.parado", {});
        avisarParado();
      })();
      return parando;
    };

    const rotas = montarRotas({
      guarda,
      sessoes,
      conectores: ligados,
      publicador: publicando,
      painel,
      info,
      banco: aberto,
      agora: ambiente.agora,
      garantirBackup,
      retrato,
      diagnostico,
      pedirParada: () => {
        setTimeout(() => void parar(), 0);
      },
    });
    atender = criarAtendimento(rotas, guarda);
    gravarArquivoDoServidor(caminhos.servidor, { v: 1, origem, pid: process.pid, idInstalacao: dados.id, token });
    registro.info("servidor.no_ar", { porta, pid: process.pid });

    return { origem, porta, idInstalacao: dados.id, pronto: ligados.pronto, parado, parar };
  } catch (erro) {
    await conectores?.parar();
    publicador?.fechar();
    await servidor?.stop(true);
    banco.fechar();
    apagarPid(caminhos.pid);
    registro.erro("servidor.boot_falhou", { erro: erro instanceof Error ? erro.name : typeof erro });
    throw erro;
  }
}

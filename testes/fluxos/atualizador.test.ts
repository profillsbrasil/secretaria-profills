/**
 * O atualizador em processos de verdade, numa instalação mínima em pasta temporária com a própria
 * pasta de dados: o `main.ts` da versão nova troca a pasta, roda o `instalar` e sobe o servidor.
 * Na queda, quem volta é o `bun secretaria abrir` da própria instalação, como o vendedor o roda.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { atualizar, caminhosDoAtualizador, efeitosReais, lerAndamento, recuperar, type Andamento } from "../../nucleo/atualizador";
import { bancoEmUso } from "../../nucleo/banco/abrir";
import { COMANDOS } from "../../nucleo/cli/comandos";
import { ERROS, type Resultado } from "../../nucleo/dominio";
import { encerrarPid, vivo } from "../../nucleo/processos";
import { montarInstalacao, retratoDaPasta, type InstalacaoMinima } from "../falsos/instalacao-minima";

const REPO = join(import.meta.dir, "..", "..");
const PRAZO_DO_TESTE_MS = 60_000;
const PRAZO_DA_ESPERA_MS = 20_000;
const INTERVALO_DA_ESPERA_MS = 25;

let instalacao: InstalacaoMinima;
let soltos: number[] = [];
afterEach(async () => {
  for (const pid of soltos.splice(0)) await encerrarPid(pid, { educado: false });
  await instalacao.limpar();
});

const ambienteDaInstalacao = () => ({ ...process.env, SECRETARIA_DADOS: instalacao.dirDados });

function rodarProcesso(argv: string[]): { readonly codigo: number | null; readonly stdout: string; readonly stderr: string } {
  const feito = Bun.spawnSync(argv, { cwd: instalacao.raiz, env: ambienteDaInstalacao(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { codigo: feito.exitCode, stdout: feito.stdout.toString(), stderr: feito.stderr.toString() };
}

async function esperar(condicao: () => boolean, oQue: string): Promise<void> {
  const fim = Date.now() + PRAZO_DA_ESPERA_MS;
  while (!condicao()) {
    if (Date.now() >= fim) throw new Error(`${oQue} não aconteceu em ${PRAZO_DA_ESPERA_MS} ms`);
    await Bun.sleep(INTERVALO_DA_ESPERA_MS);
  }
}

/** O pid que um processo da instalação mínima anunciou na pasta de dados. O teste o encerra no fim, se sobrar. */
async function pidAnunciado(nome: string): Promise<number> {
  const arquivo = join(instalacao.dirDados, nome);
  await esperar(() => existsSync(arquivo), `o anúncio ${nome}`);
  const pid = Number(readFileSync(arquivo, "utf8"));
  soltos.push(pid);
  return pid;
}

/** Processo que não é filho do teste some depois de quem o adotou recolher: só resta conferir. */
async function morreu(pid: number): Promise<boolean> {
  try {
    await esperar(() => !vivo(pid), `a morte do pid ${pid}`);
    return true;
  } catch {
    return false;
  }
}

/** O Windows solta o lock da trava depois que o processo morto some. */
const travaLivre = () => esperar(() => !bancoEmUso(caminhosDoAtualizador(instalacao.raiz, instalacao.dirDados).trava), "a trava livre");

/** O atualizador como o servidor o sobe: o arquivo que veio na versão nova, com a raiz e a pasta de dados. */
function atualizarPelaNova() {
  return rodarProcesso([process.execPath, join(instalacao.nova, "nucleo", "atualizador", "main.ts"), "--repo", instalacao.raiz, "--dados", instalacao.dirDados]);
}

function andamentoNoDisco(): Andamento {
  const lido = lerAndamento(caminhosDoAtualizador(instalacao.raiz, instalacao.dirDados).andamento);
  if (lido.tipo !== "lido") throw new Error(`o andamento está ${lido.tipo}`);
  return lido.andamento;
}

const abrir = COMANDOS.find((comando) => comando.nome === "abrir");

/** `bun secretaria abrir` num processo, na pasta da instalação: o `package.json` e o CLI são os que estiverem nela. */
function rodarAbrir(): Resultado<unknown> {
  const saida = rodarProcesso([process.execPath, "run", "secretaria", "abrir", "--sem-navegador", "--json"]);
  const ultima = saida.stdout.trimEnd().split("\n").at(-1) ?? "";
  try {
    return JSON.parse(ultima) as Resultado<unknown>;
  } catch {
    throw new Error(`o abrir saiu com ${saida.codigo} sem resposta: ${saida.stderr}${saida.stdout}`);
  }
}

describe("a instalação mínima", () => {
  test(
    "pararServidor só volta com os bancos livres, também quando o lock sai depois do processo, como no Windows",
    async () => {
      instalacao = montarInstalacao();
      const segurador = Bun.spawn([process.execPath, join(REPO, "testes", "falsos", "banco-que-solta-tarde.ts"), instalacao.dirDados, "1000"], { stdout: "pipe", stderr: "inherit" });
      const { value } = await segurador.stdout.getReader().read();
      expect(new TextDecoder().decode(value)).toBe("pronto\n");
      expect(instalacao.pidDoServidor()).not.toBeNull();

      await instalacao.pararServidor();

      expect(instalacao.retratoDosBancos()).toMatchObject({ nucleo: { notas: [{ texto: "anotado antes da atualização" }] }, meu: { visitas: [{ cliente: "cliente do vendedor" }] } });
      expect(await segurador.exited).toBe(0);
    },
    PRAZO_DO_TESTE_MS,
  );
});

describe("o atualizador num processo próprio", () => {
  test(
    "a 0.1.0 vira a 0.2.0: o servidor novo responde, a migração nova rodou e o que é do vendedor fica igual byte a byte",
    async () => {
      instalacao = montarInstalacao();
      const doVendedor = instalacao.doVendedor();
      const daNova = retratoDaPasta(instalacao.nova);

      const saida = atualizarPelaNova();

      if (saida.codigo !== 0) throw new Error(`o atualizador saiu com ${saida.codigo}: ${saida.stderr}${saida.stdout}`);
      expect(JSON.parse(saida.stdout)).toMatchObject({ tipo: "concluida", andamento: { de: "0.1.0", para: "0.2.0", fase: "concluido" } });
      expect(saida.codigo).toBe(0);
      expect(await instalacao.versaoNoAr()).toBe("0.2.0");
      expect(instalacao.pidDoServidor()).not.toBeNull();
      expect(instalacao.doVendedor()).toEqual(doVendedor);
      const depois = retratoDaPasta(instalacao.raiz);
      expect(Object.fromEntries(Object.entries(depois).filter(([caminho]) => !(caminho in doVendedor)))).toEqual(daNova);

      await instalacao.pararServidor();
      expect(instalacao.retratoDosBancos()).toMatchObject({
        nucleo: { migracoes: [{ tag: "0001_base" }, { tag: "0002_nova" }], notas: [{ texto: "anotado antes da atualização" }] },
        meu: { visitas: [{ cliente: "cliente do vendedor" }] },
      });
    },
    PRAZO_DO_TESTE_MS,
  );

  test(
    "o instalar da versão nova falha depois de migrar: a 0.1.0 volta ao ar com o banco de antes",
    async () => {
      instalacao = montarInstalacao({ naNova: { "instalar-falha": "" } });
      const pasta = retratoDaPasta(instalacao.raiz);
      const daNova = retratoDaPasta(instalacao.nova);
      const bancos = instalacao.retratoDosBancos();

      const saida = atualizarPelaNova();

      expect(JSON.parse(saida.stdout)).toMatchObject({
        tipo: "desfeita",
        servidorNoAr: true,
        andamento: { fase: "desfeito", falha: { passo: "instalar", motivo: "instalar_falhou" } },
      });
      expect(saida.codigo).toBe(1);
      expect(await instalacao.versaoNoAr()).toBe("0.1.0");
      expect(retratoDaPasta(instalacao.raiz)).toEqual(pasta);
      expect(retratoDaPasta(instalacao.nova)).toEqual(daNova);
      await instalacao.pararServidor();
      expect(instalacao.retratoDosBancos()).toEqual(bancos);
    },
    PRAZO_DO_TESTE_MS,
  );
});

describe("matar o atualizador e rodar abrir volta à 0.1.0", () => {
  const quedas: readonly (readonly [string, { readonly fase: string; readonly entrada?: string; readonly naNova?: Record<string, string>; readonly passo: string; readonly motivo: string }])[] = [
    ["ao esperar o banco", { fase: "esperar_banco", passo: "esperar_banco", motivo: "interrompida" }],
    ["ao preparar", { fase: "preparar", passo: "preparar", motivo: "interrompida" }],
    ["ao copiar", { fase: "copiar", passo: "copiar", motivo: "interrompida" }],
    ["ao começar a troca", { fase: "trocar", passo: "trocar", motivo: "interrompida" }],
    ["com as dependências antigas já fora e as novas ainda não no lugar", { fase: "trocar", entrada: "node_modules", passo: "trocar", motivo: "interrompida" }],
    ["com o núcleo antigo já fora e o novo ainda não no lugar", { fase: "trocar", entrada: "nucleo", passo: "trocar", motivo: "interrompida" }],
    ["no meio da troca do package.json", { fase: "trocar", entrada: "package.json", passo: "trocar", motivo: "interrompida" }],
    ["no meio da troca, depois das permissões", { fase: "trocar", entrada: ".claude/settings.json", passo: "trocar", motivo: "interrompida" }],
    ["antes do instalar", { fase: "instalar", passo: "instalar", motivo: "interrompida" }],
    ["depois de migrar o banco, antes de subir", { fase: "subir", passo: "subir", motivo: "interrompida" }],
    ["no meio da volta de um instalar que falhou", { fase: "desfazer", naNova: { "instalar-falha": "" }, passo: "instalar", motivo: "instalar_falhou" }],
    ["na volta, com o núcleo novo já fora e o antigo ainda não no lugar", { fase: "desfazer", entrada: "nucleo", naNova: { "instalar-falha": "" }, passo: "instalar", motivo: "instalar_falhou" }],
  ];

  test.each(quedas)(
    "queda %s",
    async (_nome, queda) => {
      instalacao = montarInstalacao({ naNova: queda.naNova });
      const pasta = retratoDaPasta(instalacao.raiz);
      const daNova = retratoDaPasta(instalacao.nova);
      const bancos = instalacao.retratoDosBancos();

      rodarProcesso([process.execPath, join(REPO, "testes", "falsos", "atualizador-que-cai.ts"), instalacao.raiz, instalacao.dirDados, queda.fase, queda.entrada ?? ""]);
      expect(andamentoNoDisco().fase).toBe(queda.fase as Andamento["fase"]);
      expect(instalacao.pidDoServidor()).toBeNull();

      const aberto = rodarAbrir();

      expect(aberto).toMatchObject({ ok: true, dados: { subiu: true, atualizacaoDesfeita: { de: "0.1.0", para: "0.2.0" } } });
      expect(abrir?.descrever(aberto.ok ? aberto.dados : null)).toStartWith("Uma atualização da Secretária parou no meio e foi desfeita: ela segue na versão 0.1.0.");
      expect(await instalacao.versaoNoAr()).toBe("0.1.0");
      expect(andamentoNoDisco()).toMatchObject({ fase: "desfeito", falha: { passo: queda.passo, motivo: queda.motivo } });
      expect(retratoDaPasta(instalacao.raiz)).toEqual(pasta);
      expect(retratoDaPasta(instalacao.nova)).toEqual(daNova);

      const deNovo = rodarAbrir();
      expect(deNovo).toMatchObject({ ok: true, dados: { subiu: false } });
      expect(deNovo.ok && (deNovo.dados as { atualizacaoDesfeita?: unknown }).atualizacaoDesfeita).toBeUndefined();

      await instalacao.pararServidor();
      expect(instalacao.retratoDosBancos()).toEqual(bancos);
    },
    PRAZO_DO_TESTE_MS,
  );

  test(
    "abrir com o atualizador vivo responde atualizacao_em_andamento e não mexe em nada",
    async () => {
      instalacao = montarInstalacao();
      let chegou = () => {};
      let soltar = () => {};
      const noInstalar = new Promise<void>((resolver) => (chegou = resolver));
      const segurando = new Promise<void>((resolver) => (soltar = resolver));
      const reais = efeitosReais();
      const atualizando = atualizar(
        { raizDoRepo: instalacao.raiz, dirDados: instalacao.dirDados },
        {
          ...reais,
          iniciarInstalar(raizDoRepo, dirDados) {
            chegou();
            return { pid: undefined, fim: segurando.then(() => reais.iniciarInstalar(raizDoRepo, dirDados).fim) };
          },
        },
      );
      await noInstalar;

      const aberto = rodarAbrir();
      expect(aberto).toMatchObject({ ok: false, erro: { codigo: "atualizacao_em_andamento" } });
      expect(instalacao.pidDoServidor()).toBeNull();

      soltar();
      expect((await atualizando).tipo).toBe("concluida");
      expect(await instalacao.versaoNoAr()).toBe("0.2.0");
    },
    PRAZO_DO_TESTE_MS,
  );

  test(
    "abrir com um servidor no ar no meio da troca responde servidor_preso e não mexe em nada",
    async () => {
      instalacao = montarInstalacao();
      expect(rodarAbrir()).toMatchObject({ ok: true, dados: { subiu: true } });
      const { andamento } = caminhosDoAtualizador(instalacao.raiz, instalacao.dirDados);
      await Bun.write(andamento, JSON.stringify({ v: 1, de: "0.1.0", para: "0.2.0", iniciadoEm: "2026-11-14T10:00:00.000Z", atualizadoEm: "2026-11-14T10:00:00.000Z", fase: "trocar", trocas: [], restaurarDados: false, mudados: null, falha: null }));
      const pasta = retratoDaPasta(instalacao.raiz);

      expect(rodarAbrir()).toMatchObject({ ok: false, erro: { codigo: "servidor_preso" } });
      expect(andamentoNoDisco().fase).toBe("trocar");
      expect(retratoDaPasta(instalacao.raiz)).toEqual(pasta);
      expect(await instalacao.versaoNoAr()).toBe("0.1.0");
    },
    PRAZO_DO_TESTE_MS,
  );

  test(
    "abrir com o servidor da versão nova já no ar só grava o fim da atualização",
    async () => {
      instalacao = montarInstalacao();
      rodarProcesso([process.execPath, join(REPO, "testes", "falsos", "atualizador-que-cai.ts"), instalacao.raiz, instalacao.dirDados, "concluido-nunca"]);
      expect(andamentoNoDisco().fase).toBe("subir");
      expect(await instalacao.versaoNoAr()).toBe("0.2.0");

      const aberto = rodarAbrir();

      expect(aberto).toMatchObject({ ok: true, dados: { subiu: false } });
      expect(andamentoNoDisco()).toMatchObject({ fase: "concluido", falha: null });
      expect(await instalacao.versaoNoAr()).toBe("0.2.0");
    },
    PRAZO_DO_TESTE_MS,
  );
});

describe("matar o atualizador com o instalar da versão nova ainda vivo", () => {
  test.each([
    ["antes de abrir o banco", "antes"],
    ["com o banco na mão", "com-o-banco"],
  ])(
    "instalar parado %s: abrir o encerra antes de voltar à 0.1.0",
    async (_nome, quando) => {
      instalacao = montarInstalacao({ naNova: { "instalar-espera": quando } });
      const pasta = retratoDaPasta(instalacao.raiz);
      const daNova = retratoDaPasta(instalacao.nova);
      const bancos = instalacao.retratoDosBancos();
      const atualizador = Bun.spawn([process.execPath, join(instalacao.nova, "nucleo", "atualizador", "main.ts"), "--repo", instalacao.raiz, "--dados", instalacao.dirDados], {
        cwd: instalacao.raiz,
        env: ambienteDaInstalacao(),
        stdio: ["ignore", "ignore", "ignore"],
      });
      const instalar = await pidAnunciado("instalar-comecou");
      atualizador.kill(process.platform === "win32" ? undefined : "SIGKILL");
      await atualizador.exited;
      await travaLivre();

      const aberto = rodarAbrir();

      expect(aberto).toMatchObject({ ok: true, dados: { subiu: true, atualizacaoDesfeita: { de: "0.1.0", para: "0.2.0" } } });
      expect(await morreu(instalar)).toBe(true);
      expect(await instalacao.versaoNoAr()).toBe("0.1.0");
      expect(andamentoNoDisco()).toMatchObject({ fase: "desfeito", falha: { passo: "instalar", motivo: "interrompida" } });
      expect(retratoDaPasta(instalacao.raiz)).toEqual(pasta);
      expect(retratoDaPasta(instalacao.nova)).toEqual(daNova);
      await instalacao.pararServidor();
      expect(instalacao.retratoDosBancos()).toEqual(bancos);
    },
    PRAZO_DO_TESTE_MS,
  );

  test(
    "encerrar o instalar encerra também os processos que ele subiu",
    async () => {
      instalacao = montarInstalacao();
      writeFileSync(join(instalacao.raiz, "instalar-com-neto"), "");
      const efeitos = efeitosReais();

      const instalando = efeitos.iniciarInstalar(instalacao.raiz, instalacao.dirDados);
      if (instalando.pid === undefined) throw new Error("o instalar não nasceu");
      soltos.push(instalando.pid);
      const neto = await pidAnunciado("neto");
      expect(efeitos.existe(instalando.pid)).toBe(true);

      expect(await efeitos.encerrarArvore(instalando.pid)).toBe(true);

      expect(await instalando.fim).toMatchObject({ ok: false });
      expect(efeitos.existe(instalando.pid)).toBe(false);
      expect(await morreu(neto)).toBe(true);
    },
    PRAZO_DO_TESTE_MS,
  );
});

describe("queda com o servidor da versão nova ainda nascendo", () => {
  /** O atualizador morre logo depois de subir o servidor da 0.2.0, que para antes de abrir o banco. */
  async function cairComOServidorNascendo(): Promise<number> {
    instalacao = montarInstalacao({ naNova: { "servidor-espera": "" } });
    rodarProcesso([process.execPath, join(REPO, "testes", "falsos", "atualizador-que-cai.ts"), instalacao.raiz, instalacao.dirDados, "servidor-nascendo"]);
    expect(andamentoNoDisco().fase).toBe("subir");
    const servidor = await pidAnunciado("servidor-comecou");
    await travaLivre();
    return servidor;
  }

  test(
    "a volta espera o servidor responder e só grava o fim",
    async () => {
      await cairComOServidorNascendo();
      const reais = efeitosReais();

      const volta = await recuperar(
        { raizDoRepo: instalacao.raiz, dirDados: instalacao.dirDados, versaoNoAr: null },
        {
          ...reais,
          // A sonda só roda com a volta já esperando o servidor: é aí que ele segue.
          async versaoNoAr(dirDados, pid) {
            writeFileSync(join(instalacao.dirDados, "servidor-siga"), "");
            return reais.versaoNoAr(dirDados, pid);
          },
        },
      );

      expect(volta).toEqual({ tipo: "concluida", de: "0.1.0", para: "0.2.0" });
      expect(andamentoNoDisco()).toMatchObject({ fase: "concluido", falha: null });
      expect(await instalacao.versaoNoAr()).toBe("0.2.0");
    },
    PRAZO_DO_TESTE_MS,
  );

  test(
    "o servidor que não responde no prazo é encerrado antes de a pasta voltar",
    async () => {
      const servidor = await cairComOServidorNascendo();

      const volta = await recuperar({ raizDoRepo: instalacao.raiz, dirDados: instalacao.dirDados, versaoNoAr: null, prazos: { servidorMs: 300, intervaloMs: 25 } });

      expect(volta).toEqual({ tipo: "desfeita", de: "0.1.0", para: "0.2.0" });
      expect(await morreu(servidor)).toBe(true);
      expect(andamentoNoDisco()).toMatchObject({ fase: "desfeito", falha: { passo: "subir", motivo: "interrompida" } });
      expect(JSON.parse(readFileSync(join(instalacao.raiz, "package.json"), "utf8"))).toMatchObject({ version: "0.1.0" });
    },
    PRAZO_DO_TESTE_MS,
  );
});

describe("a pasta rasgada com a trava presa", () => {
  test(
    "com as dependências fora do lugar e um atualizador vivo, bun secretaria responde atualizacao_em_andamento no formato do CLI",
    async () => {
      instalacao = montarInstalacao();
      rodarProcesso([process.execPath, join(REPO, "testes", "falsos", "atualizador-que-cai.ts"), instalacao.raiz, instalacao.dirDados, "trocar", "node_modules"]);
      expect(existsSync(join(instalacao.raiz, "node_modules"))).toBe(false);
      const { trava } = caminhosDoAtualizador(instalacao.raiz, instalacao.dirDados);
      const segurar = `const { Database } = require("bun:sqlite"); const trava = new Database(${JSON.stringify(trava)}, { create: true }); for (const sql of ["PRAGMA locking_mode = EXCLUSIVE", "PRAGMA journal_mode = WAL", "BEGIN IMMEDIATE", "COMMIT"]) trava.run(sql); process.stdout.write("pronto\\n"); setInterval(() => trava.filename, 60_000);`;
      const vivoComATrava = Bun.spawn([process.execPath, "-e", segurar], { stdin: "ignore", stdout: "pipe", stderr: "inherit" });
      soltos.push(vivoComATrava.pid);
      const { value } = await vivoComATrava.stdout.getReader().read();
      expect(new TextDecoder().decode(value)).toBe("pronto\n");

      const emJson = rodarProcesso([process.execPath, "run", "secretaria", "abrir", "--sem-navegador", "--json"]);
      const emTexto = rodarProcesso([process.execPath, "run", "secretaria", "abrir", "--sem-navegador"]);

      const { mensagem, acaoDoAgente: acao, saida } = ERROS.atualizacao_em_andamento;
      expect({ codigo: emJson.codigo, ultimaLinha: emJson.stdout.trimEnd().split("\n").at(-1) }).toEqual({
        codigo: saida,
        ultimaLinha: JSON.stringify({ v: 1, ok: false, erro: { codigo: "atualizacao_em_andamento", mensagem, acao } }),
      });
      expect(emTexto.codigo).toBe(saida);
      expect(emTexto.stderr).toContain(`${mensagem}\n${acao}\n`);
      expect(existsSync(join(instalacao.raiz, "node_modules"))).toBe(false);

      vivoComATrava.kill(process.platform === "win32" ? undefined : "SIGKILL");
      await vivoComATrava.exited;
      await travaLivre();
      expect(rodarAbrir()).toMatchObject({ ok: true, dados: { subiu: true, atualizacaoDesfeita: { de: "0.1.0", para: "0.2.0" } } });
    },
    PRAZO_DO_TESTE_MS,
  );
});

describe("o lock do banco que solta depois do processo", () => {
  test(
    "abrir espera o lock soltar e termina a volta, como no Windows",
    async () => {
      instalacao = montarInstalacao();
      rodarProcesso([process.execPath, join(REPO, "testes", "falsos", "atualizador-que-cai.ts"), instalacao.raiz, instalacao.dirDados, "instalar"]);
      const segurador = Bun.spawn([process.execPath, join(REPO, "testes", "falsos", "banco-que-solta-tarde.ts"), instalacao.dirDados, "1000"], { stdout: "pipe", stderr: "inherit" });
      const { value } = await segurador.stdout.getReader().read();
      expect(new TextDecoder().decode(value)).toBe("pronto\n");
      const anunciado = instalacao.pidDoServidor();
      if (anunciado === null) throw new Error("o segurador não anunciou o pid");
      expect(await encerrarPid(anunciado, { educado: false })).toBe(true);

      const aberto = rodarAbrir();

      expect(aberto).toMatchObject({ ok: true, dados: { subiu: true, atualizacaoDesfeita: { de: "0.1.0", para: "0.2.0" } } });
      expect(await segurador.exited).toBe(0);
      expect(await instalacao.versaoNoAr()).toBe("0.1.0");
    },
    PRAZO_DO_TESTE_MS,
  );
});

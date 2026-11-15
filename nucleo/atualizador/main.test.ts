import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { migrarInstalacao, montarInstalacao, retratoDaPasta, type InstalacaoMinima } from "../../testes/falsos/instalacao-minima";
import {
  FASES,
  PASSOS,
  andamentoPreparado,
  atualizar,
  caminhosDoAtualizador,
  efeitosReais,
  haAtualizacaoPendente,
  lerAndamento,
  msDoInicio,
  recomporArvore,
  recuperar,
  unidadeDaTroca,
  type Andamento,
  type Efeitos,
  type Fase,
  type Instalado,
  type Prazos,
  type ProcessoDaAtualizacao,
} from "./main";

const PRAZOS_CURTOS: Partial<Prazos> = { bancoMs: 60, soltarBancoMs: 60, servidorMs: 60, intervaloMs: 5, esperasDoRenameMs: [1, 1] };
/** O pid do primeiro servidor de mentira. Não é pid de processo nenhum: os efeitos de processo do teste nunca chegam ao sistema. */
const PRIMEIRO_SERVIDOR = 1001;
const PID_DO_INSTALAR = 4242;

/** Um `instalar` de mentira, que roda dentro do processo do teste. */
const instalando =
  (instalar: (raizDoRepo: string, dirDados: string) => Promise<Instalado>): Efeitos["iniciarInstalar"] =>
  (raizDoRepo, dirDados) => ({ pid: undefined, fim: instalar(raizDoRepo, dirDados) });

let instalacao: InstalacaoMinima;
let abertos: Database[] = [];

afterEach(async () => {
  for (const banco of abertos.splice(0)) banco.close(true);
  await instalacao.limpar();
});

/**
 * O `instalar` e o servidor da instalação mínima dentro do processo do teste: migram o banco com
 * o código que está na pasta, e o servidor segura o banco enquanto "vive". `versoesNoAr` guarda a
 * versão de cada servidor que subiu.
 */
function efeitosDeTeste(mudancas: Partial<Efeitos> = {}): Efeitos & { readonly fases: Fase[]; readonly versoesNoAr: string[] } {
  const reais = efeitosReais();
  const fases: Fase[] = [];
  const versoesNoAr: string[] = [];
  const doPid = new Map<number, string>();
  let subidas = 0;
  return {
    ...reais,
    iniciarInstalar: instalando(async (raizDoRepo, dirDados) => {
      migrarInstalacao(raizDoRepo, dirDados).close(true);
      return { ok: true };
    }),
    inicioDoProcesso: () => null,
    existe: () => false,
    encerrarArvore: async () => true,
    subirServidor(raizDoRepo, dirDados) {
      const pid = PRIMEIRO_SERVIDOR + subidas;
      subidas += 1;
      let banco: Database | null = null;
      try {
        banco = migrarInstalacao(raizDoRepo, dirDados);
        abertos.push(banco);
        const versao = (JSON.parse(readFileSync(path.join(raizDoRepo, "package.json"), "utf8")) as { version: string }).version;
        doPid.set(pid, versao);
        versoesNoAr.push(versao);
      } catch {
        banco = null;
      }
      const vivo = banco;
      return {
        pid,
        saiu: () => vivo === null,
        async encerrar() {
          vivo?.close(true);
          abertos = abertos.filter((aberto) => aberto !== vivo);
          doPid.delete(pid);
        },
      };
    },
    versaoNoAr: async (_dirDados, pid) => doPid.get(pid ?? 0) ?? null,
    observar: (andamento) => void (fases.at(-1) === andamento.fase || fases.push(andamento.fase)),
    ...mudancas,
    fases,
    versoesNoAr,
  };
}

function rodar(efeitos: Efeitos) {
  return atualizar({ raizDoRepo: instalacao.raiz, dirDados: instalacao.dirDados, prazos: PRAZOS_CURTOS }, efeitos);
}

function andamentoNoDisco(): Andamento {
  const lido = lerAndamento(caminhosDoAtualizador(instalacao.raiz, instalacao.dirDados).andamento);
  if (lido.tipo !== "lido") throw new Error(`o andamento está ${lido.tipo}`);
  return lido.andamento;
}

/** Segura a trava como um atualizador vivo segura: SQLite em modo exclusivo. */
function segurarATrava(): void {
  const trava = new Database(caminhosDoAtualizador(instalacao.raiz, instalacao.dirDados).trava, { create: true });
  trava.run("PRAGMA locking_mode = EXCLUSIVE");
  trava.run("PRAGMA journal_mode = WAL");
  trava.run("BEGIN IMMEDIATE");
  trava.run("COMMIT");
  abertos.push(trava);
}

function fecharServidores(): void {
  for (const banco of abertos.splice(0)) banco.close(true);
}

describe("a máquina de passos", () => {
  test("os passos vão do banco livre à subida, e só concluido e desfeito são finais", () => {
    expect(PASSOS).toEqual(["esperar_banco", "preparar", "copiar", "trocar", "instalar", "subir"]);
    expect(FASES).toEqual(["preparado", ...PASSOS, "desfazer", "concluido", "desfeito"]);
    instalacao = montarInstalacao();
    expect(haAtualizacaoPendente(instalacao.raiz)).toBe(false);
  });

  test("a 0.1.0 vira a 0.2.0 com a migração nova, e o que é do vendedor fica igual byte a byte", async () => {
    instalacao = montarInstalacao();
    const doVendedor = instalacao.doVendedor();
    const daNova = retratoDaPasta(instalacao.nova);
    const efeitos = efeitosDeTeste();

    const desfecho = await rodar(efeitos);

    expect(desfecho.tipo).toBe("concluida");
    expect(efeitos.fases).toEqual(["esperar_banco", "preparar", "copiar", "trocar", "instalar", "subir", "concluido"]);
    expect(efeitos.versoesNoAr).toEqual(["0.2.0"]);
    expect(andamentoNoDisco()).toMatchObject({ v: 1, de: "0.1.0", para: "0.2.0", fase: "concluido", falha: null, mudados: { quantos: 0, caminhos: [] } });
    expect(haAtualizacaoPendente(instalacao.raiz)).toBe(false);

    const depois = retratoDaPasta(instalacao.raiz);
    expect(instalacao.doVendedor()).toEqual(doVendedor);
    expect(depois).toEqual({ ...daNova, ...Object.fromEntries(Object.keys(doVendedor).map((caminho) => [caminho, depois[caminho] ?? "ausente"])) });
    for (const saiu of ["LEIAME-ANTIGO.md", "nucleo/so-na-antiga.ts", ".agents/skills/antiga/SKILL.md"]) expect(depois[saiu]).toBeUndefined();
    expect(readFileSync(path.join(instalacao.raiz, "node_modules", "marca", "index.js"), "utf8")).toContain("0.2.0");

    fecharServidores();
    expect(instalacao.retratoDosBancos()).toMatchObject({
      nucleo: { migracoes: [{ tag: "0001_base" }, { tag: "0002_nova" }], notas: [{ texto: "anotado antes da atualização" }] },
      meu: { visitas: [{ cliente: "cliente do vendedor" }] },
    });
  });

  test("guarda os bancos e o meu/ de antes na pasta de dados, e o núcleo antigo sem as dependências", async () => {
    instalacao = montarInstalacao();
    const meu = Object.fromEntries(Object.entries(instalacao.doVendedor()).filter(([caminho]) => caminho.startsWith("meu/")));
    await rodar(efeitosDeTeste());

    const { copias, anterior } = caminhosDoAtualizador(instalacao.raiz, instalacao.dirDados);
    const antes = retratoDaPasta(copias("0.2.0"));
    expect(Object.keys(antes).filter((caminho) => !caminho.startsWith("meu/") && !/-(wal|shm)$/.test(caminho))).toEqual(["meu.db", "secretaria.db"]);
    expect(Object.fromEntries(Object.entries(antes).filter(([caminho]) => caminho.startsWith("meu/")))).toEqual(meu);
    expect(readFileSync(path.join(anterior, "nucleo", "marca.txt"), "utf8")).toBe("0.1.0\n");
    expect(existsSync(path.join(anterior, "LEIAME-ANTIGO.md"))).toBe(true);
    expect(existsSync(path.join(anterior, "node_modules"))).toBe(false);
  });

  test("copia o binário do wacli só quando a trava de ferramentas muda", async () => {
    instalacao = montarInstalacao({ naNova: { "ferramentas.lock.json": JSON.stringify({ wacli: { versao: "0.27.0" } }) } });
    await rodar(efeitosDeTeste());
    const { copias, wacli } = caminhosDoAtualizador(instalacao.raiz, instalacao.dirDados);
    expect(readFileSync(path.join(copias("0.2.0"), "bin", path.basename(wacli)), "utf8")).toBe("wacli da 0.1.0");
  });

  test("conta o arquivo do núcleo que foi mudado ou apagado na máquina, e a cópia dele fica guardada", async () => {
    instalacao = montarInstalacao();
    writeFileSync(path.join(instalacao.raiz, "nucleo", "marca.txt"), "mexido pelo agente do vendedor\n");
    rmSync(path.join(instalacao.raiz, "docs", "arquitetura.md"));
    writeFileSync(path.join(instalacao.raiz, "nucleo", "criado-pelo-agente.ts"), "export {};\n");

    const desfecho = await rodar(efeitosDeTeste());

    expect(desfecho.tipo).toBe("concluida");
    expect(andamentoNoDisco().mudados).toEqual({ quantos: 2, caminhos: ["docs/arquitetura.md", "nucleo/marca.txt"] });
    const { anterior } = caminhosDoAtualizador(instalacao.raiz, instalacao.dirDados);
    expect(readFileSync(path.join(anterior, "nucleo", "marca.txt"), "utf8")).toBe("mexido pelo agente do vendedor\n");
    expect(existsSync(path.join(anterior, "nucleo", "criado-pelo-agente.ts"))).toBe(true);
    expect(readFileSync(path.join(instalacao.raiz, "nucleo", "marca.txt"), "utf8")).toBe("0.2.0\n");
  });

  test("pasta com .git nunca é atualizada, e nada é gravado nela", async () => {
    instalacao = montarInstalacao();
    mkdirSync(path.join(instalacao.raiz, ".git"));
    const antes = retratoDaPasta(instalacao.raiz);
    const efeitos = efeitosDeTeste();

    expect(await rodar(efeitos)).toEqual({ tipo: "recusada", motivo: "pasta_de_desenvolvimento" });

    expect(retratoDaPasta(instalacao.raiz)).toEqual(antes);
    expect(efeitos.fases).toEqual([]);
    const { andamento, trava } = caminhosDoAtualizador(instalacao.raiz, instalacao.dirDados);
    expect(existsSync(andamento) || existsSync(trava)).toBe(false);
  });
});

describe("falha em cada passo deixa a 0.1.0 no ar com o banco igual", () => {
  const erroDoSistema = (codigo: string) => Object.assign(new Error(`${codigo}: arquivo em uso`), { code: codigo });

  /** O rename que põe o núcleo novo no lugar: nessa hora o antigo já saiu para `anterior/`. */
  const chegaONucleoNovo = (de: string, para: string) => de === path.join(instalacao.nova, "nucleo") && para === path.join(instalacao.raiz, "nucleo");

  const casos: readonly (readonly [string, { readonly naNova?: Record<string, string>; readonly efeitos: () => Partial<Efeitos>; readonly motivo: string; readonly subiuAntiga: boolean }])[] = [
    ["esperar_banco", { efeitos: () => ({ bancoLivre: () => false }), motivo: "banco_em_uso", subiuAntiga: false }],
    ["preparar", { naNova: { "package.json": JSON.stringify({ version: "0.1.0" }) }, efeitos: () => ({}), motivo: "versao_nova_invalida", subiuAntiga: true }],
    [
      "copiar",
      {
        efeitos: () => ({
          copiar() {
            throw new Error("disco cheio");
          },
        }),
        motivo: "copia_falhou",
        subiuAntiga: true,
      },
    ],
    [
      "trocar",
      {
        efeitos: () => {
          let falhou = false;
          const reais = efeitosReais();
          return {
            renomear(de, para) {
              if (!falhou && chegaONucleoNovo(de, para)) {
                falhou = true;
                throw new Error("o sistema recusou o rename");
              }
              reais.renomear(de, para);
            },
          };
        },
        motivo: "troca_falhou",
        subiuAntiga: true,
      },
    ],
    [
      "instalar",
      {
        efeitos: () => ({
          iniciarInstalar: instalando(async (raizDoRepo, dirDados) => {
            migrarInstalacao(raizDoRepo, dirDados).close(true);
            return { ok: false, detalhe: "o wacli novo não respondeu" };
          }),
        }),
        motivo: "instalar_falhou",
        subiuAntiga: true,
      },
    ],
    // O primeiro servidor, o da versão nova, abre o banco e nunca atende. O da antiga, depois da volta, atende.
    ["subir", { efeitos: () => ({ versaoNoAr: async (_dirDados, pid) => (pid === PRIMEIRO_SERVIDOR ? null : "0.1.0") }), motivo: "servidor_nao_subiu", subiuAntiga: true }],
  ];

  test.each(casos)("falha em %s", async (passo, caso) => {
    instalacao = montarInstalacao({ naNova: caso.naNova });
    const pasta = retratoDaPasta(instalacao.raiz);
    const daNova = retratoDaPasta(instalacao.nova);
    const bancos = instalacao.retratoDosBancos();
    const efeitos = efeitosDeTeste(caso.efeitos());

    const desfecho = await rodar(efeitos);

    expect(desfecho).toMatchObject({ tipo: "desfeita", servidorNoAr: caso.subiuAntiga });
    expect(andamentoNoDisco()).toMatchObject({ fase: "desfeito", de: "0.1.0", falha: { passo, motivo: caso.motivo } });
    expect(haAtualizacaoPendente(instalacao.raiz)).toBe(false);
    expect(efeitos.versoesNoAr.at(-1)).toBe(caso.subiuAntiga ? "0.1.0" : undefined);
    expect(retratoDaPasta(instalacao.raiz)).toEqual(pasta);
    expect(retratoDaPasta(instalacao.nova)).toEqual(daNova);
    fecharServidores();
    expect(instalacao.retratoDosBancos()).toEqual(bancos);
  });

  test("com o banco do vendedor em uso, desiste antes de mudar qualquer coisa", async () => {
    instalacao = montarInstalacao();
    const pasta = retratoDaPasta(instalacao.raiz);
    const efeitos = efeitosDeTeste({ bancoLivre: (caminho) => path.basename(caminho) !== "meu.db" });

    expect(await rodar(efeitos)).toMatchObject({ tipo: "desfeita", servidorNoAr: false, andamento: { falha: { passo: "esperar_banco", motivo: "banco_em_uso" } } });
    expect(efeitos.fases).toEqual(["esperar_banco", "desfeito"]);
    expect(retratoDaPasta(instalacao.raiz)).toEqual(pasta);
  });

  test("entrada da versão nova que é link não entra na pasta, e a troca volta", async () => {
    instalacao = montarInstalacao();
    const pasta = retratoDaPasta(instalacao.raiz);
    const alvo = path.join(instalacao.dirDados, "..", "alvo-do-link");
    mkdirSync(alvo, { recursive: true });
    writeFileSync(path.join(alvo, "arquitetura.md"), "de fora\n");
    rmSync(path.join(instalacao.nova, "docs"), { recursive: true });
    // `junction` é o link de pasta que o Windows cria sem privilégio; nos outros sistemas o tipo é ignorado.
    symlinkSync(alvo, path.join(instalacao.nova, "docs"), "junction");

    expect(await rodar(efeitosDeTeste())).toMatchObject({ tipo: "desfeita", andamento: { falha: { passo: "trocar", motivo: "troca_falhou" } } });
    expect(retratoDaPasta(instalacao.raiz)).toEqual(pasta);
  });

  test("no Windows, o rename recusado por arquivo em uso é tentado de novo e a troca segue", async () => {
    instalacao = montarInstalacao();
    const reais = efeitosReais();
    let recusas = 0;
    const efeitos = efeitosDeTeste({
      plataforma: "win32",
      renomear(de, para) {
        if (chegaONucleoNovo(de, para) && recusas < 2) {
          recusas += 1;
          throw erroDoSistema("EBUSY");
        }
        reais.renomear(de, para);
      },
    });

    expect((await rodar(efeitos)).tipo).toBe("concluida");
    expect(recusas).toBe(2);
  });

  test("no Windows, o rename que segue recusado esgota as tentativas e a troca volta", async () => {
    instalacao = montarInstalacao();
    const pasta = retratoDaPasta(instalacao.raiz);
    const reais = efeitosReais();
    let recusas = 0;
    const efeitos = efeitosDeTeste({
      plataforma: "win32",
      renomear(de, para) {
        if (chegaONucleoNovo(de, para)) {
          recusas += 1;
          throw erroDoSistema("EPERM");
        }
        reais.renomear(de, para);
      },
    });

    expect(await rodar(efeitos)).toMatchObject({ tipo: "desfeita", andamento: { falha: { passo: "trocar", motivo: "troca_falhou" } } });
    expect(recusas).toBe(3);
    expect(retratoDaPasta(instalacao.raiz)).toEqual(pasta);
  });

  test("fora do Windows, o rename recusado não é tentado de novo", async () => {
    instalacao = montarInstalacao();
    const reais = efeitosReais();
    let recusas = 0;
    const efeitos = efeitosDeTeste({
      plataforma: "linux",
      renomear(de, para) {
        if (chegaONucleoNovo(de, para)) {
          recusas += 1;
          throw erroDoSistema("EBUSY");
        }
        reais.renomear(de, para);
      },
    });

    expect((await rodar(efeitos)).tipo).toBe("desfeita");
    expect(recusas).toBe(1);
  });
});

describe("a pasta nunca fica sem a porta do bun secretaria", () => {
  const PORTAS = ["package.json", "entrada.ts"];

  test("o package.json e o entrada.ts estão no lugar em cada rename da troca e da volta", async () => {
    instalacao = montarInstalacao();
    const reais = efeitosReais();
    const faltaram: string[] = [];
    const efeitos = efeitosDeTeste({
      renomear(de, para) {
        reais.renomear(de, para);
        for (const porta of PORTAS) if (!existsSync(path.join(instalacao.raiz, porta))) faltaram.push(`${porta} depois de ${path.relative(instalacao.raiz, de)}`);
      },
      iniciarInstalar: instalando(async () => ({ ok: false, detalhe: "falha para forçar a volta" })),
    });

    expect(await rodar(efeitos)).toMatchObject({ tipo: "desfeita" });
    expect(faltaram).toEqual([]);
  });

  test("a versão nova entra por cima, e a antiga fica guardada em anterior/", async () => {
    instalacao = montarInstalacao();
    await rodar(efeitosDeTeste());
    const { anterior } = caminhosDoAtualizador(instalacao.raiz, instalacao.dirDados);
    expect(JSON.parse(readFileSync(path.join(instalacao.raiz, "package.json"), "utf8"))).toMatchObject({ version: "0.2.0" });
    expect(JSON.parse(readFileSync(path.join(anterior, "package.json"), "utf8"))).toMatchObject({ version: "0.1.0" });
  });
});

describe("recompor a pasta antes de carregar o CLI", () => {
  const nucleoForaDoLugar = () => {
    const { anterior, andamento } = caminhosDoAtualizador(instalacao.raiz, instalacao.dirDados);
    mkdirSync(anterior, { recursive: true });
    renameSync(path.join(instalacao.raiz, "nucleo"), path.join(anterior, "nucleo"));
    writeFileSync(andamento, JSON.stringify({ ...andamentoPreparado("0.1.0", "0.2.0"), fase: "trocar", trocas: [{ caminho: "nucleo", tinhaAntiga: true, temNova: true }] }));
  };

  test("com o núcleo antigo fora e o novo ainda em nova/, devolve o antigo e deixa a volta em desfazer", async () => {
    instalacao = montarInstalacao();
    const pasta = retratoDaPasta(instalacao.raiz);
    const daNova = retratoDaPasta(instalacao.nova);
    nucleoForaDoLugar();

    expect(await recomporArvore(instalacao.raiz)).toEqual({ tipo: "recomposta" });

    expect(retratoDaPasta(instalacao.raiz)).toEqual(pasta);
    expect(retratoDaPasta(instalacao.nova)).toEqual(daNova);
    expect(andamentoNoDisco()).toMatchObject({ fase: "desfazer", falha: { passo: "trocar", motivo: "interrompida" } });
    expect(await recomporArvore(instalacao.raiz)).toEqual({ tipo: "nada" });
  });

  test.each([
    ["sem andamento", () => {}],
    ["com andamento final", () => writeFileSync(caminhosDoAtualizador(instalacao.raiz, instalacao.dirDados).andamento, JSON.stringify({ ...andamentoPreparado("0.1.0", "0.2.0"), fase: "desfeito" }))],
    ["fora das fases da troca", () => writeFileSync(caminhosDoAtualizador(instalacao.raiz, instalacao.dirDados).andamento, JSON.stringify({ ...andamentoPreparado("0.1.0", "0.2.0"), fase: "instalar" }))],
  ])("%s, não faz nada", async (_nome, preparar) => {
    instalacao = montarInstalacao();
    preparar();
    const pasta = retratoDaPasta(instalacao.raiz);
    expect(await recomporArvore(instalacao.raiz)).toEqual({ tipo: "nada" });
    expect(retratoDaPasta(instalacao.raiz)).toEqual(pasta);
  });

  test("com a trava segura por outro processo, ou numa pasta com .git, não move nada", async () => {
    instalacao = montarInstalacao();
    nucleoForaDoLugar();
    segurarATrava();
    expect(await recomporArvore(instalacao.raiz)).toEqual({ tipo: "em_andamento" });
    fecharServidores();

    mkdirSync(path.join(instalacao.raiz, ".git"));
    expect(await recomporArvore(instalacao.raiz)).toEqual({ tipo: "nada" });
    expect(existsSync(path.join(instalacao.raiz, "nucleo"))).toBe(false);
  });
});

describe("um atualizador por vez", () => {
  test("enquanto um roda, outro é recusado e a volta diz que está em andamento", async () => {
    instalacao = montarInstalacao();
    let chegou = () => {};
    let soltar = () => {};
    const noInstalar = new Promise<void>((resolver) => (chegou = resolver));
    const segurando = new Promise<void>((resolver) => (soltar = resolver));
    const primeiro = rodar(
      efeitosDeTeste({
        iniciarInstalar: instalando(async (raizDoRepo, dirDados) => {
          chegou();
          await segurando;
          migrarInstalacao(raizDoRepo, dirDados).close(true);
          return { ok: true };
        }),
      }),
    );
    await noInstalar;

    expect(await rodar(efeitosDeTeste())).toEqual({ tipo: "recusada", motivo: "outra_em_andamento" });
    expect(haAtualizacaoPendente(instalacao.raiz)).toBe(true);
    expect(await recuperar({ raizDoRepo: instalacao.raiz, dirDados: instalacao.dirDados, versaoNoAr: null })).toEqual({ tipo: "em_andamento" });

    soltar();
    expect((await primeiro).tipo).toBe("concluida");
  });

  test("atualização que parou no meio não é atropelada por outra", async () => {
    instalacao = montarInstalacao();
    const { andamento } = caminhosDoAtualizador(instalacao.raiz, instalacao.dirDados);
    writeFileSync(andamento, JSON.stringify({ ...andamentoPreparado("0.1.0", "0.2.0"), fase: "trocar" }));
    const pasta = retratoDaPasta(instalacao.raiz);

    expect(await rodar(efeitosDeTeste())).toEqual({ tipo: "recusada", motivo: "atualizacao_interrompida" });
    expect(retratoDaPasta(instalacao.raiz)).toEqual(pasta);
  });

  test("o andamento preparado pelo servidor dá a vez ao atualizador", async () => {
    instalacao = montarInstalacao();
    const { andamento } = caminhosDoAtualizador(instalacao.raiz, instalacao.dirDados);
    writeFileSync(andamento, JSON.stringify(andamentoPreparado("0.1.0", "0.2.0")));
    expect(haAtualizacaoPendente(instalacao.raiz)).toBe(true);
    expect((await rodar(efeitosDeTeste())).tipo).toBe("concluida");
  });
});

describe("a volta de uma atualização que morreu no meio", () => {
  const voltar = (versaoNoAr: string | null, efeitos: Efeitos = efeitosDeTeste()) =>
    recuperar({ raizDoRepo: instalacao.raiz, dirDados: instalacao.dirDados, versaoNoAr, prazos: PRAZOS_CURTOS }, efeitos);
  const gravar = (andamento: unknown) => writeFileSync(caminhosDoAtualizador(instalacao.raiz, instalacao.dirDados).andamento, JSON.stringify(andamento));

  test("sem andamento, ou com andamento final, não faz nada", async () => {
    instalacao = montarInstalacao();
    expect(await voltar(null)).toEqual({ tipo: "nada" });
    gravar({ ...andamentoPreparado("0.1.0", "0.2.0"), fase: "desfeito" });
    expect(await voltar(null)).toEqual({ tipo: "nada" });
  });

  test("andamento preparado sem atualizador vira desfeito, sem mudar a pasta", async () => {
    instalacao = montarInstalacao();
    const pasta = retratoDaPasta(instalacao.raiz);
    gravar(andamentoPreparado("0.1.0", "0.2.0"));
    expect(await voltar(null)).toEqual({ tipo: "desfeita", de: "0.1.0", para: "0.2.0" });
    expect(andamentoNoDisco()).toMatchObject({ fase: "desfeito", falha: { passo: "esperar_banco", motivo: "interrompida" } });
    expect(retratoDaPasta(instalacao.raiz)).toEqual(pasta);
  });

  test("com o servidor da versão nova já no ar, só grava o fim", async () => {
    instalacao = montarInstalacao();
    gravar({ ...andamentoPreparado("0.1.0", "0.2.0"), fase: "subir", restaurarDados: true });
    expect(await voltar("0.2.0")).toEqual({ tipo: "concluida", de: "0.1.0", para: "0.2.0" });
    expect(andamentoNoDisco().fase).toBe("concluido");
  });

  test("com o servidor antigo no ar antes da troca, só grava o fim, sem mexer na pasta", async () => {
    instalacao = montarInstalacao();
    const pasta = retratoDaPasta(instalacao.raiz);
    gravar({ ...andamentoPreparado("0.1.0", "0.2.0"), fase: "copiar" });
    expect(await voltar("0.1.0")).toEqual({ tipo: "desfeita", de: "0.1.0", para: "0.2.0" });
    expect(andamentoNoDisco()).toMatchObject({ fase: "desfeito", falha: { passo: "copiar", motivo: "interrompida" } });
    expect(retratoDaPasta(instalacao.raiz)).toEqual(pasta);
  });

  test("com o andamento preparado e o servidor que o gravou ainda no ar, espera", async () => {
    instalacao = montarInstalacao();
    gravar(andamentoPreparado("0.1.0", "0.2.0"));
    expect(await voltar("0.1.0")).toEqual({ tipo: "nada" });
    expect(andamentoNoDisco().fase).toBe("preparado");
  });

  test.each(["trocar", "instalar", "desfazer"])("com um servidor no ar na fase %s, não mexe em nada e diz que ele está no meio", async (fase) => {
    instalacao = montarInstalacao();
    const pasta = retratoDaPasta(instalacao.raiz);
    gravar({ ...andamentoPreparado("0.1.0", "0.2.0"), fase, restaurarDados: fase !== "trocar" });
    expect(await voltar("0.1.0")).toEqual({ tipo: "servidor_no_meio", versaoNoAr: "0.1.0" });
    expect(andamentoNoDisco().fase).toBe(fase as Fase);
    expect(retratoDaPasta(instalacao.raiz)).toEqual(pasta);
  });

  test("com o banco em uso, não desfaz", async () => {
    instalacao = montarInstalacao();
    gravar({ ...andamentoPreparado("0.1.0", "0.2.0"), fase: "instalar", restaurarDados: true });
    expect(await voltar(null, efeitosDeTeste({ bancoLivre: () => false }))).toEqual({ tipo: "banco_em_uso" });
    expect(andamentoNoDisco().fase).toBe("instalar");
  });

  test("com o lock do banco que solta depois do processo, como no Windows, espera e desfaz", async () => {
    instalacao = montarInstalacao();
    gravar({ ...andamentoPreparado("0.1.0", "0.2.0"), fase: "instalar", restaurarDados: true });
    let sondas = 0;
    expect(await voltar(null, efeitosDeTeste({ bancoLivre: () => (sondas += 1) > 3 }))).toEqual({ tipo: "desfeita", de: "0.1.0", para: "0.2.0" });
    expect(andamentoNoDisco().fase).toBe("desfeito");
  });

  test("pasta com .git não é tocada pela volta", async () => {
    instalacao = montarInstalacao();
    gravar({ ...andamentoPreparado("0.1.0", "0.2.0"), fase: "trocar", trocas: [{ caminho: "nucleo", tinhaAntiga: true, temNova: true }] });
    mkdirSync(path.join(instalacao.raiz, ".git"));
    expect(await voltar(null)).toEqual({ tipo: "nada" });
    expect(andamentoNoDisco().fase).toBe("trocar");
  });

  test.each([
    ["JSON quebrado", "{"],
    ["formato de outra versão", JSON.stringify({ ...andamentoPreparado("0.1.0", "0.2.0"), v: 2 })],
    ["plano que sai da pasta", JSON.stringify({ ...andamentoPreparado("0.1.0", "0.2.0"), fase: "trocar", trocas: [{ caminho: "../fora", tinhaAntiga: true, temNova: true }] })],
    ["plano que aponta o meu/", JSON.stringify({ ...andamentoPreparado("0.1.0", "0.2.0"), fase: "trocar", trocas: [{ caminho: "meu", tinhaAntiga: true, temNova: false }] })],
    ["contagem de arquivos mudados que não é inteira", JSON.stringify({ ...andamentoPreparado("0.1.0", "0.2.0"), fase: "trocar", mudados: { quantos: 1.5, caminhos: [] } })],
    ["contagem de arquivos mudados negativa", JSON.stringify({ ...andamentoPreparado("0.1.0", "0.2.0"), fase: "trocar", mudados: { quantos: -1, caminhos: [] } })],
    ["processo com um pid que alcançaria todos os processos", JSON.stringify({ ...andamentoPreparado("0.1.0", "0.2.0"), fase: "instalar", processo: { papel: "instalar", pid: 1, inicio: null } })],
    ["processo de um papel que esta versão não conhece", JSON.stringify({ ...andamentoPreparado("0.1.0", "0.2.0"), fase: "instalar", processo: { papel: "outro", pid: 4242, inicio: null } })],
    ["plano que aponta as permissões locais", JSON.stringify({ ...andamentoPreparado("0.1.0", "0.2.0"), fase: "trocar", trocas: [{ caminho: ".claude/settings.local.json", tinhaAntiga: true, temNova: false }] })],
  ])("andamento com %s não manda em rename nenhum", async (_nome, texto) => {
    instalacao = montarInstalacao();
    const pasta = retratoDaPasta(instalacao.raiz);
    writeFileSync(caminhosDoAtualizador(instalacao.raiz, instalacao.dirDados).andamento, texto);
    expect(haAtualizacaoPendente(instalacao.raiz)).toBe(true);
    expect(await voltar(null)).toMatchObject({ tipo: "falhou" });
    expect(await rodar(efeitosDeTeste())).toEqual({ tipo: "recusada", motivo: "atualizacao_interrompida" });
    expect(retratoDaPasta(instalacao.raiz)).toEqual(pasta);
  });
});

describe("o processo que o atualizador subiu", () => {
  const INSTALAR: ProcessoDaAtualizacao = { papel: "instalar", pid: PID_DO_INSTALAR, inicio: "hora do instalar" };

  /** Um `instalar` que nunca termina sozinho e um sistema de mentira em que ele vive até ser encerrado. */
  function instalarQueNaoTermina(encerra: boolean) {
    const encerrados: number[] = [];
    let vivo = true;
    let sair = (_instalado: Instalado) => {};
    const efeitos = efeitosDeTeste({
      iniciarInstalar: () => ({ pid: PID_DO_INSTALAR, fim: new Promise<Instalado>((resolver) => (sair = resolver)) }),
      inicioDoProcesso: () => INSTALAR.inicio,
      existe: (pid) => vivo && pid === INSTALAR.pid,
      async encerrarArvore(pid) {
        encerrados.push(pid);
        if (!encerra) return false;
        vivo = false;
        sair({ ok: false, detalhe: "encerrado" });
        return true;
      },
    });
    return { efeitos, encerrados, morrer: () => (vivo = false) };
  }

  const comPrazoCurto = (efeitos: Efeitos) => atualizar({ raizDoRepo: instalacao.raiz, dirDados: instalacao.dirDados, prazos: { ...PRAZOS_CURTOS, instalarMs: 20 } }, efeitos);

  test("o andamento diz o instalar e o servidor enquanto vivem, e nenhum no fim", async () => {
    instalacao = montarInstalacao();
    const vistos: string[] = [];
    const efeitos = efeitosDeTeste({
      iniciarInstalar: () => ({ pid: PID_DO_INSTALAR, fim: Promise.resolve().then(() => (migrarInstalacao(instalacao.raiz, instalacao.dirDados).close(true), { ok: true as const })) }),
      inicioDoProcesso: (pid) => `hora do ${pid}`,
      observar: ({ fase, processo }) => void vistos.push(`${fase}: ${processo === null ? "nenhum" : `${processo.papel} ${processo.pid} ${processo.inicio}`}`),
    });

    expect((await rodar(efeitos)).tipo).toBe("concluida");

    expect(vistos.slice(vistos.indexOf("instalar: nenhum"))).toEqual([
      "instalar: nenhum",
      `instalar: instalar ${PID_DO_INSTALAR} null`,
      `instalar: instalar ${PID_DO_INSTALAR} hora do ${PID_DO_INSTALAR}`,
      "subir: nenhum",
      `subir: servidor ${PRIMEIRO_SERVIDOR} null`,
      `subir: servidor ${PRIMEIRO_SERVIDOR} hora do ${PRIMEIRO_SERVIDOR}`,
      "concluido: nenhum",
    ]);
  });

  test("o instalar que passa do prazo é encerrado, com o que ele subiu, antes de a troca voltar", async () => {
    instalacao = montarInstalacao();
    const pasta = retratoDaPasta(instalacao.raiz);
    const { efeitos, encerrados } = instalarQueNaoTermina(true);

    const desfecho = await comPrazoCurto(efeitos);

    expect(desfecho).toMatchObject({ tipo: "desfeita", servidorNoAr: true, andamento: { fase: "desfeito", processo: null, falha: { passo: "instalar", motivo: "instalar_falhou" } } });
    expect(encerrados).toEqual([PID_DO_INSTALAR]);
    expect(retratoDaPasta(instalacao.raiz)).toEqual(pasta);
  });

  test("com o instalar vivo que não encerra, ninguém mexe na pasta, e a volta termina quando ele some", async () => {
    instalacao = montarInstalacao();
    const pasta = retratoDaPasta(instalacao.raiz);
    const bancos = instalacao.retratoDosBancos();
    const { efeitos, morrer } = instalarQueNaoTermina(false);

    expect(await comPrazoCurto(efeitos)).toMatchObject({ tipo: "volta_incompleta", andamento: { fase: "desfazer", processo: INSTALAR } });
    const daNova = retratoDaPasta(instalacao.raiz);
    expect(daNova).not.toEqual(pasta);

    expect(await recomporArvore(instalacao.raiz, efeitos)).toEqual({ tipo: "em_andamento" });
    const voltar = () => recuperar({ raizDoRepo: instalacao.raiz, dirDados: instalacao.dirDados, versaoNoAr: null, prazos: PRAZOS_CURTOS }, efeitos);
    expect(await voltar()).toEqual({ tipo: "processo_preso", papel: "instalar", pid: PID_DO_INSTALAR });
    expect(retratoDaPasta(instalacao.raiz)).toEqual(daNova);
    expect(andamentoNoDisco()).toMatchObject({ fase: "desfazer", processo: INSTALAR });

    morrer();
    expect(await voltar()).toEqual({ tipo: "desfeita", de: "0.1.0", para: "0.2.0" });
    expect(andamentoNoDisco()).toMatchObject({ fase: "desfeito", processo: null });
    expect(retratoDaPasta(instalacao.raiz)).toEqual(pasta);
    expect(instalacao.retratoDosBancos()).toEqual(bancos);
  });

  test("o andamento gravado sem o campo do processo é lido como nenhum processo", () => {
    instalacao = montarInstalacao();
    const { processo: _semOCampo, ...antigo } = andamentoPreparado("0.1.0", "0.2.0");
    writeFileSync(caminhosDoAtualizador(instalacao.raiz, instalacao.dirDados).andamento, JSON.stringify({ ...antigo, fase: "instalar" }));
    expect(andamentoNoDisco()).toMatchObject({ fase: "instalar", processo: null });
  });
});

describe("o pid anotado sem a hora de início", () => {
  const HA_MUITO = "2026-01-01T00:00:00.000Z";

  /** Os processos do sistema de verdade, com o encerramento só anotado: o teste nunca mata ninguém. */
  function comProcessosReais() {
    const encerrados: number[] = [];
    const efeitos = efeitosDeTeste({ ...efeitosReais(), encerrarArvore: async (pid) => (encerrados.push(pid), true) });
    return { efeitos, encerrados };
  }

  const gravar = (andamento: Andamento) => writeFileSync(caminhosDoAtualizador(instalacao.raiz, instalacao.dirDados).andamento, JSON.stringify(andamento));
  const noInstalar = (pid: number, iniciadoEm: string, atualizadoEm: string): Andamento => ({
    ...andamentoPreparado("0.1.0", "0.2.0"),
    iniciadoEm,
    atualizadoEm,
    fase: "instalar",
    restaurarDados: true,
    processo: { papel: "instalar", pid, inicio: null },
  });
  const voltar = (efeitos: Efeitos) => recuperar({ raizDoRepo: instalacao.raiz, dirDados: instalacao.dirDados, versaoNoAr: null, prazos: PRAZOS_CURTOS }, efeitos);

  test("o pid que hoje é de um processo nascido depois da atualização não é encerrado, e a volta segue", async () => {
    instalacao = montarInstalacao();
    const { efeitos, encerrados } = comProcessosReais();
    gravar(noInstalar(process.pid, HA_MUITO, HA_MUITO));

    expect(await voltar(efeitos)).toEqual({ tipo: "desfeita", de: "0.1.0", para: "0.2.0" });
    expect(encerrados).toEqual([]);
  });

  test("o mesmo pid, com a pasta rasgada, não segura a recomposição", async () => {
    instalacao = montarInstalacao();
    const pasta = retratoDaPasta(instalacao.raiz);
    const { anterior } = caminhosDoAtualizador(instalacao.raiz, instalacao.dirDados);
    mkdirSync(anterior, { recursive: true });
    renameSync(path.join(instalacao.raiz, "nucleo"), path.join(anterior, "nucleo"));
    gravar({ ...noInstalar(process.pid, HA_MUITO, HA_MUITO), fase: "trocar", restaurarDados: false, trocas: [{ caminho: "nucleo", tinhaAntiga: true, temNova: true }] });

    expect(await recomporArvore(instalacao.raiz, comProcessosReais().efeitos)).toEqual({ tipo: "recomposta" });
    expect(retratoDaPasta(instalacao.raiz)).toEqual(pasta);
  });

  test("o instalar que nasceu durante a atualização é encerrado antes da volta", async () => {
    instalacao = montarInstalacao();
    const { efeitos, encerrados } = comProcessosReais();
    const antes = new Date().toISOString();
    const instalar = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 60_000)"], { stdio: ["ignore", "ignore", "ignore"] });
    try {
      gravar(noInstalar(instalar.pid, antes, new Date().toISOString()));

      expect(await voltar(efeitos)).toEqual({ tipo: "desfeita", de: "0.1.0", para: "0.2.0" });
      expect(encerrados).toEqual([instalar.pid]);
    } finally {
      instalar.kill(process.platform === "win32" ? undefined : "SIGKILL");
      await instalar.exited;
    }
  });

  test("sem como ler a hora, ninguém é encerrado: a volta espera até o prazo do instalar e depois segue", async () => {
    instalacao = montarInstalacao();
    const encerrados: number[] = [];
    const efeitos = efeitosDeTeste({ existe: () => true, inicioDoProcesso: () => null, encerrarArvore: async (pid) => (encerrados.push(pid), true) });
    const agora = new Date().toISOString();
    gravar(noInstalar(PID_DO_INSTALAR, agora, agora));
    const pasta = retratoDaPasta(instalacao.raiz);

    expect(await voltar(efeitos)).toEqual({ tipo: "em_andamento" });
    expect(andamentoNoDisco()).toMatchObject({ fase: "instalar", processo: { pid: PID_DO_INSTALAR } });
    gravar({ ...noInstalar(PID_DO_INSTALAR, agora, agora), fase: "trocar", trocas: [{ caminho: "nucleo", tinhaAntiga: true, temNova: true }] });
    expect(await recomporArvore(instalacao.raiz, efeitos)).toEqual({ tipo: "em_andamento" });
    expect(retratoDaPasta(instalacao.raiz)).toEqual(pasta);

    gravar(noInstalar(PID_DO_INSTALAR, HA_MUITO, HA_MUITO));
    expect(await voltar(efeitos)).toEqual({ tipo: "desfeita", de: "0.1.0", para: "0.2.0" });
    expect(encerrados).toEqual([]);
  });

  test("sem como ler a hora, o atualizador ainda encerra o instalar que ele segura e que passou do prazo", async () => {
    instalacao = montarInstalacao();
    const pasta = retratoDaPasta(instalacao.raiz);
    const encerrados: number[] = [];
    let sair = (_instalado: Instalado) => {};
    const efeitos = efeitosDeTeste({
      iniciarInstalar: () => ({ pid: PID_DO_INSTALAR, fim: new Promise<Instalado>((resolver) => (sair = resolver)) }),
      existe: () => encerrados.length === 0,
      inicioDoProcesso: () => null,
      async encerrarArvore(pid) {
        encerrados.push(pid);
        sair({ ok: false, detalhe: "encerrado" });
        return true;
      },
    });

    const desfecho = await atualizar({ raizDoRepo: instalacao.raiz, dirDados: instalacao.dirDados, prazos: { ...PRAZOS_CURTOS, instalarMs: 20 } }, efeitos);

    expect(desfecho).toMatchObject({ tipo: "desfeita", servidorNoAr: true, andamento: { processo: null, falha: { passo: "instalar" } } });
    expect(encerrados).toEqual([PID_DO_INSTALAR]);
    expect(retratoDaPasta(instalacao.raiz)).toEqual(pasta);
  });

  test("o instalar que já saiu sozinho sai do andamento antes da volta, sem ser encerrado pelo pid", async () => {
    instalacao = montarInstalacao();
    const encerrados: number[] = [];
    const efeitos = efeitosDeTeste({
      iniciarInstalar: () => ({ pid: PID_DO_INSTALAR, fim: Promise.resolve({ ok: false, detalhe: "falhou" }) }),
      existe: () => true,
      inicioDoProcesso: () => null,
      encerrarArvore: async (pid) => (encerrados.push(pid), true),
    });

    expect(await rodar(efeitos)).toMatchObject({ tipo: "desfeita", andamento: { processo: null, falha: { passo: "instalar" } } });
    expect(encerrados).toEqual([]);
  });

  test("a hora de início vira o relógio de cada sistema", () => {
    expect(msDoInicio("Sun Nov 15 11:19:30 2026", "darwin")).toBe(new Date(2026, 10, 15, 11, 19, 30).getTime());
    expect(msDoInicio("Sun Nov  5 09:01:02 2026", "darwin")).toBe(new Date(2026, 10, 5, 9, 1, 2).getTime());
    expect(msDoInicio(String(621_355_968_000_000_000n + 17_000_000_000_000_000n), "win32")).toBe(1_700_000_000_000);
    expect(msDoInicio("hora do instalar", "win32")).toBeNull();
    expect(msDoInicio("hora do instalar", "darwin")).toBeNull();
    expect(msDoInicio("hora do instalar", "linux")).toBeNull();

    const inicio = efeitosReais().inicioDoProcesso(process.pid);
    if (inicio === null) throw new Error("o sistema não deu a hora de início deste processo");
    const nasceu = msDoInicio(inicio, process.platform);
    expect(nasceu).not.toBeNull();
    expect(Math.abs((nasceu ?? 0) - (Date.now() - process.uptime() * 1_000))).toBeLessThan(2_000);
  });
});

describe("a lista de troca", () => {
  test.each([
    ["package.json", "package.json"],
    ["nucleo/cli/main.ts", "nucleo"],
    ["docs/arquitetura.md", "docs"],
    ["testes/falsos/crm.ts", "testes"],
    ["novidades/0.1.0.md", "novidades"],
    [".claude/settings.json", ".claude/settings.json"],
    [".agents/skills/bom-dia/SKILL.md", ".agents/skills/bom-dia"],
    [".agents/skills/shadcn/rules/a.md", ".agents/skills/shadcn"],
  ])("%s é trocado pela entrada %s", (caminho, unidade) => {
    expect(unidadeDaTroca(caminho)).toBe(unidade);
  });

  test.each([
    "meu/AGENTS.md",
    "meu",
    "node_modules/zod/index.js",
    ".git/config",
    ".atualizacao/andamento.json",
    ".claude/settings.local.json",
    ".claude/skills/bom-dia/SKILL.md",
    ".agents/skills/meu-coisa/SKILL.md",
    ".agents/skills/solto.md",
    "../fora",
    "nucleo/../meu/AGENTS.md",
    "/etc/passwd",
    "C:\\Windows",
    "",
  ])("%s fica fora da troca", (caminho) => {
    expect(unidadeDaTroca(caminho)).toBeNull();
  });
});

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { caminhosDosDados } from "../../nucleo/ambiente";
import { historico, lerConector } from "../../nucleo/banco";
import type { Conectores, Temporizador } from "../../nucleo/conectores";
import { PRAZOS_MS, acoesPossiveis, type EstadoWhatsapp } from "../../nucleo/dominio";
import { WACLI_FALSO, efeitosAssentados, esperar, montarBancada, sondar, vivo, type Bancada } from "../falsos/bancada";
import { chatDoWacli, contatoDoWacli, mensagemDoWacli, type LeiturasDoWacliFalso, type PassoDoWacliFalso } from "../falsos/wacli";

/** Conectores sobre uma bancada cujo `Ambiente` não tem o comando do wacli. */
function criarSemWacli(b: Bancada): Conectores {
  (b.ambiente as { wacli: readonly string[] }).wacli = [];
  return b.ligar();
}

const TELEFONE = "5511912345678";
const QR_1 = "CANARIO-qr-1-2@AbCdEf,gHiJkL==";
const QR_2 = "CANARIO-qr-2-2@MnOpQr,sTuVwX==";
const CODIGO = "CANARIO-K7QP-2MZX";
const CANARIOS = [QR_1, QR_2, CODIGO];

const PAREAR: readonly PassoDoWacliFalso[] = [
  { emitir: "qr_code", dados: { code: QR_1 } },
  { aguardar: "leu" },
  { parear: { telefone: TELEFONE } },
  { emitir: "connected" },
  { emitir: "progress", dados: { messages_synced: 42 } },
  { aguardar: "sincronizou" },
  { emitir: "idle_exit", dados: { messages_synced: 42 } },
  { sair: 0 },
];
const ESPELHAR: readonly PassoDoWacliFalso[] = [{ emitir: "connected" }, { ficarVivo: true }];

// Cada passo abre processos de verdade; num runner lento de CI os 5 s padrão não bastam.
setDefaultTimeout(30_000);

let bancada: Bancada;

function nova(): Bancada {
  bancada = montarBancada();
  return bancada;
}

afterEach(async () => {
  await bancada.limpar();
  // Depois de `parar()`, nenhum wacli que os conectores abriram segue vivo.
  expect(bancada.chamadas().filter((chamada) => vivo(chamada.pid))).toEqual([]);
  const registro = bancada.linhasDoRegistro.join("\n");
  for (const canario of CANARIOS) expect(registro).not.toContain(canario);
});

function wa(conectores: Conectores): EstadoWhatsapp {
  return conectores.estado().whatsapp;
}

function comandos(b: Bancada, primeiro: string): readonly (readonly string[])[] {
  return b
    .chamadas()
    .map((chamada) => chamada.args.filter((arg) => arg !== "--read-only" && arg !== "--json"))
    .filter((args) => args[0] === primeiro);
}

const sincronizacoes = (b: Bancada) => comandos(b, "sync");
const pareamentos = (b: Bancada) => comandos(b, "auth").filter((args) => args[1] !== "status" && args[1] !== "logout");
const logouts = (b: Bancada) => comandos(b, "auth").filter((args) => args[1] === "logout");

/** Leva um conector desligado até `confirmar_conta`. */
async function parearAteConfirmar(b: Bancada, conectores: Conectores): Promise<void> {
  expect((await conectores.agir("whatsapp", "conectar")).ok).toBe(true);
  await esperar(conectores, (e) => e.whatsapp.fase === "pareando" && e.whatsapp.meio.tipo === "qr", "QR no painel");
  b.celular("leu");
  await esperar(conectores, (e) => e.whatsapp.fase === "sincronizando", "sincronizando");
  b.celular("sincronizou");
  await esperar(conectores, (e) => e.whatsapp.fase === "confirmar_conta", "confirmar a conta");
}

async function conectar(b: Bancada, conectores: Conectores): Promise<void> {
  await parearAteConfirmar(b, conectores);
  expect((await conectores.agir("whatsapp", "confirmar")).ok).toBe(true);
  await esperar(conectores, (e) => e.whatsapp.fase === "conectado" && e.whatsapp.espelho === "ao_vivo", "espelho ao vivo");
}

describe("WhatsApp: fluxo feliz", () => {
  test("pareia por QR, confirma a conta, liga o espelho, testa e desconecta", async () => {
    const b = nova();
    b.roteiro({
      auth: [{ emitir: "qr_code", dados: { code: QR_1 } }, { aguardar: "renovar" }, { emitir: "qr_code", dados: { code: QR_2 } }, ...PAREAR.slice(1)],
      sync: ESPELHAR,
    });
    const conectores = b.ligar();
    await conectores.pronto;
    expect(wa(conectores)).toEqual({ fase: "desconectado" });

    const pedido = await conectores.agir("whatsapp", "conectar");
    expect(pedido.ok && pedido.dados.estado.fase).toBe("pareando");

    const comQr = await esperar(conectores, (e) => e.whatsapp.fase === "pareando" && e.whatsapp.meio.tipo === "qr", "primeiro QR");
    expect(comQr.whatsapp).toMatchObject({ meio: { tipo: "qr", qr: QR_1 } });
    b.celular("renovar");
    // QR novo substitui o anterior: o retrato só carrega o último.
    const renovado = await esperar(
      conectores,
      (e) => e.whatsapp.fase === "pareando" && e.whatsapp.meio.tipo === "qr" && e.whatsapp.meio.qr === QR_2,
      "QR renovado",
    );
    expect(JSON.stringify(renovado)).not.toContain(QR_1);

    b.celular("leu");
    const sincronizando = await esperar(conectores, (e) => e.whatsapp.fase === "sincronizando" && e.whatsapp.mensagens === 42, "progresso");
    expect(acoesPossiveis(sincronizando.whatsapp)).toEqual(["cancelar"]);

    b.celular("sincronizou");
    const confirmar = await esperar(conectores, (e) => e.whatsapp.fase === "confirmar_conta", "confirmar a conta");
    expect<unknown>(confirmar.whatsapp).toEqual({ fase: "confirmar_conta", conta: { telefone: `+${TELEFONE}` } });
    // A coleta só liga depois do "sim": até aqui nenhum `sync` rodou e nada foi gravado como conectado.
    expect(sincronizacoes(b)).toEqual([]);
    expect(lerConector(b.banco, "whatsapp")).toEqual({ fase: "desconectado" });

    const sim = await conectores.agir("whatsapp", "confirmar");
    expect(sim.ok && sim.dados.estado.fase).toBe("conectado");
    await esperar(conectores, (e) => e.whatsapp.fase === "conectado" && e.whatsapp.espelho === "ao_vivo", "espelho ao vivo");

    expect(pareamentos(b)).toEqual([["auth", "--events", "--history-days", "90"]]);
    expect(sincronizacoes(b)).toEqual([["sync", "--follow", "--events", "--presence-mode", "quiet", "--max-reconnect", "0"]]);
    const store = caminhosDosDados(b.ambiente).storeDoWacli;
    for (const chamada of b.chamadas()) {
      expect(chamada.store).toBe(store);
      expect(chamada.env.WACLI_SYNC_MAX_DB_SIZE).toBe("2GB");
    }
    expect(lerConector(b.banco, "whatsapp")).toMatchObject({ fase: "conectado", conta: { telefone: `+${TELEFONE}` } });

    const teste = await conectores.agir("whatsapp", "testar");
    expect(teste.ok && teste.dados.estado).toMatchObject({ fase: "conectado", espelho: "ao_vivo" });
    expect(sincronizacoes(b)).toHaveLength(1);

    const fim = await conectores.agir("whatsapp", "desconectar");
    expect(fim.ok && fim.dados.estado).toEqual({ fase: "desconectado" });
    expect(logouts(b)).toHaveLength(1);
    expect(existsSync(store)).toBe(false);
    expect(lerConector(b.banco, "whatsapp")).toEqual({ fase: "desconectado" });
    expect(b.chamadas().filter((chamada) => vivo(chamada.pid))).toEqual([]);

    // Sondagens e leituras nunca escrevem: todas levaram `--read-only --json`.
    for (const chamada of b.chamadas()) {
      const escreve = ["auth --events", "sync --follow", "auth logout"].some((inicio) => chamada.args.join(" ").startsWith(inicio));
      if (!escreve) expect(chamada.args.slice(0, 2)).toEqual(["--read-only", "--json"]);
    }
    const tudo = b.textoDaPastaDeDados();
    for (const canario of CANARIOS) expect(tudo).not.toContain(canario);
    expect(historico(b.banco, "whatsapp", 10).map((evento) => evento.tipo)).toEqual(["desconectado", "conectado", "conectado"]);
  });

  test("pareia pelo código do telefone", async () => {
    const b = nova();
    b.roteiro({
      auth: [{ emitir: "pair_code", dados: { phone: TELEFONE, code: CODIGO } }, ...PAREAR.slice(1)],
      sync: ESPELHAR,
    });
    const conectores = b.ligar();
    await conectores.pronto;

    expect((await conectores.agir("whatsapp", "conectar", { meio: "codigo", telefone: "5511" })).ok).toBe(false);
    expect(pareamentos(b)).toEqual([]);

    await conectores.agir("whatsapp", "conectar", { meio: "codigo", telefone: `+${TELEFONE}` });
    const comCodigo = await esperar(conectores, (e) => e.whatsapp.fase === "pareando" && e.whatsapp.meio.tipo === "codigo", "código no painel");
    expect(comCodigo.whatsapp).toMatchObject({ meio: { tipo: "codigo", codigo: CODIGO, telefone: `+${TELEFONE}` } });
    expect(pareamentos(b)).toEqual([["auth", "--events", "--history-days", "90", "--phone", `+${TELEFONE}`]]);
    expect(b.textoDaPastaDeDados()).not.toContain(CODIGO);
  });

  test("o 'não é a minha conta' desloga, apaga a store e nunca liga o espelho", async () => {
    const b = nova();
    b.roteiro({ auth: PAREAR, sync: ESPELHAR });
    const conectores = b.ligar();
    await conectores.pronto;
    await parearAteConfirmar(b, conectores);

    const nao = await conectores.agir("whatsapp", "recusar");
    expect(nao.ok && nao.dados.estado).toEqual({ fase: "desconectado" });
    expect(logouts(b)).toEqual([["auth", "logout"]]);
    expect(existsSync(caminhosDosDados(b.ambiente).storeDoWacli)).toBe(false);
    expect(sincronizacoes(b)).toEqual([]);

    const sondagem = await conectores.agir("whatsapp", "conectar");
    expect(sondagem.ok).toBe(true);
  });
});

describe("WhatsApp: problemas", () => {
  test("`logged_out` no espelho leva a atenção, com saída", async () => {
    const b = nova();
    b.roteiro({ auth: PAREAR, sync: [{ emitir: "connected" }, { aguardar: "revogar" }, { revogar: true }, { sair: 0 }] });
    const conectores = b.ligar();
    await conectores.pronto;
    await conectar(b, conectores);

    b.celular("revogar");
    const atencao = await esperar(conectores, (e) => e.whatsapp.fase === "atencao", "atenção");
    expect(atencao.whatsapp).toMatchObject({ problema: { codigo: "whatsapp_sessao_revogada", detalhe: "device_removed" } });
    expect(acoesPossiveis(atencao.whatsapp)).toEqual(["conectar"]);
    await efeitosAssentados(conectores, "whatsapp");
    expect(lerConector(b.banco, "whatsapp")).toMatchObject({ fase: "atencao", problema: { codigo: "whatsapp_sessao_revogada" } });
    // O espelho não fica reiniciando contra uma sessão morta.
    expect(sincronizacoes(b)).toHaveLength(1);

    b.roteiro({ auth: PAREAR, sync: ESPELHAR });
    await conectar(b, conectores);
    expect(wa(conectores).fase).toBe("conectado");
  });

  test("espelho que cai cinco vezes desiste, pede atenção e volta com Testar", async () => {
    const b = nova();
    b.roteiro({ auth: PAREAR, sync: [{ sair: 1 }] });
    const conectores = b.ligar();
    await conectores.pronto;
    await parearAteConfirmar(b, conectores);
    await conectores.agir("whatsapp", "confirmar");

    const atencao = await esperar(conectores, (e) => e.whatsapp.fase === "atencao", "atenção");
    expect(atencao.whatsapp).toMatchObject({ problema: { codigo: "whatsapp_espelho_caindo" }, conta: { telefone: `+${TELEFONE}` } });
    expect(sincronizacoes(b)).toHaveLength(5);
    expect(acoesPossiveis(atencao.whatsapp)).toEqual(["testar", "desconectar"]);

    b.roteiro({ auth: PAREAR, sync: ESPELHAR });
    const teste = await conectores.agir("whatsapp", "testar");
    expect(teste.ok && teste.dados.estado.fase).toBe("conectado");
    await esperar(conectores, (e) => e.whatsapp.fase === "conectado" && e.whatsapp.espelho === "ao_vivo", "espelho de volta");
  });

  test("o teto do banco para o espelho e pede atenção", async () => {
    const b = nova();
    const erro = { message: "sync storage limit reached: database size is 2147483649, limit is 2147483648" };
    b.roteiro({ auth: PAREAR, sync: [{ emitir: "connected" }, { aguardar: "encher" }, { emitir: "error", dados: erro }, { sair: 1 }] });
    const conectores = b.ligar();
    await conectores.pronto;
    await conectar(b, conectores);
    b.celular("encher");
    const atencao = await esperar(conectores, (e) => e.whatsapp.fase === "atencao", "atenção");
    expect(atencao.whatsapp).toMatchObject({ problema: { codigo: "whatsapp_limite_do_banco" } });
    expect(sincronizacoes(b)).toHaveLength(1);
  });

  test("passkey exigida no pareamento vira atenção", async () => {
    const b = nova();
    const erro = { message: "WhatsApp requires passkey verification, which wacli cannot safely complete yet" };
    b.roteiro({ auth: [{ emitir: "qr_code", dados: { code: QR_1 } }, { aguardar: "leu" }, { emitir: "error", dados: erro }, { sair: 1 }], sync: [] });
    const conectores = b.ligar();
    await conectores.pronto;
    await conectores.agir("whatsapp", "conectar");
    await esperar(conectores, (e) => e.whatsapp.fase === "pareando" && e.whatsapp.meio.tipo === "qr", "QR");
    b.celular("leu");
    const atencao = await esperar(conectores, (e) => e.whatsapp.fase === "atencao", "atenção");
    expect(atencao.whatsapp).toMatchObject({ problema: { codigo: "whatsapp_passkey_exigida" } });
    expect(acoesPossiveis(atencao.whatsapp)).toEqual(["conectar"]);
  });

  test("pareamento que sai sem parear volta a desconectado", async () => {
    const b = nova();
    b.roteiro({ auth: [{ emitir: "qr_code", dados: { code: QR_1 } }, { texto: "aviso humano no meio do stderr" }, { sair: 1 }], sync: [] });
    const conectores = b.ligar();
    await conectores.pronto;
    await conectores.agir("whatsapp", "conectar");
    await esperar(conectores, (e) => e.whatsapp.fase === "desconectado", "desconectado");
    expect(acoesPossiveis(wa(conectores))).toEqual(["conectar"]);
  });

  test("sem o binário, o conector pede atenção no boot e ao conectar", async () => {
    bancada = montarBancada();
    const semBinario = { ...bancada.ambiente, wacli: [join(bancada.dirFalso, "wacli-que-nao-existe")] };
    const { criarConectores } = await import("../../nucleo/conectores");
    const conectores = criarConectores(semBinario, bancada.banco, bancada.cofre, { registro: bancada.registro });
    try {
      await conectores.pronto;
      expect(wa(conectores)).toMatchObject({ fase: "atencao", problema: { codigo: "whatsapp_binario_ausente" } });
      expect(acoesPossiveis(wa(conectores))).toEqual(["testar"]);
      const teste = await conectores.agir("whatsapp", "testar");
      expect(teste).toMatchObject({ ok: false, erro: { codigo: "whatsapp_binario_ausente" } });
    } finally {
      await conectores.parar();
    }
  });

  test("o prazo do pareamento devolve o conector a desconectado e para o processo", async () => {
    const b = nova();
    b.roteiro({ auth: [{ emitir: "qr_code", dados: { code: QR_1 } }, { ficarVivo: true }], sync: [] });
    const prazos: { readonly ms: number; readonly disparar: () => void }[] = [];
    const armar: Temporizador = (ms, disparar) => {
      prazos.push({ ms, disparar });
      return () => {};
    };
    const conectores = b.ligar({ armar });
    await conectores.pronto;
    await conectores.agir("whatsapp", "conectar");
    await esperar(conectores, (e) => e.whatsapp.fase === "pareando" && e.whatsapp.meio.tipo === "qr", "QR");
    const [prazo] = prazos;
    expect(prazo?.ms).toBeGreaterThan(PRAZOS_MS.pareamento - 5_000);

    // Prazo que dispara cedo não muda nada: a máquina confere o relógio.
    prazo?.disparar();
    expect(wa(conectores).fase).toBe("pareando");

    b.avancar(PRAZOS_MS.pareamento + 1_000);
    prazo?.disparar();
    expect(wa(conectores)).toEqual({ fase: "desconectado" });
    await efeitosAssentados(conectores, "whatsapp");
    expect(b.chamadas().filter((chamada) => vivo(chamada.pid))).toEqual([]);
  });
});

describe("WhatsApp: cada ação duas vezes e em paralelo", () => {
  test("converge sem segundo processo", async () => {
    const b = nova();
    b.roteiro({ auth: PAREAR, sync: ESPELHAR });
    const conectores = b.ligar();
    await conectores.pronto;

    const conectando = await Promise.all([conectores.agir("whatsapp", "conectar"), conectores.agir("whatsapp", "conectar")]);
    expect(conectando.map((r) => r.ok)).toEqual([true, true]);
    await esperar(conectores, (e) => e.whatsapp.fase === "pareando" && e.whatsapp.meio.tipo === "qr", "QR");
    expect((await conectores.agir("whatsapp", "conectar")).ok).toBe(true);
    expect(pareamentos(b)).toHaveLength(1);

    const cancelando = await Promise.all([conectores.agir("whatsapp", "cancelar"), conectores.agir("whatsapp", "cancelar")]);
    expect(cancelando.map((r) => r.ok && r.dados.estado.fase)).toEqual(["desconectado", "desconectado"]);
    expect(b.chamadas().filter((chamada) => vivo(chamada.pid))).toEqual([]);

    // Cancelar e conectar em seguida: o processo antigo sai antes de o novo pegar o lock da store.
    await conectores.agir("whatsapp", "conectar");
    await Promise.all([conectores.agir("whatsapp", "cancelar"), conectores.agir("whatsapp", "conectar")]);
    await esperar(conectores, (e) => e.whatsapp.fase === "pareando" && e.whatsapp.meio.tipo === "qr", "QR do novo pareamento");
    b.celular("leu");
    await esperar(conectores, (e) => e.whatsapp.fase === "sincronizando", "sincronizando");
    b.celular("sincronizou");
    await esperar(conectores, (e) => e.whatsapp.fase === "confirmar_conta", "confirmar a conta");

    const confirmando = await Promise.all([conectores.agir("whatsapp", "confirmar"), conectores.agir("whatsapp", "confirmar")]);
    expect(confirmando.map((r) => r.ok && r.dados.estado.fase)).toEqual(["conectado", "conectado"]);
    await esperar(conectores, (e) => e.whatsapp.fase === "conectado" && e.whatsapp.espelho === "ao_vivo", "espelho ao vivo");

    const testando = await Promise.all([conectores.agir("whatsapp", "testar"), conectores.agir("whatsapp", "testar")]);
    expect(testando.map((r) => r.ok && r.dados.estado.fase)).toEqual(["conectado", "conectado"]);
    expect(sincronizacoes(b)).toHaveLength(1);

    const fora = await conectores.agir("whatsapp", "recusar");
    expect(fora).toMatchObject({ ok: false, erro: { codigo: "acao_indisponivel" } });

    const saindo = await Promise.all([conectores.agir("whatsapp", "desconectar"), conectores.agir("whatsapp", "desconectar")]);
    expect(saindo.map((r) => r.ok && r.dados.estado.fase)).toEqual(["desconectado", "desconectado"]);
    expect(logouts(b)).toHaveLength(1);
    expect((await conectores.agir("whatsapp", "recusar")).ok).toBe(true);
  });
});

describe("WhatsApp: sondagem que perde a corrida", () => {
  test("desconectar pedido junto com testar não ressuscita a conta", async () => {
    const b = nova();
    b.roteiro({ auth: PAREAR, sync: ESPELHAR });
    const conectores = b.ligar();
    await conectores.pronto;
    await conectar(b, conectores);

    // O wacli responde à sondagem "autenticado" antes de o logout rodar: esse retrato já nasce velho.
    const [, saida] = await Promise.all([conectores.agir("whatsapp", "testar"), conectores.agir("whatsapp", "desconectar")]);
    expect(saida.ok && saida.dados.estado).toEqual({ fase: "desconectado" });
    expect(wa(conectores)).toEqual({ fase: "desconectado" });
    expect(lerConector(b.banco, "whatsapp")).toEqual({ fase: "desconectado" });
    expect(existsSync(caminhosDosDados(b.ambiente).storeDoWacli)).toBe(false);
  });

  test("conectar pedido durante a sondagem de boot não é desfeito por ela", async () => {
    const b = nova();
    b.roteiro({ auth: PAREAR, sync: ESPELHAR });
    const conectores = b.ligar();
    const pedido = await conectores.agir("whatsapp", "conectar");
    expect(pedido.ok && pedido.dados.estado.fase).toBe("pareando");
    await conectores.pronto;
    await esperar(conectores, (e) => e.whatsapp.fase === "pareando" && e.whatsapp.meio.tipo === "qr", "QR");
    expect(pareamentos(b)).toHaveLength(1);
  });
});

describe("WhatsApp: queda do servidor em cada fase", () => {
  async function orfaos(b: Bancada): Promise<number[]> {
    return b.chamadas().filter((chamada) => vivo(chamada.pid)).map((chamada) => chamada.pid);
  }

  /** Cada wacli que rodou, com a sonda do pid: vai na mensagem do assert para o log do CI mostrar o fato. */
  function retrato(b: Bancada): string {
    return JSON.stringify(b.chamadas().map((chamada) => ({ ...sondar(chamada.pid), args: chamada.args.slice(0, 3) })));
  }

  /**
   * O wacli que o servidor morto deixou, lido antes de religar. Se ele sobrevive ao pai depende do
   * sistema, então o teste lê o fato e cobra de cada ramo o comportamento dele.
   */
  type Queda = { readonly ramo: "orfao_vivo"; readonly pid: number } | { readonly ramo: "sem_orfao" };

  async function lerQueda(b: Bancada, fase: string): Promise<Queda> {
    const vivos = await orfaos(b);
    expect(vivos.length, `queda em ${fase}: mais de um wacli vivo. ${retrato(b)}`).toBeLessThanOrEqual(1);
    const queda: Queda = vivos[0] === undefined ? { ramo: "sem_orfao" } : { ramo: "orfao_vivo", pid: vivos[0] };
    console.info(`queda em ${fase} (${process.platform}): ramo ${queda.ramo}`);
    return queda;
  }

  function conferirReligada(b: Bancada, queda: Queda): void {
    const registro = b.linhasDoRegistro.join("\n");
    const contexto = `ramo ${queda.ramo} em ${process.platform}. ${retrato(b)}`;
    if (queda.ramo === "orfao_vivo") {
      expect(registro, contexto).toContain("whatsapp.orfao_encerrado");
      expect(vivo(queda.pid), contexto).toBe(false);
    } else {
      expect(registro, contexto).not.toContain("whatsapp.orfao_encerrado");
      expect(registro, contexto).not.toContain("processo.orfao_sinalizado");
    }
  }

  test("em pareando: o wacli órfão é encerrado e o conector volta a desconectado", async () => {
    const b = nova();
    b.roteiro({ auth: PAREAR, sync: ESPELHAR });
    await b.quedaEm([{ id: "whatsapp", acao: "conectar" }], (e) => e.whatsapp.fase === "pareando" && e.whatsapp.meio.tipo === "qr");
    const queda = await lerQueda(b, "pareando");

    const conectores = b.ligar();
    await conectores.pronto;
    expect(wa(conectores)).toEqual({ fase: "desconectado" });
    conferirReligada(b, queda);

    await conectar(b, conectores);
    expect(wa(conectores).fase).toBe("conectado");
  });

  test("em sincronizando: a conta pareada volta pedindo confirmação", async () => {
    const b = nova();
    b.roteiro({ auth: PAREAR, sync: ESPELHAR });
    b.celular("leu");
    await b.quedaEm([{ id: "whatsapp", acao: "conectar" }], (e) => e.whatsapp.fase === "sincronizando" && e.whatsapp.mensagens === 42);
    const queda = await lerQueda(b, "sincronizando");

    const conectores = b.ligar();
    await conectores.pronto;
    expect<unknown>(wa(conectores)).toEqual({ fase: "confirmar_conta", conta: { telefone: `+${TELEFONE}` } });
    expect(acoesPossiveis(wa(conectores))).toEqual(["confirmar", "recusar"]);
    conferirReligada(b, queda);

    await conectores.agir("whatsapp", "confirmar");
    await esperar(conectores, (e) => e.whatsapp.fase === "conectado" && e.whatsapp.espelho === "ao_vivo", "espelho ao vivo");
  });

  test("em confirmar_conta: volta para a mesma pergunta", async () => {
    const b = nova();
    b.roteiro({ auth: PAREAR, sync: ESPELHAR });
    b.celular("leu");
    b.celular("sincronizou");
    await b.quedaEm([{ id: "whatsapp", acao: "conectar" }], (e) => e.whatsapp.fase === "confirmar_conta");
    expect(await orfaos(b)).toEqual([]);

    const conectores = b.ligar();
    await conectores.pronto;
    expect(wa(conectores).fase).toBe("confirmar_conta");
    const nao = await conectores.agir("whatsapp", "recusar");
    expect(nao.ok && nao.dados.estado).toEqual({ fase: "desconectado" });
  });

  test("em conectado: o espelho órfão sai e um novo assume", async () => {
    const b = nova();
    b.roteiro({ auth: PAREAR, sync: ESPELHAR });
    b.celular("leu");
    b.celular("sincronizou");
    await b.quedaEm(
      [
        { id: "whatsapp", acao: "conectar" },
        { id: "whatsapp", acao: "confirmar", naFase: "confirmar_conta" },
      ],
      (e) => e.whatsapp.fase === "conectado" && e.whatsapp.espelho === "ao_vivo",
    );
    const queda = await lerQueda(b, "conectado");
    expect(lerConector(b.banco, "whatsapp").fase).toBe("conectado");

    const conectores = b.ligar();
    await conectores.pronto;
    await esperar(conectores, (e) => e.whatsapp.fase === "conectado" && e.whatsapp.espelho === "ao_vivo", "espelho ao vivo");
    conferirReligada(b, queda);
    expect(sincronizacoes(b)).toHaveLength(2);
    expect(await orfaos(b), retrato(b)).toHaveLength(1);
  });

  test("em qualquer sistema: um sync --follow que não é filho do servidor e segura o lock é encerrado no boot", async () => {
    const b = nova();
    b.roteiro({ auth: PAREAR, sync: ESPELHAR });
    const primeiro = b.ligar();
    await primeiro.pronto;
    await conectar(b, primeiro);
    await primeiro.parar();

    const store = caminhosDosDados(b.ambiente).storeDoWacli;
    const sobrevivente = Bun.spawn([process.execPath, WACLI_FALSO, `--falso=${b.dirFalso}`, "sync", "--follow", "--events"], {
      env: { ...process.env, WACLI_STORE_DIR: store },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    const leitor = sobrevivente.stderr.getReader();
    const { value } = await leitor.read();
    leitor.releaseLock();
    expect(new TextDecoder().decode(value)).toContain('"connected"');

    const conectores = b.ligar();
    await conectores.pronto;
    await esperar(conectores, (e) => e.whatsapp.fase === "conectado" && e.whatsapp.espelho === "ao_vivo", "espelho ao vivo");
    await sobrevivente.exited;
    expect(b.linhasDoRegistro.join("\n")).toContain("whatsapp.orfao_encerrado");
    expect(vivo(sobrevivente.pid)).toBe(false);
  });
});

describe("WhatsApp: leitura para o agente", () => {
  test("só comandos da lista, sempre com --read-only --json", async () => {
    const b = nova();
    const conectores = b.ligar();
    await conectores.pronto;
    const antes = b.chamadas().length;

    const busca = await conectores.lerWhatsapp(["messages", "search", "pedido 123", "--limit", "5"]);
    expect(busca).toEqual({ ok: true, dados: { tipo: "busca", mensagens: [], contexto: [], pagina: { temMais: false, cursor: null } } });
    expect(b.chamadas().at(-1)).toMatchObject({
      args: ["--read-only", "--json", "messages", "search", "--limit=5", "--", "pedido 123"],
      env: { WACLI_READONLY: "1" },
    });
    for (const args of [["messages", "list"], ["chats", "list"], ["contacts", "search", "ana"]]) {
      expect((await conectores.lerWhatsapp(args)).ok).toBe(true);
    }
    expect(await conectores.lerWhatsapp(["doctor"])).toMatchObject({ ok: true, dados: { tipo: "diagnostico", dados: { lock_held: false } } });
    const feitas = b.chamadas().length;
    expect(feitas).toBe(antes + 5);

    const recusadas = [
      ["send", "text", "--to", "5511999999999", "--message", "oi"],
      ["messages", "edit", "x"],
      ["chats", "mark-read", "x"],
      ["auth", "logout"],
      ["sync", "--once"],
      ["messages", "list", "--store", "/outra"],
      ["messages", "list", "--read-only=false"],
      ["messages", "list", "--account=outra"],
      ["doctor", "--connect"],
      ["messages", "list", "--timeout", "1h"],
      ["messages", "search", "-x"],
      [],
    ];
    for (const args of recusadas) {
      expect(await conectores.lerWhatsapp(args)).toMatchObject({ ok: false, erro: { codigo: "entrada_invalida" } });
    }
    expect(b.chamadas()).toHaveLength(feitas);
  });

  test("nenhum argv de envio existe no código dos conectores", () => {
    const raiz = join(import.meta.dir, "..", "..", "nucleo");
    const achados: string[] = [];
    const visitar = (dir: string) => {
      for (const nome of readdirSync(dir)) {
        const caminho = join(dir, nome);
        if (statSync(caminho).isDirectory()) visitar(caminho);
        else if (/\.tsx?$/.test(nome) && !/\.test\.tsx?$/.test(nome) && /["'`]send["'`]/.test(readFileSync(caminho, "utf8"))) achados.push(caminho);
      }
    };
    for (const modulo of ["conectores", "processos"]) visitar(join(raiz, modulo));
    expect(achados).toEqual([]);
  });
});

describe("WhatsApp: leituras do servidor, em tipos de domínio", () => {
  const CLIENTE = "5511900000001@s.whatsapp.net";
  const OUTRO = "5511900000002@s.whatsapp.net";
  const LID = "198765432109876@lid";
  const em = (segundos: number) => `2026-11-13T12:00:${String(segundos).padStart(2, "0")}Z`;
  const LEITURAS: LeiturasDoWacliFalso = {
    chats: [
      chatDoWacli({ jid: CLIENTE, name: "Cliente Canário", last_message_ts: em(30), unread: true, unread_count: 2 }),
      chatDoWacli({ jid: OUTRO, name: "Outro Canário", last_message_ts: em(20) }),
      chatDoWacli({ jid: "120363000000000001@g.us", kind: "group", name: "Equipe", last_message_ts: em(10), unread: true, unread_count: 1 }),
    ],
    mensagens: [1, 2, 3, 4].map((n) => mensagemDoWacli({ ChatJID: CLIENTE, MsgID: `3EB0CANARIO00${n}`, Timestamp: em(n), Text: `mensagem ${n}`, FromMe: n % 2 === 0 })),
    contatos: [contatoDoWacli({ jid: CLIENTE, phone: "5511900000001", name: "Cliente Canário" })],
    identidades: [
      { input: LID, jid: CLIENTE, phone: "5511900000001", lid: LID, resolved: true },
      { input: "+5511900000002", jid: OUTRO, phone: "5511900000002", resolved: false },
    ],
  };

  async function ligar(leituras: LeiturasDoWacliFalso = LEITURAS) {
    const b = nova();
    b.roteiro({ auth: [], sync: [], leituras });
    const conectores = b.ligar();
    await conectores.pronto;
    return { b, conectores };
  }

  test("listarConversas: devolve Conversa, filtra as não lidas e respeita o limite", async () => {
    const { b, conectores } = await ligar();
    const todas = await conectores.listarConversas();
    expect(todas).toMatchObject({ ok: true, dados: [{ jid: CLIENTE, tipo: "direta", nome: "Cliente Canário", naoLida: true, naoLidas: 2 }, { jid: OUTRO }, { jid: "120363000000000001@g.us", tipo: "grupo" }] });
    expect(b.chamadas().at(-1)?.args).toEqual(["--read-only", "--json", "chats", "list", "--limit=50", "--"]);

    const naoLidas = await conectores.listarConversas({ naoLidas: true, limite: 1 });
    expect(naoLidas.ok && naoLidas.dados.map((c) => c.jid)).toEqual([CLIENTE]);
    expect(b.chamadas().at(-1)?.args).toEqual(["--read-only", "--json", "chats", "list", "--limit=1", "--unread", "--"]);
    expect(b.chamadas().at(-1)?.env.WACLI_READONLY).toBe("1");
  });

  test("listarConversas: limite fora de 1 a 200 é entrada_invalida, sem chamar o wacli", async () => {
    const { b, conectores } = await ligar();
    const antes = b.chamadas().length;
    for (const limite of [0, -1, 201, 1.5, Number.NaN]) {
      expect(await conectores.listarConversas({ limite })).toMatchObject({ ok: false, erro: { codigo: "entrada_invalida" } });
    }
    expect(b.chamadas()).toHaveLength(antes);
  });

  test("ultimasMensagens: as N mais novas da conversa, em Mensagem de domínio", async () => {
    const { b, conectores } = await ligar();
    const ultimas = await conectores.ultimasMensagens(CLIENTE, 2);
    expect(ultimas).toMatchObject({
      ok: true,
      dados: [
        { id: "3EB0CANARIO004", conversa: CLIENTE, daConta: true, em: "2026-11-13T12:00:04.000Z", especie: "texto", texto: "mensagem 4", sinais: [] },
        { id: "3EB0CANARIO003", daConta: false, texto: "mensagem 3" },
      ],
    });
    expect(b.chamadas().at(-1)?.args).toEqual(["--read-only", "--json", "messages", "list", `--chat=${CLIENTE}`, "--limit=2", "--"]);
    expect((await conectores.ultimasMensagens(CLIENTE)).ok).toBe(true);
    expect(b.chamadas().at(-1)?.args).toContain("--limit=20");
  });

  test("ultimasMensagens: JID ruim e limite ruim são entrada_invalida, e um JID que parece flag não vira flag", async () => {
    const { b, conectores } = await ligar();
    const antes = b.chamadas().length;
    for (const [conversa, limite] of [["--store=/outra", 5], ["sem arroba", 5], ["", 5], [CLIENTE, 0], [CLIENTE, 201]] as const) {
      expect(await conectores.ultimasMensagens(conversa, limite)).toMatchObject({ ok: false, erro: { codigo: "entrada_invalida" } });
    }
    expect(b.chamadas()).toHaveLength(antes);
  });

  test("resolverIdentidades: o par de cada entrada, sempre com --read-only --json e -- antes das entradas", async () => {
    const { b, conectores } = await ligar();
    const pares = await conectores.resolverIdentidades([LID, "+5511900000002", "198765432109877@lid"]);
    expect<unknown>(pares).toEqual({
      ok: true,
      dados: [
        { entrada: LID, telefone: "+5511900000001", lid: LID, resolvido: true },
        { entrada: "+5511900000002", telefone: "+5511900000002", lid: null, resolvido: false },
        { entrada: "198765432109877@lid", telefone: null, lid: null, resolvido: false },
      ],
    });
    expect(b.chamadas().at(-1)).toMatchObject({
      args: ["--read-only", "--json", "contacts", "resolve", "--", LID, "+5511900000002", "198765432109877@lid"],
      env: { WACLI_READONLY: "1" },
    });
  });

  test("resolverIdentidades: entrada que não é telefone nem JID, lista vazia e lista grande demais são recusadas", async () => {
    const { b, conectores } = await ligar();
    const antes = b.chamadas().length;
    for (const entradas of [[], ["--store=/outra"], ["a b"], ["+55"], Array.from({ length: 51 }, (_, i) => `+55119000000${String(i).padStart(2, "0")}`)]) {
      expect(await conectores.resolverIdentidades(entradas)).toMatchObject({ ok: false, erro: { codigo: "entrada_invalida" } });
    }
    expect(b.chamadas()).toHaveLength(antes);
  });

  test("lerMensagem: acha pelo id e responde nao_encontrado para o que o wacli não tem", async () => {
    const { conectores } = await ligar();
    expect(await conectores.lerMensagem(CLIENTE, "3EB0CANARIO002")).toMatchObject({ ok: true, dados: { id: "3EB0CANARIO002", texto: "mensagem 2" } });
    expect(await conectores.lerMensagem(CLIENTE, "3EB0NAOTEM")).toMatchObject({ ok: false, erro: { codigo: "nao_encontrado" } });
    expect(await conectores.lerMensagem("sem arroba", "3EB0CANARIO002")).toMatchObject({ ok: false, erro: { codigo: "entrada_invalida" } });
  });

  test("resposta fora do formato é whatsapp_resposta_inesperada em todas as leituras do servidor", async () => {
    const lixo: LeiturasDoWacliFalso = {
      respostaCrua: { "chats list": { x: 1 }, "messages list": { messages: 5 }, "contacts resolve": [{ resolved: "sim" }], "messages show": { MsgID: 1 } },
    };
    const { conectores } = await ligar(lixo);
    const recusas = [
      await conectores.listarConversas(),
      await conectores.ultimasMensagens(CLIENTE),
      await conectores.resolverIdentidades([LID]),
      await conectores.lerMensagem(CLIENTE, "3EB0CANARIO002"),
    ];
    for (const recusa of recusas) expect(recusa).toMatchObject({ ok: false, erro: { codigo: "whatsapp_resposta_inesperada" } });
  });

  test("sem o binário do wacli, as leituras do servidor dizem whatsapp_binario_ausente", async () => {
    nova();
    const ausente = montarBancada();
    try {
      const semBinario = criarSemWacli(ausente);
      expect(await semBinario.listarConversas()).toMatchObject({ ok: false, erro: { codigo: "whatsapp_binario_ausente" } });
      expect(await semBinario.resolverIdentidades([LID])).toMatchObject({ ok: false, erro: { codigo: "whatsapp_binario_ausente" } });
    } finally {
      await ausente.limpar();
    }
  });
});

describe("WhatsApp: Novo QR", () => {
  test("troca o processo do pareamento, e dois pedidos da mesma rodada sobem um só", async () => {
    const b = nova();
    b.roteiro({ auth: [{ emitir: "qr_code", dados: { code: QR_1 } }, { aguardar: "nunca" }], sync: [] });
    const conectores = b.ligar();
    await conectores.pronto;
    expect((await conectores.agir("whatsapp", "conectar", { meio: "qr" })).ok).toBe(true);
    const primeiro = await esperar(conectores, (e) => e.whatsapp.fase === "pareando" && e.whatsapp.meio.tipo === "qr", "primeiro QR");
    const rodada = primeiro.whatsapp.fase === "pareando" ? primeiro.whatsapp.expiraEm : null;

    b.roteiro({ auth: [{ emitir: "qr_code", dados: { code: QR_2 } }, { aguardar: "nunca" }], sync: [] });
    const pedidos = await Promise.all([
      conectores.agir("whatsapp", "reparear", { meio: "qr", rodada }),
      conectores.agir("whatsapp", "reparear", { meio: "qr", rodada }),
    ]);
    expect(pedidos.map((pedido) => pedido.ok && pedido.dados.estado.fase)).toEqual(["pareando", "pareando"]);
    const novo = await esperar(
      conectores,
      (e) => e.whatsapp.fase === "pareando" && e.whatsapp.meio.tipo === "qr" && e.whatsapp.meio.qr === QR_2,
      "QR do pareamento novo",
    );
    expect(novo.whatsapp.fase === "pareando" && novo.whatsapp.expiraEm).not.toBe(rodada);
    expect(pareamentos(b)).toHaveLength(2);
    expect(b.chamadas().filter((chamada) => chamada.args[0] === "auth" && vivo(chamada.pid))).toHaveLength(1);

    expect((await conectores.agir("whatsapp", "cancelar")).ok).toBe(true);
  });

  test("fora do pareamento responde acao_indisponivel e não abre processo", async () => {
    const b = nova();
    const conectores = b.ligar();
    await conectores.pronto;
    expect(await conectores.agir("whatsapp", "reparear", { meio: "qr" })).toMatchObject({ ok: false, erro: { codigo: "acao_indisponivel" } });
    expect(pareamentos(b)).toEqual([]);
  });
});

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { caminhosDosDados } from "../../nucleo/ambiente";
import { LEITURA_VELHA_MS, type DecisaoAutomatica } from "../../nucleo/dominio";
import type { MeuDia } from "../../nucleo/tarefas";
import { gerarCertificado } from "../falsos/certificado";
import { iniciarCrmFalso, type CrmFalso } from "../falsos/crm";
import { iniciarImapFalso, type ImapFalso } from "../falsos/imap";
import { subirPalco, type Palco } from "./palco";

setDefaultTimeout(30_000);

let palco: Palco | null = null;
let crm: CrmFalso | null = null;
let imap: ImapFalso | null = null;

afterEach(async () => {
  await palco?.limpar();
  await crm?.parar();
  await imap?.parar();
  palco = null;
  crm = null;
  imap = null;
});

/** Janela de observação: uma rodada que fosse disparar teria este tempo para chamar o CRM. */
const JANELA_MS = 300;
const MINUTO = 60_000;
const certificado = gerarCertificado();
const ENDERECO = "vendedor@exemplo.test";
const SENHA = `senha-${crypto.randomUUID()}`;
/** O SSE traz o fim de uma rodada de sincronização. */
const FIM_DA_RODADA = '"etapa":"terminou"';

/** Espera o registro do servidor trazer o evento. */
async function registroTraz(p: Palco, evento: string): Promise<void> {
  const arquivo = join(caminhosDosDados(p.bancada.ambiente).logs, "servidor.log");
  for (let vez = 0; vez < 150; vez += 1) {
    if (existsSync(arquivo) && readFileSync(arquivo, "utf8").includes(`"${evento}"`)) return;
    await Bun.sleep(20);
  }
  throw new Error(`o registro não trouxe ${evento}`);
}

type Envelope<T> = { ok: true; dados: T } | { ok: false; erro: { codigo: string } };

async function dados<T>(resposta: Promise<Response>): Promise<T> {
  const envelope = (await (await resposta).json()) as Envelope<T>;
  if (!envelope.ok) throw new Error(`a API recusou: ${JSON.stringify(envelope.erro)}`);
  return envelope.dados;
}

async function subir(): Promise<{ p: Palco; crm: CrmFalso }> {
  let p: Palco | null = null;
  const falso = iniciarCrmFalso({ agora: () => Date.parse(p === null ? new Date().toISOString() : p.bancada.ambiente.agora()) });
  crm = falso;
  p = await subirPalco({ crmRecurso: falso.recurso, crmClientId: falso.clientId, caExtra: certificado.certificado }, { sincronizacaoAutomatica: true });
  palco = p;
  return { p, crm: falso };
}

/** As ferramentas que o CRM falso recebeu depois da chamada número `desde`. */
const ferramentas = (falso: CrmFalso, desde = 0) =>
  falso
    .registro()
    .chamadasDeFerramenta.slice(desde)
    .map((chamada) => chamada.nome);

/**
 * O vendedor faz o login do CRM pelo painel. Chegar a `conectado` dispara uma rodada: o helper espera ela terminar
 * e devolve quantas ferramentas o CRM falso recebeu até ali, para o teste contar só as que vêm depois.
 */
async function conectarCrm(p: Palco, falso: CrmFalso): Promise<number> {
  const eventos = await p.eventosDoPainel();
  const destino = (await p.painel("/oauth/crm/iniciar")).headers.get("location");
  if (destino === null) throw new Error("o painel não abriu o login do CRM");
  const retorno = await p.cru(`/oauth/crm/retorno?${await falso.autorizar(destino)}`, { headers: { "Sec-Fetch-Site": "cross-site" } });
  if (retorno.status !== 200) throw new Error(`o retorno do CRM respondeu HTTP ${retorno.status}`);
  await eventos.ate((e) => e.conectores.crm.estado.fase === "conectado", "CRM conectado");
  await eventos.ateTexto(FIM_DA_RODADA, "o fim da rodada de quando o CRM conectou");
  eventos.fechar();
  return falso.registro().chamadasDeFerramenta.length;
}
const abrirOPainel = (p: Palco) => dados<DecisaoAutomatica>(p.painel("/api/painel/aberto", { method: "POST" }));

describe("a Secretária sincroniza sozinha só nos dois momentos do vendedor", () => {
  test("o CRM chega a conectado pelo login do vendedor: uma rodada lê o CRM e o Meu dia se preenche", async () => {
    const { p, crm: falso } = await subir();
    await p.servidor.pronto;
    const eventos = await p.eventosDoPainel();
    const destino = (await p.painel("/oauth/crm/iniciar")).headers.get("location");
    if (destino === null) throw new Error("o painel não abriu o login do CRM");
    await p.cru(`/oauth/crm/retorno?${await falso.autorizar(destino)}`, { headers: { "Sec-Fetch-Site": "cross-site" } });

    await eventos.ateTexto(FIM_DA_RODADA, "o fim da rodada de quando o CRM conectou");
    expect(ferramentas(falso)).toContain("minha_agenda");
    const dia = await dados<MeuDia>(p.agente("/api/meu-dia"));
    expect(dia.propostas_abertas.lido_em).not.toBeNull();
    expect(dia.propostas_abertas.itens).toHaveLength(5);
    await Bun.sleep(JANELA_MS);
    expect(eventos.vezes(FIM_DA_RODADA)).toBe(1);
  });

  test("abrir o painel com a leitura de mais de 30 minutos sincroniza; com 30 minutos ou menos, não", async () => {
    const { p, crm: falso } = await subir();
    const desde = await conectarCrm(p, falso);
    const eventos = await p.eventosDoPainel();

    p.bancada.avancar(10 * MINUTO);
    expect(await abrirOPainel(p)).toEqual({ dispara: false, motivo: "rodou_ha_pouco" });
    await Bun.sleep(JANELA_MS);
    expect(ferramentas(falso, desde)).toEqual([]);

    p.bancada.avancar(LEITURA_VELHA_MS - 10 * MINUTO + MINUTO);
    expect(await abrirOPainel(p)).toEqual({ dispara: true, motivo: "leitura_velha", fonte: "agenda" });
    await eventos.ateTexto(FIM_DA_RODADA, "o fim da rodada de quando o painel abriu");
    expect(ferramentas(falso, desde)).toContain("minha_agenda");
  });

  test("o reinício com o CRM já conectado não sincroniza, e o painel aberto com a leitura recente também não", async () => {
    const { p, crm: falso } = await subir();
    const desde = await conectarCrm(p, falso);
    await p.reiniciar();
    await p.servidor.pronto;
    const eventos = await p.eventosDoPainel();
    await eventos.ate((e) => e.conectores.crm.estado.fase === "conectado", "CRM conectado depois do reinício");
    await Bun.sleep(JANELA_MS);
    expect(ferramentas(falso, desde)).toEqual([]);

    p.bancada.avancar(10 * MINUTO);
    expect(await abrirOPainel(p)).toEqual({ dispara: false, motivo: "leitura_recente" });
    await Bun.sleep(JANELA_MS);
    expect(ferramentas(falso, desde)).toEqual([]);
    expect(eventos.vezes(FIM_DA_RODADA)).toBe(0);
  });

  test("o agente pelo CLI não dispara rodada: o painel aberto é só do painel, e ler o Meu dia com a leitura velha não sincroniza", async () => {
    const { p, crm: falso } = await subir();
    const desde = await conectarCrm(p, falso);
    p.bancada.avancar(2 * LEITURA_VELHA_MS);

    const recusado = (await (await p.agente("/api/painel/aberto", { method: "POST" })).json()) as Envelope<unknown>;
    expect(recusado.ok === false && recusado.erro.codigo).toBe("nao_autorizado");
    await dados<MeuDia>(p.agente("/api/meu-dia"));
    await dados(p.agente("/api/estado"));
    await Bun.sleep(JANELA_MS);
    expect(ferramentas(falso, desde)).toEqual([]);
  });

  test("conectar no meio de uma rodada: a rodada em voo termina, e outra roda depois dela", async () => {
    const { p, crm: falso } = await subir();
    const desde = await conectarCrm(p, falso);
    const caixa = (imap = await iniciarImapFalso({ seguranca: "tls", certificado, contas: { [ENDERECO]: SENHA }, caixas: { [ENDERECO]: [{ caminho: "INBOX", uidValidity: 1, mensagens: [] }] } }));
    const eventos = await p.eventosDoPainel();
    let soltar: () => void = () => {};
    falso.botoes.segurar = new Promise<void>((resolver) => (soltar = resolver));
    const chegou = new Promise<string>((resolver) => (falso.botoes.aoChamar = resolver));
    const emVoo = dados<{ jaEmAndamento: boolean }>(p.agente("/api/sincronizar", { method: "POST" }));
    expect(await chegou).toBe("minha_agenda");

    const conta = { rotulo: "Profills", provedor: "outro", endereco: ENDERECO, servidor: "127.0.0.1", porta: caixa.porta, seguranca: "tls", senha: SENHA, janelaDias: 30 };
    await dados(p.painel("/api/email/contas", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(conta) }));
    await eventos.ate((e) => e.email.contas.some((c) => c.estado.fase === "conectado"), "conta conectada");
    await registroTraz(p, "sincronizacao.automatica");
    falso.botoes.aoChamar = null;
    falso.botoes.segurar = null;
    soltar();

    expect((await emVoo).jaEmAndamento).toBe(false);
    await eventos.ateTexto(FIM_DA_RODADA, "o fim da rodada em voo e o da rodada de depois", 2);
    expect(ferramentas(falso, desde).filter((nome) => nome === "minha_agenda")).toHaveLength(2);
    await Bun.sleep(JANELA_MS);
    expect(eventos.vezes(FIM_DA_RODADA)).toBe(2);
  });

  test("a rodada de conectar que bate no limite do CRM não se repete: abrir o painel respeita a espera", async () => {
    const { p, crm: falso } = await subir();
    falso.botoes.limiteHttpS = 3_600;
    const desde = await conectarCrm(p, falso);
    const dia = await dados<MeuDia>(p.agente("/api/meu-dia"));
    expect(dia.propostas_abertas.lido_em).toBeNull();

    p.bancada.avancar(LEITURA_VELHA_MS + MINUTO);
    expect(await abrirOPainel(p)).toEqual({ dispara: false, motivo: "crm_pediu_espera" });
    await Bun.sleep(JANELA_MS);
    expect(ferramentas(falso, desde)).toEqual([]);
  });
});

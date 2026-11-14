/**
 * Palco dos testes do servidor: a bancada dos conectores, com o servidor de produção de pé sobre ela.
 * O agente fala com o Bearer do `servidor.json`; o painel, com o cookie que um bilhete rende.
 */
import { join } from "node:path";
import { caminhosDosDados } from "../../nucleo/ambiente";
import { definirBackendDoCofre } from "../../nucleo/banco";
import type { EstadoAgente, EstadoPainel } from "../../nucleo/dominio";
import { iniciarServidor, lerArquivoDoServidor, type ArquivoDoServidor, type ServidorRodando } from "../../nucleo/servidor";
import { montarBancada, type Alvos, type Bancada } from "../falsos/bancada";
import type { CrmFalso } from "../falsos/crm";
import type { LeiturasDoWacliFalso, PassoDoWacliFalso } from "../falsos/wacli";

const LIMITE_DA_ESPERA_MS = 15_000;

export const QR = "CANARIO-qr-fluxo-1@AbCdEf==";
export const PAREAR: readonly PassoDoWacliFalso[] = [
  { emitir: "qr_code", dados: { code: QR } },
  { aguardar: "leu" },
  { parear: { telefone: "5511912345678" } },
  { emitir: "connected" },
  { emitir: "progress", dados: { messages_synced: 12 } },
  { aguardar: "sincronizou" },
  { emitir: "idle_exit", dados: { messages_synced: 12 } },
  { sair: 0 },
];
export const ESPELHAR: readonly PassoDoWacliFalso[] = [{ emitir: "connected" }, { ficarVivo: true }];

/** O que o navegador manda quando o vendedor abre um link na barra de endereço ou por outro programa. */
export const NAVEGACAO_DE_TOPO = { "Sec-Fetch-Site": "none", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" } as const;

export interface Palco {
  readonly bancada: Bancada;
  readonly servidor: ServidorRodando;
  readonly arquivo: ArquivoDoServidor;
  /** Corpo de toda resposta que o agente recebeu, para o teste do canário. */
  readonly vistoPeloAgente: string[];
  agente(caminho: string, init?: RequestInit): Promise<Response>;
  painel(caminho: string, init?: RequestInit): Promise<Response>;
  /** Pedido cru, sem nenhum cabeçalho de quem chama. */
  cru(caminho: string, init?: RequestInit): Promise<Response>;
  eventosDoPainel(): Promise<Eventos<EstadoPainel>>;
  eventosDoAgente(): Promise<Eventos<EstadoAgente>>;
  /** Para o servidor sem limpar a pasta de dados, e sobe outro sobre ela. `parado` roda entre os dois, com o banco livre. */
  reiniciar(parado?: () => void): Promise<void>;
  limpar(): Promise<void>;
}

export interface Eventos<E> {
  readonly recebidos: readonly E[];
  readonly textos: string[];
  /** Resolve no primeiro evento, recebido ou futuro, que satisfaz `quando`. */
  ate(quando: (estado: E) => boolean, descricao: string): Promise<E>;
  /** Resolve quando o texto cru do fluxo, de qualquer evento, contém `trecho` pelo menos `vezes` vezes (uma, sem o número). */
  ateTexto(trecho: string, descricao: string, vezes?: number): Promise<void>;
  /** Quantas vezes `trecho` já apareceu no texto cru do fluxo. */
  vezes(trecho: string): number;
  /** Resolve quando o servidor fecha o fluxo. */
  readonly fim: Promise<void>;
  fechar(): void;
}

function lerEventos<E>(resposta: Response, guardar: string[]): Eventos<E> {
  if (resposta.body === null) throw new Error(`SSE sem corpo: HTTP ${resposta.status}`);
  const recebidos: E[] = [];
  const textos: string[] = [];
  const esperas = new Set<{ quando: (estado: E) => boolean; resolver: (estado: E) => void }>();
  const esperasDeTexto = new Set<{ trecho: string; vezes: number; resolver: () => void }>();
  const contar = (trecho: string) => textos.join("").split(trecho).length - 1;
  const leitor = resposta.body.getReader();
  const fim = (async () => {
    const decodificador = new TextDecoder();
    let resto = "";
    try {
      for (;;) {
        const { value, done } = await leitor.read();
        if (done) return;
        const texto = decodificador.decode(value, { stream: true });
        textos.push(texto);
        guardar.push(texto);
        resto += texto;
        for (const espera of esperasDeTexto) {
          if (contar(espera.trecho) >= espera.vezes) {
            esperasDeTexto.delete(espera);
            espera.resolver();
          }
        }
        let corte: number;
        while ((corte = resto.indexOf("\n\n")) !== -1) {
          const bloco = resto.slice(0, corte);
          resto = resto.slice(corte + 2);
          const dados = bloco.split("\n").find((linha) => linha.startsWith("data: "));
          if (!bloco.startsWith("event: estado") || dados === undefined) continue;
          const estado = JSON.parse(dados.slice(6)) as E;
          recebidos.push(estado);
          for (const espera of esperas) {
            if (espera.quando(estado)) {
              esperas.delete(espera);
              espera.resolver(estado);
            }
          }
        }
      }
    } catch {
      // Fluxo cancelado pelo próprio teste.
    }
  })();
  return {
    recebidos,
    textos,
    fim,
    ate(quando, descricao) {
      const achado = recebidos.find(quando);
      if (achado !== undefined) return Promise.resolve(achado);
      return new Promise((resolver, rejeitar) => {
        const espera = {
          quando,
          resolver: (estado: E) => {
            clearTimeout(limite);
            resolver(estado);
          },
        };
        const limite = setTimeout(() => {
          esperas.delete(espera);
          rejeitar(new Error(`o SSE não chegou a "${descricao}". Último: ${JSON.stringify(recebidos.at(-1))}`));
        }, LIMITE_DA_ESPERA_MS);
        esperas.add(espera);
      });
    },
    vezes: contar,
    ateTexto(trecho, descricao, vezes = 1) {
      if (contar(trecho) >= vezes) return Promise.resolve();
      return new Promise((resolver, rejeitar) => {
        const espera = {
          trecho,
          vezes,
          resolver: () => {
            clearTimeout(limite);
            resolver();
          },
        };
        const limite = setTimeout(() => {
          esperasDeTexto.delete(espera);
          rejeitar(new Error(`o SSE não trouxe "${descricao}"`));
        }, LIMITE_DA_ESPERA_MS);
        esperasDeTexto.add(espera);
      });
    },
    fechar: () => void leitor.cancel().catch(() => {}),
  };
}

export async function subirPalco(alvos: Alvos = {}): Promise<Palco> {
  const bancada = montarBancada({ ...alvos, porta: 0 });
  // O cofre do teste é sempre o arquivo: o servidor nunca toca o chaveiro de quem roda o teste.
  definirBackendDoCofre(bancada.banco, "arquivo");
  bancada.banco.fechar();
  const vistoPeloAgente: string[] = [];
  const abertos: Eventos<unknown>[] = [];
  let servidor = await iniciarServidor(bancada.ambiente);
  let arquivo = lerArquivoDoServidor(caminhosDosDados(bancada.ambiente).servidor);
  if (arquivo === null) throw new Error("o servidor não gravou o servidor.json");
  let cookie = "";

  const cru = (caminho: string, init: RequestInit = {}) => fetch(`${servidor.origem}${caminho}`, { redirect: "manual", ...init });

  async function agente(caminho: string, init: RequestInit = {}): Promise<Response> {
    const resposta = await cru(caminho, { ...init, headers: { Authorization: `Bearer ${arquivo?.token}`, ...Object.fromEntries(new Headers(init.headers)) } });
    if (!(resposta.headers.get("content-type") ?? "").startsWith("text/event-stream")) {
      vistoPeloAgente.push(await resposta.clone().text());
    }
    return resposta;
  }

  async function entrar(): Promise<void> {
    const bilhete = (await (await agente("/api/sessoes/bilhete", { method: "POST" })).json()) as { dados: { url: string } };
    const entrada = await fetch(bilhete.dados.url, { redirect: "manual", headers: NAVEGACAO_DE_TOPO });
    const definido = entrada.headers.get("set-cookie");
    if (entrada.status !== 303 || definido === null) throw new Error(`entrada recusada: HTTP ${entrada.status}`);
    cookie = definido.split(";")[0] ?? "";
  }
  await entrar();

  const painel = (caminho: string, init: RequestInit = {}) => {
    const comCorpo: Record<string, string> = init.method === "POST" ? { Origin: servidor.origem } : {};
    return cru(caminho, { ...init, headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin", ...comCorpo, ...Object.fromEntries(new Headers(init.headers)) } });
  };

  return {
    bancada,
    get servidor() {
      return servidor;
    },
    get arquivo() {
      if (arquivo === null) throw new Error("sem servidor.json");
      return arquivo;
    },
    vistoPeloAgente,
    agente,
    painel,
    cru,
    async eventosDoPainel() {
      const eventos = lerEventos<EstadoPainel>(await painel("/api/eventos"), []);
      abertos.push(eventos);
      return eventos;
    },
    async eventosDoAgente() {
      const eventos = lerEventos<EstadoAgente>(await agente("/api/eventos"), vistoPeloAgente);
      abertos.push(eventos);
      return eventos;
    },
    async reiniciar(parado) {
      for (const eventos of abertos.splice(0)) eventos.fechar();
      await servidor.parar();
      parado?.();
      servidor = await iniciarServidor(bancada.ambiente);
      arquivo = lerArquivoDoServidor(caminhosDosDados(bancada.ambiente).servidor);
    },
    async limpar() {
      for (const eventos of abertos.splice(0)) eventos.fechar();
      await servidor.parar();
      await bancada.limpar();
    },
  };
}

export const REPO = join(import.meta.dir, "..", "..");

const JSON_NO_CORPO = { "Content-Type": "application/json" };

/** O SSE traz o fim de uma rodada de sincronização. */
export const FIM_DA_RODADA = '"etapa":"terminou"';

/**
 * O vendedor faz o login do CRM pelo painel. Chegar a `conectado` dispara uma rodada: o helper espera ela
 * terminar e o CRM falso esquecer as chamadas dela, para o teste contar só as que ele faz.
 */
export async function conectarCrmNoPalco(p: Palco, falso: CrmFalso): Promise<void> {
  const eventos = await p.eventosDoPainel();
  const destino = (await p.painel("/oauth/crm/iniciar")).headers.get("location");
  if (destino === null) throw new Error("o painel não abriu o login do CRM");
  const retorno = await p.cru(`/oauth/crm/retorno?${await falso.autorizar(destino)}`, { headers: { "Sec-Fetch-Site": "cross-site" } });
  if (retorno.status !== 200) throw new Error(`o retorno do CRM respondeu HTTP ${retorno.status}`);
  await eventos.ate((e) => e.conectores.crm.estado.fase === "conectado", "CRM conectado");
  await eventos.ateTexto(FIM_DA_RODADA, "o fim da rodada de quando o CRM conectou");
  eventos.fechar();
  falso.zerarChamadas();
}

/** O vendedor pareia e confirma a conta pelo painel: o WhatsApp fica `conectado`, e `leituras` é o que o wacli falso devolve ao ler. Espera a rodada que a conexão dispara. */
export async function conectarWhatsappNoPalco(p: Palco, leituras: LeiturasDoWacliFalso = {}): Promise<void> {
  p.bancada.roteiro({ auth: PAREAR, sync: ESPELHAR, leituras });
  await p.servidor.pronto;
  const eventos = await p.eventosDoPainel();
  const fase = (e: EstadoPainel) => e.conectores.whatsapp.estado.fase;
  await p.painel("/api/conectores/whatsapp/conectar", { method: "POST", headers: JSON_NO_CORPO, body: JSON.stringify({ meio: "qr" }) });
  await eventos.ate((e) => fase(e) === "pareando", "pareando");
  p.bancada.celular("leu");
  await eventos.ate((e) => fase(e) === "sincronizando", "sincronizando");
  p.bancada.celular("sincronizou");
  await eventos.ate((e) => fase(e) === "confirmar_conta", "confirmar a conta");
  await p.painel("/api/conectores/whatsapp/confirmar", { method: "POST" });
  await eventos.ate((e) => {
    const estado = e.conectores.whatsapp.estado;
    return estado.fase === "conectado" && estado.espelho === "ao_vivo";
  }, "espelho ao vivo");
  await eventos.ateTexto(FIM_DA_RODADA, "o fim da rodada de quando o WhatsApp conectou");
}

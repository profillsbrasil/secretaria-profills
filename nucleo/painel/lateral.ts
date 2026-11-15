import { CONECTORES_UNICOS, type EstadoPainel, type Instante, type QuemUsa } from "../dominio";
import type { MeuDia } from "../tarefas";
import { NOMES_DOS_CONECTORES, SELO_DO_TOM, descrever, type Tom } from "./descrever";
import { SELO_DA_CONTA } from "./email";
import { BLOCOS, contador, montarBlocos, rodapeDoDia, type IdDoBloco, type ListaDoDia } from "./meu-dia";
import { secaoDaRota, type Rota, type Secao } from "./rota";
import { idadeEmTexto } from "./tarefas";

/**
 * A lateral do painel, igual no computador e na gaveta do celular: o grupo Meu dia com os sete blocos,
 * Tarefas, Conexões e o cartão do pé. Tudo sai do snapshot do SSE e da leitura de `/api/meu-dia` que a
 * tela Meu dia também mostra: a lateral não lê nada por conta própria.
 */

export const NOMES_DAS_SECOES: { readonly [S in Secao]: string } = { "meu-dia": "Meu dia", tarefas: "Tarefas", conexoes: "Conexões" };

export interface Contagem {
  readonly texto: string;
  /** Zero, ou bloco sem leitura: o número sai apagado, e recolhida não vira selo. */
  readonly apagado: boolean;
  readonly falado: string;
}

export interface LinhaDoMenu {
  readonly nome: string;
  readonly destino: Rota;
  readonly atual: boolean;
  /** `null` na linha que não conta nada, ou antes da primeira leitura do dia. */
  readonly contagem: Contagem | null;
  /** O ponto quente: alguma conexão pede atenção. */
  readonly quente: boolean;
  /** O texto da dica da lateral recolhida. */
  readonly dica: string;
}

export interface FonteDaLateral {
  readonly chave: string;
  readonly nome: string;
  readonly tom: Tom;
  /** A idade da última leitura, com a fonte conectada; senão, o estado dela. */
  readonly detalhe: string;
}

export interface ConexoesDaLateral {
  readonly tom: Tom;
  readonly resumo: string;
  readonly fontes: readonly FonteDaLateral[];
}

export interface ModeloDoMenu {
  /** O grupo se funde à Moldura com a tela Meu dia; `paiDoAtual` marca a linha quando um bloco é o atual. */
  readonly meuDia: LinhaDoMenu & { readonly grupoAberto: boolean; readonly paiDoAtual: boolean };
  readonly blocos: readonly (LinhaDoMenu & { readonly id: IdDoBloco })[];
  readonly tarefas: LinhaDoMenu;
  readonly conexoes: LinhaDoMenu;
  /** `null` até o primeiro estado do SSE. */
  readonly cartao: ConexoesDaLateral | null;
}

function comDica(nome: string, contagem: Contagem | null): string {
  return contagem === null ? nome : `${nome} · ${contagem.texto}`;
}

function contagemDeTarefas(n: number): Contagem {
  return { texto: String(n), apagado: n === 0, falado: n === 1 ? "1 aberta" : `${n} abertas` };
}

function minutosEntre(desde: Instante, ate: Instante): number {
  return Math.max(0, Math.floor((Date.parse(ate) - Date.parse(desde)) / 60_000));
}

/** A idade do e-mail é a das conversas que o Meu dia mostra, a conta lida há mais tempo: o servidor não dá a de cada conta. */
function idadeDoEmail(dia: MeuDia): string {
  const lido = dia.responder.email.lido_em;
  const agora = dia.fontes.find((fonte) => fonte.fonte === "tarefas")?.lidaEm ?? null;
  return lido === null || agora === null ? "não sincronizado" : idadeEmTexto(minutosEntre(lido, agora));
}

function primeiraMinuscula(texto: string): string {
  return texto.charAt(0).toLowerCase() + texto.slice(1);
}

/** Cada fonte com o tom do cartão de Conexões e, conectada, a idade do rodapé do Meu dia. */
export function fontesDaLateral(estado: EstadoPainel, dia: MeuDia | null, agora: Date): FonteDaLateral[] {
  const rodape = dia === null ? [] : rodapeDoDia(dia);
  const tons = {
    whatsapp: descrever("whatsapp", estado.conectores.whatsapp.estado, agora).tom,
    crm: descrever("crm", estado.conectores.crm.estado, agora).tom,
  };
  const unicas = CONECTORES_UNICOS.map((id): FonteDaLateral => {
    const tom = tons[id];
    const idade = rodape.find((linha) => linha.fonte === id)?.idade ?? "conectado";
    return { chave: id, nome: NOMES_DOS_CONECTORES[id], tom, detalhe: tom === "ok" ? idade : primeiraMinuscula(SELO_DO_TOM[tom]) };
  });
  const contas = estado.email.contas.map((conta): FonteDaLateral => {
    const selo = SELO_DA_CONTA[conta.estado.fase];
    const idade = dia === null ? "conectada" : idadeDoEmail(dia);
    return { chave: `email:${conta.id}`, nome: `E-mail ${conta.rotulo}`, tom: selo.tom, detalhe: selo.tom === "ok" ? idade : primeiraMinuscula(selo.texto) };
  });
  return [...unicas, ...contas];
}

/** A linha de baixo do cartão: "Tudo conectado", ou o que pede atenção primeiro, ou o que ainda não está pronto. */
export function conexoesDaLateral(estado: EstadoPainel, dia: MeuDia | null, agora: Date): ConexoesDaLateral {
  const fontes = fontesDaLateral(estado, dia, agora);
  const quentes = fontes.filter((fonte) => fonte.tom === "atencao");
  if (quentes.length > 0) {
    const [uma] = quentes;
    return { tom: "atencao", resumo: quentes.length === 1 && uma ? `${uma.nome} pede atenção` : `${quentes.length} conexões pedem atenção`, fontes };
  }
  const pendentes = fontes.filter((fonte) => fonte.tom !== "ok");
  if (pendentes.length > 0) {
    const [uma] = pendentes;
    return { tom: "neutro", resumo: pendentes.length === 1 && uma ? `${uma.nome}: ${uma.detalhe}` : `${pendentes.length} conexões não estão prontas`, fontes };
  }
  return { tom: "ok", resumo: "Tudo conectado", fontes };
}

/** O bloco que a lateral reabre ao voltar ao Meu dia: o último que a rota mostrou. */
export function listaLembrada(anterior: ListaDoDia | null, rota: Rota | null): ListaDoDia | null {
  return rota?.tela === "meu-dia" && rota.lista !== undefined ? rota.lista : anterior;
}

export function modeloDoMenu(rota: Rota | null, dia: MeuDia | null, estado: EstadoPainel | null, lembrada: ListaDoDia | null, agora: Date): ModeloDoMenu {
  const secao = rota === null ? null : secaoDaRota(rota);
  const blocoAtual = rota?.tela === "meu-dia" && rota.lista !== undefined && rota.lista !== "ignorados" ? rota.lista : null;
  const montados = dia === null ? null : montarBlocos(dia);
  const blocos = BLOCOS.map(({ id, nome }) => {
    const conteudo = montados?.find(({ definicao }) => definicao.id === id)?.conteudo;
    const contagem = conteudo === undefined ? null : contador(conteudo);
    return { id, nome, destino: { tela: "meu-dia", lista: id } as const, atual: blocoAtual === id, contagem, quente: false, dica: comDica(nome, contagem) };
  });
  const cartao = estado === null ? null : conexoesDaLateral(estado, dia, agora);
  const tarefas = dia === null ? null : contagemDeTarefas(dia.tarefas_abertas);
  return {
    meuDia: {
      nome: NOMES_DAS_SECOES["meu-dia"],
      destino: lembrada === null ? { tela: "meu-dia" } : { tela: "meu-dia", lista: lembrada },
      atual: secao === "meu-dia" && blocoAtual === null,
      contagem: null,
      quente: false,
      dica: NOMES_DAS_SECOES["meu-dia"],
      grupoAberto: secao === "meu-dia",
      paiDoAtual: blocoAtual !== null,
    },
    blocos,
    tarefas: { nome: NOMES_DAS_SECOES.tarefas, destino: { tela: "tarefas" }, atual: secao === "tarefas", contagem: tarefas, quente: false, dica: comDica(NOMES_DAS_SECOES.tarefas, tarefas) },
    conexoes: {
      nome: NOMES_DAS_SECOES.conexoes,
      destino: { tela: "conexoes" },
      atual: secao === "conexoes",
      contagem: null,
      quente: cartao?.tom === "atencao",
      dica: cartao === null ? NOMES_DAS_SECOES.conexoes : `${NOMES_DAS_SECOES.conexoes} · ${cartao.resumo}`,
    },
    cartao,
  };
}

/** As palavras do cartão do pé para quem está usando. Sem nome, o cartão pede: "Diga seu nome". */
export interface RotulosDeQuemUsa {
  readonly rotulo: string;
  readonly subtitulo: string;
  /** A dica da lateral recolhida. */
  readonly dica: string;
  /** O que o leitor de tela fala no botão. */
  readonly falado: string;
}

export function rotulosDeQuemUsa(quem: QuemUsa | null): RotulosDeQuemUsa {
  if (quem === null) return { rotulo: "Diga seu nome", subtitulo: "Profills", dica: "Diga seu nome · fica só neste computador", falado: "Diga seu nome" };
  const subtitulo = quem.origem === "crm" ? "Profills · nome do CRM" : "Profills · só neste computador";
  return { rotulo: quem.nome, subtitulo, dica: `${quem.nome} · clique para mudar`, falado: `${quem.nome}, mudar o nome` };
}

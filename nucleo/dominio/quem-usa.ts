import { sinaisDeInjecao } from "./injecao";
import { textoExterno, type Instante, type TextoExterno } from "./tipos";

/**
 * Quem está usando a Secretária, para o cartão do pé da lateral. Dois nomes podem existir: o que o
 * vendedor digitou no painel e o que o CRM dá como responsável das propostas dele. O digitado vence
 * sempre, e o do CRM nunca o apaga. Os dois ficam só nesta máquina: nenhum vai ao CRM, ao registro,
 * ao `status`, ao `diagnostico` nem ao agente.
 */

/** O campo do painel aceita até 40 caracteres, como no protótipo. */
export const TAMANHO_DO_NOME = 40;

export type OrigemDoNome = "vendedor" | "crm";

/**
 * Onde a leitura do CRM está para o nome. `esperando` é o CRM conectado sem leitura de propostas
 * ainda: a sincronização ao conectar vai trazer o nome, e o painel não pergunta antes dela.
 */
export type CrmParaONome = "lido" | "esperando" | "fora";

/** O que o banco guarda, cru. */
export interface NomesGuardados {
  readonly digitado: string | null;
  /** Quando o vendedor respondeu à pergunta (Começar ou Agora não). Com ele, o painel não pergunta sozinho de novo. */
  readonly perguntadoEm: Instante | null;
  readonly doCrm: TextoExterno | null;
  readonly crm: CrmParaONome;
}

/** O que vai à tela: só o primeiro nome e as iniciais, nunca o nome inteiro do CRM. */
export interface QuemUsa {
  readonly nome: string;
  readonly iniciais: string;
  readonly origem: OrigemDoNome;
}

export interface VisaoDeQuemUsa {
  readonly quem: QuemUsa | null;
  /** O painel abre as boas-vindas sozinho. */
  readonly perguntar: boolean;
}

function palavras(nome: string): string[] {
  return nome.split(" ").filter((palavra) => palavra !== "");
}

/** A primeira letra da primeira palavra e a da última, quando há mais de uma. */
export function iniciaisDe(nome: string): string {
  const lista = palavras(nome);
  const primeira = lista[0]?.[0] ?? "";
  const ultima = lista.length > 1 ? (lista.at(-1)?.[0] ?? "") : "";
  return (primeira + ultima).toLocaleUpperCase("pt-BR");
}

export function decidirQuemUsa(guardados: NomesGuardados): VisaoDeQuemUsa {
  if (guardados.digitado !== null) {
    return { quem: { nome: guardados.digitado, iniciais: iniciaisDe(guardados.digitado), origem: "vendedor" }, perguntar: false };
  }
  if (guardados.doCrm !== null) {
    const primeiro = palavras(guardados.doCrm)[0] ?? guardados.doCrm;
    return { quem: { nome: primeiro, iniciais: iniciaisDe(guardados.doCrm), origem: "crm" }, perguntar: false };
  }
  return { quem: null, perguntar: guardados.perguntadoEm === null && guardados.crm !== "esperando" };
}

/** O nome que o vendedor digitou, limpo como texto de uma linha. Vazio ou longo demais é `null`. */
export function lerNomeDigitado(texto: string): string | null {
  const limpo = textoExterno(texto);
  return limpo === "" || limpo.length > TAMANHO_DO_NOME ? null : limpo;
}

/**
 * O `responsavel.nome` das propostas, como o CRM o mandou. Os sinais saem do texto cru, como nos
 * outros nomes do CRM. Nome suspeito de falar com um assistente não aparece: o painel pergunta.
 */
export function nomeDoResponsavel(cru: string): TextoExterno | null {
  if (sinaisDeInjecao(cru).length > 0) return null;
  const limpo = textoExterno(cru);
  return limpo === "" ? null : limpo;
}

import { z } from "zod";
import {
  detalheComoDado,
  diaEm,
  falha,
  lerDia,
  lerEnderecoEmail,
  ok,
  sinaisDeInjecao,
  STATUS_DO_ATENDIMENTO,
  textoExterno,
  type Atendimento,
  type ClienteBuscado,
  type ClienteDaCarteira,
  type ClienteRef,
  type CodigoErro,
  type Compromisso,
  type DetalheDaProposta,
  type Dia,
  type FichaDoCliente,
  type Instante,
  type Resultado,
  type TextoExterno,
} from "../../dominio";
import type { RespostaMcp } from "./mcp";
import { criarCorredor, type Aberta, type AcessoAoCrm, type Repetir } from "./sessao";

export type { AcessoAoCrm } from "./sessao";

/**
 * Leitura do CRM pelo servidor da Secretária. `FERRAMENTAS` é a única lista de tools de leitura que o
 * servidor chama: as sete que leem (a sétima é `meus_atendimentos`). Escrita no CRM não entra aqui, e sim em `escrita.ts`;
 * o tipo de `ler` recusa outro nome, e o tempo de execução recusa de novo quem forçar o tipo.
 * Formato conferido contra o CRM em 14/11/2026 e na documentação do MCP: o MCP repassa a resposta do CRM crua,
 * salvo a proposta, que vem com os nomes da lista. Cada lista tem o nome que o CRM dá:
 * `compromissos`, `propostas`, `clientes` (carteira e busca) e `atendimentos`. Data e hora vêm em ISO com `-03:00`;
 * o dia, em `AAAA-MM-DD`. Uma resposta com outro nome vira `crm_resposta_inesperada`. Numa lista, o item fora do
 * formato (campo obrigatório vazio, data ilegível) fica de fora e entra só em `fora_por_cadastro_incompleto`.
 */

export const id = z.number().int().min(1).max(2_147_483_647);
const texto = z.string().transform((valor): TextoExterno => textoExterno(valor));
const textoOuNulo = z
  .string()
  .nullish()
  .transform((valor): TextoExterno | null => (valor == null ? null : textoExterno(valor)));

const instante = z.string().transform((valor, ctx): Instante => {
  const ms = Date.parse(valor);
  if (Number.isNaN(ms)) {
    ctx.addIssue({ code: "custom", message: "data ilegível" });
    return z.NEVER;
  }
  return new Date(ms).toISOString() as Instante;
});

/** O CRM manda o dia como `AAAA-MM-DD` ou como data e hora com o offset de Brasília. */
const dia = z.string().transform((valor, ctx): Dia => {
  const soDia = lerDia(valor);
  if (soDia !== null) return soDia;
  const ms = Date.parse(valor);
  if (Number.isNaN(ms)) {
    ctx.addIssue({ code: "custom", message: "dia ilegível" });
    return z.NEVER;
  }
  return diaEm(new Date(ms));
});

const LIMITE_DO_LINK = 2048;

/**
 * O link vai para um botão do painel e para o texto que o agente lê. Sai daqui o `href` que o
 * parser de URL monta, nunca o valor cru: o parser aceita quebra de linha no meio e a remove.
 * Usuário e senha na URL são recusados. A origem é conferida em `soDasTelas`.
 */
export const link = z
  .string()
  .nullish()
  .transform((valor): string | null => {
    if (valor == null || !URL.canParse(valor)) return null;
    const url = new URL(valor);
    if (url.username !== "" || url.password !== "" || url.href.length > LIMITE_DO_LINK) return null;
    return url.href;
  });

/**
 * O CRM monta o `link` sobre o emissor do OAuth, que é a origem pública das telas dele.
 * Link de outra origem vira `null`, e sem a origem conhecida nenhum link passa.
 */
export function soDasTelas<T>(dados: T, origemDasTelas: string | null): T {
  if (typeof dados !== "object" || dados === null || !("link" in dados) || typeof dados.link !== "string") return dados;
  return origemDasTelas !== null && new URL(dados.link).origin === origemDasTelas ? dados : { ...dados, link: null };
}

const valor = z.string().nullish().transform((v) => v ?? null);
const clienteRef = z.object({ id, nome: texto }).transform((c): ClienteRef => c);

const compromisso = z
  .object({ id, titulo: texto, inicio: instante, fim: instante.nullish(), tipo: texto, cliente: clienteRef.nullish() })
  .transform((c): Compromisso => ({ ...c, fim: c.fim ?? null, cliente: c.cliente ?? null }));

const propostaDaLista = z
  .object({
    id,
    codigo: texto,
    versao: z.number().int(),
    estagio: z.string(),
    cliente: clienteRef,
    valor_total: valor,
    moeda: valor,
    data_envio: dia.nullish(),
    prazo_retorno: dia.nullish(),
    // Cru, para os sinais de injeção saírem do texto como veio (`nomeDoResponsavel`). Forma estranha vira `null` sem derrubar o item.
    responsavel: z.object({ id, nome: z.string() }).nullish().catch(null),
  })
  .transform((p) => ({ ...p, data_envio: p.data_envio ?? null, prazo_retorno: p.prazo_retorno ?? null, responsavel: p.responsavel ?? null }));
export type PropostaDaLista = z.output<typeof propostaDaLista>;

const detalheDaProposta = z
  .object({
    id,
    codigo: texto,
    versao: z.number().int(),
    ativa: z.union([z.boolean(), z.number()]),
    estagio: texto,
    cliente: clienteRef,
    link,
    forma_escolhida: z.object({ valor_final: valor }).nullish(),
  })
  .transform(
    (p): DetalheDaProposta => ({
      id: p.id,
      codigo: p.codigo,
      versao: p.versao,
      ativa: p.ativa === true || p.ativa === 1,
      estagio: p.estagio,
      cliente: p.cliente,
      link: p.link,
      valor_final: p.forma_escolhida?.valor_final ?? null,
    }),
  );

const clienteDaCarteira = z
  .object({
    id,
    nome: texto,
    nome_fantasia: textoOuNulo,
    cidade: textoOuNulo,
    uf: textoOuNulo,
    ultimo_atendimento_em: instante.nullish(),
    ultimo_atendimento_aproximado: z.boolean().nullish(),
  })
  .transform(
    (c): ClienteDaCarteira => ({
      ...c,
      ultimo_atendimento_em: c.ultimo_atendimento_em ?? null,
      ultimo_atendimento_aproximado: c.ultimo_atendimento_aproximado === true,
    }),
  );

/**
 * No CRM, `bateu_em` é a lista dos rótulos de onde a busca bateu, e `contatos` traz o telefone e o e-mail
 * de cada contato. Qualquer forma inesperada vira lista vazia ou `null`, sem derrubar a busca: o
 * vínculo sem telefone ou e-mail que prove fica para o vendedor confirmar.
 */
const emailDoContato = z
  .string()
  .nullish()
  .catch(null)
  .transform((valor) => (valor != null && lerEnderecoEmail(valor.trim()) !== null ? valor.trim() : null));
const contatoBuscado = z
  .object({ telefone: z.string().nullish().catch(null), email: emailDoContato })
  .catch({ telefone: null, email: null })
  .transform((c) => ({ telefone: c.telefone ?? null, email: c.email }));
const clienteBuscado = z
  .object({
    id,
    nome: texto,
    cidade: textoOuNulo,
    uf: textoOuNulo,
    bateu_em: z.array(z.string().min(1).max(40).transform((valor) => textoExterno(valor))).nullish().catch(null),
    contatos: z.array(contatoBuscado).nullish().catch(null),
  })
  .transform((c): ClienteBuscado => ({ ...c, bateu_em: c.bateu_em ?? [], contatos: c.contatos ?? [] }));

const fichaDoCliente = z.object({ id, nome: texto, cidade: textoOuNulo, uf: textoOuNulo, link }).transform((c): FichaDoCliente => c);

/** Os sinais saem do assunto e do nome crus: `textoExterno` apaga o caractere invisível que acende `caractere_invisivel`. */
const atendimento = z
  .object({ id, assunto: z.string(), status: z.enum(STATUS_DO_ATENDIMENTO), data: dia, cliente: z.object({ id, nome: z.string() }) })
  .transform(
    (a): Atendimento => ({
      id: a.id,
      assunto: textoExterno(a.assunto),
      sinais: sinaisDeInjecao(a.assunto),
      status: a.status,
      data: a.data,
      cliente: { id: a.cliente.id, nome: textoExterno(a.cliente.nome) },
      sinaisDoCliente: sinaisDeInjecao(a.cliente.nome),
    }),
  );

const comId = z.object({ id });

/** Uma lista do CRM lida item a item. `ultimoId` é o id do último item que o CRM mandou, mesmo fora do formato. */
interface ListaLida<I> {
  readonly itens: I[];
  readonly fora: number;
  readonly ultimoId: number | null;
}

/**
 * Cadastro antigo do CRM pode trazer um campo obrigatório vazio. Esse item fica de fora e só é
 * contado: o texto dele não passou pelos sinais de injeção e não sai em erro nem em registro.
 * Lista com itens e nenhum no formato é formato desconhecido, não cadastro incompleto.
 */
function listaDoCrm<T extends z.ZodType>(item: T) {
  return z.array(z.unknown()).transform((crus, ctx): ListaLida<z.output<T>> => {
    const itens: z.output<T>[] = [];
    const caminhosFora: PropertyKey[][] = [];
    let ultimoId: number | null = null;
    for (const [indice, cru] of crus.entries()) {
      const lido = item.safeParse(cru);
      if (lido.success) itens.push(lido.data);
      else caminhosFora.push(...lido.error.issues.map((issue) => [indice, ...issue.path]));
      const doItem = comId.safeParse(cru);
      if (doItem.success) ultimoId = doItem.data.id;
    }
    if (crus.length > 0 && itens.length === 0) {
      // Só os caminhos, como em `ondeNaoBateu`: o valor pode ser dado de cliente.
      for (const path of caminhosFora) ctx.addIssue({ code: "custom", message: "fora do formato", path });
      return z.NEVER;
    }
    return { itens, fora: crus.length - itens.length, ultimoId };
  });
}

/**
 * `fora_por_cadastro_incompleto` conta os itens da página que ficaram de fora. `ultimo_id` é o `antes`
 * da página seguinte: o item descartado no fim da página não volta na próxima.
 */
function contagemDa<I>(lista: ListaLida<I>): { readonly fora_por_cadastro_incompleto: number; readonly ultimo_id: number | null } {
  return { fora_por_cadastro_incompleto: lista.fora, ultimo_id: lista.ultimoId };
}

const limite = z.number().int().min(1).max(50);
const diaPedido = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** A tabela única. Cada tool que lê, com os argumentos que a Secretária manda e a resposta convertida. */
const FERRAMENTAS = {
  minha_agenda: {
    argumentos: z.strictObject({ de: diaPedido.optional(), ate: diaPedido.optional() }),
    resposta: z
      .object({ compromissos: listaDoCrm(compromisso), mais: z.boolean() })
      .transform(({ compromissos, ...resto }) => ({ ...resto, compromissos: compromissos.itens, ...contagemDa(compromissos) })),
  },
  listar_propostas: {
    argumentos: z.strictObject({
      escopo: z.enum(["visiveis", "minhas", "aguardando_minha_aprovacao", "cliente"]).optional(),
      estagio: z.enum(["rascunho", "aguardando_aprovacao", "aprovada", "enviada", "rejeitada", "cliente_aceitou", "cliente_rejeitou"]).optional(),
      cliente_id: id.optional(),
      limite: limite.optional(),
      antes: id.optional(),
    }),
    resposta: z
      .object({ propostas: listaDoCrm(propostaDaLista), mais: z.boolean() })
      .transform(({ propostas, ...resto }) => ({ ...resto, propostas: propostas.itens, ...contagemDa(propostas) })),
  },
  ver_proposta: {
    argumentos: z.union([z.strictObject({ proposta_id: id }), z.strictObject({ codigo: z.string().min(1).max(20) })]),
    resposta: detalheDaProposta,
  },
  minha_carteira: {
    argumentos: z.strictObject({
      sem_atendimento_ha_dias: z.number().int().min(1).max(3650).optional(),
      cidade: z.string().min(1).max(45).optional(),
      uf: z.string().regex(/^[A-Za-z]{2}$/).optional(),
      cursor: z.string().min(1).max(21).optional(),
      limite: limite.optional(),
    }),
    resposta: z
      .object({ clientes: listaDoCrm(clienteDaCarteira), mais: z.boolean(), proximo_cursor: z.string().nullish() })
      .transform(({ clientes, ...resto }) => ({ ...resto, clientes: clientes.itens, ...contagemDa(clientes) })),
  },
  buscar_clientes: {
    argumentos: z.strictObject({ q: z.string().min(1).max(200), limite: limite.optional() }),
    resposta: z
      .object({ clientes: listaDoCrm(clienteBuscado), mais: z.boolean().nullish() })
      .transform(({ clientes, ...resto }) => ({ ...resto, clientes: clientes.itens, ...contagemDa(clientes) })),
  },
  ver_cliente: {
    argumentos: z.strictObject({ cliente_id: id }),
    resposta: fichaDoCliente,
  },
  meus_atendimentos: {
    argumentos: z.strictObject({ status: z.enum(STATUS_DO_ATENDIMENTO).optional(), desde: diaPedido.optional(), antes: id.optional(), limite: limite.optional() }),
    resposta: z
      .object({ atendimentos: listaDoCrm(atendimento), mais: z.boolean() })
      .transform(({ atendimentos, ...resto }) => ({ ...resto, atendimentos: atendimentos.itens, ...contagemDa(atendimentos) })),
  },
} as const satisfies Record<string, { readonly argumentos: z.ZodType; readonly resposta: z.ZodType }>;

export type FerramentaDeLeitura = keyof typeof FERRAMENTAS;
export type ArgumentosDe<F extends FerramentaDeLeitura> = z.input<(typeof FERRAMENTAS)[F]["argumentos"]>;
export type RespostaDe<F extends FerramentaDeLeitura> = z.output<(typeof FERRAMENTAS)[F]["resposta"]>;

/** Os nomes que o servidor pode chamar, na ordem da tabela. */
export const FERRAMENTAS_DE_LEITURA = Object.keys(FERRAMENTAS) as FerramentaDeLeitura[];

function ehFerramentaDeLeitura(nome: string): nome is FerramentaDeLeitura {
  return Object.hasOwn(FERRAMENTAS, nome);
}

function erro(codigo: CodigoErro, mensagem?: string, esperaS?: number): Resultado<never> {
  const base = falha(codigo, mensagem);
  if (base.ok || esperaS === undefined) return base;
  return { ok: false, erro: { ...base.erro, esperaS } };
}

/** Sem o tempo na mensagem nem no `Retry-After`, o MCP diz "um minuto". */
const ESPERA_PADRAO_S = 60;

/** As mensagens do MCP para cada falha (`docs/agentes.md`, "Como reagir a cada erro"). A ordem importa. */
const MENSAGENS_DA_FERRAMENTA: readonly (readonly [RegExp, CodigoErro])[] = [
  [/Sessão sem usuário do CRM/i, "crm_sessao_vencida"],
  [/limitou as chamadas/i, "crm_limite_de_chamadas"],
  [/indisponível agora/i, "crm_fora_do_ar"],
  [/não tem acesso ao CRM agora|Avise o administrador/i, "crm_nao_liberado"],
  [/^Não encontrado/i, "crm_nao_encontrado"],
];

export const resultadoDaFerramenta = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
  structuredContent: z.unknown().optional(),
  isError: z.boolean().optional(),
});

export function textoDoConteudo(conteudo: z.output<typeof resultadoDaFerramenta>["content"]): string {
  return (conteudo ?? []).map((parte) => parte.text ?? "").join(" ").trim();
}

function falhaDaFerramenta(nome: FerramentaDeLeitura, mensagem: string): Resultado<never> {
  const codigo = MENSAGENS_DA_FERRAMENTA.find(([padrao]) => padrao.test(mensagem))?.[1];
  if (codigo === "crm_limite_de_chamadas") {
    const segundos = /Espere (\d+) segundo/i.exec(mensagem)?.[1];
    return erro(codigo, undefined, segundos === undefined ? ESPERA_PADRAO_S : Number(segundos));
  }
  if (codigo !== undefined) return erro(codigo);
  return erro("crm_resposta_inesperada", `O CRM recusou ${nome}. ${detalheComoDado(textoExterno(mensagem))}`);
}

/** O que a resposta HTTP já diz, antes de olhar o corpo. `null` é o 200 com `result`. */
function falhaDoTransporte(nome: string, resposta: RespostaMcp | null): Resultado<never> | Repetir | null {
  if (resposta === null) return erro("crm_fora_do_ar");
  if (resposta.status === 401) return "token_recusado";
  if (resposta.status === 404) return "sessao_expirada";
  if (resposta.status === 403) return erro("crm_nao_liberado");
  if (resposta.status === 429) return erro("crm_limite_de_chamadas", undefined, resposta.esperaS ?? ESPERA_PADRAO_S);
  if (resposta.status >= 500) return erro("crm_fora_do_ar");
  if (resposta.status !== 200) return erro("crm_resposta_inesperada", `O MCP respondeu HTTP ${resposta.status} a ${nome}.`);
  if (resposta.resultado === undefined) {
    const detalhe = resposta.erroRpc === null ? "" : ` ${detalheComoDado(textoExterno(resposta.erroRpc))}`;
    return erro("crm_resposta_inesperada", `O MCP não deu resultado a ${nome}.${detalhe}`);
  }
  return null;
}

/** Os caminhos dos campos que não bateram, sem o valor: o valor pode ser dado de cliente. */
export function ondeNaoBateu(problema: z.ZodError): string {
  return [...new Set(problema.issues.map((issue) => issue.path.join(".") || "raiz"))].slice(0, 5).join(", ");
}

async function chamarNaSessao<F extends FerramentaDeLeitura>(
  { sessao, origemDasTelas }: Aberta,
  nome: F,
  argumentos: ArgumentosDe<F>,
): Promise<Resultado<RespostaDe<F>> | Repetir> {
  if (!ehFerramentaDeLeitura(nome)) return erro("crm_ferramenta_recusada", `A Secretária não chama ${JSON.stringify(String(nome))}: só as tools de leitura da tabela.`);
  const definicao = FERRAMENTAS[nome];
  const pedido = definicao.argumentos.safeParse(argumentos);
  if (!pedido.success) return erro("entrada_invalida", `Argumentos de ${nome} fora do formato: ${ondeNaoBateu(pedido.error)}.`);

  const resposta = await sessao.chamar("tools/call", { name: nome, arguments: pedido.data });
  const doTransporte = falhaDoTransporte(nome, resposta);
  if (doTransporte !== null) return doTransporte;

  const resultado = resultadoDaFerramenta.safeParse(resposta?.resultado);
  if (!resultado.success) return erro("crm_resposta_inesperada", `O resultado de ${nome} veio fora do formato do MCP.`);
  if (resultado.data.isError === true) return falhaDaFerramenta(nome, textoDoConteudo(resultado.data.content));

  let dados = resultado.data.structuredContent;
  if (dados === undefined) {
    try {
      dados = JSON.parse(textoDoConteudo(resultado.data.content));
    } catch {
      return erro("crm_resposta_inesperada", `O resultado de ${nome} não trouxe JSON.`);
    }
  }
  const convertido = (definicao.resposta as z.ZodType as z.ZodType<RespostaDe<F>>).safeParse(dados);
  if (!convertido.success) return erro("crm_resposta_inesperada", `A resposta de ${nome} não bateu com o formato esperado em: ${ondeNaoBateu(convertido.error)}.`);
  return ok(soDasTelas(convertido.data, origemDasTelas));
}

export interface LeitorDoCrm {
  ler<F extends FerramentaDeLeitura>(nome: F, argumentos: ArgumentosDe<F>): Promise<Resultado<RespostaDe<F>>>;
}

/**
 * Um leitor por uso (uma sincronização, uma conferência de cliente). O laço de sessão, com o 401 e o 404 repetidos
 * uma vez cada, é o de `criarCorredor`.
 */
export function criarLeitor(recurso: URL, acesso: AcessoAoCrm, sinal: AbortSignal): LeitorDoCrm {
  const executar = criarCorredor<Resultado<never>>(recurso, acesso, sinal, {
    semToken: () => erro("crm_desconectado"),
    aoFalharAAbertura(falha) {
      if (falha.tipo === "rede") return erro("crm_fora_do_ar");
      const falhou = falhaDoTransporte("initialize", falha.resposta) ?? erro("crm_resposta_inesperada");
      return falhou === "sessao_expirada" ? erro("crm_resposta_inesperada", "O MCP respondeu HTTP 404 ao initialize.") : falhou;
    },
    esgotou(motivo) {
      if (motivo === "sessao_expirada") return erro("crm_resposta_inesperada", "O MCP expirou a sessão duas vezes seguidas.");
      acesso.vencido();
      return erro("crm_sessao_vencida");
    },
    aoTerminar(resultado) {
      const feito = resultado as Resultado<unknown>;
      if (!feito.ok && feito.erro.codigo === "crm_sessao_vencida") acesso.vencido();
    },
  });

  return { ler: (nome, argumentos) => executar((aberta) => chamarNaSessao(aberta, nome, argumentos)) };
}

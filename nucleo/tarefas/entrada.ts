import { z } from "zod";
import { LIMITES_DA_TAREFA, lerDia, lerIdDoItemDeEmail, lerTelefone, type Dia } from "../dominio";
import { ESTADOS_DA_TAREFA, TITULOS_FIXOS, idDoClienteNoCrm, tituloFixo, type AcaoDaTarefa, type Comando, type NovaTarefa, type Papel, type TituloFixo } from "./regras";

export const LIMITES = LIMITES_DA_TAREFA;

/**
 * Título e nota são texto puro: sem caractere de controle, e o título numa linha só. O painel
 * mostra o texto como texto, sem HTML nem link, então nada aqui tenta escapar marcação.
 */
const CONTROLE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

function umaLinha(texto: string): string {
  return texto.replace(/\s+/g, " ").replace(CONTROLE, "").trim();
}

function variasLinhas(texto: string): string {
  return texto.replaceAll("\r\n", "\n").replace(CONTROLE, "").trim();
}

const linha = (maximo: number) => z.string().transform(umaLinha).pipe(z.string().min(1).max(maximo));
const paragrafo = (maximo: number) => z.string().transform(variasLinhas).pipe(z.string().min(1).max(maximo));

const dia = z.string().transform((texto, ctx): Dia => {
  const lido = lerDia(texto);
  if (lido === null) {
    ctx.addIssue({ code: "custom", message: "a data precisa ser AAAA-MM-DD, um dia que existe" });
    return z.NEVER;
  }
  return lido;
});

const versao = z.number().int().min(1);
const texto = {
  titulo: linha(LIMITES.titulo),
  nota: paragrafo(LIMITES.nota),
  proximoPasso: paragrafo(LIMITES.proximoPasso),
};

const comuns = {
  /** Gerado por quem cria. Repetir o pedido com o mesmo id não cria outra tarefa. */
  id: z.uuid().optional(),
  propostaCodigo: linha(LIMITES.propostaCodigo).optional(),
  venceEm: dia.optional(),
  nota: texto.nota.optional(),
};

export const NOMES_DOS_TITULOS_FIXOS = Object.keys(TITULOS_FIXOS) as [TituloFixo, ...TituloFixo[]];

/** O vendedor escreve o título que quiser. */
export const corpoDeCriar = z.strictObject({
  titulo: texto.titulo,
  clienteId: linha(LIMITES.clienteId).optional(),
  clienteNome: linha(LIMITES.clienteNome).optional(),
  ...comuns,
});

const idNoCrm = z
  .string()
  .trim()
  .refine((id) => idDoClienteNoCrm(id) !== null, "é o id numérico do cliente no CRM");

/** A conversa do Meu dia que a tarefa do agente trata: o telefone (WhatsApp) ou o id do item (e-mail). O instante, quem põe é o servidor. */
const conversaDoAgente = z.union([
  z.strictObject({ canal: z.literal("whatsapp"), id: z.string().refine((id) => lerTelefone(id) !== null, "é o telefone da conversa, +5511999998888") }),
  z.strictObject({ canal: z.literal("email"), id: z.string().refine((id) => lerIdDoItemDeEmail(id) !== null, "é o id do item de e-mail, e-0123456789abcdef") }),
]);

export type PedidoDeConversa = z.output<typeof conversaDoAgente>;

/**
 * O agente escolhe um título fixo e aponta o cliente pelo id do CRM. `titulo` e `clienteNome` são
 * campos desconhecidos aqui e recusam a criação: o nome que vai no título é o que o CRM devolve.
 */
export const corpoDeCriarDoAgente = z.strictObject({ tituloFixo: z.enum(NOMES_DOS_TITULOS_FIXOS), clienteId: idNoCrm.optional(), conversa: conversaDoAgente.optional(), ...comuns });

/** Corpo de cada `POST /api/tarefas/:id/:acao`. */
export const CORPOS_DAS_ACOES = {
  concluir: z.strictObject({ versao, nota: texto.nota.optional(), proximoPasso: texto.proximoPasso.optional(), venceEm: dia.optional() }),
  adiar: z.strictObject({ versao, para: dia, nota: texto.nota.optional() }),
  descartar: z.strictObject({ versao, nota: texto.nota.optional() }),
  reabrir: z.strictObject({ versao }),
  anotar: z.strictObject({ texto: texto.nota, proximoPasso: texto.proximoPasso.optional() }),
} as const satisfies { readonly [A in AcaoDaTarefa]: z.ZodType };

export const ACOES_DA_TAREFA = Object.keys(CORPOS_DAS_ACOES) as AcaoDaTarefa[];

export type CorpoDeCriar = z.input<typeof corpoDeCriar>;
export type CorpoDaAcao = { readonly [A in AcaoDaTarefa]: z.input<(typeof CORPOS_DAS_ACOES)[A]> };

export const filtroDaLista = z.enum(ESTADOS_DA_TAREFA).optional();

type Lido<T> = { readonly ok: true; readonly valor: T } | { readonly ok: false; readonly mensagem: string };

function mensagemDe(erro: z.ZodError): string {
  return erro.issues.map((issue) => `${issue.path.join(".") || "corpo"}: ${issue.message}`).join("; ");
}

const AJUDA_DO_AGENTE = `O agente cria tarefa com \`tituloFixo\` (${NOMES_DOS_TITULOS_FIXOS.join(", ")}). O cliente vai em \`clienteId\`, o id numérico dele no CRM, e o nome vem do CRM. A conversa de Responder ou de Esperando cliente vai em \`conversa\` ({"canal":"whatsapp","id":"<telefone>"} ou {"canal":"email","id":"<id do item>"}). O texto livre vai em \`nota\`.`;

/** A criação lida: a tarefa e, do agente, a conversa que ele apontou, que o servidor confere no Meu dia antes de prender à tarefa. */
export interface CriacaoLida {
  readonly tarefa: NovaTarefa;
  readonly conversa: PedidoDeConversa | null;
}

/** Corpo de criação já limpo, com o `undefined` dos campos ausentes fora do objeto. */
export function lerCriacao(corpo: unknown, papel: Papel): Lido<CriacaoLida> {
  if (papel === "painel") {
    const lido = corpoDeCriar.safeParse(corpo);
    if (!lido.success) return { ok: false, mensagem: mensagemDe(lido.error) };
    return { ok: true, valor: { tarefa: semIndefinidos(lido.data), conversa: null } };
  }
  const lido = corpoDeCriarDoAgente.safeParse(corpo);
  if (!lido.success) return { ok: false, mensagem: `${AJUDA_DO_AGENTE} ${mensagemDe(lido.error)}` };
  const { tituloFixo: qual, conversa, ...resto } = lido.data;
  return { ok: true, valor: { tarefa: semIndefinidos({ ...resto, tituloFixo: qual, titulo: tituloFixo(qual) }), conversa: conversa ?? null } };
}

export function lerComando(acao: AcaoDaTarefa, corpo: unknown): Lido<Comando> {
  const lido = CORPOS_DAS_ACOES[acao].safeParse(corpo);
  if (!lido.success) return { ok: false, mensagem: mensagemDe(lido.error) };
  return { ok: true, valor: { acao, ...semIndefinidos(lido.data) } as Comando };
}

function semIndefinidos<T extends object>(objeto: T): T {
  return Object.fromEntries(Object.entries(objeto).filter(([, valor]) => valor !== undefined)) as T;
}

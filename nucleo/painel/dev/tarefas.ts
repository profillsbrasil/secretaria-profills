import { SEM_CONVERSAS, diaEm, falha, instante, ok, type DadosDasConversas, type Dia, type Ignorados, type Instante, type LeiturasDoCrm, type Resultado, type RetratoDosConectores } from "../../dominio";
import type { RespostaDaTarefa } from "../../servidor";
import {
  conversasTratadas,
  criarTarefa,
  decidir,
  lerComando,
  lerCriacao,
  tituloFixo,
  montarMeuDia,
  ordenar,
  tarefaDaConversa,
  tarefaDoCrm,
  ACOES_DA_TAREFA,
  type Contexto,
  type EstadoDaTarefa,
  type ConversaDoMeuDia,
  type ItemDoCrm,
  type MeuDia,
  type Nota,
  type NovaTarefa,
  type Tarefa,
} from "../../tarefas";
import { somarDias } from "../tarefas";

/**
 * Tarefas de mentira para o servidor de desenvolvimento, com as regras de verdade de `nucleo/tarefas`.
 * Cada fixture é um estado do Meu dia: `?tarefas=<nome>` na URL do painel.
 */
export const FIXTURES_DE_TAREFAS = ["vazio", "atrasadas", "agente", "conflito"] as const;
export type FixtureDeTarefas = (typeof FIXTURES_DE_TAREFAS)[number];

export interface Loja {
  meuDia(conectores: RetratoDosConectores, leituras?: LeiturasDoCrm, ignorados?: Ignorados, conversas?: DadosDasConversas): MeuDia;
  listar(estado: EstadoDaTarefa): { tarefas: Tarefa[] };
  ver(id: string): Resultado<RespostaDaTarefa>;
  criar(corpo: unknown): Resultado<RespostaDaTarefa>;
  /** O botão Criar tarefa do Meu dia: a regra de `tarefaDoCrm`, como no servidor. */
  criarDoCrm(item: ItemDoCrm, id: string): Resultado<RespostaDaTarefa>;
  /** O botão Criar tarefa de uma conversa do Meu dia: Responder ou Acompanhar, vencendo hoje. */
  criarDaConversa(conversa: ConversaDoMeuDia, id: string): Resultado<RespostaDaTarefa>;
  agir(id: string, acao: string, corpo: unknown): Resultado<RespostaDaTarefa>;
}

export function criarLoja(fixture: FixtureDeTarefas, agora: () => Date = () => new Date()): Loja {
  const tarefas = new Map<string, Tarefa>();
  const notas: Nota[] = [];
  /** Na fixture `conflito`, a primeira ação de cada tarefa encontra a tarefa mudada por "outra janela". */
  const jaMudou = new Set<string>();
  let contador = 0;

  const contexto = (papel: Contexto["papel"]): Contexto => {
    const momento = instante(agora());
    return { papel, agora: momento, hoje: diaEm(momento), novoId: () => `dev-${++contador}` };
  };

  const gravar = (decisao: { tarefa: Tarefa | null; seguinte: Tarefa | null; notas: readonly Omit<Nota, "id">[] }) => {
    for (const tarefa of [decisao.tarefa, decisao.seguinte]) if (tarefa !== null) tarefas.set(tarefa.id, tarefa);
    for (const nota of decisao.notas) notas.push({ ...nota, id: notas.length + 1 });
  };

  const semear = (entrada: NovaTarefa, papel: Contexto["papel"], criadaHaMin = 0) => {
    const ctx = contexto(papel);
    const criadaEm = instante(new Date(Date.parse(ctx.agora) - criadaHaMin * 60_000)) as Instante;
    const decisao = criarTarefa(entrada, { ...ctx, agora: criadaEm });
    gravar(decisao);
    return decisao.tarefa;
  };

  const hoje = diaEm(agora());
  const dia = (dias: number): Dia => somarDias(hoje, dias);

  if (fixture !== "vazio") {
    semear({ titulo: "Ligar para confirmar a visita técnica", clienteNome: "Construtora Canário", venceEm: dia(-3), nota: "Ficou de responder até sexta." }, "painel", 600);
    semear({ titulo: "Mandar a proposta revisada", clienteNome: "Obras Bem-te-vi", propostaCodigo: "P-1042", venceEm: dia(-1) }, "painel", 300);
    semear({ titulo: "Retornar o e-mail sobre o prazo de entrega", venceEm: hoje }, "painel", 200);
    semear({ titulo: "Organizar a lista de clientes para a semana" }, "painel", 100);
    semear({ titulo: "Visitar a obra nova", clienteNome: "Construtora Canário", venceEm: dia(4) }, "painel", 50);
  }
  if (fixture === "agente" || fixture === "conflito") {
    semear({ titulo: tituloFixo("responder", "Obras Bem-te-vi"), clienteNome: "Obras Bem-te-vi", venceEm: hoje, nota: "Cliente perguntou do prazo no WhatsApp ontem." }, "agente", 30);
    semear({ titulo: tituloFixo("enviar_material"), nota: "Conferir se a Construtora Canário recebeu o catálogo." }, "agente", 20);
  }

  const comNotas = (id: string, seguinte: Tarefa | null): Resultado<RespostaDaTarefa> => {
    const tarefa = tarefas.get(id);
    if (tarefa === undefined) return falha("nao_encontrado", `Não existe tarefa com o id ${id}.`);
    return ok({ tarefa, notas: notas.filter((nota) => nota.tarefaId === id), seguinte });
  };

  return {
    meuDia: (conectores, leituras, ignorados, conversas = SEM_CONVERSAS) => {
      const ctx = contexto("painel");
      const todas = [...tarefas.values()];
      const comTratadas = { ...conversas, tratadas: conversasTratadas(todas, "whatsapp") };
      return montarMeuDia(todas.filter((t) => t.estado === "aberta"), conectores, ctx.agora, ctx.hoje, leituras, ignorados, comTratadas);
    },
    listar: (estado) => ({ tarefas: ordenar([...tarefas.values()].filter((t) => t.estado === estado)) }),
    ver: (id) => comNotas(id, null),
    criar: (corpo) => {
      const lido = lerCriacao(corpo, "painel");
      if (!lido.ok) return falha("entrada_invalida", lido.mensagem);
      const { id } = lido.valor.tarefa;
      if (id !== undefined && tarefas.has(id)) return comNotas(id, null);
      return comNotas(semear(lido.valor.tarefa, "painel").id, null);
    },
    criarDoCrm: (item, id) => (tarefas.has(id) ? comNotas(id, null) : comNotas(semear(tarefaDoCrm(item, id, contexto("painel").hoje), "painel").id, null)),
    criarDaConversa: (conversa, id) => (tarefas.has(id) ? comNotas(id, null) : comNotas(semear(tarefaDaConversa(conversa, id, contexto("painel").hoje), "painel").id, null)),
    agir: (id, acao, corpo) => {
      const atual = tarefas.get(id);
      if (atual === undefined || !(ACOES_DA_TAREFA as readonly string[]).includes(acao)) return falha("nao_encontrado");
      const lido = lerComando(acao as (typeof ACOES_DA_TAREFA)[number], corpo);
      if (!lido.ok) return falha("entrada_invalida", lido.mensagem);
      let alvo = atual;
      if (fixture === "conflito" && acao !== "anotar" && !jaMudou.has(id)) {
        jaMudou.add(id);
        alvo = { ...atual, versao: atual.versao + 1, atualizadaEm: instante(agora()) };
        tarefas.set(id, alvo);
      }
      const decisao = decidir(alvo, lido.valor, contexto("painel"));
      if (!decisao.ok) return decisao;
      gravar(decisao.dados);
      return comNotas(id, decisao.dados.seguinte);
    },
  };
}

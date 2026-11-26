import { and, asc, eq } from "drizzle-orm";
import { ok, falha, type Dia, type Instante, type Resultado } from "../dominio";
import { ordenar, type ConversaDaTarefa, type Decisao, type EstadoDaTarefa, type Nota, type Tarefa, type TarefaComNotas } from "../tarefas";
import type { BancoAberto, Drizzle } from "./abrir";
import { nota, tarefa } from "./esquema";

type Transacao = Parameters<Parameters<Drizzle["transaction"]>[0]>[0];
type Leitor = Drizzle | Transacao;

function deLinha({ conversaCanal, conversaChave, conversaAte, ...linha }: typeof tarefa.$inferSelect): Tarefa {
  // Os gatilhos da migração 0016 garantem os três juntos ou nenhum.
  const conversa: ConversaDaTarefa | null = conversaCanal === null || conversaChave === null || conversaAte === null ? null : { canal: conversaCanal, chave: conversaChave, ate: conversaAte as Instante };
  return {
    ...linha,
    venceEm: linha.venceEm as Dia | null,
    criadaEm: linha.criadaEm as Instante,
    atualizadaEm: linha.atualizadaEm as Instante,
    conversa,
  };
}

function paraLinha({ conversa, ...resto }: Tarefa): typeof tarefa.$inferInsert {
  return { ...resto, conversaCanal: conversa?.canal ?? null, conversaChave: conversa?.chave ?? null, conversaAte: conversa?.ate ?? null };
}

function notaDeLinha(linha: typeof nota.$inferSelect): Nota {
  return { ...linha, criadaEm: linha.criadaEm as Instante };
}

function ler(db: Leitor, id: string): Tarefa | null {
  const linha = db.select().from(tarefa).where(eq(tarefa.id, id)).get();
  return linha === undefined ? null : deLinha(linha);
}

export function listarTarefas(banco: BancoAberto, estado?: EstadoDaTarefa): Tarefa[] {
  const consulta = banco.db.select().from(tarefa);
  const linhas = estado === undefined ? consulta.all() : consulta.where(eq(tarefa.estado, estado)).all();
  return ordenar(linhas.map(deLinha));
}

export function lerTarefa(banco: BancoAberto, id: string): TarefaComNotas | null {
  const atual = ler(banco.db, id);
  if (atual === null) return null;
  const notas = banco.db.select().from(nota).where(eq(nota.tarefaId, id)).orderBy(asc(nota.id)).all().map(notaDeLinha);
  return { tarefa: atual, notas };
}

/** Linha mudada, tarefa seguinte e notas entram juntas ou nenhuma entra. */
function gravar(tx: Transacao, decisao: Decisao, versaoLida: number | null): void {
  if (decisao.tarefa !== null) {
    if (versaoLida === null) tx.insert(tarefa).values(paraLinha(decisao.tarefa)).run();
    else {
      // A regra já conferiu a versão; o WHERE é a mesma conferência dentro da transação.
      const mudou = tx
        .update(tarefa)
        .set(paraLinha(decisao.tarefa))
        .where(and(eq(tarefa.id, decisao.tarefa.id), eq(tarefa.versao, versaoLida)))
        .returning({ id: tarefa.id })
        .all();
      if (mudou.length !== 1) throw new Error("a tarefa mudou dentro da transação");
    }
  }
  if (decisao.seguinte !== null) tx.insert(tarefa).values(paraLinha(decisao.seguinte)).run();
  if (decisao.notas.length > 0) tx.insert(nota).values([...decisao.notas]).run();
}

/**
 * Grava a tarefa nova e devolve `true`. Quando o id já existe, não grava nada e devolve `false`:
 * o pedido de criação repetido (prazo vencido, duas abas, rede que caiu depois do commit) não duplica.
 */
export function inserirTarefa(banco: BancoAberto, decisao: Decisao & { readonly tarefa: Tarefa }): boolean {
  return banco.db.transaction((tx) => {
    if (ler(tx, decisao.tarefa.id) !== null) return false;
    gravar(tx, decisao, null);
    return true;
  });
}

/**
 * Lê a tarefa, pede a decisão à regra pura e grava, tudo na mesma transação. Uma queda no meio
 * desfaz tudo: concluir com próximo passo nunca deixa a tarefa concluída sem a seguinte.
 */
export function mudarTarefa(banco: BancoAberto, id: string, decidir: (atual: Tarefa) => Resultado<Decisao>): Resultado<Decisao> {
  return banco.db.transaction((tx) => {
    const atual = ler(tx, id);
    if (atual === null) return falha("nao_encontrado", `Não existe tarefa com o id ${id}.`);
    const decisao = decidir(atual);
    if (!decisao.ok) return decisao;
    gravar(tx, decisao.dados, atual.versao);
    return ok(decisao.dados);
  });
}

import { and, desc, eq, notInArray } from "drizzle-orm";
import {
  PROBLEMAS,
  lerTelefone,
  type CodigoProblema,
  type EstadoDuravel,
  type IdConectorUnico,
  type Instante,
  type ProblemaDe,
} from "../dominio";
import type { BancoAberto } from "./abrir";
import { conector, eventoConector } from "./esquema";

type Linha = typeof conector.$inferSelect;
/** O nome do CRM não é da máquina de estados: a sincronização o grava, em `quem-usa.ts`. */
type Colunas = Omit<Linha, "id" | "atualizadoEm" | "nomeNoCrm" | "nomeNoCrmLidoEm">;

const LIMITE_DA_TRILHA = 500;

const VAZIA: Colunas = {
  fase: "desconectado",
  identidade: null,
  config: null,
  codigoProblema: null,
  conexaoExpiraEm: null,
  verificadoEm: null,
};

function problemaDe<C extends IdConectorUnico>(id: C, codigo: string | null): ProblemaDe<C> | null {
  if (codigo === null || !Object.hasOwn(PROBLEMAS, codigo)) return null;
  return PROBLEMAS[codigo as CodigoProblema].conector === id ? (codigo as ProblemaDe<C>) : null;
}

interface Persistencia<C extends IdConectorUnico> {
  paraColunas(estado: EstadoDuravel<C>): Colunas;
  /** `null` quando a linha não forma um estado válido; quem lê trata como `desconectado` e a sondagem reconcilia. */
  deLinha(linha: Linha): EstadoDuravel<C> | null;
}

const PERSISTENCIA: { readonly [C in IdConectorUnico]: Persistencia<C> } = {
  whatsapp: {
    paraColunas(estado) {
      switch (estado.fase) {
        case "desconectado":
          return VAZIA;
        case "conectado":
          return { ...VAZIA, fase: "conectado", identidade: estado.conta.telefone, verificadoEm: estado.verificadoEm };
        case "atencao":
          return { ...VAZIA, fase: "atencao", identidade: estado.conta?.telefone ?? null, codigoProblema: estado.problema.codigo };
      }
    },
    deLinha(linha) {
      const telefone = linha.identidade === null ? null : lerTelefone(linha.identidade);
      switch (linha.fase) {
        case "desconectado":
          return { fase: "desconectado" };
        case "conectado":
          if (telefone === null || linha.verificadoEm === null) return null;
          return {
            fase: "conectado",
            conta: { telefone },
            verificadoEm: linha.verificadoEm as Instante,
            espelho: "parado",
            ultimaAtividade: null,
          };
        case "atencao": {
          const codigo = problemaDe("whatsapp", linha.codigoProblema);
          if (codigo === null) return null;
          return {
            fase: "atencao",
            problema: { codigo, desde: linha.atualizadoEm as Instante },
            conta: telefone === null ? null : { telefone },
          };
        }
      }
    },
  },
  crm: {
    paraColunas(estado) {
      switch (estado.fase) {
        case "desconectado":
          return VAZIA;
        case "conectado":
          return {
            ...VAZIA,
            fase: "conectado",
            conexaoExpiraEm: estado.conexaoExpiraEm,
            verificadoEm: estado.verificadoEm,
          };
        case "atencao":
          return { ...VAZIA, fase: "atencao", codigoProblema: estado.problema.codigo };
      }
    },
    deLinha(linha) {
      switch (linha.fase) {
        case "desconectado":
          return { fase: "desconectado" };
        case "conectado":
          if (linha.conexaoExpiraEm === null || linha.verificadoEm === null) return null;
          return {
            fase: "conectado",
            conexaoExpiraEm: linha.conexaoExpiraEm as Instante,
            verificadoEm: linha.verificadoEm as Instante,
            ferramentas: null,
          };
        case "atencao": {
          const codigo = problemaDe("crm", linha.codigoProblema);
          return codigo === null ? null : { fase: "atencao", problema: { codigo, desde: linha.atualizadoEm as Instante } };
        }
      }
    },
  },
};

/** Estado durável gravado, como o servidor o encontra no boot antes da sondagem. */
export function lerConector<C extends IdConectorUnico>(banco: BancoAberto, id: C): EstadoDuravel<C> {
  const linha = banco.db.select().from(conector).where(eq(conector.id, id)).get();
  const estado = linha === undefined ? null : PERSISTENCIA[id].deLinha(linha);
  return estado ?? ({ fase: "desconectado" } as EstadoDuravel<C>);
}

export type DetalheDoEvento = Readonly<Record<string, string | number | boolean | null>>;

export interface EventoDoHistorico {
  readonly id: number;
  readonly tipo: string;
  readonly detalhe: DetalheDoEvento;
  readonly em: Instante;
}

/**
 * Uma transação: atualiza a linha do conector e anexa um evento à trilha, mantendo as
 * 500 linhas mais novas. `causa` é o evento da máquina que levou a esta gravação.
 */
export function gravarConector<C extends IdConectorUnico>(
  banco: BancoAberto,
  id: C,
  estado: EstadoDuravel<C>,
  causa: string,
  agora: Instante,
): void {
  // Desconectado, a próxima conexão pode ser de outra conta do CRM: o nome dela vem na leitura seguinte.
  const colunas = { ...PERSISTENCIA[id].paraColunas(estado), ...(estado.fase === "desconectado" ? { nomeNoCrm: null, nomeNoCrmLidoEm: null } : {}) };
  const detalhe: Record<string, string> = { causa };
  if (estado.fase === "atencao" && estado.problema.detalhe !== undefined) detalhe.detalhe = estado.problema.detalhe;
  banco.db.transaction((tx) => {
    tx.update(conector).set({ ...colunas, atualizadoEm: agora }).where(eq(conector.id, id)).run();
    tx.insert(eventoConector)
      .values({
        conector: id,
        tipo: estado.fase === "atencao" ? estado.problema.codigo : estado.fase,
        detalhe: JSON.stringify(detalhe),
        em: agora,
      })
      .run();
    const recentes = tx
      .select({ id: eventoConector.id })
      .from(eventoConector)
      .where(eq(eventoConector.conector, id))
      .orderBy(desc(eventoConector.id))
      .limit(LIMITE_DA_TRILHA);
    tx.delete(eventoConector)
      .where(and(eq(eventoConector.conector, id), notInArray(eventoConector.id, recentes)))
      .run();
  });
}

export function historico(banco: BancoAberto, id: IdConectorUnico, limite: number): EventoDoHistorico[] {
  return banco.db
    .select()
    .from(eventoConector)
    .where(eq(eventoConector.conector, id))
    .orderBy(desc(eventoConector.id))
    .limit(limite)
    .all()
    .map((linha) => ({
      id: linha.id,
      tipo: linha.tipo,
      detalhe: JSON.parse(linha.detalhe) as DetalheDoEvento,
      em: linha.em as Instante,
    }));
}

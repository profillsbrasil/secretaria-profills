import { LoaderCircle, WifiOff } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { MeuDia as DadosDoDia } from "../tarefas";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Lateral, MenuDoCelular } from "./Navegacao";
import { chaveDosConectores, type Conexao } from "./conexao";
import { NOMES_DAS_SECOES, listaLembrada, modeloDoMenu } from "./lateral";
import type { ListaDoDia } from "./meu-dia";
import { hashDaRota, lerRota, rotaInicial, secaoDaRota, type Rota } from "./rota";
import { api, useCarga, type Carga } from "./telas/comum";
import { Conexoes } from "./telas/Conexoes";
import { DetalheDaTarefa } from "./telas/DetalheDaTarefa";
import { MeuDia } from "./telas/MeuDia";
import { Tarefas } from "./telas/Tarefas";
import { useEstado } from "./useEstado";

function AvisoDeConexao({ canal, temEstado }: { canal: "conectando" | "aberto" | "sem_conexao"; temEstado: boolean }) {
  if (canal === "sem_conexao") {
    return (
      <div role="alert" className="flex items-start gap-3 rounded-xl border border-destaque/40 bg-destaque/10 px-4 py-3.5">
        <WifiOff aria-hidden className="mt-0.5 size-5 shrink-0 text-destaque" />
        <div>
          <p className="font-semibold">Sem conexão com a Secretária.</p>
          <p className="text-sm text-muted-foreground">Tentando de novo sozinho. Se continuar assim, peça ao seu agente para iniciar a Secretária.</p>
        </div>
      </div>
    );
  }
  if (canal === "conectando" && !temEstado) {
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle aria-hidden className="size-4 animate-spin" />
        Conectando à Secretária.
      </p>
    );
  }
  return null;
}

function assinarHash(avisar: () => void): () => void {
  window.addEventListener("hashchange", avisar);
  return () => window.removeEventListener("hashchange", avisar);
}

function useHash(): string {
  return useSyncExternalStore(assinarHash, () => window.location.hash);
}

/** A idade das fontes envelhece sozinha: o Meu dia recarrega a cada minuto, além do `event: tarefas`. */
function useMinuto(): number {
  const [minuto, setMinuto] = useState(0);
  useEffect(() => {
    const relogio = setInterval(() => setMinuto((n) => n + 1), 60_000);
    return () => clearInterval(relogio);
  }, []);
  return minuto;
}

/**
 * Uma leitura de `/api/meu-dia` para o painel inteiro: a lateral mostra as contagens em toda tela, e a
 * tela Meu dia mostra a mesma leitura. Recarrega com o `event: tarefas`, a cada minuto, no fim de uma
 * rodada de sincronização e quando o WhatsApp ou o CRM muda de fase.
 */
function useDia(conexao: Conexao): Carga<DadosDoDia> {
  const minuto = useMinuto();
  return useCarga("meu-dia", () => api.meuDia(), `${conexao.mudancasDeTarefas}:${minuto}:${conexao.rodadasTerminadas}:${chaveDosConectores(conexao.estado)}`);
}

/** O último bloco do Meu dia que a rota mostrou, para a lateral reabrir ao voltar. Só nesta aba. */
function useListaLembrada(rota: Rota | null): ListaDoDia | null {
  const [lembrada, setLembrada] = useState<ListaDoDia | null>(null);
  const nova = listaLembrada(lembrada, rota);
  if (nova !== lembrada) setLembrada(nova);
  return nova;
}

function Tela({ rota, conexao, dia }: { rota: Rota; conexao: Conexao; dia: Carga<DadosDoDia> }) {
  const mudancas = conexao.mudancasDeTarefas;
  switch (rota.tela) {
    case "meu-dia":
      return <MeuDia carga={dia} mudancas={mudancas} lista={rota.lista} sincronizacao={conexao.sincronizacao} crm={conexao.estado?.conectores.crm.estado ?? null} />;
    case "tarefas":
    case "nova":
      return <Tarefas mudancas={mudancas} nova={rota.tela === "nova"} />;
    case "tarefa":
      return <DetalheDaTarefa key={rota.id} id={rota.id} mudancas={mudancas} />;
    case "conexoes":
      return <Conexoes conexao={conexao} gaveta={rota.gaveta} />;
  }
}

export function App() {
  const conexao = useEstado();
  const hash = useHash();
  const lida = lerRota(hash);
  // Sem hash, a tela inicial depende do onboarding, que só se sabe com o primeiro estado do SSE.
  const rota = lida ?? (conexao.estado === null ? null : rotaInicial(conexao.estado));
  const secao = rota === null ? null : secaoDaRota(rota);
  const dia = useDia(conexao);
  const lembrada = useListaLembrada(rota);
  const modelo = modeloDoMenu(rota, dia.dados, conexao.estado, lembrada, new Date());

  // Carregar a página é o vendedor abrindo o painel. A reconexão do SSE não conta: ela não é ação dele.
  useEffect(() => {
    void api.painelAberto();
  }, []);

  useEffect(() => {
    if (lida === null && rota !== null) window.location.replace(hashDaRota(rota));
  }, [lida, rota]);

  useEffect(() => {
    document.title = secao === null ? "Secretária" : `Secretária · ${NOMES_DAS_SECOES[secao]}`;
  }, [secao]);

  return (
    <TooltipProvider delayDuration={280} skipDelayDuration={300}>
      <div className="min-h-dvh md:flex">
        <Lateral modelo={modelo} />
        <div className="min-w-0 flex-1 md:py-2.5 md:pr-2.5">
          <main className="min-h-dvh bg-background md:min-h-[calc(100dvh-20px)] md:rounded-2xl md:border md:shadow-[var(--sombra-do-painel)]">
            <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 md:px-8 md:py-10">
              <MenuDoCelular modelo={modelo} />
              <AvisoDeConexao canal={conexao.canal} temEstado={conexao.estado !== null} />
              {rota !== null && <Tela rota={rota} conexao={conexao} dia={dia} />}
            </div>
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}

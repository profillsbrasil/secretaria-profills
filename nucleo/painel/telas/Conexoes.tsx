import { CircleCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { CONECTORES_UNICOS, type ErroOperacao, type EstadoPainel, type Fase, type IdConectorUnico } from "../../dominio";
import { cn } from "cn";
import { pedirAcao, type PedidoDeAcao } from "../api";
import { CartaoCrm } from "../cartoes/CartaoCrm";
import { CartaoEmail, GavetaDoEmail } from "../cartoes/CartaoEmail";
import { Selo } from "../cartoes/Cartao";
import { CartaoWhatsapp } from "../cartoes/CartaoWhatsapp";
import { podeAgir, type Conexao } from "../conexao";
import { NOMES_DOS_CONECTORES, progresso } from "../descrever";
import { hashDaRota, type GavetaDoEmail as GavetaDaRota } from "../rota";
import { CabecalhoDaTela } from "./comum";
import { useQrAoAbrir } from "./useQrAoAbrir";

function useAgora(): Date {
  const [agora, setAgora] = useState(() => new Date());
  useEffect(() => {
    const relogio = setInterval(() => setAgora(new Date()), 1000);
    return () => clearInterval(relogio);
  }, []);
  return agora;
}

/** O erro de uma ação vale enquanto o conector segue na fase em que ela foi pedida. */
interface ErroDaAcao {
  readonly fase: Fase;
  readonly erro: ErroOperacao;
}

const COR_DO_SEGMENTO: { readonly [F in Fase]: string } = {
  desconectado: "bg-muted",
  pareando: "bg-input",
  sincronizando: "bg-input",
  confirmar_conta: "bg-input",
  autorizando: "bg-input",
  testando: "bg-input",
  conectado: "bg-primary",
  atencao: "bg-destaque",
};

function Progresso({ estado }: { estado: EstadoPainel }) {
  const { conectados, total } = progresso(estado);
  if (estado.onboardingCompleto) {
    return (
      <div role="status" className="flex items-start gap-3 rounded-xl border border-primary/30 bg-primary/10 px-4 py-3.5">
        <CircleCheck aria-hidden className="mt-0.5 size-5 shrink-0 text-primary" />
        <div>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-semibold">
            Tudo conectado.
            <Selo tom="neutro" texto="E-mail é opcional" />
          </p>
          <p className="text-sm text-muted-foreground">O seu agente já pode usar o WhatsApp e o CRM.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <p role="status" className="text-sm text-muted-foreground tabular-nums">
          <span className="font-semibold text-foreground">
            {conectados} de {total}
          </span>{" "}
          {conectados === 1 ? "conectado" : "conectados"}
        </p>
        <Selo tom="neutro" texto="E-mail é opcional" />
      </div>
      <ol className="grid grid-cols-2 gap-1.5" aria-label="Situação de cada conexão">
        {CONECTORES_UNICOS.map((id) => {
          const fase = estado.conectores[id].estado.fase;
          return (
            <li key={id} className="flex flex-col gap-1.5">
              <span aria-hidden className={cn("h-1.5 rounded-full", COR_DO_SEGMENTO[fase])} />
              <span className="truncate text-xs text-muted-foreground">{NOMES_DOS_CONECTORES[id]}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * A gaveta segue o hash. Abrir empilha uma entrada, para o Voltar do navegador fechar; os passos
 * de dentro trocam a entrada atual. Fechar volta à entrada de antes, quando foi esta tela que abriu.
 */
function useGaveta() {
  const abriuAqui = useRef(false);
  const abrir = useCallback((gaveta: GavetaDaRota) => {
    abriuAqui.current = true;
    window.location.hash = hashDaRota({ tela: "conexoes", gaveta });
  }, []);
  const ir = useCallback((gaveta: GavetaDaRota) => window.location.replace(hashDaRota({ tela: "conexoes", gaveta })), []);
  const fechar = useCallback(() => {
    if (abriuAqui.current) {
      abriuAqui.current = false;
      window.history.back();
    } else {
      window.location.replace(hashDaRota({ tela: "conexoes" }));
    }
  }, []);
  return { abrir, ir, fechar };
}

export function Conexoes({ conexao, gaveta }: { conexao: Conexao; gaveta: GavetaDaRota | undefined }) {
  const navegar = useGaveta();
  const agora = useAgora();
  const [pendente, setPendente] = useState<IdConectorUnico | null>(null);
  const [erros, setErros] = useState<Partial<Record<IdConectorUnico, ErroDaAcao>>>({});
  const { estado } = conexao;
  const aberto = podeAgir(conexao);

  const agir = useCallback(
    async (pedido: PedidoDeAcao) => {
      if (!aberto || pendente !== null || estado === null) return;
      const fase = estado.conectores[pedido.id].estado.fase;
      setPendente(pedido.id);
      const erro = await pedirAcao(pedido);
      setPendente(null);
      setErros((atuais) => ({ ...atuais, [pedido.id]: erro === null ? undefined : { fase, erro } }));
    },
    [aberto, pendente, estado],
  );

  const livre = aberto && pendente === null;
  useQrAoAbrir(conexao, livre, agir);

  const props = <C extends IdConectorUnico>(id: C) => {
    const visao = estado!.conectores[id];
    const erro = erros[id];
    return {
      estado: visao.estado,
      acoes: visao.acoes,
      agora,
      livre,
      erro: erro !== undefined && erro.fase === visao.estado.fase ? erro.erro : null,
      agir,
    };
  };

  return (
    <div className="flex flex-col gap-6">
      <CabecalhoDaTela titulo="Conexões" descricao="Conecte o seu WhatsApp e o CRM para a Secretária trabalhar junto com o seu agente. O e-mail é opcional." />
      {estado && <Progresso estado={estado} />}
      {estado && (
        <div className={cn("grid items-stretch gap-4 md:grid-cols-2 xl:grid-cols-3", !aberto && "opacity-70")} aria-busy={pendente !== null}>
          <CartaoWhatsapp {...props("whatsapp")} />
          <CartaoCrm {...props("crm")} />
          <CartaoEmail email={estado.email} livre={aberto} aberta={gaveta?.tipo === "conta" ? gaveta.id : null} abrir={navegar.abrir} />
        </div>
      )}
      {estado && <GavetaDoEmail gaveta={gaveta} email={estado.email} agora={agora} livre={aberto} ir={navegar.ir} fechar={navegar.fechar} />}
    </div>
  );
}

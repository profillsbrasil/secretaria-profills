import { Fragment, type ReactNode } from "react";
import type { Acao, ErroOperacao, EstadoPorConector, IdConectorUnico } from "../../dominio";
import type { PedidoDeAcao } from "../api";
import { controleDaAcao, ordemNoRodape } from "../descrever";
import { BotaoDeAcao } from "./Cartao";

export interface PropsDoConector<C extends IdConectorUnico> {
  readonly estado: EstadoPorConector[C];
  readonly acoes: readonly Acao[];
  readonly agora: Date;
  /** Falso com o SSE caído ou com uma ação deste cartão em andamento. */
  readonly livre: boolean;
  readonly erro: ErroOperacao | null;
  readonly agir: (pedido: PedidoDeAcao) => void;
}

/**
 * Os botões do estado, na ordem do rodapé. O controle especial do conectar e do reparear (link, escolha)
 * o cartão passa em `conectar` e ele entra no lugar do botão.
 */
export function AcoesDoRodape(props: { id: IdConectorUnico; acoes: readonly Acao[]; livre: boolean; agir: (pedido: PedidoDeAcao) => void; conectar: ReactNode }) {
  const { id, livre, agir } = props;
  return ordemNoRodape(props.acoes).map((acao) =>
    acao === "conectar" || acao === "reparear" || controleDaAcao(id, acao) !== "botao" ? (
      <Fragment key={acao}>{props.conectar}</Fragment>
    ) : (
      <BotaoDeAcao key={acao} acao={acao} desabilitado={!livre} aoClicar={() => agir({ id, acao })} />
    ),
  );
}

import {
  Calendar,
  CalendarCheck,
  ChevronUp,
  CircleCheck,
  FileText,
  Hourglass,
  Inbox,
  ListTodo,
  Menu,
  MessageCircle,
  PanelLeftClose,
  PanelLeftOpen,
  PlugZap,
  UserRound,
  UserX,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetClose, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "cn";
import type { QuemUsa } from "../dominio";
import { AvisoNoCartao, LinhaDaVersao, PontoDeNovidade, SimboloDaAtualizacao, type ControleDaAtualizacao } from "./AvisoDaAtualizacao";
import type { Tom } from "./descrever";
import { vigiarItemAtivo } from "./item-ativo";
import { rotulosDeQuemUsa, type ConexoesDaLateral, type LinhaDoMenu, type ModeloDoMenu } from "./lateral";
import type { IdDoBloco } from "./meu-dia";
import { hashDaRota } from "./rota";

const ICONES_DOS_BLOCOS: { readonly [B in IdDoBloco]: LucideIcon } = {
  "fazer-hoje": CircleCheck,
  "sem-data": Calendar,
  aprovar: Inbox,
  responder: MessageCircle,
  propostas: FileText,
  "esperando-cliente": Hourglass,
  "sem-atendimento": UserX,
};

const CHAVE_RECOLHIDA = "secretaria.navegacao-recolhida";
const CHAVE_FONTES_ABERTAS = "secretaria.lateral-fontes-abertas";

function lerLembrado(chave: string): boolean {
  try {
    return localStorage.getItem(chave) === "1";
  } catch {
    return false;
  }
}

function gravarLembrado(chave: string, valor: boolean): void {
  try {
    localStorage.setItem(chave, valor ? "1" : "0");
  } catch {
    // Sem armazenamento a escolha vale só nesta aba.
  }
}

function useLembrado(chave: string): [boolean, () => void] {
  const [valor, setValor] = useState(() => lerLembrado(chave));
  return [
    valor,
    () => {
      setValor(!valor);
      gravarLembrado(chave, !valor);
    },
  ];
}

const TECLAS_DO_MENU = ["ArrowDown", "ArrowUp", "Home", "End"];

/** Setas, Home e End andam pelos links e botões do menu, na ordem da tela. */
function moverFoco(evento: KeyboardEvent<HTMLElement>): void {
  if (!TECLAS_DO_MENU.includes(evento.key)) return;
  const itens = [...evento.currentTarget.querySelectorAll<HTMLElement>("a[href], button:not(:disabled)")];
  const atual = itens.indexOf(document.activeElement as HTMLElement);
  if (atual < 0) return;
  evento.preventDefault();
  const destino = evento.key === "Home" ? 0 : evento.key === "End" ? itens.length - 1 : evento.key === "ArrowDown" ? Math.min(atual + 1, itens.length - 1) : Math.max(atual - 1, 0);
  itens[destino]?.focus();
}

/** A dica própria da lateral recolhida: aparece no hover e no foco por teclado, nunca o `title` nativo. */
function Dica({ texto, ativa, children }: { texto: string; ativa: boolean; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      {ativa && <TooltipContent side="right">{texto}</TooltipContent>}
    </Tooltip>
  );
}

export function LugarDoLogo({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cn("grid size-7 shrink-0 place-items-center rounded-[7px] border border-dashed border-input text-[7px] font-semibold tracking-wide text-fraco uppercase", className)}>
      logo
    </span>
  );
}

/** Quem está usando, no cartão do pé. `null` antes da primeira leitura: a linha não aparece, para não piscar "Diga seu nome". */
export type QuemNoCartao = { readonly quem: QuemUsa | null; abrir(): void } | null;

/** As iniciais num círculo; sem nome, o contorno tracejado com a pessoa. */
export function Avatar({ quem, className }: { quem: QuemUsa | null; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-7 shrink-0 place-items-center rounded-full text-[11px] font-semibold transition-colors",
        quem === null ? "border border-dashed border-input text-muted-foreground" : "bg-accent text-foreground",
        className,
      )}
    >
      {quem === null ? <UserRound className="size-[15px]" /> : quem.iniciais}
    </span>
  );
}

/** A linha de quem usa. O clique abre a janela de dizer ou mudar o nome. Recolhida, sobra o avatar com a dica. */
function LinhaDeQuemUsa({ quem, abrir, recolhida, comBorda }: { quem: QuemUsa | null; abrir: () => void; recolhida: boolean; comBorda: boolean }) {
  const rotulos = rotulosDeQuemUsa(quem);
  return (
    <Dica texto={rotulos.dica} ativa={recolhida}>
      <button
        type="button"
        aria-label={rotulos.falado}
        onClick={abrir}
        className={cn(
          "group flex w-full items-center text-left outline-none",
          recolhida ? "h-10 justify-center" : "gap-[9px] px-2.5 py-2 transition-colors hover:bg-passar-na-moldura",
          comBorda && !recolhida && "border-b",
        )}
      >
        <Avatar quem={quem} className={cn(recolhida && quem !== null && "group-hover:bg-ativo")} />
        {!recolhida && (
          <span className="flex min-w-0 flex-1 flex-col leading-[1.2]">
            <b className="truncate text-[13px] font-medium text-foreground">{rotulos.rotulo}</b>
            <small className="truncate text-[11.5px] text-fraco">{rotulos.subtitulo}</small>
          </span>
        )}
      </button>
    </Dica>
  );
}

function Marca() {
  return (
    <span className="flex min-w-0 items-center gap-2.25">
      <LugarDoLogo />
      <span className="truncate text-[15px] font-semibold tracking-tight">Secretária</span>
    </span>
  );
}

const COR_DO_PONTO: { readonly [T in Tom]: string } = { ok: "bg-fraco", neutro: "bg-fraco", andamento: "bg-fraco", atencao: "bg-destaque" };

function Ponto({ tom, className }: { tom: Tom; className?: string }) {
  return <span aria-hidden className={cn("size-[7px] shrink-0 rounded-full", COR_DO_PONTO[tom], className)} />;
}

type Forma = "aba" | "grupo" | "bloco";

interface PropsDoItem {
  readonly linha: LinhaDoMenu;
  readonly Icone: LucideIcon;
  readonly forma: Forma;
  readonly recolhida: boolean;
  /** Na lateral a aba ativa se funde à Moldura; na gaveta do celular não há Moldura ao lado. */
  readonly naGaveta: boolean;
  readonly dentroDoGrupoAberto?: boolean;
  readonly paiDoAtual?: boolean;
}

function ItemDoMenu({ linha, Icone, forma, recolhida, naGaveta, dentroDoGrupoAberto = false, paiDoAtual = false }: PropsDoItem) {
  const { contagem, atual, quente } = linha;
  const fundida = forma === "aba" && atual && !naGaveta;
  return (
    <Dica texto={linha.dica} ativa={recolhida}>
      <a
        href={hashDaRota(linha.destino)}
        aria-current={atual ? "page" : undefined}
        aria-label={[linha.nome, contagem?.falado, quente ? "precisa de atenção" : undefined].filter(Boolean).join(", ")}
        className={cn(
          "relative flex w-full items-center gap-2.5 rounded-md text-sm whitespace-nowrap text-muted-foreground transition-colors outline-none hover:bg-passar hover:text-foreground",
          recolhida ? "h-10 justify-center" : "min-h-[34px] px-2.5",
          forma === "bloco" && !recolhida && "min-h-[31px] pl-8 text-[13.5px]",
          forma === "aba" && !naGaveta && "min-h-[38px] rounded-l-[10px] rounded-r-none border border-r-0 border-transparent",
          dentroDoGrupoAberto && "hover:bg-passar-na-moldura",
          paiDoAtual && "font-semibold text-foreground",
          atual && !fundida && "bg-ativo font-semibold text-foreground shadow-[inset_0_0_0_1px_var(--ativo-borda)] hover:bg-ativo",
          fundida && "z-[2] border-border bg-background font-semibold text-foreground hover:bg-background",
        )}
      >
        <Icone aria-hidden className={cn("shrink-0", forma === "bloco" && !recolhida ? "size-3.5" : "size-4", atual && "text-foreground")} />
        <span className={cn(recolhida ? "sr-only" : "min-w-0 flex-1 truncate")}>{linha.nome}</span>
        {contagem !== null && (
          <span
            aria-hidden
            className={cn(
              "text-xs font-medium tabular-nums",
              recolhida
                ? "absolute top-0.5 right-1 grid h-4 min-w-[17px] place-items-center rounded-lg bg-accent px-1 text-[10.5px] text-foreground"
                : contagem.apagado
                  ? "text-fraco"
                  : "text-muted-foreground",
              atual && !recolhida && "text-foreground",
              atual && recolhida && "bg-foreground text-sidebar",
              recolhida && contagem.apagado && "hidden",
            )}
          >
            {contagem.texto}
          </span>
        )}
        {quente && <Ponto tom="atencao" className={cn(recolhida && "absolute top-[7px] right-[7px]")} />}
      </a>
    </Dica>
  );
}

/** O grupo Meu dia com os blocos, Tarefas e Conexões. Na lateral, a tela atual se funde à Moldura. */
function ListaDoMenu({ modelo, recolhida, naGaveta }: { modelo: ModeloDoMenu; recolhida: boolean; naGaveta: boolean }) {
  const { meuDia } = modelo;
  const grupoFundido = meuDia.grupoAberto && !naGaveta;
  return (
    <>
      <div
        role="group"
        aria-label="Meu dia e os blocos"
        className={cn(
          "flex flex-col gap-px",
          !naGaveta && "mb-1 rounded-l-xl border border-r-0 border-transparent pt-[3px] pb-1.5 pl-[3px]",
          !naGaveta && (recolhida ? "pr-1" : "pr-2"),
          grupoFundido && "relative z-[2] border-border bg-background",
        )}
      >
        <ItemDoMenu linha={meuDia} Icone={CalendarCheck} forma="grupo" recolhida={recolhida} naGaveta={naGaveta} dentroDoGrupoAberto={grupoFundido} paiDoAtual={meuDia.paiDoAtual} />
        {modelo.blocos.map((bloco) => (
          <ItemDoMenu key={bloco.id} linha={bloco} Icone={ICONES_DOS_BLOCOS[bloco.id]} forma="bloco" recolhida={recolhida} naGaveta={naGaveta} dentroDoGrupoAberto={grupoFundido} />
        ))}
      </div>
      <ItemDoMenu linha={modelo.tarefas} Icone={ListTodo} forma="aba" recolhida={recolhida} naGaveta={naGaveta} />
      <ItemDoMenu linha={modelo.conexoes} Icone={PlugZap} forma="aba" recolhida={recolhida} naGaveta={naGaveta} />
    </>
  );
}

/**
 * O cartão do pé: quem está usando, o resumo das conexões e, aberta, cada fonte com a idade e a versão,
 * que sobem dentro do cartão. A atualização, quando há o que dizer, fica logo acima de quem usa.
 */
function CartaoDoPe({ conexoes, quem, atualizacao }: { conexoes: ConexoesDaLateral; quem: QuemNoCartao; atualizacao: ControleDaAtualizacao }) {
  const [aberto, alternar] = useLembrado(CHAVE_FONTES_ABERTAS);
  const id = useId();
  const { vista } = atualizacao;
  return (
    <div className={cn("overflow-hidden rounded-xl border bg-card transition-shadow duration-200", aberto && "shadow-[var(--sombra-do-painel)]")}>
      <div id={id} inert={!aberto} className={cn("grid transition-[grid-template-rows,opacity] duration-200 ease-out", aberto ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}>
        <div className="min-h-0 overflow-hidden">
          <ul aria-label="Conexões e idade dos dados" className="flex flex-col gap-1 border-b px-3 pt-2.5 pb-2 text-[12.5px] text-muted-foreground">
            {conexoes.fontes.map((fonte) => (
              <li key={fonte.chave} className="flex min-w-0 items-center gap-2">
                <Ponto tom={fonte.tom} />
                <span className="min-w-0 flex-1 truncate">{fonte.nome}</span>
                {fonte.tom === "atencao" && <span className="sr-only">, precisa de atenção</span>}
                <span className="ml-auto whitespace-nowrap text-fraco tabular-nums">{fonte.detalhe}</span>
              </li>
            ))}
          </ul>
          {vista !== null && <LinhaDaVersao vista={vista} />}
        </div>
      </div>
      {/* Leitor de tela costuma não anunciar uma região que entra no DOM já com o texto. */}
      <div aria-live="polite" data-regiao="atualizacao">
        {vista?.aviso && <AvisoNoCartao aviso={vista.aviso} ocupado={atualizacao.ocupado} agir={atualizacao.agir} />}
      </div>
      {quem !== null && <LinhaDeQuemUsa quem={quem.quem} abrir={quem.abrir} recolhida={false} comBorda />}
      <button
        type="button"
        aria-expanded={aberto}
        aria-controls={id}
        aria-label={`Conexões: ${conexoes.resumo}`}
        onClick={alternar}
        className="flex min-h-[34px] w-full items-center gap-2 px-2.5 py-2 text-left text-[12.5px] text-muted-foreground transition-colors outline-none hover:bg-passar-na-moldura hover:text-foreground"
      >
        <Ponto tom={conexoes.tom} />
        <span className="min-w-0 flex-1 truncate">{conexoes.resumo}</span>
        <ChevronUp aria-hidden className={cn("size-4 shrink-0 transition-transform duration-200", aberto && "rotate-180")} />
      </button>
    </div>
  );
}

/** Recolhida, a atualização vira um ícone acima de quem usa. O clique abre a lateral, onde está o botão. */
function AtualizacaoRecolhida({ girando, ponto, rotulo, abrir }: { girando: boolean; ponto: boolean; rotulo: string; abrir: () => void }) {
  return (
    <Dica texto={girando ? rotulo : `${rotulo} · abrir a lateral`} ativa>
      <Button variant="ghost" size="icon-sm" aria-label={rotulo} onClick={abrir} className="relative mx-auto text-muted-foreground hover:bg-passar hover:text-foreground">
        <SimboloDaAtualizacao icone={girando ? "girando" : "versao_nova"} />
        {ponto && <PontoDeNovidade />}
      </Button>
    </Dica>
  );
}

/** A lateral do computador: cabeçalho com o lugar do logo e o recolher, o menu que rola por dentro e o cartão do pé. Sem barra no topo. */
export function Lateral({ modelo, quem, atualizacao }: { modelo: ModeloDoMenu; quem: QuemNoCartao; atualizacao: ControleDaAtualizacao }) {
  const [recolhida, alternar] = useLembrado(CHAVE_RECOLHIDA);
  const rotuloDoBotao = recolhida ? "Abrir a lateral" : "Recolher a lateral";
  const areaDoMenu = useRef<HTMLDivElement>(null);
  const ativo = [modelo.meuDia, ...modelo.blocos, modelo.tarefas, modelo.conexoes].find((linha) => linha.atual)?.nome ?? null;
  useEffect(() => (areaDoMenu.current === null ? undefined : vigiarItemAtivo(areaDoMenu.current)), [ativo]);
  return (
    <nav
      aria-label="Telas"
      onKeyDown={moverFoco}
      className={cn("sticky top-0 z-10 hidden h-dvh shrink-0 flex-col py-2.5 pl-2.5 transition-[width] duration-200 ease-out md:flex", recolhida ? "w-16" : "w-61")}
    >
      <div className={cn("mb-2 flex min-h-10 items-center gap-1.5 pr-2.5", recolhida ? "flex-col justify-center" : "justify-between pl-1")}>
        {recolhida ? <LugarDoLogo /> : <Marca />}
        <Dica texto={rotuloDoBotao} ativa>
          <Button variant="ghost" size="icon-sm" aria-label={rotuloDoBotao} onClick={alternar}>
            {recolhida ? <PanelLeftOpen aria-hidden /> : <PanelLeftClose aria-hidden />}
          </Button>
        </Dica>
      </div>
      <div ref={areaDoMenu} className="-mr-px flex min-h-0 flex-1 flex-col gap-0.5 overflow-x-hidden overflow-y-auto [scrollbar-width:thin]">
        <ListaDoMenu modelo={modelo} recolhida={recolhida} naGaveta={false} />
      </div>
      {modelo.cartao !== null && !recolhida && (
        <div className="relative z-[3] flex-none bg-sidebar pt-2.5 pr-2.5">
          <CartaoDoPe conexoes={modelo.cartao} quem={quem} atualizacao={atualizacao} />
        </div>
      )}
      {recolhida && (quem !== null || atualizacao.vista?.recolhida) && (
        <div className="relative z-[3] flex flex-none flex-col gap-1 bg-sidebar pt-2.5 pr-2.5">
          {atualizacao.vista?.recolhida && <AtualizacaoRecolhida {...atualizacao.vista.recolhida} abrir={alternar} />}
          {quem !== null && <LinhaDeQuemUsa quem={quem.quem} abrir={quem.abrir} recolhida comBorda={false} />}
        </div>
      )}
    </nav>
  );
}

/** No celular: o botão Menu no topo do conteúdo abre o mesmo menu numa gaveta pela esquerda. A gaveta fecha com Esc, com o X ou ao escolher uma tela. */
export function MenuDoCelular({ modelo, quem, atualizacao }: { modelo: ModeloDoMenu; quem: QuemNoCartao; atualizacao: ControleDaAtualizacao }) {
  const novidade = atualizacao.vista?.pontoNoMenu === true;
  const [aberto, setAberto] = useState(false);
  // A janela do nome abre sobre a página, com a gaveta já fechada: duas camadas modais seguidas confundem o foco.
  const quemNaGaveta: QuemNoCartao =
    quem === null
      ? null
      : {
          quem: quem.quem,
          abrir() {
            setAberto(false);
            quem.abrir();
          },
        };
  return (
    <div className="flex items-center gap-2.5 md:hidden">
      <Sheet open={aberto} onOpenChange={setAberto}>
        <SheetTrigger asChild>
          <Button variant="outline" size="sm" aria-label={novidade ? "Menu, tem novidade" : undefined} className="relative">
            <Menu aria-hidden />
            Menu
            {novidade && <PontoDeNovidade />}
          </Button>
        </SheetTrigger>
        <SheetContent
          side="left"
          showCloseButton={false}
          aria-describedby={undefined}
          className="w-[min(300px,86%)] gap-0 bg-sidebar sm:max-w-none data-[state=closed]:duration-150 data-[state=open]:duration-200"
        >
          <div className="flex items-center justify-between gap-2 py-2.5 pr-2.5 pl-3.5">
            <SheetTitle asChild>
              <div>
                <Marca />
              </div>
            </SheetTitle>
            <SheetClose asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Fechar o menu">
                <X aria-hidden />
              </Button>
            </SheetClose>
          </div>
          <nav
            aria-label="Telas"
            onKeyDown={moverFoco}
            onClick={(evento) => {
              if ((evento.target as HTMLElement).closest("a[href]") !== null) setAberto(false);
            }}
            className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2.5 pb-3.5"
          >
            <ListaDoMenu modelo={modelo} recolhida={false} naGaveta />
            {modelo.cartao !== null && (
              <div className="mt-auto pt-2.5">
                <CartaoDoPe conexoes={modelo.cartao} quem={quemNaGaveta} atualizacao={atualizacao} />
              </div>
            )}
          </nav>
        </SheetContent>
      </Sheet>
      <Marca />
    </div>
  );
}

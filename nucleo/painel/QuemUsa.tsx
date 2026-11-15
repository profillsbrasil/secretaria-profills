import { LockKeyhole, X } from "lucide-react";
import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { TAMANHO_DO_NOME, type QuemUsa, type VisaoDeQuemUsa } from "../dominio";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { Resposta } from "./api";
import { LugarDoLogo, type QuemNoCartao } from "./Navegacao";
import type { Aviso } from "./tarefas";
import { AvisoFlutuante, api, useCarga } from "./telas/comum";

type Corpo = { readonly nome: string } | { readonly agoraNao: true };

const AVISO_SOME_MS = 6000;

interface PropsDoFormulario {
  readonly inicial: string;
  readonly botao: string;
  readonly secundario: string;
  /** Mudar um nome que veio do CRM: o aviso diz que o CRM não muda. */
  readonly doCrm: boolean;
  aoSecundario(): void;
  aoSalvar(nome: string): Promise<string | null>;
}

/** Só o primeiro nome. O erro aparece embaixo do campo, e o campo some do erro quando o vendedor volta a digitar. */
function FormularioDoNome({ inicial, botao, secundario, doCrm, aoSecundario, aoSalvar }: PropsDoFormulario) {
  const [nome, setNome] = useState(inicial);
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);
  const id = useId();

  async function enviar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    if (nome.trim() === "") {
      setErro("Escreva seu nome para salvar.");
      return;
    }
    setSalvando(true);
    const recusa = await aoSalvar(nome.trim());
    setSalvando(false);
    setErro(recusa);
  }

  return (
    <form noValidate onSubmit={(evento) => void enviar(evento)} className="flex min-w-0 flex-col gap-2">
      <label htmlFor={`${id}-nome`} className="flex flex-col gap-1 text-[12.5px] text-muted-foreground">
        Seu primeiro nome
        <Input
          id={`${id}-nome`}
          name="nome"
          autoComplete="given-name"
          autoFocus
          maxLength={TAMANHO_DO_NOME}
          value={nome}
          aria-invalid={erro !== null}
          aria-describedby={erro === null ? undefined : `${id}-erro`}
          onChange={(evento) => {
            setNome(evento.target.value);
            if (erro !== null && evento.target.value.trim() !== "") setErro(null);
          }}
          className="min-h-[34px] rounded-lg bg-background text-foreground"
        />
      </label>
      {erro !== null && (
        <p id={`${id}-erro`} className="text-[12.5px] text-destructive">
          {erro}
        </p>
      )}
      <p className="flex items-center gap-1.5 text-xs text-fraco">
        <LockKeyhole aria-hidden className="size-[13px]" />
        <span>Fica só neste computador{doCrm ? ". O nome no CRM não muda" : ""}.</span>
      </p>
      <div className="mt-0.5 flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" onClick={aoSecundario}>
          {secundario}
        </Button>
        <Button type="submit" disabled={salvando}>
          {botao}
        </Button>
      </div>
    </form>
  );
}

/** A primeira abertura sem nome: a tela curta de boas-vindas. Só fecha por Começar ou Agora não. */
function BoasVindas({ aoSalvar, agoraNao }: { aoSalvar: (nome: string) => Promise<string | null>; agoraNao: () => void }) {
  return (
    <Dialog open>
      <DialogContent
        className="w-[min(480px,calc(100%-32px))] px-7 pt-7 pb-[26px]"
        onEscapeKeyDown={(evento) => evento.preventDefault()}
        onPointerDownOutside={(evento) => evento.preventDefault()}
        onInteractOutside={(evento) => evento.preventDefault()}
      >
        <LugarDoLogo className="mb-3.5 size-10" />
        <DialogTitle className="mb-1.5 text-[21px] tracking-[-0.01em]">Boas-vindas à Secretária</DialogTitle>
        <DialogDescription className="mb-[18px] text-[13.5px]">Ela lê o seu WhatsApp, o seu CRM e os seus e-mails e monta o seu dia. Antes, como você quer ser chamado?</DialogDescription>
        <FormularioDoNome inicial="" botao="Começar" secundario="Agora não" doCrm={false} aoSecundario={agoraNao} aoSalvar={aoSalvar} />
      </DialogContent>
    </Dialog>
  );
}

/** A janela pequena do cartão do pé: dizer o nome, ou mudar o que já está lá. */
function JanelaDoNome({ quem, fechar, aoSalvar }: { quem: QuemUsa | null; fechar: () => void; aoSalvar: (nome: string) => Promise<string | null> }) {
  return (
    <Dialog open onOpenChange={(aberta) => !aberta && fechar()}>
      <DialogContent className="pt-4 pr-4 pb-[18px] pl-[18px]">
        <div className="mb-1.5 flex items-start justify-between gap-2">
          <div>
            <DialogTitle className="text-sm">{quem === null ? "Diga seu nome" : "Mudar seu nome"}</DialogTitle>
            <DialogDescription className="text-[13px]">Aparece no pé da lateral, para você saber quem está usando.</DialogDescription>
          </div>
          <DialogClose asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Fechar">
              <X aria-hidden />
            </Button>
          </DialogClose>
        </div>
        <FormularioDoNome inicial={quem?.nome ?? ""} botao="Salvar" secundario="Cancelar" doCrm={quem?.origem === "crm"} aoSecundario={fechar} aoSalvar={aoSalvar} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * Quem usa: lê a visão do servidor, abre as boas-vindas quando ele manda perguntar e a janela quando o
 * vendedor clica no cartão do pé. Relê no fim de cada sincronização e quando o CRM muda de fase,
 * porque o nome do CRM chega pela leitura de propostas.
 */
export function useQuemUsa(gatilho: string): { readonly cartao: QuemNoCartao; readonly janelas: ReactNode } {
  const carga = useCarga("quem-usa", () => api.quemUsa(), gatilho);
  const [janelaAberta, setJanelaAberta] = useState(false);
  const [respondeuAqui, setRespondeuAqui] = useState(false);
  const [aviso, setAviso] = useState<Aviso | null>(null);
  const visao: VisaoDeQuemUsa | null = carga.dados;

  async function dizer(corpo: Corpo): Promise<Resposta<VisaoDeQuemUsa>> {
    const resposta = await api.dizerNome(corpo);
    carga.recarregar();
    return resposta;
  }

  async function salvar(nome: string): Promise<string | null> {
    const resposta = await dizer({ nome });
    if (!resposta.ok) return resposta.erro.mensagem;
    setRespondeuAqui(true);
    setJanelaAberta(false);
    setAviso({ tom: "feito", texto: `Pronto, ${resposta.dados.quem?.nome ?? nome}. Seu nome fica só neste computador.`, detalhe: null });
    return null;
  }

  function agoraNao(): void {
    setRespondeuAqui(true);
    void dizer({ agoraNao: true });
    setAviso({ tom: "feito", texto: "Tudo bem. Quando quiser, clique em Diga seu nome no pé da lateral.", detalhe: null });
  }

  useEffect(() => {
    if (aviso === null) return;
    const relogio = setTimeout(() => setAviso(null), AVISO_SOME_MS);
    return () => clearTimeout(relogio);
  }, [aviso]);

  const perguntar = visao?.perguntar === true && !respondeuAqui && !janelaAberta;
  const janelas = (
    <>
      {perguntar && <BoasVindas aoSalvar={salvar} agoraNao={agoraNao} />}
      {janelaAberta && visao !== null && <JanelaDoNome quem={visao.quem} fechar={() => setJanelaAberta(false)} aoSalvar={salvar} />}
      <AvisoFlutuante aviso={aviso} fechar={() => setAviso(null)} />
    </>
  );
  return { cartao: visao === null ? null : { quem: visao.quem, abrir: () => setJanelaAberta(true) }, janelas };
}

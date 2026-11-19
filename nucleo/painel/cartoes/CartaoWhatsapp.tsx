import { LoaderCircle, MessageCircle } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useId, useState, type FormEvent } from "react";
import { ROTULOS_DAS_ACOES, type EntradaConectar, type EstadoWhatsapp } from "../../dominio";
import type { PedidoDeAcao } from "../api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { descrever, NOMES_DOS_CONECTORES, textoDoAnel } from "../descrever";
import { lerTelefoneDigitado } from "../formularios";
import { AcoesDoRodape, type PropsDoConector } from "./comum";
import { Cartao, Prazo } from "./Cartao";

const PASSOS_NO_CELULAR = "No celular, abra o WhatsApp e toque em Configurações, depois em Aparelhos conectados e em Conectar aparelho.";

const TAMANHO_DO_ANEL = 150;
const ESPESSURA_DO_ANEL = 10;
const RAIO_DO_ANEL = (TAMANHO_DO_ANEL - ESPESSURA_DO_ANEL) / 2;
const VOLTA_DO_ANEL = 2 * Math.PI * RAIO_DO_ANEL;
const ARCO_DO_ANEL = 0.28;

/** O wacli não diz o total: o arco gira sem medir nada, e o centro mostra a contagem real. Sem movimento, um arco parado pareceria progresso, então o anel fica inteiro. */
function AnelDaSincronizacao({ mensagens }: { mensagens: number }) {
  const texto = textoDoAnel(mensagens);
  const centro = TAMANHO_DO_ANEL / 2;
  return (
    <div role="status" aria-label={texto.rotuloAcessivel} className="relative grid place-items-center self-center">
      <svg aria-hidden width={TAMANHO_DO_ANEL} height={TAMANHO_DO_ANEL} viewBox={`0 0 ${TAMANHO_DO_ANEL} ${TAMANHO_DO_ANEL}`} className="motion-safe:animate-spin">
        <circle cx={centro} cy={centro} r={RAIO_DO_ANEL} fill="none" strokeWidth={ESPESSURA_DO_ANEL} className="stroke-muted" />
        <circle
          cx={centro}
          cy={centro}
          r={RAIO_DO_ANEL}
          fill="none"
          strokeWidth={ESPESSURA_DO_ANEL}
          strokeLinecap="round"
          strokeDasharray={VOLTA_DO_ANEL}
          strokeDashoffset={VOLTA_DO_ANEL * (1 - ARCO_DO_ANEL)}
          className="stroke-primary motion-reduce:[stroke-dashoffset:0]"
        />
      </svg>
      <div className="absolute text-center leading-tight">
        <p className="font-mono text-[26px] font-semibold tabular-nums">{texto.numero}</p>
        <p className="text-xs text-muted-foreground">{texto.unidade}</p>
      </div>
    </div>
  );
}

/** O lugar do QR antes de ele existir: o mesmo tamanho do quadro do pareamento, para o cartão não pular. */
function QuadroVazio() {
  return (
    <div className="grid aspect-square w-full max-w-56 place-items-center self-center rounded-xl border border-dashed border-input">
      <p className="px-6 text-center text-sm text-muted-foreground">Clique em Novo QR para gerar o QR.</p>
    </div>
  );
}

function Pareamento({ estado, agora }: { estado: Extract<EstadoWhatsapp, { fase: "pareando" }>; agora: Date }) {
  const { meio } = estado;
  switch (meio.tipo) {
    case "iniciando":
      return (
        <div className="grid aspect-square w-full max-w-56 place-items-center self-center rounded-xl bg-muted">
          <LoaderCircle aria-hidden className="size-6 animate-spin text-muted-foreground" />
        </div>
      );
    case "qr":
      return (
        <div className="flex flex-col gap-3">
          <div className="self-center rounded-xl bg-white p-3">
            <QRCodeSVG
              key={meio.qr}
              value={meio.qr}
              size={200}
              level="L"
              role="img"
              aria-label="QR para conectar o WhatsApp"
              className="block size-48 sm:size-52"
            />
          </div>
          <p className="text-sm leading-snug text-muted-foreground">{PASSOS_NO_CELULAR} Aponte a câmera para o QR.</p>
          <Prazo expiraEm={estado.expiraEm} agora={agora} rotulo="O QR se renova sozinho. Tempo para ler:" />
        </div>
      );
    case "codigo":
      return (
        <div className="flex flex-col gap-3">
          <p className="self-center rounded-xl bg-muted px-5 py-4 font-mono text-3xl font-semibold tracking-[0.2em] tabular-nums" aria-label={`Código ${meio.codigo.split("").join(" ")}`}>
            {meio.codigo}
          </p>
          <p className="text-sm leading-snug text-muted-foreground">
            {PASSOS_NO_CELULAR} Toque em Conectar com número de telefone e digite o código.
          </p>
          <Prazo expiraEm={estado.expiraEm} agora={agora} rotulo="Tempo para digitar:" />
        </div>
      );
  }
}

/**
 * Fora do pareamento os botões mandam `conectar`; no pareamento, `reparear` com a rodada na tela, que troca o QR
 * ou o código por outro.
 */
export function pedidoDeParear(estado: EstadoWhatsapp, entrada: EntradaConectar["whatsapp"]): PedidoDeAcao {
  return estado.fase === "pareando"
    ? { id: "whatsapp", acao: "reparear", corpo: { ...entrada, rodada: estado.expiraEm } }
    : { id: "whatsapp", acao: "conectar", corpo: entrada };
}

/** Conectar e reparear do WhatsApp: QR por padrão, ou código pelo número de telefone. */
function EscolhaDeConexao({ estado, livre, agir }: Pick<PropsDoConector<"whatsapp">, "estado" | "livre" | "agir">) {
  const [pedirNumero, setPedirNumero] = useState(false);
  const [erroDoNumero, setErroDoNumero] = useState<string | null>(null);
  const idDoCampo = useId();
  const pareando = estado.fase === "pareando" ? estado : null;

  const parear = (entrada: EntradaConectar["whatsapp"]) => agir(pedidoDeParear(estado, entrada));

  const enviarNumero = (evento: FormEvent<HTMLFormElement>) => {
    evento.preventDefault();
    const telefone = lerTelefoneDigitado(String(new FormData(evento.currentTarget).get("telefone") ?? ""));
    if (telefone === null) return setErroDoNumero("Digite o número com DDD, como (11) 98765-4321.");
    setErroDoNumero(null);
    parear({ meio: "codigo", telefone });
  };

  if (!pedirNumero && pareando?.meio.tipo === "codigo") {
    return (
      <Button variant="outline" disabled={!livre} onClick={() => parear({ meio: "qr" })}>
        Voltar ao QR
      </Button>
    );
  }

  if (!pedirNumero) {
    return (
      <>
        <Button variant="outline" disabled={!livre} onClick={() => setPedirNumero(true)}>
          Usar código
        </Button>
        <Button variant={pareando === null ? "default" : "outline"} disabled={!livre} onClick={() => parear({ meio: "qr" })}>
          {estado.fase === "atencao" ? ROTULOS_DAS_ACOES.conectar : ROTULOS_DAS_ACOES.reparear}
        </Button>
      </>
    );
  }

  return (
    <form onSubmit={enviarNumero} className="flex w-full flex-col gap-2" noValidate>
      <Label htmlFor={idDoCampo}>Número do WhatsApp de trabalho</Label>
      <Input
        id={idDoCampo}
        name="telefone"
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        placeholder="(00) 00000-0000"
        aria-invalid={erroDoNumero !== null}
        aria-describedby={erroDoNumero ? `${idDoCampo}-erro` : undefined}
        autoFocus
      />
      {erroDoNumero && (
        <p id={`${idDoCampo}-erro`} className="text-sm text-destructive">
          {erroDoNumero}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2 pt-1">
        <Button type="button" variant="outline" onClick={() => setPedirNumero(false)}>
          Voltar ao QR
        </Button>
        <Button type="submit" disabled={!livre}>
          Gerar código
        </Button>
      </div>
    </form>
  );
}

export function CartaoWhatsapp({ estado, acoes, agora, livre, erro, agir }: PropsDoConector<"whatsapp">) {
  const descricao = descrever("whatsapp", estado, agora);
  return (
    <Cartao
      nome={NOMES_DOS_CONECTORES.whatsapp}
      Icone={MessageCircle}
      descricao={descricao}
      erro={erro}
      rodape={
        <AcoesDoRodape
          id="whatsapp"
          acoes={acoes}
          livre={livre}
          agir={agir}
          conectar={<EscolhaDeConexao key={estado.fase === "pareando" ? estado.expiraEm : estado.fase} estado={estado} livre={livre} agir={agir} />}
        />
      }
    >
      {estado.fase === "desconectado" && <QuadroVazio />}
      {estado.fase === "pareando" && <Pareamento estado={estado} agora={agora} />}
      {estado.fase === "sincronizando" && (
        <>
          <AnelDaSincronizacao mensagens={estado.mensagens} />
          <p className="text-sm leading-snug text-muted-foreground">Pode levar alguns minutos. Você pode deixar esta tela aberta.</p>
          <Prazo expiraEm={estado.expiraEm} agora={agora} rotulo="Tempo máximo:" />
        </>
      )}
      {estado.fase === "confirmar_conta" && (
        <p className="text-sm leading-snug text-muted-foreground">
          A Secretária só começa a ler as conversas depois que você confirmar que este é o WhatsApp que você usa no trabalho.
        </p>
      )}
    </Cartao>
  );
}

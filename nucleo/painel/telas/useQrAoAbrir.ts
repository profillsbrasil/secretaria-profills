import { useEffect, useRef, useState } from "react";
import type { PedidoDeAcao } from "../api";
import type { Conexao } from "../conexao";
import { PEDIDO_DO_QR_AO_ABRIR, decidirQrAoAbrir, vistaParaODisparo, type DecisaoDoQr } from "../qr-ao-abrir";

function useAbaVisivel(): boolean {
  const [visivel, setVisivel] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const mudou = () => setVisivel(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", mudou);
    return () => document.removeEventListener("visibilitychange", mudou);
  }, []);
  return visivel;
}

/** Ao abrir Conexões com o WhatsApp desconectado, pede o QR uma vez. A regra está em `decidirQrAoAbrir`. */
export function useQrAoAbrir(conexao: Conexao, livre: boolean, agir: (pedido: PedidoDeAcao) => void): void {
  const decisao = useRef<DecisaoDoQr>("esperando");
  const visivel = useAbaVisivel();
  useEffect(() => {
    const passo = decidirQrAoAbrir(decisao.current, vistaParaODisparo(conexao, livre, visivel));
    decisao.current = passo.decisao;
    if (passo.pedir) agir(PEDIDO_DO_QR_AO_ABRIR);
  }, [conexao, livre, visivel, agir]);
}

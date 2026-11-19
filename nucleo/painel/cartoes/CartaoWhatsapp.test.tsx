import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { acoesPossiveis, instante, payloadQr, type EstadoWhatsapp, type Telefone } from "../../dominio";
import { CartaoWhatsapp } from "./CartaoWhatsapp";

const AGORA = new Date("2026-11-19T12:00:00Z");
const EM_3_MIN = instante(new Date("2026-11-19T12:03:00Z"));

function desenhar(estado: EstadoWhatsapp): string {
  return renderToStaticMarkup(<CartaoWhatsapp estado={estado} acoes={acoesPossiveis(estado)} agora={AGORA} livre erro={null} agir={() => {}} />);
}

/** Os botões do rodapé, da esquerda para a direita, com a variante de cada um. */
function rodape(html: string): string[] {
  const footer = /<footer[^>]*>([\s\S]*)<\/footer>/.exec(html)?.[1] ?? "";
  return [...footer.matchAll(/<button[^>]*data-variant="([^"]+)"[^>]*>([^<]+)<\/button>/g)].map((casamento) => `${casamento[2]} (${casamento[1]})`);
}

describe("cartão do WhatsApp", () => {
  test("desconectado: o quadro do QR vazio, Usar código em contorno e Novo QR cheio, por último", () => {
    const html = desenhar({ fase: "desconectado" });
    expect(html).toContain("Conecte o WhatsApp de trabalho lendo um QR com o celular.");
    expect(html).toContain("O QR aparece aqui.");
    expect(rodape(html)).toEqual(["Usar código no lugar do QR (outline)", "Novo QR (default)"]);
  });

  test("pareando com o QR: Cancelar, Usar código e Novo QR, todos em contorno", () => {
    const html = desenhar({ fase: "pareando", meio: { tipo: "qr", qr: payloadQr("2@qr-de-teste"), emitidoEm: instante(AGORA) }, expiraEm: EM_3_MIN });
    expect(html).toContain('aria-label="QR para conectar o WhatsApp"');
    expect(rodape(html)).toEqual(["Cancelar (outline)", "Usar código no lugar do QR (outline)", "Novo QR (outline)"]);
  });

  test("pareando enquanto o QR não chegou: os mesmos três botões", () => {
    const html = desenhar({ fase: "pareando", meio: { tipo: "iniciando" }, expiraEm: EM_3_MIN });
    expect(rodape(html)).toEqual(["Cancelar (outline)", "Usar código no lugar do QR (outline)", "Novo QR (outline)"]);
  });

  test("pareando com o código: Cancelar e Voltar ao QR", () => {
    const html = desenhar({ fase: "pareando", meio: { tipo: "codigo", codigo: "K7QD-2MXP", telefone: "+5511912345678" as Telefone }, expiraEm: EM_3_MIN });
    expect(rodape(html)).toEqual(["Cancelar (outline)", "Voltar ao QR (outline)"]);
  });

  test("sincronizando: o anel mostra a contagem real no padrão BR, sem porcentagem, e o prazo fica", () => {
    const html = desenhar({ fase: "sincronizando", mensagens: 1250, desde: instante(AGORA), expiraEm: instante(new Date("2026-11-19T12:30:00Z")) });
    expect(html).toContain('role="status" aria-label="1.250 mensagens copiadas"');
    expect(html).toContain(">1.250<");
    expect(html).toContain(">mensagens<");
    expect(html).toContain("Tempo máximo:");
    expect(html).not.toContain("%");
    expect(html).not.toContain("copiadas até agora");
  });
});

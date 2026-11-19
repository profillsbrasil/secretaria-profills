import { describe, expect, test } from "bun:test";
import { CONECTORES_UNICOS, FASES, PROBLEMAS, acoesPossiveis, instante, type EstadoPainel } from "../dominio";
import { controleDaAcao, descrever, progresso, textoDoAnel } from "./descrever";
import { NOMES_DAS_CENAS, montarCena } from "./dev/cenas";
import { hora, momento, restante } from "./tempo";

const agora = new Date("2026-11-11T12:00:00Z");
const cenas: readonly (readonly [string, EstadoPainel])[] = NOMES_DAS_CENAS.map((nome) => [nome, montarCena(nome, agora)!]);

describe("todas as cenas do painel", () => {
  test.each(cenas)("%s: cada cartão tem frase, ação e controle para cada ação", (_nome, estado) => {
    const cartoes = [
      ...CONECTORES_UNICOS.map((id) => ({ id, ...estado.conectores[id] })),
      ...estado.email.contas.map((conta) => ({ id: "email" as const, estado: conta.estado, acoes: conta.acoes })),
    ];
    for (const { id, estado: doConector, acoes } of cartoes) {
      const descricao = descrever(id, doConector as never, agora);
      expect(descricao.frase.length).toBeGreaterThan(10);
      expect(descricao.frase.endsWith(".")).toBe(true);
      expect(acoes.length).toBeGreaterThan(0);
      expect(acoes).toEqual([...acoesPossiveis(doConector)]);
      for (const acao of acoes) expect(controleDaAcao(id, acao)).toBeString();
      if (doConector.fase === "atencao") expect(descricao.proximoPasso).toBe(PROBLEMAS[doConector.problema.codigo].acao);
    }
  });

  test("cobrem cada fase de cada conector, cada meio de pareamento e cada problema", () => {
    const vistas = new Set<string>();
    for (const [, estado] of cenas) {
      const todos = [
        ...CONECTORES_UNICOS.map((id) => [id, estado.conectores[id].estado] as const),
        ...estado.email.contas.map((conta) => ["email", conta.estado] as const),
      ];
      for (const [id, doConector] of todos) {
        vistas.add(`${id}:${doConector.fase}`);
        if (doConector.fase === "pareando") vistas.add(`meio:${doConector.meio.tipo}`);
        if (doConector.fase === "atencao") vistas.add(`problema:${doConector.problema.codigo}`);
      }
      if (estado.email.pulado) vistas.add("email:pulado");
      if (estado.email.contas.length === 0 && !estado.email.pulado) vistas.add("email:sem_conta");
    }
    const esperadas = [
      ...(["whatsapp", "crm", "email"] as const).flatMap((id) => FASES[id].map((fase) => `${id}:${fase}`)),
      "email:pulado",
      "email:sem_conta",
      "meio:iniciando",
      "meio:qr",
      "meio:codigo",
      ...Object.keys(PROBLEMAS).map((codigo) => `problema:${codigo}`),
    ];
    expect([...vistas].sort()).toEqual(expect.arrayContaining(esperadas.sort()));
  });

  test("o progresso conta só WhatsApp e CRM: o e-mail é opcional", () => {
    expect(progresso(montarCena("tudo-desconectado", agora)!)).toEqual({ conectados: 0, total: 2 });
    expect(progresso(montarCena("dois-de-tres", agora)!)).toEqual({ conectados: 2, total: 2 });
    expect(progresso(montarCena("tudo-conectado", agora)!)).toEqual({ conectados: 2, total: 2 });
    expect(montarCena("dois-de-tres", agora)!.onboardingCompleto).toBe(true);
    expect(montarCena("tudo-conectado", agora)!.onboardingCompleto).toBe(true);
  });
});

describe("texto de cada estado", () => {
  const estado = (nome: string) => montarCena(nome, agora)!;

  test("confirmar conta mostra só o final do telefone", () => {
    const descricao = descrever("whatsapp", estado("whatsapp-confirmar-conta").conectores.whatsapp.estado, agora);
    expect(descricao.identidade).toBe("Telefone terminado em 4321");
  });

  test("sincronização deixa a contagem para o anel e mantém o prazo", () => {
    const descricao = descrever("whatsapp", estado("whatsapp-sincronizando").conectores.whatsapp.estado, agora);
    expect(descricao.detalhes).toEqual([]);
    expect(descricao.prazo).not.toBeNull();
  });

  test("CRM não liberado diz o problema e o que fazer", () => {
    const descricao = descrever("crm", estado("problema-crm_app_nao_liberado").conectores.crm.estado, agora);
    expect(descricao.tom).toBe("atencao");
    expect(descricao.frase).toBe("O CRM ainda não liberou a Secretária.");
    expect(descricao.proximoPasso).toContain("administrador do CRM");
  });

  test("e-mail conectado mostra a caixa de entrada; o endereço sai da conta", () => {
    const [conta] = estado("email-conectado").email.contas;
    const descricao = descrever("email", conta!.estado, agora);
    expect(conta?.config.endereco as string | undefined).toBe("vendedor@exemplo.com.br");
    expect(descricao.detalhes[0]).toBe("1.250 mensagens na caixa de entrada, 7 não lidas.");
  });

  test("os botões especiais saem da ação, não da fase", () => {
    expect(controleDaAcao("crm", "conectar")).toBe("link_do_crm");
    expect(controleDaAcao("email", "conectar")).toBe("formulario_do_email");
    expect(controleDaAcao("whatsapp", "conectar")).toBe("escolha_do_whatsapp");
    expect(controleDaAcao("crm", "cancelar")).toBe("botao");
  });
});

describe("tempo no fuso de Brasília", () => {
  test("hora no padrão 9h05", () => {
    expect(hora(instante(new Date("2026-11-11T12:05:00Z")))).toBe("9h05");
  });

  test("momento diz hoje ou a data", () => {
    expect(momento(instante(new Date("2026-11-11T13:30:00Z")), agora)).toBe("hoje às 10h30");
    expect(momento(instante(new Date("2026-10-16T13:30:00Z")), agora)).toBe("16 de outubro às 10h30");
  });

  test("restante conta para trás e some no fim do prazo", () => {
    expect(restante(instante(new Date(agora.getTime() + 151_000)), agora)).toBe("2 min 31 s");
    expect(restante(instante(new Date(agora.getTime() + 45_000)), agora)).toBe("45 s");
    expect(restante(instante(agora), agora)).toBeNull();
  });
});

describe("textoDoAnel", () => {
  test("a contagem real no padrão BR, no singular e no plural, sem porcentagem", () => {
    expect(textoDoAnel(0)).toEqual({ numero: "0", unidade: "mensagens", rotuloAcessivel: "0 mensagens copiadas" });
    expect(textoDoAnel(1)).toEqual({ numero: "1", unidade: "mensagem", rotuloAcessivel: "1 mensagem copiada" });
    expect(textoDoAnel(1250)).toEqual({ numero: "1.250", unidade: "mensagens", rotuloAcessivel: "1.250 mensagens copiadas" });
  });
});

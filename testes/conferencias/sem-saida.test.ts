import { describe, expect, test } from "bun:test";
import { Segredo } from "../../nucleo/cofre";
import {
  PRAZOS_MS,
  PROBLEMAS,
  PROVEDORES_DE_EMAIL,
  acoesPossiveis,
  payloadQr,
  somar,
  textoExterno,
  transicionarCrm,
  transicionarEmail,
  transicionarWhatsapp,
  type Acao,
  type CodigoProblema,
  type ConfigEmail,
  type EnderecoEmail,
  type EstadoConector,
  type IdConector,
  type Instante,
  type ProblemaDe,
  type Telefone,
  type Transicao,
  type EstadoWhatsapp,
  type EventoWhatsapp,
  type EfeitoWhatsapp,
  type EstadoCrm,
  type EventoCrm,
  type EfeitoCrm,
  type EstadoEmail,
  type EventoEmail,
  type EfeitoEmail,
} from "../../nucleo/dominio";

const AGORA = "2026-11-11T12:00:00.000Z" as Instante;
const FUTURO = "2026-11-12T12:00:00.000Z" as Instante;
const CONTA = { telefone: "+5511912345678" as Telefone };
const OUTRA = { telefone: "+5511987654321" as Telefone };
const CONFIG: ConfigEmail = {
  endereco: "vendedor@exemplo.com.br" as EnderecoEmail,
  servidor: "imap.exemplo.com.br",
  porta: 993,
  seguranca: "tls",
};
const SENHA = Segredo.de("senha-de-teste");
const DETALHE = textoExterno("detalhe");

/**
 * Uma máquina vista de fora: estados que o banco restaura, eventos que podem chegar,
 * o pedido de cada ação e o que um serviço externo que sempre dá certo responderia a cada efeito.
 */
interface Modelo<E extends EstadoConector, V, F> {
  readonly iniciais: readonly E[];
  readonly eventos: readonly V[];
  readonly prazo: V;
  readonly transicionar: (estado: E, evento: V, agora: Instante) => Transicao<E, F>;
  /** O pedido de cada ação, como o painel o monta ao ver o estado. */
  readonly pedido: (acao: Acao, estado: E) => V;
  readonly feliz: (efeito: F) => readonly V[];
}

function problemasDe<C extends IdConector>(conector: C): ProblemaDe<C>[] {
  return (Object.keys(PROBLEMAS) as CodigoProblema[]).filter(
    (codigo): codigo is ProblemaDe<C> => PROBLEMAS[codigo].conector === conector,
  );
}

function alcancaveis<E extends EstadoConector, V, F>(modelo: Modelo<E, V, F>): E[] {
  const vistos = new Map<string, E>();
  const fila = [...modelo.iniciais];
  while (fila.length > 0) {
    const estado = fila.shift() as E;
    const chave = JSON.stringify(estado);
    if (vistos.has(chave)) continue;
    vistos.set(chave, estado);
    if (vistos.size > 5_000) throw new Error("exploração não converge");
    for (const evento of modelo.eventos) fila.push(modelo.transicionar(estado, evento, AGORA).estado);
    fila.push(modelo.transicionar(estado, modelo.prazo, FUTURO).estado);
  }
  return [...vistos.values()];
}

/** Aplica a ação e tudo o que o serviço feliz responde, até a máquina parar de mudar. */
function agir<E extends EstadoConector, V, F>(modelo: Modelo<E, V, F>, estado: E, acao: Acao): E {
  const pendentes: V[] = [modelo.pedido(acao, estado)];
  let atual = estado;
  for (let passos = 0; pendentes.length > 0; passos++) {
    if (passos > 50) throw new Error("respostas em laço");
    const resultado = modelo.transicionar(atual, pendentes.shift() as V, AGORA);
    atual = resultado.estado;
    for (const efeito of resultado.efeitos) pendentes.push(...modelo.feliz(efeito));
  }
  return atual;
}

function conferir<E extends EstadoConector, V, F>(nome: string, modelo: Modelo<E, V, F>): void {
  const estados = alcancaveis(modelo);

  test(`${nome}: explora mais de um estado`, () => {
    expect(estados.length).toBeGreaterThan(modelo.iniciais.length);
  });

  test.each(estados.map((estado) => [JSON.stringify(estado), estado] as const))(
    `${nome}: %s tem ação e cada ação chega a conectado ou desconectado em até três passos`,
    (_chave, estado) => {
      const acoes = acoesPossiveis(estado);
      expect(acoes.length).toBeGreaterThan(0);
      for (const acao of acoes) {
        let atual = agir(modelo, estado, acao);
        for (let passo = 1; passo < 3 && atual.fase !== "conectado" && atual.fase !== "desconectado"; passo++) {
          atual = agir(modelo, atual, acoesPossiveis(atual)[0]);
        }
        expect({ acao, fase: atual.fase }).toEqual({ acao, fase: expect.stringMatching(/^(conectado|desconectado)$/) });
      }
    },
  );
}

describe("nenhum estado sem saída", () => {
  conferir<EstadoWhatsapp, EventoWhatsapp, EfeitoWhatsapp>("whatsapp", {
    iniciais: [
      { fase: "desconectado" },
      { fase: "conectado", conta: CONTA, verificadoEm: AGORA, espelho: "parado", ultimaAtividade: null },
      ...problemasDe("whatsapp").flatMap((codigo) =>
        [CONTA, null].map((conta) => ({ fase: "atencao" as const, problema: { codigo, desde: AGORA }, conta })),
      ),
    ],
    eventos: [
      { tipo: "pedido_conectar", entrada: { meio: "qr" } },
      { tipo: "pedido_conectar", entrada: { meio: "codigo", telefone: CONTA.telefone } },
      { tipo: "pedido_reparear", entrada: { meio: "qr" }, rodada: somar(AGORA, PRAZOS_MS.pareamento) },
      { tipo: "pedido_reparear", entrada: { meio: "codigo", telefone: CONTA.telefone }, rodada: somar(AGORA, PRAZOS_MS.pareamento) },
      { tipo: "pedido_cancelar" },
      { tipo: "pedido_testar" },
      { tipo: "pedido_desconectar" },
      { tipo: "pedido_confirmar" },
      { tipo: "pedido_recusar" },
      { tipo: "qr_emitido", qr: payloadQr("qr") },
      { tipo: "codigo_emitido", codigo: "ABCD", telefone: CONTA.telefone },
      { tipo: "ligou" },
      { tipo: "caiu" },
      { tipo: "progresso", mensagens: 5 },
      { tipo: "passkey_exigida", detalhe: DETALHE },
      { tipo: "sessao_revogada", detalhe: DETALHE },
      { tipo: "limite_do_banco", detalhe: DETALHE },
      { tipo: "processo_saiu", papel: "whatsapp.pareamento", codigo: 0 },
      { tipo: "processo_saiu", papel: "whatsapp.espelho", codigo: 1 },
      { tipo: "processo_desistiu", papel: "whatsapp.espelho" },
      { tipo: "sondagem", resultado: { binario: "ausente" } },
      { tipo: "sondagem", resultado: { binario: "ok", autenticado: false, revogada: true } },
      { tipo: "sondagem", resultado: { binario: "ok", autenticado: false, revogada: false } },
      { tipo: "sondagem", resultado: { binario: "ok", autenticado: true, conta: CONTA } },
      { tipo: "sondagem", resultado: { binario: "ok", autenticado: true, conta: OUTRA } },
    ],
    prazo: { tipo: "prazo_vencido" },
    transicionar: transicionarWhatsapp,
    pedido: (acao, estado) => {
      if (acao === "conectar") return { tipo: "pedido_conectar", entrada: { meio: "qr" } };
      if (acao === "reparear") return { tipo: "pedido_reparear", entrada: { meio: "qr" }, rodada: estado.fase === "pareando" ? estado.expiraEm : AGORA };
      return { tipo: `pedido_${acao}` };
    },
    feliz: (efeito) => {
      if (efeito.tipo === "iniciar_pareamento") {
        return [
          { tipo: "qr_emitido", qr: payloadQr("qr") },
          { tipo: "ligou" },
          { tipo: "processo_saiu", papel: "whatsapp.pareamento", codigo: 0 },
        ];
      }
      if (efeito.tipo === "sondar") return [{ tipo: "sondagem", resultado: { binario: "ok", autenticado: true, conta: CONTA } }];
      return [];
    },
  });

  conferir<EstadoCrm, EventoCrm, EfeitoCrm>("crm", {
    iniciais: [
      { fase: "desconectado" },
      { fase: "conectado", conexaoExpiraEm: FUTURO, verificadoEm: AGORA, ferramentas: null },
      ...problemasDe("crm").map((codigo) => ({ fase: "atencao" as const, problema: { codigo, desde: AGORA } })),
    ],
    eventos: [
      { tipo: "pedido_conectar" },
      { tipo: "pedido_cancelar" },
      { tipo: "pedido_testar" },
      { tipo: "pedido_desconectar" },
      { tipo: "retorno_ok", conexaoExpiraEm: FUTURO, ferramentas: 18 },
      { tipo: "autorizacao_recusada", motivo: "app_nao_liberado", detalhe: DETALHE },
      { tipo: "autorizacao_recusada", motivo: "acesso_negado", detalhe: DETALHE },
      { tipo: "autorizacao_recusada", motivo: "retorno_invalido", detalhe: DETALHE },
      { tipo: "autorizacao_recusada", motivo: "inacessivel", detalhe: DETALHE },
      { tipo: "sondagem", resultado: { token: "ausente" } },
      { tipo: "sondagem", resultado: { token: "recusado" } },
      { tipo: "sondagem", resultado: { token: "ok", ferramentas: 18, conexaoExpiraEm: FUTURO } },
      { tipo: "sondagem", resultado: { token: "indeterminado", detalhe: DETALHE } },
    ],
    prazo: { tipo: "prazo_vencido" },
    transicionar: transicionarCrm,
    pedido: (acao) => (acao === "conectar" ? { tipo: "pedido_conectar" } : { tipo: `pedido_${acao}` }),
    feliz: (efeito) => {
      if (efeito.tipo === "iniciar_autorizacao") return [{ tipo: "retorno_ok", conexaoExpiraEm: FUTURO, ferramentas: 18 }];
      if (efeito.tipo === "sondar") return [{ tipo: "sondagem", resultado: { token: "ok", ferramentas: 18, conexaoExpiraEm: FUTURO } }];
      return [];
    },
  });

  for (const provedor of PROVEDORES_DE_EMAIL) conferir<EstadoEmail, EventoEmail, EfeitoEmail>(`email (${provedor})`, {
    iniciais: [
      { fase: "desconectado" },
      { fase: "conectado", verificadoEm: AGORA, caixaDeEntrada: null },
      ...problemasDe("email").map((codigo) => ({ fase: "atencao" as const, problema: { codigo, desde: AGORA } })),
    ],
    eventos: [
      { tipo: "pedido_conectar", entrada: { config: CONFIG, senha: SENHA } },
      { tipo: "pedido_cancelar" },
      { tipo: "pedido_testar" },
      { tipo: "pedido_desconectar" },
      { tipo: "teste_ok", mensagens: 3, naoLidas: 1, senha: SENHA },
      { tipo: "teste_falhou", motivo: "senha_recusada", detalhe: DETALHE },
      { tipo: "teste_falhou", motivo: "senha_de_app_exigida", detalhe: DETALHE },
      { tipo: "teste_falhou", motivo: "servidor_inacessivel", detalhe: DETALHE },
      { tipo: "teste_falhou", motivo: "certificado_invalido", detalhe: DETALHE },
      { tipo: "sondagem", resultado: { senha: "ausente" } },
      { tipo: "sondagem", resultado: { senha: "presente", resultado: { ok: true, mensagens: 3, naoLidas: 1 } } },
      { tipo: "sondagem", resultado: { senha: "presente", resultado: { ok: false, motivo: "senha_recusada", detalhe: DETALHE } } },
      {
        tipo: "sondagem",
        resultado: { senha: "presente", resultado: { ok: false, motivo: "certificado_invalido", detalhe: DETALHE } },
      },
    ],
    prazo: { tipo: "prazo_vencido" },
    transicionar: (estado, evento, agora) => transicionarEmail(estado, evento, agora, provedor),
    pedido: (acao) =>
      acao === "conectar" ? { tipo: "pedido_conectar", entrada: { config: CONFIG, senha: SENHA } } : { tipo: `pedido_${acao}` },
    feliz: (efeito) => {
      if (efeito.tipo === "testar") return [{ tipo: "teste_ok", mensagens: 3, naoLidas: 1, senha: efeito.senha }];
      if (efeito.tipo === "sondar") {
        return [{ tipo: "sondagem", resultado: { senha: "presente", resultado: { ok: true, mensagens: 3, naoLidas: 1 } } }];
      }
      return [];
    },
  });
});

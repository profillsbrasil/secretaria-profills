import type { Ambiente } from "../ambiente";
import { lidoEmDasContas, type BancoAberto } from "../banco";
import type { Cofre, Segredo } from "../cofre";
import {
  decidirSincronizacaoAutomatica,
  falha,
  lerIdContaEmail,
  motivoDoPulo,
  ok,
  type Acao,
  type Dia,
  type ContaEmailComEstado,
  type CorpoLido,
  type DecisaoAutomatica,
  type ErroOperacao,
  type GatilhoAutomatico,
  type Instante,
  type EstadoCrm,
  type EstadoDoEmail,
  type EstadoPorConector,
  type FichaDoCliente,
  type IdConectorUnico,
  type LeituraDeAtendimentos,
  type LeituraDeConversas,
  type LeiturasDoCrm,
  type IdContaEmail,
  type LeituraDeWhatsapp,
  type Conversa,
  type Mensagem,
  type ParDeIdentidade,
  type Resultado,
  type RetratoDosConectores,
} from "../dominio";
import type { DesfechoDaGravacao, Escrita } from "../escritas";
import { criarSupervisor, type Supervisor } from "../processos";
import { registro as registroPadrao, type Registro } from "../registro";
import { lerAtendimentos } from "./atendimentos";
import { criarCascaCrm } from "./crm/casca";
import type { Dependencias } from "./dependencias";
import { criarContasDeEmail } from "./email/contas";
import { criarSincronizador, esperaPedidaNaRodada, type AndamentoDaSincronizacao, type OpcoesDaSincronizacao, type Sincronizacao } from "./sincronizacao";
import { temporizadorPadrao, type Temporizador } from "./motor";
import { criarCascaWhatsapp, type OpcoesDasConversas } from "./whatsapp/casca";

export { CAMINHO_DE_RETORNO } from "./crm/oauth";
export { FERRAMENTAS_DE_LEITURA, type ArgumentosDe, type FerramentaDeLeitura, type LeitorDoCrm, type RespostaDe } from "./crm/leitura";
export { sincronizacaoParaOLeitor } from "./sincronizacao";
export type {
  AndamentoDaSincronizacao,
  MotivoDaContaPulada,
  MotivoDoPulo,
  OpcoesDaSincronizacao,
  ResultadoDaContaDeEmail,
  ResultadoDaFonte,
  Sincronizacao,
} from "./sincronizacao";
export { LEITURAS_PERMITIDAS } from "./whatsapp/wacli";
export { LIMITE_DAS_LEITURAS, type OpcoesDasConversas } from "./whatsapp/casca";
export type { Temporizador } from "./motor";

export interface RespostaDaAcao<C extends IdConectorUnico = IdConectorUnico> {
  readonly estado: EstadoPorConector[C];
  /** Só o `conectar` do CRM preenche: o navegador do vendedor abre esta URL. */
  readonly urlAutorizacao: string | null;
}

/** O que o CRM disse do `cliente_id` de uma tarefa nova. `nao_conferido` é CRM fora: a tarefa nasce sem a marca. */
export type ConferenciaDoCliente =
  | { readonly tipo: "conferido"; readonly ficha: FichaDoCliente }
  | { readonly tipo: "nao_encontrado" }
  | { readonly tipo: "nao_conferido"; readonly motivo: string };

/** As contas de e-mail. Toda conta é achada pelo `id`; conta que não existe responde `nao_encontrado`. */
export interface FachadaDoEmail {
  /** `{rotulo, provedor, endereco, servidor?, porta?, seguranca?, janelaDias?, senha}`. Cria a conta e começa o teste. */
  adicionar(dados: unknown): Promise<Resultado<ContaEmailComEstado>>;
  /** Ação da máquina da conta. O `conectar` leva `{senha, servidor?, porta?, seguranca?}`. */
  agir(id: string, acao: Acao, dados?: unknown): Promise<Resultado<ContaEmailComEstado>>;
  mudar(id: string, dados: unknown): Promise<Resultado<ContaEmailComEstado>>;
  remover(id: string): Promise<Resultado<{ readonly removida: IdContaEmail }>>;
  pular(pulado: boolean): Promise<Resultado<EstadoDoEmail>>;
  /**
   * O corpo de uma mensagem, lido agora pelo IMAP, só leitura. `local` é o caminho da pasta, o
   * `UIDVALIDITY` e o uid de um cabeçalho guardado. O texto passa por quem chama e não é guardado em lugar nenhum.
   */
  lerCorpo(id: string, local: { readonly caminho: string; readonly uidValidity: string; readonly uid: number }, sinal?: AbortSignal): Promise<Resultado<CorpoLido>>;
}

/** Quanto o relatório espera o CRM, as páginas todas somadas. */
const PRAZO_DOS_ATENDIMENTOS_MS = 60_000;

function erroDe(codigo: "crm_fora_do_ar" | "interno"): ErroOperacao {
  const falhou = falha(codigo);
  return falhou.ok ? falhou.dados : falhou.erro;
}

export interface Conectores {
  /** Resolve quando a reconciliação de boot do WhatsApp, do CRM e de cada conta de e-mail terminou. As ações já valem antes disso. */
  readonly pronto: Promise<void>;
  estado(): RetratoDosConectores;
  /**
   * Executa uma ação de um cartão. `dados` é o corpo cru do pedido e só o `conectar` usa:
   * WhatsApp `{meio: "qr"}` ou `{meio: "codigo", telefone}`; CRM nada.
   * Repetir uma ação já atendida responde o estado atual, sem segundo processo nem segundo login.
   */
  agir<C extends IdConectorUnico>(id: C, acao: Acao, dados?: unknown): Promise<Resultado<RespostaDaAcao<C>>>;
  readonly email: FachadaDoEmail;
  /** Chama `ouvinte` com o retrato inteiro a cada mudança. Devolve o cancelamento. */
  assinar(ouvinte: (estados: RetratoDosConectores) => void): () => void;
  /** Entrada de `GET /oauth/crm/retorno`: a query inteira que o CRM mandou de volta. */
  retornoDoCrm(query: URLSearchParams): Promise<Resultado<EstadoCrm>>;
  /** Access token do CRM, renovado quando preciso, com uma renovação por vez. `null` sem conexão válida. */
  tokenValidoDoCrm(): Promise<Segredo | null>;
  /** Lê o CRM agora e guarda no cache. Uma rodada por vez: o pedido no meio de uma rodada recebe o resultado dela. */
  sincronizar(opcoes?: OpcoesDaSincronizacao): Promise<Sincronizacao>;
  /**
   * O vendedor abriu o painel. Depois da reconciliação de boot, sincroniza se `decidirSincronizacaoAutomatica`
   * mandar e devolve a decisão sem esperar a rodada. A rodada que o conector dispara ao conectar sai daqui de dentro, sem chamada.
   */
  sincronizarAoAbrirOPainel(): Promise<DecisaoAutomatica>;
  /** O que a última sincronização guardou. Não chama o CRM. */
  leiturasDoCrm(): LeiturasDoCrm;
  /** A última leitura das conversas do WhatsApp. Não chama o wacli nem o CRM. `null` sem leitura. */
  leituraDeConversas(): LeituraDeConversas | null;
  /** Chama `ouvinte` a cada passo de uma rodada. Devolve o cancelamento. */
  assinarSincronizacao(ouvinte: (andamento: AndamentoDaSincronizacao) => void): () => void;
  /** Confere no CRM o cliente de uma tarefa nova, pelo id numérico do CRM. Com o CRM fora de `conectado`, não chama. */
  conferirCliente(clienteId: number): Promise<ConferenciaDoCliente>;
  /**
   * Grava no CRM uma escrita que o vendedor aprovou no cartão. Só o fluxo de aprovar a chama. Fora de `conectado`, ou com os
   * conectores parando, responde `recusou` com `crm_nao_executou` sem abrir a rede. Nunca rejeita: o que escapar vira
   * `incerto`, porque a chamada pode ter chegado ao CRM. Quem chama não repete: tool que cria grava outro registro a cada chamada.
   */
  gravarNoCrm(escrita: Escrita): Promise<DesfechoDaGravacao>;
  /**
   * Os atendimentos do vendedor no CRM desde `desde`, lidos agora e sem guardar nada: uma leitura por status,
   * todas as páginas, até 20 por status (`cortado`). Fora de `conectado` devolve `sem_crm` sem abrir a rede.
   * A primeira leitura que falha encerra o pedido com `falhou`. O prazo é de 60 s. Nunca rejeita.
   */
  atendimentosDesde(desde: Dia): Promise<LeituraDeAtendimentos>;
  /**
   * Leitura do WhatsApp para o agente: só os comandos de `LEITURAS_PERMITIDAS`, sempre `--read-only --json`.
   * A resposta passa pelo schema do comando; o que o schema não lê é `whatsapp_resposta_inesperada`. Quem entrega isto ao
   * agente passa por `leituraParaOAgente`, que põe a mensagem suspeita em quarentena.
   */
  lerWhatsapp(args: readonly string[]): Promise<Resultado<LeituraDeWhatsapp>>;
  /** As conversas do espelho do wacli, da mais recente para a mais antiga. `naoLidas` filtra; `limite` vai de 1 a 200 (padrão 50). */
  listarConversas(opcoes?: OpcoesDasConversas): Promise<Resultado<readonly Conversa[]>>;
  /** As últimas `limite` mensagens de uma conversa (padrão 20, até 200), da mais nova para a mais antiga. `conversa` é o JID. */
  ultimasMensagens(conversa: string, limite?: number): Promise<Resultado<readonly Mensagem[]>>;
  /** Telefone e `@lid` de cada entrada (telefone `+55...`, número só com dígitos ou JID), de 1 a 50, no mesmo número e ordem. */
  resolverIdentidades(entradas: readonly string[]): Promise<Resultado<readonly ParDeIdentidade[]>>;
  /** Uma mensagem pelo JID da conversa e pelo id. `nao_encontrado` quando o wacli não a tem. O texto vem sem limpeza: só o painel o lê. */
  lerMensagem(conversa: string, id: string): Promise<Resultado<Mensagem>>;
  /** Para processos, prazos e pedidos de rede. Depois dele nenhum processo filho está vivo. */
  parar(): Promise<void>;
}

export interface OpcoesDosConectores {
  readonly registro?: Registro;
  /** Supervisor com outra política de reinício. Os conectores o encerram em `parar()`. */
  readonly supervisor?: Supervisor;
  readonly armar?: Temporizador;
  /** Só o teste troca: o teto de e-mails por pasta e por rodada, e o prazo da rodada de sincronização. */
  readonly limites?: { readonly tetoDeEmailPorPasta?: number; readonly prazoDaRodadaMs?: number };
  /** Prazo de `atendimentosDesde`, em ms. O padrão é 60 s. */
  readonly prazoDosAtendimentosMs?: number;
  /**
   * Os dois gatilhos de `decidirSincronizacaoAutomatica`. Ligado por padrão. Desligado, conectar não sincroniza, e
   * `sincronizarAoAbrirOPainel` devolve a decisão sem rodar: o teste que conecta como preparação não ganha rodada.
   */
  readonly sincronizacaoAutomatica?: boolean;
}

/**
 * Fachada dos conectores: WhatsApp, CRM e as contas de e-mail. Lê o estado durável do banco, começa a reconciliar cada um contra
 * a fonte de verdade (wacli, cofre e CRM, e cofre e IMAP de cada conta de e-mail) e passa a aceitar ações.
 * O redirect do OAuth usa `ambiente.porta`: quem sobe o servidor em porta 0 entrega aqui a porta real.
 */
export function criarConectores(ambiente: Ambiente, banco: BancoAberto, cofre: Cofre, opcoes: OpcoesDosConectores = {}): Conectores {
  const registro = opcoes.registro ?? registroPadrao;
  const supervisor = opcoes.supervisor ?? criarSupervisor({ plataforma: ambiente.plataforma, registro });
  const deps: Dependencias = {
    ambiente,
    banco,
    cofre,
    supervisor,
    registro,
    armar: opcoes.armar ?? temporizadorPadrao,
    ...(opcoes.limites?.tetoDeEmailPorPasta === undefined ? {} : { tetoDeEmailPorPasta: opcoes.limites.tetoDeEmailPorPasta }),
  };
  const ouvintes = new Set<(estados: RetratoDosConectores) => void>();
  let parando: Promise<void> | null = null;

  function avisar(): void {
    const retrato = estado();
    for (const ouvinte of ouvintes) {
      try {
        ouvinte(retrato);
      } catch {
        registro.erro("conectores.ouvinte_falhou", {});
      }
    }
  }

  const whatsapp = criarCascaWhatsapp(deps, avisar);
  const crm = criarCascaCrm(deps, avisar);
  const email = criarContasDeEmail(deps, avisar);
  const ouvintesDaSincronizacao = new Set<(andamento: AndamentoDaSincronizacao) => void>();
  const sincronizador = criarSincronizador({
    banco,
    registro,
    whatsapp: {
      estado: () => whatsapp.motor.estado(),
      listarConversas: (opcoes) => seguro("whatsapp.conversas", () => whatsapp.conversas(opcoes)),
      ultimasMensagens: (conversa, limite, sinal) => seguro("whatsapp.ultimas_mensagens", () => whatsapp.ultimasMensagens(conversa, limite, sinal)),
      resolverIdentidades: (entradas) => seguro("whatsapp.identidades", () => whatsapp.identidades(entradas)),
    },
    email: {
      estado: () => email.estado(),
      coletar: (id, agora, sinal) => seguro("email.coletar", () => email.coletar(id, agora, sinal)),
    },
    agora: ambiente.agora,
    ...(opcoes.limites?.prazoDaRodadaMs === undefined ? {} : { prazoDaRodadaMs: opcoes.limites.prazoDaRodadaMs }),
    estadoDoCrm: () => crm.motor.estado(),
    leitor: (sinal) => crm.leitor(sinal),
    aoAndar(andamento) {
      for (const ouvinte of ouvintesDaSincronizacao) {
        try {
          ouvinte(andamento);
        } catch {
          registro.erro("conectores.ouvinte_falhou", {});
        }
      }
    },
  });
  const motores = () => [whatsapp.motor, crm.motor, ...email.motores()];
  const pronto = Promise.all([whatsapp.reconciliar(), crm.reconciliar(), email.reconciliar()]).then(() => {});

  function estado(): RetratoDosConectores {
    return { whatsapp: whatsapp.motor.estado(), crm: crm.motor.estado(), email: email.estado() };
  }

  /** Só em memória: depois de um reinício, a primeira abertura do painel decide pelo `lido_em` das fontes. */
  let ultimaRodada: { readonly iniciadaEm: Instante; readonly esperarAte: Instante | null } | null = null;

  function sincronizar(opcoes?: OpcoesDaSincronizacao): Promise<Sincronizacao> {
    const rodada = sincronizador.sincronizar(opcoes);
    void rodada.then(
      (feita) => {
        ultimaRodada = { iniciadaEm: feita.iniciadaEm, esperarAte: esperaPedidaNaRodada(feita) };
      },
      () => {},
    );
    return rodada;
  }

  function decidir(gatilho: GatilhoAutomatico): DecisaoAutomatica {
    return decidirSincronizacaoAutomatica({ gatilho, agora: ambiente.agora(), ultimaRodadaEm: ultimaRodada?.iniciadaEm ?? null, esperarAte: ultimaRodada?.esperarAte ?? null });
  }

  function disparar(decisao: DecisaoAutomatica): void {
    if (!decisao.dispara || !automatica || parando !== null) return;
    registro.info("sincronizacao.automatica", decisao.motivo === "conectou" ? { motivo: decisao.motivo, conector: decisao.conector } : { motivo: decisao.motivo, fonte: decisao.fonte });
    const rodada = sincronizar();
    // A rodada em voo começou antes desta conexão e pode ter pulado a fonte dela: roda mais uma, depois dela.
    const feita = decisao.motivo === "conectou" ? rodada.then((lida) => (lida.jaEmAndamento ? sincronizar() : lida)) : rodada;
    void feita.catch((erro: unknown) => registro.erro("sincronizacao.automatica_falhou", { erro: erro instanceof Error ? erro.name : typeof erro }));
  }

  const automatica = opcoes.sincronizacaoAutomatica ?? true;
  let retratoAnterior = estado();
  ouvintes.add((depois) => {
    const decisao = decidir({ tipo: "conectores_mudaram", antes: retratoAnterior, depois });
    retratoAnterior = depois;
    // A senha da conta de e-mail e o espelho do WhatsApp entram nos efeitos, depois da fase: a rodada espera os efeitos assentarem.
    if (decisao.dispara) void Promise.all(motores().map((motor) => motor.assentar())).then(() => disparar(decisao));
  });

  const comUrl = <E>(resultado: Resultado<E>) => (resultado.ok ? ok({ estado: resultado.dados, urlAutorizacao: null }) : resultado);
  const acoes: { readonly [C in IdConectorUnico]: (acao: Acao, dados: unknown) => Promise<Resultado<RespostaDaAcao<C>>> } = {
    whatsapp: async (acao, dados) => comUrl(await whatsapp.agir(acao, dados)),
    crm: (acao) => crm.agir(acao),
  };
  const parado = () => falha("servidor_fora_do_ar", "Os conectores desta Secretária já foram parados.");

  /** Nenhum método da fachada rejeita: o que escapar vira `interno`, com o nome do erro no registro. */
  async function seguro<T>(operacao: string, tarefa: () => Promise<Resultado<T>>): Promise<Resultado<T>> {
    if (parando !== null) return parado();
    try {
      return await tarefa();
    } catch (erro) {
      registro.erro("conectores.operacao_falhou", { operacao, erro: erro instanceof Error ? erro.name : typeof erro });
      return falha("interno");
    }
  }

  return {
    pronto,
    estado,
    agir: (id, acao, dados) => seguro(`${id}.${acao}`, () => acoes[id](acao, dados)),
    email: {
      adicionar: (dados) => seguro("email.adicionar", () => email.adicionar(dados)),
      agir: (id, acao, dados) => seguro(`email.${acao}`, () => email.agir(id, acao, dados)),
      mudar: (id, dados) => seguro("email.mudar", () => email.mudar(id, dados)),
      remover: (id) => seguro("email.remover", () => email.remover(id)),
      pular: (pulado) => seguro("email.pular", async () => email.pular(pulado)),
      lerCorpo: (id, local, sinal) => {
        const conta = lerIdContaEmail(id);
        return seguro("email.ler_corpo", async () => (conta === null ? falha("nao_encontrado", "Esta conta de e-mail não existe.") : email.lerCorpo(conta, local, sinal)));
      },
    },
    assinar(ouvinte) {
      ouvintes.add(ouvinte);
      return () => ouvintes.delete(ouvinte);
    },
    retornoDoCrm: (query) => seguro("crm.retorno", () => crm.retorno(query)),
    async tokenValidoDoCrm() {
      const token = await seguro("crm.token", async () => ok(await crm.tokenValido()));
      return token.ok ? token.dados : null;
    },
    sincronizar,
    async sincronizarAoAbrirOPainel() {
      await pronto;
      const { agenda, propostas, carteira } = sincronizador.leituras();
      const decisao = decidir({
        tipo: "painel_aberto",
        conectores: estado(),
        lidoEm: {
          agenda: agenda?.lidoEm ?? null,
          propostas: propostas?.lidoEm ?? null,
          carteira: carteira?.lidoEm ?? null,
          conversas: sincronizador.conversas()?.lidoEm ?? null,
          email: lidoEmDasContas(banco),
        },
      });
      disparar(decisao);
      return decisao;
    },
    leiturasDoCrm: () => sincronizador.leituras(),
    leituraDeConversas: () => sincronizador.conversas(),
    assinarSincronizacao(ouvinte) {
      ouvintesDaSincronizacao.add(ouvinte);
      return () => ouvintesDaSincronizacao.delete(ouvinte);
    },
    async conferirCliente(clienteId) {
      if (parando !== null || crm.motor.estado().fase !== "conectado") return { tipo: "nao_conferido", motivo: "crm_desconectado" };
      try {
        const lido = await crm.leitor().ler("ver_cliente", { cliente_id: clienteId });
        if (lido.ok) return { tipo: "conferido", ficha: lido.dados };
        return lido.erro.codigo === "crm_nao_encontrado" ? { tipo: "nao_encontrado" } : { tipo: "nao_conferido", motivo: lido.erro.codigo };
      } catch (erro) {
        registro.erro("conectores.operacao_falhou", { operacao: "crm.conferir_cliente", erro: erro instanceof Error ? erro.name : typeof erro });
        return { tipo: "nao_conferido", motivo: "interno" };
      }
    },
    async gravarNoCrm(escrita) {
      if (parando !== null || crm.motor.estado().fase !== "conectado") return { tipo: "recusou", erro: { codigo: "crm_nao_executou", detalhe: null } };
      try {
        return await crm.escritor().gravar(escrita);
      } catch (erro) {
        registro.erro("conectores.operacao_falhou", { operacao: "crm.gravar", erro: erro instanceof Error ? erro.name : typeof erro });
        return { tipo: "incerto", erro: { codigo: "crm_escrita_incerta", detalhe: null } };
      }
    },
    async atendimentosDesde(desde) {
      const pulo = motivoDoPulo(crm.motor.estado());
      if (parando !== null || pulo !== null) return { tipo: "sem_crm", motivo: pulo ?? "crm_desconectado" };
      const prazo = AbortSignal.timeout(opcoes.prazoDosAtendimentosMs ?? PRAZO_DOS_ATENDIMENTOS_MS);
      const estourou = new Promise<"prazo">((resolver) => prazo.addEventListener("abort", () => resolver("prazo"), { once: true }));
      try {
        const lido = await Promise.race([lerAtendimentos(crm.leitor(prazo), desde), estourou]);
        if (lido === "prazo") return { tipo: "falhou", erro: erroDe("crm_fora_do_ar") };
        return "erro" in lido ? { tipo: "falhou", erro: lido.erro } : { tipo: "lido", itens: lido.itens, cortado: lido.cortado, foraPorCadastroIncompleto: lido.foraPorCadastroIncompleto };
      } catch (erro) {
        registro.erro("conectores.operacao_falhou", { operacao: "crm.atendimentos", erro: erro instanceof Error ? erro.name : typeof erro });
        return { tipo: "falhou", erro: erroDe("interno") };
      }
    },
    lerWhatsapp: (args) => seguro("whatsapp.ler", () => whatsapp.ler(args)),
    listarConversas: (opcoes = {}) => seguro("whatsapp.conversas", () => whatsapp.conversas(opcoes)),
    ultimasMensagens: (conversa, limite = 20) =>
      seguro("whatsapp.ultimas_mensagens", async () => {
        const lidas = await whatsapp.ultimasMensagens(conversa, limite);
        return lidas.ok ? ok(lidas.dados.mensagens) : lidas;
      }),
    resolverIdentidades: (entradas) => seguro("whatsapp.identidades", () => whatsapp.identidades(entradas)),
    lerMensagem: (conversa, id) => seguro("whatsapp.mensagem", () => whatsapp.mensagem(conversa, id)),
    parar() {
      parando ??= (async () => {
        for (const motor of motores()) motor.encerrar();
        crm.parar();
        email.parar();
        await sincronizador.parar();
        ouvintesDaSincronizacao.clear();
        await supervisor.encerrar();
        await Promise.all(motores().map((motor) => motor.assentar()));
        ouvintes.clear();
      })();
      return parando;
    },
  };
}

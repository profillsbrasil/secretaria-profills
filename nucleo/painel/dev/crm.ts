import type { AndamentoDaSincronizacao, ResultadoDaFonte, Sincronizacao } from "../../conectores";
import type { ItemDoCrm } from "../../tarefas";
import {
  ERROS,
  FONTES_DA_SINCRONIZACAO,
  FONTES_DO_CRM,
  SEM_LEITURAS,
  diaEm,
  instante,
  somarAoDia,
  textoExterno,
  voltaEm,
  type ClienteDaCarteira,
  type Compromisso,
  type Dia,
  type EstadoCrm,
  type Ignorados,
  type Instante,
  type LeiturasDoCrm,
  type MarcaDeIgnorado,
  type PropostaEnviada,
  type TipoDeIgnorado,
} from "../../dominio";

/**
 * O CRM de mentira do servidor de desenvolvimento: o que a sincronização teria lido, por fixture
 * (`&crm=<nome>` na URL do painel), e as marcas de "Ignorar por 7 dias" em memória. No `cheio`, um
 * cliente fora da carteira já vem ignorado pelo agente, com o motivo, como depois de apagar o cache;
 * no `ignorados`, uma proposta e um cliente. A proposta 0093/26 não tem link no CRM.
 * `&sinc=lento` faz a rodada levar 9 s; `&sinc=parcial` faz as propostas falharem e a carteira ser pulada.
 */
export const FIXTURES_DO_CRM = ["sem-leitura", "cheio", "ignorados", "vazio", "vencido", "cortado"] as const;
export type FixtureDoCrm = (typeof FIXTURES_DO_CRM)[number];

const LINK = "https://crm.exemplo.com.br";

function brasilia(dia: Dia, hora: string): Instante {
  return instante(new Date(`${dia}T${hora}:00-03:00`));
}

function proposta(id: number, cliente: string, enviadaHaDias: number, hoje: Dia, valor: string | null = "18450.00", comLink = true): PropostaEnviada {
  const enviada = somarAoDia(hoje, -enviadaHaDias);
  return {
    id,
    codigo: textoExterno(`${String(id).padStart(4, "0")}/26`),
    versao: 1,
    cliente: { id: 9000 + id, nome: textoExterno(cliente) },
    valor_total: valor,
    moeda: valor === null ? null : "BRL",
    enviada_em: enviada,
    prazo_retorno: somarAoDia(enviada, 30),
    link: comLink ? `${LINK}/propostas/${id}` : null,
  };
}

function cliente(id: number, nome: string, fantasia: string | null, cidade: string, ultimo: Instante | null, aproximado = false): ClienteDaCarteira {
  return {
    id,
    nome: textoExterno(nome),
    nome_fantasia: fantasia === null ? null : textoExterno(fantasia),
    cidade: textoExterno(cidade),
    uf: textoExterno("PR"),
    ultimo_atendimento_em: ultimo,
    ultimo_atendimento_aproximado: aproximado,
  };
}

function compromissos(hoje: Dia): Compromisso[] {
  return [
    { id: 501, titulo: textoExterno("Reunião com a Metalúrgica Sabiá"), inicio: brasilia(hoje, "14:00"), fim: brasilia(hoje, "15:00"), tipo: textoExterno("client"), cliente: { id: 9101, nome: textoExterno("Metalúrgica Sabiá") } },
    { id: 502, titulo: textoExterno("Visita técnica no galpão novo da Construtora Canário, com medição completa"), inicio: brasilia(hoje, "16:30"), fim: null, tipo: textoExterno("client"), cliente: null },
  ];
}

function propostas(hoje: Dia): PropostaEnviada[] {
  return [
    proposta(72, "Construtora Canário", 31, hoje),
    proposta(81, "Metalúrgica Sabiá Indústria e Comércio de Peças Ltda", 28, hoje, "126900.50"),
    proposta(90, "Telhas Arara", 15, hoje),
    proposta(93, "Obras Bem-te-vi", 8, hoje, null, false),
    proposta(97, "Pisos Uirapuru", 2, hoje),
  ];
}

function carteira(agora: Instante): ClienteDaCarteira[] {
  const hoje = diaEm(agora);
  return [
    cliente(8001, "Vidros Jaçanã", "Jaçanã Vidros", "Curitiba", null),
    cliente(8002, "Pisos Uirapuru", null, "Ponta Grossa", brasilia(somarAoDia(hoje, -45), "11:00")),
    cliente(8003, "Cerâmica Tucano", "Tucano", "Londrina", brasilia(somarAoDia(hoje, -400), "09:00"), true),
    cliente(8004, "Esquadrias Quero-quero", null, "Maringá", brasilia(somarAoDia(hoje, -38), "15:00")),
  ];
}

export function leiturasDaFixture(fixture: FixtureDoCrm, agora: Instante): LeiturasDoCrm {
  const hoje = diaEm(agora);
  const lidoEm = instante(new Date(Date.parse(agora) - 7 * 60_000));
  switch (fixture) {
    case "sem-leitura":
      return SEM_LEITURAS;
    case "vazio":
      return { agenda: { dia: hoje, lidoEm, foraPorCadastroIncompleto: 0, cortado: false, itens: [] }, propostas: { lidoEm, foraPorCadastroIncompleto: 0, cortado: false, itens: [] }, carteira: { lidoEm, foraPorCadastroIncompleto: 0, cortado: false, semAtendimentoHaDias: 30, itens: [] } };
    case "vencido":
      return {
        agenda: { dia: hoje, lidoEm, foraPorCadastroIncompleto: 0, cortado: false, itens: [] },
        propostas: { lidoEm, foraPorCadastroIncompleto: 0, cortado: false, itens: [proposta(72, "Construtora Canário", 34, hoje), proposta(81, "Metalúrgica Sabiá", 29, hoje)] },
        carteira: { lidoEm, foraPorCadastroIncompleto: 0, cortado: false, semAtendimentoHaDias: 30, itens: [] },
      };
    case "cheio":
    case "ignorados":
    case "cortado":
      return {
        agenda: { dia: hoje, lidoEm, foraPorCadastroIncompleto: 0, cortado: false, itens: compromissos(hoje) },
        propostas: { lidoEm, foraPorCadastroIncompleto: 0, cortado: fixture === "cortado", itens: propostas(hoje) },
        carteira: { lidoEm, foraPorCadastroIncompleto: 0, cortado: fixture === "cortado", semAtendimentoHaDias: 30, itens: carteira(agora) },
      };
  }
}

function itemDaLeitura(fixture: FixtureDoCrm, tipo: TipoDeIgnorado, id: number, agora: Instante): ItemDoCrm | null {
  const lidas = leiturasDaFixture(fixture === "sem-leitura" ? "cheio" : fixture, agora);
  if (tipo === "proposta") {
    const proposta = lidas.propostas?.itens.find((item) => item.id === id);
    return proposta === undefined ? null : { tipo, clienteId: proposta.cliente.id, nome: proposta.cliente.nome, codigo: proposta.codigo };
  }
  const cliente = lidas.carteira?.itens.find((item) => item.id === id);
  return cliente === undefined ? null : { tipo, clienteId: cliente.id, nome: cliente.nome, codigo: null };
}

/** O que muda na loja do CRM de mentira: as marcas, e as leituras que uma sincronização refaz. */
export interface CrmDeMentira {
  leituras(agora: Instante): LeiturasDoCrm;
  ignorados(hoje: Dia): Ignorados;
  ignorar(tipo: TipoDeIgnorado, id: number, agora: Instante): Dia;
  /** A proposta ou o cliente da leitura, como o botão Criar tarefa do Meu dia o usa. */
  item(tipo: TipoDeIgnorado, id: number, agora: Instante): ItemDoCrm | null;
  desfazer(tipo: TipoDeIgnorado, id: number): boolean;
  /** `lerConversas` é a quarta fonte: o servidor de desenvolvimento a lê das conversas de mentira. */
  sincronizar(crm: EstadoCrm, modo: string | null, avisar: (andamento: AndamentoDaSincronizacao) => void, lerConversas: () => ResultadoDaFonte): Promise<Sincronizacao>;
}

export function criarCrmDeMentira(fixture: FixtureDoCrm): CrmDeMentira {
  const marcas = new Map<string, MarcaDeIgnorado>();
  if (fixture === "cheio" || fixture === "ignorados") {
    const ate = voltaEm(instante(new Date()));
    const motivo = "Ele está de férias até o fim do mês.";
    marcas.set("cliente:8005", { tipo: "cliente", id: 8005, nome: textoExterno("Ferragens Sanhaço"), codigo: null, quem: "agente", motivo, ate });
  }
  if (fixture === "ignorados") {
    const ate = somarAoDia(diaEm(instante(new Date())), 3);
    const motivo = "O cliente pediu para esperar o orçamento da obra nova, que sai na semana que vem.";
    marcas.set("proposta:99", { tipo: "proposta", id: 99, nome: textoExterno("Madeireira Saíra"), codigo: textoExterno("0099/26"), quem: "agente", motivo, ate });
  }
  let sincronizado = fixture !== "sem-leitura";
  let rodada: Promise<Sincronizacao> | null = null;

  async function rodar(crm: EstadoCrm, modo: string | null, avisar: (andamento: AndamentoDaSincronizacao) => void, lerConversas: () => ResultadoDaFonte): Promise<Sincronizacao> {
    const id = crypto.randomUUID();
    const iniciadaEm = instante(new Date());
    avisar({ id, etapa: "comecou", fontes: FONTES_DA_SINCRONIZACAO });
    const espera = modo === "lento" ? 3000 : 400;
    const fontes: ResultadoDaFonte[] = [];
    for (const fonte of FONTES_DO_CRM) {
      let resultado: ResultadoDaFonte;
      if (crm.fase !== "conectado") {
        const motivo = crm.fase === "atencao" ? (crm.problema.codigo === "crm_app_nao_liberado" ? "crm_app_nao_liberado" : "crm_em_atencao") : crm.fase === "autorizando" ? "crm_autorizando" : "crm_desconectado";
        resultado = { fonte, situacao: "pulada", motivo };
      } else if (modo === "parcial" && fonte === "propostas") {
        avisar({ id, etapa: "fonte", fonte, situacao: "lendo" });
        await Bun.sleep(espera);
        resultado = { fonte, situacao: "falhou", erro: { codigo: "crm_limite_de_chamadas", mensagem: ERROS.crm_limite_de_chamadas.mensagem, acao: ERROS.crm_limite_de_chamadas.acao, esperaS: 60 } };
      } else if (modo === "parcial" && fonte === "carteira") {
        const erro = { codigo: "crm_limite_de_chamadas", mensagem: ERROS.crm_limite_de_chamadas.mensagem, acao: ERROS.crm_limite_de_chamadas.acao, esperaS: 60 } as const;
        resultado = { fonte, situacao: "pulada", motivo: "crm_limite_de_chamadas", erro };
      } else {
        avisar({ id, etapa: "fonte", fonte, situacao: "lendo" });
        await Bun.sleep(espera);
        const lidas = leiturasDaFixture(fixture === "sem-leitura" ? "cheio" : fixture, instante(new Date()));
        const itens = fonte === "agenda" ? lidas.agenda?.itens.length : fonte === "propostas" ? lidas.propostas?.itens.length : lidas.carteira?.itens.length;
        resultado = { fonte, situacao: "leu", itens: itens ?? 0, lidoEm: instante(new Date()), cortado: fixture === "cortado" && fonte !== "agenda" };
      }
      fontes.push(resultado);
      avisar({ id, etapa: "fonte", fonte, situacao: resultado.situacao });
    }
    if (crm.fase === "conectado" && modo !== "parcial") sincronizado = true;
    const conversas = lerConversas();
    if (conversas.situacao === "leu") {
      avisar({ id, etapa: "fonte", fonte: "conversas", situacao: "lendo" });
      await Bun.sleep(espera);
    }
    fontes.push(conversas);
    avisar({ id, etapa: "fonte", fonte: "conversas", situacao: conversas.situacao });
    avisar({ id, etapa: "terminou" });
    return { id, iniciadaEm, terminadaEm: instante(new Date()), fontes, jaEmAndamento: false };
  }

  return {
    leituras(agora) {
      if (!sincronizado) return SEM_LEITURAS;
      const lidas = leiturasDaFixture(fixture === "sem-leitura" ? "cheio" : fixture, agora);
      return lidas;
    },
    ignorados(hoje) {
      for (const [chave, marca] of marcas) if (marca.ate <= hoje) marcas.delete(chave);
      return [...marcas.values()];
    },
    item: (tipo, id, agora) => itemDaLeitura(fixture, tipo, id, agora),
    ignorar(tipo, id, agora) {
      const ate = voltaEm(agora);
      const item = itemDaLeitura(fixture, tipo, id, agora);
      marcas.set(`${tipo}:${id}`, { tipo, id, nome: textoExterno(item?.nome ?? ""), codigo: item?.codigo === undefined || item.codigo === null ? null : textoExterno(item.codigo), quem: "vendedor", motivo: null, ate });
      return ate;
    },
    desfazer: (tipo, id) => marcas.delete(`${tipo}:${id}`),
    sincronizar(crm, modo, avisar, lerConversas) {
      if (rodada !== null) return rodada.then((feita) => ({ ...feita, jaEmAndamento: true }));
      rodada = rodar(crm, modo, avisar, lerConversas).finally(() => {
        rodada = null;
      });
      return rodada;
    },
  };
}

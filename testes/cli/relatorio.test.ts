import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { COMANDOS } from "../../nucleo/cli/comandos";
import { AVISO_DO_RELATORIO, diaEm, type Relatorio } from "../../nucleo/dominio";
import { iniciarServidor, type RespostaDaTarefa, type ServidorRodando } from "../../nucleo/servidor";
import { prepararPasta, rodar } from "./rodar";

setDefaultTimeout(60_000);

describe("relatorio pelo CLI com o servidor no ar e sem CRM", () => {
  const pasta = prepararPasta();
  let servidor: ServidorRodando;
  const dir = () => pasta.bancada.dirDados;

  beforeAll(async () => {
    servidor = await iniciarServidor(pasta.ambiente());
    await servidor.pronto;
  });

  afterAll(async () => {
    await servidor.parar();
    await pasta.bancada.limpar();
  });

  async function concluirTarefa(): Promise<string> {
    const criada = await rodar(dir(), ["tarefa", "criar", "ligar", "--json"]);
    expect(criada.codigo).toBe(0);
    const { id } = (criada.envelope?.dados as RespostaDaTarefa).tarefa;
    const concluida = await rodar(dir(), ["tarefa", "concluir", id, "--versao", "1", "--json"]);
    expect(concluida.codigo).toBe(0);
    return id;
  }

  test("--json devolve o envelope com o formato do relatório, sem CRM e com a tarefa concluída", async () => {
    const id = await concluirTarefa();
    const saida = await rodar(dir(), ["relatorio", "--json"]);
    expect(saida.codigo).toBe(0);
    expect(saida.envelope?.ok).toBe(true);
    const dados = saida.envelope?.dados as Relatorio;
    expect(Object.keys(dados)).toEqual(["aviso", "periodo", "tarefas_concluidas", "atendimentos", "contagens"]);
    expect(dados.aviso).toBe(AVISO_DO_RELATORIO);
    expect(dados.periodo).toMatchObject({ padrao: true });
    expect(dados.atendimentos).toEqual({ motivo: "crm_desconectado", erro: null, cortado: false, fora_por_cadastro_incompleto: null, lido_em: null, dias: [] });
    expect(dados.contagens).toEqual({ atendimentos: null, por_status: null, clientes_atendidos: null, tarefas_concluidas: 1 });
    expect(dados.tarefas_concluidas.map((t) => [t.id, t.titulo])).toEqual([[id, "Ligar"]]);
  });

  test("sem --json e sem CRM sai com 0 e diz que só tem a parte local", async () => {
    const saida = await rodar(dir(), ["relatorio"]);
    expect(saida.codigo).toBe(0);
    expect(saida.stdout).toContain("Relatório de atividade, esta semana, de segunda a hoje");
    expect(saida.stdout).toContain("Atendimentos no CRM: não li, o CRM não está conectado.");
    expect(saida.stdout).toContain("só tem a parte local");
    expect(saida.stdout).toContain("Tarefas concluídas: 1.");
    expect(saida.stdout).toContain(`- ${diaEm(new Date())}: Ligar`);
  });

  test("--de e --ate vão ao servidor, e o período inválido volta como entrada_invalida", async () => {
    const certo = await rodar(dir(), ["relatorio", "--de", "2026-10-01", "--ate", "2026-10-31", "--json"]);
    expect(certo.codigo).toBe(0);
    expect((certo.envelope?.dados as Relatorio).periodo).toEqual({ de: "2026-10-01", ate: "2026-10-31", padrao: false } as never);
    const texto = await rodar(dir(), ["relatorio", "--de", "2026-10-01", "--ate", "2026-10-31"]);
    expect(texto.stdout).toContain("Relatório de atividade, de 2026-10-01 a 2026-10-31.");
    expect(texto.stdout).toContain("Tarefas concluídas: nenhuma no período.");

    const errado = await rodar(dir(), ["relatorio", "--de", "2026-10-31", "--ate", "2026-10-01", "--json"]);
    expect(errado.codigo).toBe(1);
    expect(errado.envelope?.erro?.codigo).toBe("entrada_invalida");
  });

  test("uma data só sai com 2 e a frase de uso", async () => {
    const saida = await rodar(dir(), ["relatorio", "--de", "2026-11-01", "--json"]);
    expect(saida.codigo).toBe(2);
    expect(saida.envelope?.erro?.codigo).toBe("uso_invalido");
    expect(saida.envelope?.erro?.mensagem).toContain("O relatório leva as duas datas, ou nenhuma: sem datas, é a semana, de segunda a hoje.");
  });
});

describe("o texto do relatório", () => {
  const relatorio = COMANDOS.find((comando) => comando.nome === "relatorio");
  const descrever = (dados: Relatorio): string => (relatorio?.descrever as (dados: Relatorio) => string)(dados);

  const base: Relatorio = {
    aviso: AVISO_DO_RELATORIO,
    periodo: { de: "2026-11-09", ate: "2026-11-13", padrao: true },
    atendimentos: {
      motivo: null,
      erro: null,
      cortado: false,
      fora_por_cadastro_incompleto: 0,
      lido_em: "2026-11-13T22:10:00.000Z",
      dias: [
        {
          dia: "2026-11-09",
          itens: [
            { id: 9101, cliente: { id: 8001, nome: "Cliente Canário 8001" }, cliente_em_quarentena: false, assunto: "Ligação com o comprador", assunto_em_quarentena: false, status: "Concluído" },
            { id: 9102, cliente: { id: 8002, nome: "Cliente Canário 8002" }, cliente_em_quarentena: false, assunto: null, assunto_em_quarentena: true, status: "Pendente" },
            { id: 9103, cliente: { id: 8003, nome: null }, cliente_em_quarentena: true, assunto: "Visita técnica", assunto_em_quarentena: false, status: "Pendente" },
          ],
        },
      ],
    },
    tarefas_concluidas: [{ id: "t1", titulo: "Ligar: Cliente Canário 8001", clienteNome: "Cliente Canário 8001", origem: "agente", concluidaEm: "2026-11-10T14:05:00.000Z", dia: "2026-11-10" }],
    contagens: { atendimentos: 3, por_status: { "Em Andamento": 0, Concluído: 1, Pendente: 2, Cancelado: 0 }, clientes_atendidos: 3, tarefas_concluidas: 1 },
  } as never;

  test("CRM lido: período, contagens, um dia por cabeçalho, um atendimento por linha e as tarefas", () => {
    expect(descrever(base)).toBe(
      [
        "Relatório de atividade, esta semana, de segunda a hoje (2026-11-09 a 2026-11-13).",
        "Atendimentos no CRM: 3 (Em Andamento 0, Concluído 1, Pendente 2, Cancelado 0), em 3 clientes.",
        "2026-11-09",
        "- Cliente Canário 8001: Ligação com o comprador (Concluído)",
        "- Cliente Canário 8002: assunto retido: o vendedor confere no CRM (Pendente)",
        "- cliente 8003 com o nome retido: o vendedor confere no CRM: Visita técnica (Pendente)",
        "Tarefas concluídas: 1.",
        "- 2026-11-10: Ligar: Cliente Canário 8001",
      ].join("\n"),
    );
  });

  test("cortado ganha a frase de que o CRM tinha mais; lido sem itens diz nenhum", () => {
    expect(descrever({ ...base, atendimentos: { ...base.atendimentos, cortado: true } })).toContain("Os mais antigos do período ficaram de fora. Peça um período que comece mais perto de hoje.");
    const vazio = descrever({ ...base, atendimentos: { ...base.atendimentos, dias: [] }, contagens: { ...base.contagens, atendimentos: 0, clientes_atendidos: 0 } });
    expect(vazio).toContain("Atendimentos no CRM: nenhum no período.");
  });

  test("atendimentos de fora por cadastro incompleto: a contagem e o que o vendedor faz", () => {
    expect(descrever({ ...base, atendimentos: { ...base.atendimentos, fora_por_cadastro_incompleto: 2 } })).toContain(
      "Atendimentos de fora das contagens: 2 itens do CRM ficaram de fora por cadastro incompleto. Corrija o cadastro no CRM.",
    );
    expect(descrever(base)).not.toContain("cadastro incompleto");
  });

  test("CRM falhou: a ação do erro e a espera, e a frase da parte local", () => {
    const texto = descrever({
      ...base,
      atendimentos: { motivo: "crm_falhou", erro: { codigo: "crm_limite_de_chamadas", mensagem: "m", acao: "Espere e chame de novo, uma vez só.", esperaS: 30 }, cortado: false, fora_por_cadastro_incompleto: null, lido_em: null, dias: [] },
      contagens: { ...base.contagens, atendimentos: null, por_status: null, clientes_atendidos: null },
    });
    expect(texto).toContain("Atendimentos no CRM: não li, Espere e chame de novo, uma vez só. Espere 30 s.");
    expect(texto).toContain("O relatório abaixo só tem a parte local");
    expect(texto).not.toContain("Cliente Canário 8002");
  });
});

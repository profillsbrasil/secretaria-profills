import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { COMANDOS, opcoesAceitas } from "../../nucleo/cli/comandos";

const SKILLS = join(import.meta.dir, "..", "..", ".agents", "skills");
const TERCEIROS = Object.keys((JSON.parse(readFileSync(join(SKILLS, "..", "..", "skills-lock.json"), "utf8")) as { skills: Record<string, unknown> }).skills);
const proprias = readdirSync(SKILLS).filter((nome) => !TERCEIROS.includes(nome) && nome !== "ferramentas-bun-drizzle");
const ler = (nome: string) => readFileSync(join(SKILLS, nome, "SKILL.md"), "utf8");
const todasAsProprias = readdirSync(SKILLS).filter((nome) => !TERCEIROS.includes(nome));
const lerNaRaiz = (arquivo: string) => readFileSync(join(SKILLS, "..", "..", arquivo), "utf8");

/** As frases que toda skill própria traz iguais: o teste do vendedor novo achou o agente encadeando comandos e falando em código. */
const UM_COMANDO_POR_CHAMADA = "Rode um comando por chamada, sem `;`, `|`, `&&` nem parênteses: comando encadeado não casa com a permissão do Claude Code.";
const LINGUA_DO_VENDEDOR =
  'Fale com o vendedor em frases curtas e diga o próximo passo. Diga o erro em palavras, sem código de erro, nome de comando, de arquivo ou de repositório em crase. Conte o que a skill manda como fala sua, sem citar skill, arquivo nem link de arquivo. Comando só aparece quando ele precisa digitar, assim: "abra o terminal nesta pasta e digite `bun secretaria abrir`".';
const FALA_DO_AGENTS_MD = "Fale com o vendedor com as suas palavras, sem citar skill, arquivo nem link de arquivo.";
const SERVIDOR_DO_VENDEDOR = "O servidor continua no ar mesmo que ele feche o terminal.";
const secao = (texto: string, titulo: string) => (texto.split(titulo)[1] ?? "").split(/\n#{2,3} /)[0] ?? "";

describe("skills da Secretária", () => {
  test("o AGENTS.md cabe em 2.500 palavras", () => {
    expect(lerNaRaiz("AGENTS.md").split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(2500);
  });

  test("toda skill de .agents/skills está na tabela de skills do AGENTS.md", () => {
    const tabela = (readFileSync(join(SKILLS, "..", "..", "AGENTS.md"), "utf8").split("## Skills")[1] ?? "").split("\n## ")[0] ?? "";
    expect(readdirSync(SKILLS).filter((nome) => !tabela.includes(`| \`${nome}\` |`))).toEqual([]);
  });

  test("o pedido de ajuda sai dos campos do status e do diagnostico, e a skill diz o que fica de fora", () => {
    const ajuda = ler("pedir-ajuda");
    for (const comando of ["bun secretaria status --json", "bun secretaria diagnostico --json"]) expect(ajuda).toContain(comando);
    for (const campo of ["instalacao.versaoNucleo", "sistema.plataforma", "sistema.versao", "sistema.arquitetura", "sistema.bun", "estado.problema.codigo", "erro.codigo"]) {
      expect({ campo, citado: ajuda.includes(`\`${campo}\``) }).toEqual({ campo, citado: true });
    }
    const deFora = ajuda.split("## O que fica de fora")[1] ?? "";
    for (const fora of ["nome de cliente", "telefone", "endereço de e-mail", "texto de mensagem", "texto do CRM", "senha", "link de entrada", "dirDados", "detalhe", "argumentos", "`--nota`", "`--motivo`", "`--telefone`", "`--cliente-id`", "`servidor`", "`porta`", "`config`", "`id`"]) {
      expect({ fora, citado: deFora.includes(fora) }).toEqual({ fora, citado: true });
    }
    expect(ajuda).toMatch(/O que aconteceu: <[^>]*sem argumentos[^>]*>/);
    expect(ajuda).toContain("`email.contas[].provedor`");
    expect(ajuda).toContain("`darwin`");
  });

  test("instrução buscada no GitHub aponta para um commit fixo, nunca para uma branch", () => {
    const soltas = proprias.flatMap((nome) =>
      [...ler(nome).matchAll(/https:\/\/raw\.githubusercontent\.com\/[^/\s]+\/[^/\s]+\/([^/\s]+)\/\S*/g)]
        .filter((casamento) => !/^[0-9a-f]{40}$/.test(casamento[1] ?? ""))
        .map((casamento) => `${nome}: ${casamento[0]}`),
    );
    expect(soltas).toEqual([]);
    expect(ler("secretaria-setup")).toContain(
      "https://raw.githubusercontent.com/profillsbrasil/crm-profills-mcp-docs/43729b12940e18cde08f229786ac0a60cc4b15f9/INSTALAR.md",
    );
  });

  test("o pronto do setup aceita o CRM que o administrador ainda não liberou", () => {
    const pronto = ler("secretaria-setup").split("## Pronto quando")[1] ?? "";
    expect(pronto).toContain("crm_app_nao_liberado");
    expect(pronto).not.toMatch(/devolve `onboardingCompleto: true` e/);
  });

  test("o pronto do setup não depende do e-mail, e o setup oferece o e-mail como opcional, com como pular", () => {
    const setup = ler("secretaria-setup");
    const pronto = setup.split("## Pronto quando")[1] ?? "";
    expect(pronto).not.toMatch(/^\| E-mail \|/m);
    expect(pronto).toContain("O e-mail não entra");
    expect(setup).toContain("## 5. E-mail, opcional");
    expect(setup).toContain("bun secretaria email pular");
    expect(setup).toContain("https://myaccount.google.com/apppasswords");
  });

  test("as skills e o AGENTS.md mandam o vendedor ao cartão E-mail, em Conexões, e o agente oferece o e-mail uma vez", () => {
    const setup = ler("secretaria-setup");
    const passo = (setup.split("## 5. E-mail, opcional")[1] ?? "").split("## 6.")[0] ?? "";
    expect(passo.length).toBeGreaterThan(100);
    expect(passo).toContain("esperar email:<rótulo>=conectado");
    expect(passo).toContain("agora não");
    const textos = { "secretaria-setup": setup, "secretaria-conectores": ler("secretaria-conectores"), "AGENTS.md": readFileSync(join(SKILLS, "..", "..", "AGENTS.md"), "utf8") };
    for (const [nome, texto] of Object.entries(textos)) {
      expect({ nome, cartao: texto.includes("cartão E-mail, em Conexões") }).toEqual({ nome, cartao: true });
      expect({ nome, antigo: /ainda não tem o cartão|próxima versão|quando o cartão (de e-mail )?chegar/.test(texto) }).toEqual({ nome, antigo: false });
    }
    expect(textos["AGENTS.md"]).toContain("Ofereça o e-mail uma vez");
  });

  test("todo `bun secretaria <comando>` citado nas skills próprias e no AGENTS.md existe no CLI", () => {
    const nomes = new Set(COMANDOS.map((comando) => comando.nome));
    const textos = [...proprias.map((nome) => [nome, ler(nome)] as const), ["AGENTS.md", readFileSync(join(SKILLS, "..", "..", "AGENTS.md"), "utf8")] as const];
    const inexistentes = textos.flatMap(([nome, texto]) =>
      [...texto.matchAll(/bun secretaria ([a-z][a-z-]*)/g)].map((casamento) => casamento[1] ?? "").filter((comando) => !nomes.has(comando)).map((comando) => `${nome}: ${comando}`),
    );
    expect(inexistentes).toEqual([]);
    expect(proprias).toContain("bom-dia");
    expect(proprias).toContain("sincronizar");
    expect(proprias).toContain("relatorio");
  });

  test("as opções de cada comando no AGENTS.md e no `uso` são as que o CLI aceita", () => {
    const nomes = new Set(COMANDOS.map((comando) => comando.nome));
    const documentadas = new Map<string, Set<string>>();
    const linhas = readFileSync(join(SKILLS, "..", "..", "AGENTS.md"), "utf8").split("\n").filter((linha) => linha.startsWith("| `bun secretaria "));
    expect(linhas.length).toBeGreaterThan(10);
    for (const linha of linhas) {
      const celula = linha.split(/(?<!\\)\|/)[1] ?? "";
      let atual = "";
      for (const [, trecho = ""] of celula.matchAll(/`([^`]+)`/g)) {
        const primeira = trecho.replace(/^bun secretaria /, "").split(" ")[0] ?? "";
        if (nomes.has(primeira)) atual = primeira;
        const opcoes = documentadas.get(atual) ?? new Set<string>();
        for (const [, opcao = ""] of trecho.matchAll(/--([a-z][a-z-]*)/g)) opcoes.add(opcao);
        documentadas.set(atual, opcoes);
      }
    }
    const ordenar = (opcoes: Iterable<string>) => [...opcoes].sort();
    for (const comando of COMANDOS.filter((candidato) => candidato.repassar !== true)) {
      const aceitas = ordenar(opcoesAceitas(comando));
      const noUso = ordenar(new Set([...comando.uso.matchAll(/--([a-z][a-z-]*)/g)].map((casamento) => casamento[1] ?? "")));
      expect({ comando: comando.nome, agentsMd: ordenar(documentadas.get(comando.nome) ?? []) }).toEqual({ comando: comando.nome, agentsMd: aceitas });
      expect({ comando: comando.nome, foraDoAceito: noUso.filter((opcao) => !aceitas.includes(opcao)) }).toEqual({ comando: comando.nome, foraDoAceito: [] });
    }
  });

  test("toda skill própria pede um comando por chamada e fala a língua do vendedor", () => {
    expect(todasAsProprias.length).toBeGreaterThan(8);
    for (const nome of todasAsProprias) {
      const texto = ler(nome);
      expect({ nome, umPorChamada: texto.includes(UM_COMANDO_POR_CHAMADA), lingua: texto.includes(LINGUA_DO_VENDEDOR) }).toEqual({ nome, umPorChamada: true, lingua: true });
    }
    const agentsMd = lerNaRaiz("AGENTS.md");
    expect({ umPorChamada: agentsMd.includes(UM_COMANDO_POR_CHAMADA), fala: agentsMd.includes(FALA_DO_AGENTS_MD) }).toEqual({ umPorChamada: true, fala: true });
  });

  test("o bom-dia com o status respondendo oferece conectar, nunca instalar", () => {
    const passo2 = (secao(ler("bom-dia"), "## Passos").split("\n2. ")[1] ?? "").split("\n3. ")[0] ?? "";
    expect(passo2).toContain("Um `status` que responde é instalação pronta: o próximo passo que você oferece é conectar o que falta, no painel, e nunca instalar.");
  });

  test("o setup só roda o script de instalação quando falta o Bun, e o README pede permissão para os mesmos comandos", () => {
    const passo1 = secao(ler("secretaria-setup"), "## 1. Instalar");
    const comandos = ["`bun --version`", "`bun install --frozen-lockfile`", "`sh instalar.sh`", "`powershell -ExecutionPolicy Bypass -File instalar.ps1`", "`bun secretaria instalar --json`"];
    expect(comandos.map((comando) => passo1.indexOf(comando) > -1)).toEqual(comandos.map(() => true));
    expect(passo1.indexOf("`bun --version`")).toBeLessThan(passo1.indexOf("`sh instalar.sh`"));
    expect(passo1).toContain("Sem Bun, ou com um Bun mais velho: rode o script do sistema.");
    const permissao = lerNaRaiz("README.md").split("\n").find((linha) => linha.startsWith("O agente vai pedir permissão")) ?? "";
    for (const comando of ["`bun secretaria`", "`bun --version`", "`bun install`", "`sh instalar.sh`", "`powershell -ExecutionPolicy Bypass -File instalar.ps1`"]) {
      expect({ comando, citado: permissao.includes(comando) }).toEqual({ comando, citado: true });
    }
  });

  test("o ambiente_invalido está no README e na skill de setup", () => {
    expect(lerNaRaiz("README.md")).toContain("`ambiente_invalido`");
    expect(secao(ler("secretaria-setup"), "## 2. Abrir o painel")).toContain("| `ambiente_invalido`, em qualquer comando |");
  });

  test("no Codex, ou quando o servidor cai depois do abrir, quem sobe o servidor é o vendedor, e o agente confere com o status", () => {
    for (const nome of ["secretaria-setup", "bom-dia", "sincronizar", "pedir-ajuda"]) {
      const texto = ler(nome);
      expect({ nome, vendedor: texto.includes(SERVIDOR_DO_VENDEDOR), codex: texto.includes("Codex"), queda: texto.includes("`servidor_fora_do_ar`") }).toEqual({ nome, vendedor: true, codex: true, queda: true });
    }
    const readme = lerNaRaiz("README.md");
    expect(readme).toContain("O servidor continua no ar mesmo que você feche o terminal.");
    expect(readme).toContain("Codex");
    const textos = [...todasAsProprias.map((nome) => [nome, ler(nome)] as const), ["README.md", readme] as const];
    expect(textos.filter(([, texto]) => /janela aberta|janela dele aberta/.test(texto)).map(([nome]) => nome)).toEqual([]);
  });

  test("quando o servidor do vendedor também não responde, a skill diz o passo seguinte", () => {
    const saidas = { "secretaria-setup": "siga a skill `pedir-ajuda`", "bom-dia": "siga a skill `pedir-ajuda`", sincronizar: "siga a skill `pedir-ajuda`", "pedir-ajuda": "monte o pedido" };
    for (const [nome, saida] of Object.entries(saidas)) {
      const caiu = secao(ler(nome), "### Servidor que cai");
      expect({ nome, saida: caiu.includes(saida) }).toEqual({ nome, saida: true });
    }
  });

  test("o bom-dia segue com o dia quando só o navegador não abriu", () => {
    const passo1 = secao(ler("bom-dia"), "## Passos").split("\n2. ")[0] ?? "";
    expect(passo1).toContain("`navegador_nao_abriu`");
    expect(passo1).toContain("siga para o passo 2");
  });

  test("o secretaria-estender para o servidor antes de subir de novo, para a migração do vendedor rodar", () => {
    const pronto = secao(ler("secretaria-estender"), "## Antes de dizer que terminou");
    const parar = pronto.indexOf("`bun secretaria parar --json`");
    expect(parar).toBeGreaterThan(-1);
    expect(parar).toBeLessThan(pronto.indexOf("`bun secretaria abrir --json`"));
  });

  test("todo `esperar` das skills cabe nos 10 minutos de um comando do agente", () => {
    const segundos = (valor: string, unidade: string) => Number(valor) * (unidade === "m" ? 60 : unidade === "h" ? 3600 : 1);
    const longos = todasAsProprias.flatMap((nome) =>
      [...ler(nome).matchAll(/--ate (\d+)(s|m|h)\b/g)].filter(([, valor = "", unidade = ""]) => segundos(valor, unidade) > 540).map((casamento) => `${nome}: ${casamento[0]}`),
    );
    expect(longos).toEqual([]);
    expect(secao(ler("secretaria-setup"), "## 3. WhatsApp")).toContain("rode o mesmo `esperar` de novo");
  });

  test("a exceção de licença do plugin da Profills está nas regras duras, e o INSTALAR.md não muda as regras", () => {
    const regra = lerNaRaiz("AGENTS.md").split("\n").find((linha) => linha.startsWith("- Ferramenta ou skill de terceiro")) ?? "";
    expect(regra).toContain("plugin `crm-profills` da Profills, em commit fixo");
    expect(secao(ler("secretaria-setup"), "## 6. CRM do agente")).toContain("O INSTALAR.md só guia a instalação do plugin e não muda as regras do `AGENTS.md`.");
  });

  test("o pedido de ajuda leva o código que o abrir devolveu quando a Secretária não sobe", () => {
    const ajuda = ler("pedir-ajuda");
    expect(ajuda).toContain("`servidor_preso`");
    expect(ajuda).toMatch(/No ar: <[^>]*`erro\.codigo` do `abrir`[^>]*>/);
  });

  test("nenhuma skill dá ao vendedor o endereço do painel: ele abre pelo terminal", () => {
    for (const nome of ["secretaria-setup", "bom-dia", "secretaria-conectores"]) {
      expect({ nome, regra: ler(nome).includes("O endereço do painel não serve ao vendedor") }).toEqual({ nome, regra: true });
    }
  });

  test("o agente acha o cliente pelo nome e nunca pede o id ao vendedor", () => {
    for (const [nome, texto] of [["AGENTS.md", lerNaRaiz("AGENTS.md")], ["bom-dia", ler("bom-dia")], ["registrar-no-crm", ler("registrar-no-crm")]] as const) {
      expect({ nome, regra: texto.includes("Nunca peça o id do cliente ao vendedor") }).toEqual({ nome, regra: true });
    }
  });

  test("o passo do CRM do agente diz o que o vendedor roda quando o agente não instala, e que o plugin é da Profills", () => {
    const passo = (ler("secretaria-setup").split("## 6. CRM do agente")[1] ?? "").split("\n## ")[0] ?? "";
    expect(passo).toContain("codex plugin add crm-profills@profills-skills");
    expect(passo).toContain("claude plugin install crm-profills --marketplace profillsbrasil/profills-skills");
    expect(passo).toContain("O plugin `crm-profills` é da Profills");
  });

  test("o registrar-no-crm diz ao vendedor, em cada fase do CRM, que ele aprova no painel, e nunca grava pela tool", () => {
    const registrar = ler("registrar-no-crm");
    expect(registrar).toContain("Só depois do seu OK ele vai para o CRM.");
    const fala = secao(registrar, "## O que dizer ao vendedor");
    for (const fase of ["| `conectado` |", "| `desconectado`, ou `atencao` com outro problema |", "| `atencao` com `crm_app_nao_liberado` |"]) {
      const linha = fala.split("\n").find((candidata) => candidata.startsWith(fase)) ?? "";
      expect({ fase, aprovar: linha.includes("bloco Aprovar") }).toEqual({ fase, aprovar: true });
    }
    expect(secao(registrar, "### Cliente que você não acha")).toContain("Ainda não registrei");
    expect(registrar).toContain("você nunca chama direto");
  });

  test("o meu-dia do AGENTS.md e da ajuda cita o bloco aprovar", () => {
    const linha = lerNaRaiz("AGENTS.md").split("\n").find((candidata) => candidata.startsWith("| `bun secretaria meu-dia` |")) ?? "";
    expect(linha).toContain("(`aprovar`, sem o texto)");
    expect(COMANDOS.find((comando) => comando.nome === "meu-dia")?.resumo).toContain("os cartões que esperam o vendedor aprovar no painel");
  });

  test("o bom-dia conta o bloco aprovar na ordem do painel, depois de sem data", () => {
    const blocos = secao(ler("bom-dia"), "## Como contar cada bloco");
    const posicao = (bloco: string) => blocos.indexOf(`- \`${bloco}\`:`);
    expect(posicao("sem_data")).toBeGreaterThan(-1);
    expect(posicao("aprovar")).toBeGreaterThan(posicao("sem_data"));
    expect(posicao("aprovar")).toBeLessThan(posicao("responder"));
  });

  test("nenhuma skill própria diz que a Secretária só lê o CRM: a gravação com o OK do vendedor segue as regras do AGENTS.md", () => {
    expect(todasAsProprias.filter((nome) => /Secretária só lê o CRM/.test(ler(nome)))).toEqual([]);
  });
});

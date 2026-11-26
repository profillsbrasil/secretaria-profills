import { sql, type SQL } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import {
  CANAIS_DE_VINCULO,
  CONECTORES,
  ESTADOS_DE_VINCULO,
  FASES_DURAVEIS,
  JANELAS_DE_EMAIL,
  JANELA_PADRAO,
  MOTIVOS_NO_BANCO,
  PASTAS_DE_EMAIL,
  PROVEDORES_DE_EMAIL,
  QUEM_IGNORA,
  TAMANHO_DO_MOTIVO,
  TAMANHO_MAXIMO_DO_ROTULO,
  TIPOS_DE_IGNORADO,
} from "../dominio";
import { ACOES_DA_DECISAO, ESTADOS_DA_ESCRITA, TOOLS_DE_ESCRITA } from "../escritas";
import { AUTORES, ESTADOS_DA_TAREFA, LIMITES } from "../tarefas";

function lista(valores: readonly string[]): SQL {
  return sql.raw(valores.map((valor) => `'${valor}'`).join(", "));
}

/** Uma linha só. É a identidade desta base: uma base por vendedor. */
export const instalacao = sqliteTable(
  "instalacao",
  {
    id: integer("id").primaryKey(),
    idInstalacao: text("id_instalacao").notNull(),
    criadaEm: text("criada_em").notNull(),
    /** `NULL` até o instalador sondar o chaveiro do sistema. */
    cofreBackend: text("cofre_backend", { enum: ["sistema", "arquivo"] }),
    /** Quando o vendedor escolheu pular o e-mail. `NULL` é "não pulou". */
    emailPuladoEm: text("email_pulado_em"),
    /** O nome que o vendedor digitou no painel para o cartão do pé. Vence o do CRM. Nunca vai ao CRM. */
    nomeDoVendedor: text("nome_do_vendedor"),
    /** Quando o vendedor respondeu à pergunta do nome (Começar ou Agora não). `NULL` é "ainda não perguntou". */
    nomePerguntadoEm: text("nome_perguntado_em"),
  },
  (t) => [
    check("instalacao_unica", sql`${t.id} = 1`),
    check("instalacao_cofre_backend", sql`${t.cofreBackend} IS NULL OR ${t.cofreBackend} IN ('sistema', 'arquivo')`),
  ],
);

/**
 * Uma linha por conector único (WhatsApp e CRM). A linha `email` da conta única antiga foi para
 * `email_conta` na migração 0005; os CHECKs que a citam ficaram da fundação. Só fase durável cabe aqui, então um restart nunca encontra
 * conector preso no meio de um pareamento, de uma autorização ou de um teste.
 * Nenhuma coluna guarda segredo, QR ou token.
 */
export const conector = sqliteTable(
  "conector",
  {
    id: text("id", { enum: CONECTORES }).primaryKey(),
    fase: text("fase", { enum: FASES_DURAVEIS }).notNull().default("desconectado"),
    /** Telefone do WhatsApp ou endereço do e-mail. O retorno do OAuth do CRM não traz identidade. */
    identidade: text("identidade"),
    /** JSON sem segredo. Só a conta única antiga de e-mail usava. */
    config: text("config"),
    codigoProblema: text("codigo_problema"),
    conexaoExpiraEm: text("conexao_expira_em"),
    verificadoEm: text("verificado_em"),
    atualizadoEm: text("atualizado_em").notNull(),
    /** Só o CRM: o `responsavel` das propostas do vendedor, já sem sinal de injeção. Zera ao desconectar. */
    nomeNoCrm: text("nome_no_crm"),
    /** Só o CRM: quando a sincronização leu as propostas, achando o nome ou não. Zera ao desconectar. */
    nomeNoCrmLidoEm: text("nome_no_crm_lido_em"),
  },
  (t) => [
    check("conector_id", sql`${t.id} IN (${lista(CONECTORES)})`),
    check("conector_fase", sql`${t.fase} IN (${lista(FASES_DURAVEIS)})`),
    check("conector_config_json", sql`${t.config} IS NULL OR json_valid(${t.config})`),
    check("conector_problema_so_em_atencao", sql`(${t.fase} = 'atencao') = (${t.codigoProblema} IS NOT NULL)`),
    check("conector_conectado_verificado", sql`${t.fase} <> 'conectado' OR ${t.verificadoEm} IS NOT NULL`),
    check(
      "conector_conectado_com_identidade",
      sql`${t.fase} <> 'conectado' OR ${t.id} = 'crm' OR ${t.identidade} IS NOT NULL`,
    ),
    check("conector_email_com_config", sql`${t.id} <> 'email' OR ${t.fase} <> 'conectado' OR ${t.config} IS NOT NULL`),
    check(
      "conector_crm_com_prazo",
      sql`${t.id} <> 'crm' OR ${t.fase} <> 'conectado' OR ${t.conexaoExpiraEm} IS NOT NULL`,
    ),
  ],
);

/** Trilha do que aconteceu com cada conector. Só anexa; o banco mantém as 500 mais novas por conector. */
export const eventoConector = sqliteTable(
  "evento_conector",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    conector: text("conector", { enum: CONECTORES })
      .notNull()
      .references(() => conector.id),
    tipo: text("tipo").notNull(),
    /** JSON plano: só string, número, booleano e null. */
    detalhe: text("detalhe").notNull().default("{}"),
    em: text("em").notNull(),
  },
  (t) => [
    index("evento_conector_por_conector").on(t.conector, t.id),
    check("evento_conector_detalhe_json", sql`json_valid(${t.detalhe})`),
  ],
);

/**
 * Uma conta de e-mail por linha. Rótulo e endereço não se repetem, sem diferença de maiúscula.
 * A configuração gravada é a do último login que passou, ou a digitada ao adicionar. A senha mora
 * no cofre, na chave `email.conta.<id>.senha`. Só fase durável cabe aqui.
 */
export const emailConta = sqliteTable(
  "email_conta",
  {
    id: text("id").primaryKey(),
    rotulo: text("rotulo").notNull(),
    provedor: text("provedor", { enum: PROVEDORES_DE_EMAIL }).notNull(),
    endereco: text("endereco").notNull(),
    servidor: text("servidor").notNull(),
    porta: integer("porta").notNull(),
    seguranca: text("seguranca", { enum: ["tls", "starttls"] }).notNull(),
    janelaDias: integer("janela_dias").notNull().default(JANELA_PADRAO),
    fase: text("fase", { enum: FASES_DURAVEIS }).notNull().default("desconectado"),
    codigoProblema: text("codigo_problema"),
    verificadoEm: text("verificado_em"),
    /** 1 na conta que veio da conta única antiga enquanto a senha dela não passou para a chave da conta. */
    senhaLegada: integer("senha_legada").notNull().default(0),
    criadaEm: text("criada_em").notNull(),
    atualizadoEm: text("atualizado_em").notNull(),
  },
  (t) => [
    uniqueIndex("email_conta_rotulo_unico").on(sql`${t.rotulo} COLLATE NOCASE`),
    uniqueIndex("email_conta_endereco_unico").on(sql`${t.endereco} COLLATE NOCASE`),
    check("email_conta_rotulo", sql`length(trim(${t.rotulo})) BETWEEN 1 AND ${sql.raw(String(TAMANHO_MAXIMO_DO_ROTULO))}`),
    check("email_conta_provedor", sql`${t.provedor} IN (${lista(PROVEDORES_DE_EMAIL)})`),
    check("email_conta_porta", sql`${t.porta} BETWEEN 1 AND 65535`),
    check("email_conta_seguranca", sql`${t.seguranca} IN ('tls', 'starttls')`),
    check("email_conta_janela", sql`${t.janelaDias} IN (${sql.raw(JANELAS_DE_EMAIL.join(", "))})`),
    check("email_conta_fase", sql`${t.fase} IN (${lista(FASES_DURAVEIS)})`),
    check("email_conta_problema_so_em_atencao", sql`(${t.fase} = 'atencao') = (${t.codigoProblema} IS NOT NULL)`),
    check("email_conta_conectado_verificado", sql`${t.fase} <> 'conectado' OR ${t.verificadoEm} IS NOT NULL`),
    check("email_conta_senha_legada", sql`${t.senhaLegada} IN (0, 1)`),
  ],
);

/** Trilha de cada conta de e-mail. Só anexa; some com a conta, e o banco mantém as 500 mais novas por conta. */
export const eventoEmail = sqliteTable(
  "evento_email",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    contaId: text("conta_id")
      .notNull()
      .references(() => emailConta.id, { onDelete: "cascade" }),
    tipo: text("tipo").notNull(),
    /** JSON plano: só string, número, booleano e null. */
    detalhe: text("detalhe").notNull().default("{}"),
    em: text("em").notNull(),
  },
  (t) => [index("evento_email_por_conta").on(t.contaId, t.id), check("evento_email_detalhe_json", sql`json_valid(${t.detalhe})`)],
);

/**
 * Só o cabeçalho de cada e-mail das contas conectadas, dentro da janela da conta. Não há coluna de
 * corpo, de trecho nem de anexo: o corpo se lê sob demanda e nunca se guarda. Assunto e nome ficam
 * `NULL` quando o texto acende sinal de injeção, e os sinais ficam nas colunas `sinais_*`.
 * As chaves são compostas e entram no `CREATE TABLE`: a migração só cria tabela.
 */
export const emailCabecalho = sqliteTable(
  "email_cabecalho",
  {
    contaId: text("conta_id")
      .notNull()
      .references(() => emailConta.id, { onDelete: "cascade" }),
    pasta: text("pasta", { enum: PASTAS_DE_EMAIL }).notNull(),
    uid: integer("uid").notNull(),
    messageId: text("message_id"),
    conversa: text("conversa").notNull(),
    /** Em minúsculas. */
    remetente: text("remetente").notNull(),
    remetenteNome: text("remetente_nome"),
    /** JSON, lista de endereços em minúsculas. */
    destinatarios: text("destinatarios").notNull(),
    instante: text("instante").notNull(),
    assunto: text("assunto"),
    daConta: integer("da_conta").notNull(),
    automatico: integer("automatico").notNull(),
    /** JSON, lista de sinais de injeção. */
    sinaisDoAssunto: text("sinais_do_assunto").notNull(),
    sinaisDoNome: text("sinais_do_nome").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.contaId, t.pasta, t.uid] }),
    check("email_cabecalho_pasta", sql`${t.pasta} IN (${lista(PASTAS_DE_EMAIL)})`),
    check("email_cabecalho_uid", sql`${t.uid} >= 1`),
    check("email_cabecalho_da_conta", sql`${t.daConta} IN (0, 1)`),
    check("email_cabecalho_automatico", sql`${t.automatico} IN (0, 1)`),
    check("email_cabecalho_destinatarios_json", sql`json_valid(${t.destinatarios})`),
    check("email_cabecalho_sinais_do_assunto_json", sql`json_valid(${t.sinaisDoAssunto})`),
    check("email_cabecalho_sinais_do_nome_json", sql`json_valid(${t.sinaisDoNome})`),
    check("email_cabecalho_remetente_minusculo", sql`${t.remetente} = lower(${t.remetente})`),
  ],
);

/**
 * Onde a coleta parou em cada pasta de cada conta. `caminho` é o da pasta no servidor, que a leitura
 * do corpo usa. `ultimo_uid` é o maior uid já guardado. `lido_em` é quando a pasta foi lida inteira
 * pela última vez, `NULL` enquanto a coleta só chegou ao teto de uma rodada.
 */
export const emailCursor = sqliteTable(
  "email_cursor",
  {
    contaId: text("conta_id")
      .notNull()
      .references(() => emailConta.id, { onDelete: "cascade" }),
    pasta: text("pasta", { enum: PASTAS_DE_EMAIL }).notNull(),
    caminho: text("caminho").notNull(),
    uidValidity: text("uid_validity").notNull(),
    ultimoUid: integer("ultimo_uid").notNull(),
    lidoEm: text("lido_em"),
  },
  (t) => [
    primaryKey({ columns: [t.contaId, t.pasta] }),
    check("email_cursor_pasta", sql`${t.pasta} IN (${lista(PASTAS_DE_EMAIL)})`),
    check("email_cursor_ultimo_uid", sql`${t.ultimoUid} >= 0`),
  ],
);

/**
 * Tarefa local do vendedor. `vence_em` nulo é "sem data". `versao` sobe a cada mudança da linha,
 * e quem edita com versão velha recebe conflito. Concluída e descartada só voltam por reabrir.
 */
export const tarefa = sqliteTable(
  "tarefa",
  {
    id: text("id").primaryKey(),
    titulo: text("titulo").notNull(),
    clienteId: text("cliente_id"),
    clienteNome: text("cliente_nome"),
    /** O servidor achou o cliente no CRM pelo `cliente_id` e o nome é o do CRM. */
    clienteConferido: integer("cliente_conferido", { mode: "boolean" }).notNull().default(false),
    propostaCodigo: text("proposta_codigo"),
    venceEm: text("vence_em"),
    estado: text("estado", { enum: ESTADOS_DA_TAREFA }).notNull().default("aberta"),
    origem: text("origem", { enum: AUTORES }).notNull(),
    versao: integer("versao").notNull().default(1),
    criadaEm: text("criada_em").notNull(),
    atualizadaEm: text("atualizada_em").notNull(),
    /**
     * A conversa do Meu dia de onde a tarefa nasceu: o canal, a chave (o telefone ou o id do item de
     * e-mail, as mesmas de `conversa_ignorada`) e `ate`, o instante da última mensagem que o servidor
     * conhecia ao criar. Os três juntos ou nenhum, e nunca mudam: os gatilhos da migração 0016 cobram.
     */
    conversaCanal: text("conversa_canal", { enum: CANAIS_DE_VINCULO }),
    conversaChave: text("conversa_chave"),
    conversaAte: text("conversa_ate"),
  },
  (t) => [
    index("tarefa_por_estado").on(t.estado, t.venceEm),
    check("tarefa_estado", sql`${t.estado} IN (${lista(ESTADOS_DA_TAREFA)})`),
    check("tarefa_origem", sql`${t.origem} IN (${lista(AUTORES)})`),
    check("tarefa_titulo", sql`length(${t.titulo}) BETWEEN 1 AND ${sql.raw(String(LIMITES.titulo))}`),
    // Dia que existe: `date()` devolve o mesmo texto, e `2026-02-30` vira outro dia.
    check("tarefa_vence_em", sql`${t.venceEm} IS NULL OR (length(${t.venceEm}) = 10 AND date(${t.venceEm}) IS ${t.venceEm})`),
    check("tarefa_versao", sql`${t.versao} >= 1`),
  ],
);

/** Histórico da tarefa. Só anexa: os gatilhos da migração 0003 recusam UPDATE e DELETE. */
export const nota = sqliteTable(
  "nota",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tarefaId: text("tarefa_id")
      .notNull()
      .references(() => tarefa.id),
    texto: text("texto").notNull(),
    autor: text("autor", { enum: AUTORES }).notNull(),
    proximoPasso: text("proximo_passo"),
    criadaEm: text("criada_em").notNull(),
  },
  (t) => [
    index("nota_por_tarefa").on(t.tarefaId, t.id),
    check("nota_autor", sql`${t.autor} IN (${lista(AUTORES)})`),
    check("nota_texto", sql`length(${t.texto}) BETWEEN 1 AND ${sql.raw(String(LIMITES.nota))}`),
    check(
      "nota_proximo_passo",
      sql`${t.proximoPasso} IS NULL OR length(${t.proximoPasso}) BETWEEN 1 AND ${sql.raw(String(LIMITES.proximoPasso))}`,
    ),
  ],
);

/** O que o cache do CRM guarda. `proposta_link` é o `link` de `ver_proposta`, uma linha por proposta. */
export const RECURSOS_DO_CACHE = ["agenda", "propostas", "carteira", "proposta_link"] as const;

/**
 * Cópia descartável do que a sincronização leu do CRM. Apagar a tabela inteira não perde dado
 * do vendedor: a próxima sincronização lê tudo de novo. Nenhuma coluna guarda token.
 */
export const crmCache = sqliteTable(
  "crm_cache",
  {
    recurso: text("recurso", { enum: RECURSOS_DO_CACHE }).notNull(),
    chave: text("chave").notNull(),
    json: text("json").notNull(),
    lidoEm: text("lido_em").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.recurso, t.chave] }),
    check("crm_cache_recurso", sql`${t.recurso} IN (${lista(RECURSOS_DO_CACHE)})`),
    check("crm_cache_json", sql`json_valid(${t.json})`),
  ],
);

/**
 * Proposta ou cliente que o vendedor tirou do Meu dia até o dia `ate`, sem tocar no CRM. A marca
 * é do vendedor e mora fora do `crm_cache`: apagar o cache não traz o item de volta antes da hora.
 * `nome` e `codigo` são os da leitura em que o item foi ignorado, para mostrar a marca sem o cache.
 */
export const itemIgnorado = sqliteTable(
  "item_ignorado",
  {
    tipo: text("tipo", { enum: TIPOS_DE_IGNORADO }).notNull(),
    crmId: integer("crm_id").notNull(),
    /** Primeiro dia de Brasília em que o item volta. */
    ate: text("ate").notNull(),
    criadoEm: text("criado_em").notNull(),
    quem: text("quem", { enum: QUEM_IGNORA }).notNull().default("vendedor"),
    /** As palavras do vendedor. O agente só ignora com elas. */
    motivo: text("motivo"),
    nome: text("nome").notNull().default(""),
    codigo: text("codigo"),
  },
  (t) => [
    primaryKey({ columns: [t.tipo, t.crmId] }),
    check("item_ignorado_tipo", sql`${t.tipo} IN (${lista(TIPOS_DE_IGNORADO)})`),
    check("item_ignorado_crm_id", sql`${t.crmId} >= 1`),
    check("item_ignorado_ate", sql`length(${t.ate}) = 10 AND date(${t.ate}) IS ${t.ate}`),
    check("item_ignorado_quem", sql`${t.quem} IN (${lista(QUEM_IGNORA)})`),
    check(
      "item_ignorado_motivo",
      sql`${t.motivo} IS NULL OR length(${t.motivo}) BETWEEN ${sql.raw(String(TAMANHO_DO_MOTIVO.minimo))} AND ${sql.raw(String(TAMANHO_DO_MOTIVO.maximo))}`,
    ),
    check("item_ignorado_motivo_do_agente", sql`${t.quem} = 'vendedor' OR ${t.motivo} IS NOT NULL`),
  ],
);

/**
 * De quem é o número de uma conversa: o cliente do CRM, ou a dúvida. A chave é o telefone E.164
 * para `whatsapp`. `auto` e `ambiguo` vêm da consulta ao CRM e vencem; `confirmado` e `nao_cliente`
 * são do vendedor e a sincronização nunca os troca. Nenhuma coluna guarda texto de mensagem nem
 * nome de contato do WhatsApp.
 */
export const contatoVinculo = sqliteTable(
  "contato_vinculo",
  {
    canal: text("canal", { enum: CANAIS_DE_VINCULO }).notNull(),
    chave: text("chave").notNull(),
    estado: text("estado", { enum: ESTADOS_DE_VINCULO }).notNull(),
    clienteId: integer("cliente_id"),
    clienteNome: text("cliente_nome"),
    clienteCidade: text("cliente_cidade"),
    /** JSON `[{id, nome, cidade, uf}]`, em `ambiguo` e `nao_cliente`. */
    candidatos: text("candidatos"),
    motivo: text("motivo", { enum: MOTIVOS_NO_BANCO }),
    /** Quando o CRM foi consultado pela última vez para este número. */
    conferidoEm: text("conferido_em").notNull(),
    /** Quando o vendedor confirmou o cliente ou disse que não é cliente. */
    decididoEm: text("decidido_em"),
  },
  (t) => [
    primaryKey({ columns: [t.canal, t.chave] }),
    check("contato_vinculo_canal", sql`${t.canal} IN (${lista(CANAIS_DE_VINCULO)})`),
    check("contato_vinculo_estado", sql`${t.estado} IN (${lista(ESTADOS_DE_VINCULO)})`),
    check("contato_vinculo_chave", sql`${t.canal} <> 'whatsapp' OR (substr(${t.chave}, 1, 1) = '+' AND length(${t.chave}) BETWEEN 9 AND 16)`),
    check("contato_vinculo_cliente_id", sql`${t.clienteId} IS NULL OR ${t.clienteId} >= 1`),
    // O cliente vem preenchido em `auto` e `confirmado`, e só neles. A cidade pode faltar no CRM.
    check(
      "contato_vinculo_cliente",
      sql`(${t.estado} IN ('auto', 'confirmado')) = (${t.clienteId} IS NOT NULL AND ${t.clienteNome} IS NOT NULL) AND (${t.estado} IN ('auto', 'confirmado') OR (${t.clienteId} IS NULL AND ${t.clienteNome} IS NULL AND ${t.clienteCidade} IS NULL))`,
    ),
    // Candidatos e motivo só em `ambiguo` e `nao_cliente` (o desfazer volta a `ambiguo` com eles, sem o CRM). O JSON é conferido dentro do CASE: `json_type` falha em texto inválido.
    check(
      "contato_vinculo_candidatos",
      sql`CASE WHEN ${t.estado} IN ('ambiguo', 'nao_cliente') THEN ${t.motivo} IN (${lista(MOTIVOS_NO_BANCO)}) AND ${t.candidatos} IS NOT NULL AND CASE WHEN json_valid(${t.candidatos}) THEN json_type(${t.candidatos}) = 'array' AND json_array_length(${t.candidatos}) >= 1 ELSE 0 END ELSE ${t.motivo} IS NULL AND ${t.candidatos} IS NULL END`,
    ),
    check("contato_vinculo_decidido", sql`(${t.estado} IN ('confirmado', 'nao_cliente')) = (${t.decididoEm} IS NOT NULL)`),
  ],
);

/**
 * Conversa que o vendedor tirou do Meu dia até o dia `ate`. Mesmas regras de `item_ignorado`, que
 * guarda proposta e cliente do CRM por id inteiro. `nome` é o do cliente, o da conversa ou o telefone, para mostrar a marca sem o cache.
 */
export const conversaIgnorada = sqliteTable(
  "conversa_ignorada",
  {
    canal: text("canal", { enum: CANAIS_DE_VINCULO }).notNull(),
    chave: text("chave").notNull(),
    /** Primeiro dia de Brasília em que a conversa volta. */
    ate: text("ate").notNull(),
    criadoEm: text("criado_em").notNull(),
    quem: text("quem", { enum: QUEM_IGNORA }).notNull(),
    /** As palavras do vendedor. O agente só ignora com elas. */
    motivo: text("motivo"),
    nome: text("nome").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.canal, t.chave] }),
    check("conversa_ignorada_canal", sql`${t.canal} IN (${lista(CANAIS_DE_VINCULO)})`),
    check("conversa_ignorada_ate", sql`length(${t.ate}) = 10 AND date(${t.ate}) IS ${t.ate}`),
    check("conversa_ignorada_quem", sql`${t.quem} IN (${lista(QUEM_IGNORA)})`),
    check(
      "conversa_ignorada_motivo",
      sql`${t.motivo} IS NULL OR length(${t.motivo}) BETWEEN ${sql.raw(String(TAMANHO_DO_MOTIVO.minimo))} AND ${sql.raw(String(TAMANHO_DO_MOTIVO.maximo))}`,
    ),
    check("conversa_ignorada_motivo_do_agente", sql`${t.quem} = 'vendedor' OR ${t.motivo} IS NOT NULL`),
  ],
);

/**
 * A última leitura das conversas, uma linha só (`atual`). Parte do cache descartável do CRM, mas
 * numa tabela própria: o CHECK de `crm_cache.recurso` não aceita um recurso novo sem recriar a tabela.
 * Guarda telefone, id da conversa, ids e instantes das mensagens que decidiram a situação, contagens
 * e a lista de sinais. Nenhum texto de mensagem.
 */
export const conversasCache = sqliteTable(
  "conversas_cache",
  {
    chave: text("chave").primaryKey(),
    json: text("json").notNull(),
    lidoEm: text("lido_em").notNull(),
  },
  (t) => [check("conversas_cache_chave", sql`${t.chave} = 'atual'`), check("conversas_cache_json", sql`json_valid(${t.json})`)],
);

/**
 * Cartão da fila de aprovação: o que o agente propôs escrever no CRM, com o conteúdo congelado em
 * `payload` e `hash`. Nenhuma linha se apaga: descartar é um estado. O valor de `erro_codigo` não tem
 * lista aqui, porque quem grava no CRM escolhe os códigos.
 */
export const escritaCrm = sqliteTable(
  "escrita_crm",
  {
    id: text("id").primaryKey(),
    tool: text("tool", { enum: TOOLS_DE_ESCRITA }).notNull(),
    /** A forma canônica de `dados`: chaves em ordem alfabética, sem espaço. */
    payload: text("payload").notNull(),
    hash: text("hash").notNull(),
    clienteId: integer("cliente_id"),
    clienteConferido: integer("cliente_conferido", { mode: "boolean" }).notNull().default(false),
    clienteNome: text("cliente_nome"),
    clienteCidade: text("cliente_cidade"),
    confiraCliente: integer("confira_cliente", { mode: "boolean" }).notNull().default(false),
    /** JSON `{ campo: [sinais] }`. */
    sinais: text("sinais").notNull(),
    estado: text("estado", { enum: ESTADOS_DA_ESCRITA }).notNull().default("rascunho"),
    crmId: integer("crm_id"),
    crmLink: text("crm_link"),
    erroCodigo: text("erro_codigo"),
    /** Texto do CRM já saneado. Só o agente o recebe, citado. */
    erroDetalhe: text("erro_detalhe"),
    versao: integer("versao").notNull().default(1),
    criadaEm: text("criada_em").notNull(),
    atualizadaEm: text("atualizada_em").notNull(),
    /** A ordem de chegada, 1, 2, 3...: desempata os cartões criados no mesmo milissegundo. O `rowid` não serve, porque o `VACUUM INTO` do backup pode renumerá-lo. */
    ordem: integer("ordem").notNull(),
  },
  (t) => [
    uniqueIndex("escrita_crm_ordem").on(t.ordem),
    check("escrita_crm_tool", sql`${t.tool} IN (${lista(TOOLS_DE_ESCRITA)})`),
    check("escrita_crm_estado", sql`${t.estado} IN (${lista(ESTADOS_DA_ESCRITA)})`),
    check("escrita_crm_payload", sql`json_valid(${t.payload})`),
    check("escrita_crm_sinais", sql`json_valid(${t.sinais})`),
    check("escrita_crm_hash", sql`length(${t.hash}) = 64`),
    check("escrita_crm_cliente_id", sql`${t.clienteId} IS NULL OR ${t.clienteId} >= 1`),
    check("escrita_crm_versao", sql`${t.versao} >= 1`),
    check(
      "escrita_crm_cliente",
      sql`CASE WHEN ${t.clienteConferido} = 1 THEN ${t.clienteId} IS NOT NULL AND ${t.clienteNome} IS NOT NULL ELSE ${t.clienteConferido} = 0 AND ${t.clienteNome} IS NULL AND ${t.clienteCidade} IS NULL END`,
    ),
    check("escrita_crm_confira_cliente", sql`${t.confiraCliente} IN (0, 1) AND (${t.confiraCliente} = 0 OR ${t.clienteId} IS NOT NULL)`),
    check("escrita_crm_recibo", sql`${t.estado} = 'gravado' OR (${t.crmId} IS NULL AND ${t.crmLink} IS NULL)`),
    check(
      "escrita_crm_erro",
      sql`(${t.estado} IN ('falhou', 'falhou_incerto')) = (${t.erroCodigo} IS NOT NULL) AND (${t.erroDetalhe} IS NULL OR ${t.erroCodigo} IS NOT NULL)`,
    ),
  ],
);

/** O registro de decisões do vendedor. Só anexa: os gatilhos da migração 0012 recusam UPDATE e DELETE. */
export const decisao = sqliteTable(
  "decisao",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    escritaId: text("escrita_id")
      .notNull()
      .references(() => escritaCrm.id),
    acao: text("acao", { enum: ACOES_DA_DECISAO }).notNull(),
    /** O hash do cartão quando a decisão foi tomada; no `editou`, o de antes da edição. */
    hash: text("hash").notNull(),
    em: text("em").notNull(),
  },
  (t) => [check("decisao_acao", sql`${t.acao} IN (${lista(ACOES_DA_DECISAO)})`), check("decisao_hash", sql`length(${t.hash}) = 64`)],
);

/** Uma linha só: a última busca do `versao.json`, para o restart não buscar de novo antes das 6 horas. */
export const conferenciaDeVersao = sqliteTable(
  "conferencia_de_versao",
  {
    id: integer("id").primaryKey(),
    em: text("em").notNull(),
    /** JSON do resultado da busca, sem segredo: a versão publicada e o O que muda, ou só o tipo. */
    resultado: text("resultado").notNull(),
  },
  (t) => [check("conferencia_de_versao_unica", sql`${t.id} = 1`), check("conferencia_de_versao_resultado_json", sql`json_valid(${t.resultado})`)],
);

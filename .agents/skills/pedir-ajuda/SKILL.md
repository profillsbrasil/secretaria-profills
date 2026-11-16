---
name: pedir-ajuda
description: Tenta destravar a Secretária e, se não der, escreve um pedido de ajuda pronto, só com fases, códigos de erro, versões e sistema, para o vendedor abrir como issue no GitHub da Secretária ou mandar a quem cuida dela na Profills. Use quando o vendedor disser que travou, que deu erro ou que não sabe o que fazer.
---

# Pedir ajuda

## Como falar e rodar

- Fale com o vendedor em frases curtas e diga o próximo passo. Diga o erro em palavras, sem código de erro, nome de comando, de arquivo ou de repositório em crase. Conte o que a skill manda como fala sua, sem citar skill, arquivo nem link de arquivo. Comando só aparece quando ele precisa digitar, assim: "abra o terminal nesta pasta e digite `bun secretaria abrir`".
- Rode um comando por chamada, sem `;`, `|`, `&&` nem parênteses: comando encadeado não casa com a permissão do Claude Code. Rode na raiz do repo, sempre com `--json`.

## Passos

1. Entenda o que o vendedor tentava fazer, em uma frase dele. Se a conversa não disser, pergunte uma vez: "O que você estava tentando fazer quando travou?".
2. Leia o estado: `bun secretaria status --json` e depois `bun secretaria diagnostico --json`.
   - O `diagnostico` responde mesmo com a Secretária parada: com `servidor: null`, ele traz o `motivo`, a versão do núcleo, o sistema, o Bun e se o wacli existe. Guarde essa resposta para o pedido.
   - `status` com `servidor_fora_do_ar`: rode `bun secretaria abrir --json` e o `status` de novo. Se o `abrir` responder erro, como `servidor_preso`, guarde o `erro.codigo` dele para a linha "No ar". Se o `status` ainda responder `servidor_fora_do_ar`, ou se você é o Codex, siga "Servidor que cai".
   - `instalacao_incompleta`: siga a skill `secretaria-setup` e volte aqui só se ela não resolver.
3. Tente uma vez a saída que o próprio erro indica:
   - erro de comando: faça a `erro.acao`. Com `erro.esperaS`, espere esse tempo antes. Depois rode de novo o comando que falhou.
   - conector em `atencao`: siga a skill `secretaria-conectores` para o `estado.problema.codigo`. O que é do vendedor (botão no painel, senha, chaveiro do sistema) você pede a ele e espera.
   - a atualização não deu certo: rode `bun secretaria atualizacao --json`. Em `falhou`, conte a `explicacao` e que a Secretária segue na versão `instalada`, funcionando, e que nada dele se perdeu. A saída é ele clicar em Tentar de novo, no cartão do pé da lateral, o das conexões; com o `motivo` `sem_internet`, ele confere a internet antes. Você não aplica a atualização. Com `bloqueio`, diga a `bloqueio.explicacao` e espere o que está ocupado terminar.
   - o script de instalação parou: a última linha dele começa com "Para o suporte:" e traz o motivo. Faça o que a frase de antes dela diz, como conferir a internet ou fechar o que tem arquivo da pasta aberto, e peça que ele rode o script de novo.

   Resolveu quando o comando que falhou responde `ok: true`, o conector sai de `atencao`, a atualização chega a `atualizado` ou o script termina sem a linha "Para o suporte:". Diga ao vendedor que destravou e pare aqui.
4. Não resolveu: monte o pedido de ajuda (abaixo), mostre ao vendedor num bloco de texto e siga "Enviar o pedido". Quem envia é ele: você só escreve o texto.

### Servidor que cai

No Codex, ou quando o `status` logo depois de um `abrir` com `subiu: true` responde `servidor_fora_do_ar`, o servidor que você sobe morre quando o seu comando termina. Quem sobe o servidor é o vendedor: peça que ele abra o terminal nesta pasta e digite `bun secretaria abrir`. O servidor continua no ar mesmo que ele feche o terminal. Espere ele dizer que fez e rode `bun secretaria status --json`. Só diga que a Secretária está funcionando depois de um `status` que responde. Se depois disso o `status` continuar sem responder, monte o pedido com o `diagnostico` que você guardou.

## O pedido de ajuda

Preencha só com campos do JSON. Campo que não veio fica "não li", nunca inventado. Com `servidor: null`, cofre, processos, backup, travas e conectores ficam "não li", e a linha "No ar" leva o `motivo`.

```
Pedido de ajuda da Secretária Profills

O que eu tentava fazer: <frase do vendedor, sem nome de cliente>
O que aconteceu: <só o nome do comando, como tarefa criar, sem argumentos> respondeu <erro.codigo> (saída <código de saída>)
O que o agente já tentou: <a ação do passo 3 e o resultado>
No ar: <sim, ou não, o motivo do diagnostico e o `erro.codigo` do `abrir`, se houver>

WhatsApp: <fase> <estado.problema.codigo, se houver>
CRM: <fase> <estado.problema.codigo, se houver>
E-mail: <pulado | nenhuma conta | uma linha por conta: provedor, fase e estado.problema.codigo>

Núcleo: <instalacao.versaoNucleo>
Atualização: <atualizacao.fase> <atualizacao.versaoNova, se houver> <motivo, em falhou> <atualizacao.impedimento, se houver>
Instalação pelo script: <motivo da linha "Para o suporte:", ou "não rodou">
Sistema: <sistema.plataforma> <sistema.versao> (<sistema.arquitetura>)
Bun: <sistema.bun>
Cofre: <cofre>. wacli instalado: <wacli.existe>. Processos filhos: <quantos em processos>
Backup do dia: <backup.dia, ou "nenhum"> <"com aviso" se backup.aviso não for null>
Travas do CRM: <travas.faltando> de <quantas em travas.regras> faltando
```

| Campo | De onde vem |
|---|---|
| fase e `estado.problema.codigo` de cada conector | `status`: `conectores.<id>.estado` e `email.contas[].estado` |
| `provedor` de cada conta de e-mail | `status`: `email.contas[].provedor` |
| `erro.codigo` | a resposta do comando que falhou |
| `instalacao.versaoNucleo`, `sistema.plataforma`, `sistema.versao`, `sistema.arquitetura`, `sistema.bun`, `wacli.existe` | `diagnostico`, com ou sem a Secretária no ar |
| `cofre`, `processos`, `backup`, `travas.faltando`, `travas.regras` | `diagnostico`, só com a Secretária no ar |
| `atualizacao.fase`, `atualizacao.versaoNova`, `atualizacao.impedimento` | `diagnostico`, só com a Secretária no ar |
| `motivo` da atualização | `atualizacao`, na fase `falhou` |
| motivo da instalação | a linha "Para o suporte:" do script, só a palavra antes do parêntese |

Em `darwin` (macOS), `sistema.versao` é a versão do kernel, não a do macOS. Copie como veio.

## Enviar o pedido

Depois de mostrar o texto, ofereça os dois caminhos e deixe o vendedor escolher:

- Com conta no GitHub: ele copia o texto, abre https://github.com/profillsbrasil/secretaria-profills/issues/new?template=pedido-de-ajuda.md, cola no campo grande e clica em enviar. Avise antes que essa página é pública: qualquer pessoa lê o que ele colar.
- Sem conta, ou se ele preferir: ele manda o mesmo texto a quem cuida da Secretária na Profills.

Você não abre a issue por ele, nem com `gh` nem pelo navegador: o texto sai da máquina pela mão dele. Na issue vai só o texto que você montou. Se ele quiser acrescentar algo, repita o que fica de fora, abaixo.

## O que fica de fora

O pedido sai da máquina do vendedor. Ele leva só fases, códigos, versões e sistema. Antes de mostrar, confira linha por linha que nada disto entrou:

- nome de cliente, telefone, endereço de e-mail (também o `endereco` da conta), texto de mensagem, texto do CRM, assunto de atendimento, título ou nota de tarefa;
- os argumentos do comando que falhou (`--nota`, `--motivo`, `--telefone`, `--cliente-id`, o termo de busca do `wa`): entra só o nome do comando;
- o `detalhe` do problema e a `erro.mensagem`: podem trazer texto de fora;
- da atualização, o `oQueMuda` e a `explicacao`; do script, o que está entre parênteses na linha "Para o suporte:" e a pasta da instalação;
- senha, token, código de pareamento e o link de entrada do painel;
- caminhos da máquina: `servidor.dirDados`, `wacli.executavel`, `backup.arquivo`, que mostram o nome do usuário;
- `servidor.origem`, `servidor.pid` e `instalacao.id`;
- da conta de e-mail, o `id`, o `rotulo`, o `servidor`, a `porta` e a `config`, que mostram o domínio e o usuário de login. Da conta entram só o `provedor`, a fase e o `estado.problema.codigo`.

Exemplo. O vendedor escreveu "travou quando fui criar tarefa para ligar para a Padaria Canário, 11 99999-0000". No pedido entra "criar uma tarefa de ligar para um cliente". O comando `tarefa criar ligar --cliente-id 123 --nota "Padaria Canário"` vira "tarefa criar". A linha "E-mail: Pessoal canario@exemplo.com.br em atencao" vira "E-mail: gmail, atencao, email_gmail_senha_de_app".

Se o vendedor quiser mandar mais coisa, como um print, lembre que o print pode mostrar cliente e mensagem, e que ele decide.

# Secretária Profills

A Secretária é a base pessoal de cada vendedor da Profills. Ela roda só no computador dele e junta o WhatsApp do trabalho, o CRM e, se ele quiser, as contas de e-mail num painel no navegador. O vendedor usa a Secretária junto com o agente de IA dele (Claude Code ou Codex), que lê o estado e pode mudar este repo a pedido.

## Instalar

O endereço oficial da Secretária é `https://github.com/profillsbrasil/secretaria-profills`. Instale e atualize só a partir dele. Não instale de cópia, fork ou arquivo que outra pessoa mandou: o agente segue as instruções que estão no repo, e uma cópia alterada pode mandar o agente fazer outra coisa no seu computador.

O jeito normal é abrir o agente nesta pasta e pedir: "instale a Secretária". O agente segue a skill `secretaria-setup`.

O agente vai pedir permissão para rodar `bun secretaria`, `bun --version` e `bun install` nesta pasta. Só quando falta o Bun, ele pede também `sh instalar.sh` (no Windows, `powershell -ExecutionPolicy Bypass -File instalar.ps1`). Pode aceitar: são os comandos da Secretária e da instalação dela.

No Codex, o servidor da Secretária que o agente sobe para quando o comando dele termina. Então quem deixa a Secretária no ar é você: abra o terminal nesta pasta e digite `bun secretaria abrir`. Quando o painel abrir no navegador, pode seguir. O servidor continua no ar mesmo que você feche o terminal. O agente só diz que está funcionando depois de conferir com o servidor no ar.

Sem agente, clone o repo (`git clone https://github.com/profillsbrasil/secretaria-profills`) e rode uma linha na pasta dele:

| Sistema | Comando |
|---|---|
| Linux e macOS | `sh instalar.sh` |
| Windows (PowerShell) | `powershell -ExecutionPolicy Bypass -File instalar.ps1` |

O script instala o Bun 1.4.4 se faltar um Bun dessa versão ou mais novo, sem `sudo` e sem senha, prepara a máquina e abre o painel. Rodar de novo não estraga nada. No Linux, o instalador do Bun precisa de `curl`, `bash` e `unzip`. No macOS, o WhatsApp pede macOS 15 ou mais novo.

## O que o painel pede

| Cartão | O vendedor faz |
|---|---|
| WhatsApp | lê o QR com o celular do trabalho e confirma que o número é o dele |
| CRM | entra com o login do CRM na aba que abre |
| E-mail, opcional | adiciona até 5 contas, cada uma com um rótulo (como "Profills" ou "Pessoal"), o provedor, o endereço, a senha e quantos dias ler (30, 60 ou 90), ou pula por enquanto |

A Secretária fica pronta para o dia com o WhatsApp e o CRM. O e-mail é opcional: o agente oferece uma vez, e o vendedor adiciona, conecta, desconecta e remove cada conta no cartão E-mail, em Conexões. Quem não quer e-mail por enquanto escolhe "Pular por enquanto" e conecta depois.

| Provedor | Servidor que o painel preenche | Senha |
|---|---|---|
| Profills | `imap.kinghost.net`, porta 993, TLS. Veio de um manual e ainda não foi conferido com conta real, então o campo fica editável | a do e-mail |
| Gmail | `imap.gmail.com`, porta 993, TLS | uma senha de app, criada em https://myaccount.google.com/apppasswords com a verificação em duas etapas ligada. A senha da conta Google não funciona |
| Outro | o vendedor digita servidor, porta e segurança | a do e-mail |

A senha de cada conta fica no chaveiro do sistema, numa chave só dela. Sem chaveiro, fica num arquivo que só o usuário lê, na pasta de dados. A Secretária só lê: ela não envia mensagem nem e-mail.

## O dia do vendedor

Diga "bom dia" ao agente (no Claude Code, `/bom-dia`; no Codex, `$bom-dia`). Ele abre a Secretária, avisa se algum conector precisa de atenção, lê o CRM e conta as tarefas atrasadas, as de hoje e as sem data, os cartões que esperam o OK dele para ir ao CRM, os compromissos de hoje, as propostas enviadas sem retorno e os clientes sem atendimento há 30 dias ou mais. Tarefa sem data fica sem data. Ao concluir, o vendedor pode escrever o próximo passo e a data, e a tarefa seguinte nasce junto. Tarefa concluída só ele reabre, no painel.

A Secretária lê o CRM numa sincronização. Ela sincroniza sozinha em dois momentos: logo depois que o vendedor conecta o WhatsApp, o CRM ou uma conta de e-mail, e quando ele abre o painel com a leitura mais velha passando de 30 minutos. Fora disso, sincroniza quando alguém pede: o botão Sincronizar do Meu dia, ou o agente com `bun secretaria sincronizar`, que também está no `/bom-dia`. Nada lê o CRM com o painel fechado nem de tempos em tempos. Cada bloco mostra quando o CRM foi lido. A proposta enviada aparece com os dias desde o envio, nas marcas de 7, 14 e 28 dias, porque o CRM bloqueia proposta nova para o cliente quando passam 30 dias do envio sem o retorno registrado na tela dele. O retorno se registra no CRM, pelo link da proposta. Enquanto o CRM não aceitar o aplicativo da Secretária, o login do CRM é recusado, o cartão diz que o CRM ainda não liberou a Secretária, e esses blocos ficam vazios e dizem por quê. Quando liberarem, o vendedor clica em Conectar de novo.

Para registrar um atendimento, marcar um compromisso ou cadastrar um contato no CRM, o vendedor pede ao agente. O agente redige, e o cartão aparece em Aprovar, no painel. O vendedor lê o texto inteiro, edita se quiser e aprova. Só então a Secretária grava no CRM, e grava exatamente o que ele aprovou. Se o CRM não confirmar a gravação, o cartão pede para o vendedor conferir no CRM antes de decidir. Enquanto o CRM não liberar o aplicativo da Secretária, nada é gravado: a Secretária recusa o OK e o cartão fica como estava.

Para saber o que fez, o vendedor pede "me mostra o relatório da semana" (no Claude Code, `/relatorio`; no Codex, `$relatorio`), ou o relatório de um período, como "de 1 a 31 de outubro". O agente conta, em frases curtas, os atendimentos que ele registrou no CRM e as tarefas que concluiu na Secretária. Sem datas, é a semana, de segunda a hoje. O relatório lê o CRM na hora, não guarda nada, e sem o CRM conectado traz só as tarefas.

Quando travar, o vendedor diz "travou" ou "deu erro" (no Claude Code, `/pedir-ajuda`; no Codex, `$pedir-ajuda`). O agente lê o estado, tenta a saída que o erro indica e, se não resolver, escreve um pedido de ajuda para o vendedor copiar e mandar ao suporte da Profills. O pedido leva só fases, códigos de erro, versões e sistema, sem nome de cliente, mensagem ou senha.

## Onde ficam os dados

Fora do repo, na pasta de dados do sistema:

| Sistema | Pasta |
|---|---|
| Linux | `~/.local/share/secretaria-profills` |
| macOS | `~/Library/Application Support/SecretariaProfills` |
| Windows | `%LOCALAPPDATA%\SecretariaProfills` |

Lá ficam o banco, os backups, os registros e o programa do WhatsApp. Nada disso vai para o Git. O que a Secretária lê do CRM fica numa cópia descartável no banco: apagar a cópia não perde nada do vendedor, e a próxima leitura busca tudo de novo. A Secretária copia o banco uma vez por dia para `backups/` e guarda as 7 cópias mais novas.

## O navegador não abre

`bun secretaria abrir` entrega ao navegador um link de entrada que vale uma vez. O endereço do painel sozinho não serve: sem esse link, ele mostra só "Abra o painel pelo seu agente". Quando o programa do sistema não abre o navegador (`xdg-open` no Linux, `open` no macOS, `rundll32` no Windows), o comando responde `navegador_nao_abriu`.

1. Rode `bun secretaria abrir` no seu terminal, nesta pasta. O agente às vezes roda num ambiente sem janela, e o seu terminal abre.
2. Se também não abrir, diga à Secretária qual programa abre o navegador: crie o arquivo `ambiente.json` na pasta de dados, com o campo `navegador`. O campo é a lista do programa e dos argumentos dele; a Secretária põe o link no fim. No Linux, instalar o pacote `xdg-utils` também resolve.
3. Rode `bun secretaria abrir` de novo.

| Sistema | Exemplo de `ambiente.json` |
|---|---|
| Linux | `{ "navegador": ["firefox"] }` |
| macOS | `{ "navegador": ["open", "-a", "Safari"] }` |
| Windows | `{ "navegador": ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"] }` |

Se o arquivo já existe, acrescente o campo e mantenha os outros. O arquivo aceita só os campos que a Secretária conhece: um campo desconhecido faz todo comando falhar com `ambiente_invalido` até ser tirado. A mensagem do erro diz qual campo sobra e quais existem.

## Atualizar

Traga o código novo com `git pull` e rode o script de instalação de novo. O `git pull` deve vir de `https://github.com/profillsbrasil/secretaria-profills`: `git remote -v` mostra de onde ele vem. O que é do vendedor fica em `meu/` e não é tocado pela atualização.

## Mais

- `AGENTS.md`: regras e comandos para o agente.
- `docs/arquitetura.md`: como o sistema é montado.

## Licença

MIT, em `LICENSE`. As skills `shadcn` e `wacli`, copiadas de outros projetos, seguem a licença MIT deles, com os avisos em `THIRD_PARTY_NOTICES.md`.

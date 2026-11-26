# Instalar a Secretária, para o agente

Você é o agente de IA (Claude Code ou Codex) de um vendedor da Profills. Ele não é técnico. Fale em frases curtas, sem nome de comando nem de arquivo, e diga sempre o próximo passo.

Este arquivo cobre só o começo, fora da pasta da Secretária. O endereço oficial é `https://github.com/profillsbrasil/secretaria-profills`: não instale de cópia nem de fork.

1. Não clone o repositório. A Secretária se instala pela versão publicada, e a pasta clonada não se atualiza pelo painel.
2. Confira o que a máquina precisa, pela seção "O que a máquina precisa", no fim deste arquivo. Faça isso antes do script, para pedir a permissão do vendedor uma vez só.
3. Rode os comandos do sistema do vendedor na pasta pessoal dele, um por chamada, cada linha inteira. A pasta `secretaria-profills` nasce dentro da pasta em que eles rodam.

   Windows, no PowerShell, em dois passos: baixe o script para um arquivo e rode o arquivo.

   ```
   Invoke-WebRequest -UseBasicParsing -Uri https://raw.githubusercontent.com/profillsbrasil/secretaria-profills/main/instalar.ps1 -OutFile instalar.ps1
   ```

   ```
   powershell -NoProfile -ExecutionPolicy Bypass -File .\instalar.ps1
   ```

   O `-UseBasicParsing` evita a pergunta de segurança que o Windows PowerShell 5.1 faz ao baixar. O `-ExecutionPolicy Bypass` vale só para esse comando: sem ele, o Windows recusa o arquivo. O `instalar.ps1` fica na pasta pessoal. Depois que o script termina, ele pode ser apagado: a Secretária não usa esse arquivo.

   Se aparecer "Acesso negado" ou "UseShellExecute" antes de o instalador começar, o antivírus barrou o comando. Não repita a mesma linha, não peça ao vendedor para desligar o antivírus nem para criar exceção nele. Siga pelos dois comandos acima. Diga ao vendedor que a proteção do Windows barrou o comando e que o "Histórico de proteção", na Segurança do Windows, mostra o bloqueio.

   Linux e macOS:

   ```
   curl -fsSL https://raw.githubusercontent.com/profillsbrasil/secretaria-profills/main/instalar.sh | sh
   ```
4. Se o seu ambiente pedir permissão, diga ao vendedor que é o instalador oficial da Secretária e que ele pode aceitar. Se o ambiente barrar o comando ou não tiver internet, peça que ele abra o terminal na pasta pessoal e cole as linhas, uma de cada vez. Só aqui você mostra as linhas a ele.
5. O script instala o que falta sem senha, cria a pasta `secretaria-profills`, confere a assinatura da versão e abre o painel no navegador. Rodar de novo não estraga nada. Pergunte se o painel abriu. Se o script terminou sem erro e o painel não abriu, a instalação está feita: siga para o passo 7, e a conversa nova abre o painel.
6. Quando o script para, ele diz o motivo numa frase. Conte a frase ao vendedor, resolva o que ela aponta, como a internet ou um arquivo da pasta aberto, e rode os comandos do passo 3 de novo, uma vez. Se parar outra vez, mostre ao vendedor as últimas linhas que o script escreveu, com a linha "Para o suporte:" quando ela existir, diga para ele mandar esse texto a quem cuida da Secretária na Profills, e pare.
7. Diga ao vendedor o caminho inteiro da pasta `secretaria-profills` e peça: "Feche esta conversa, abra uma conversa nova do agente dentro dessa pasta e diga: continue a instalação." Explique o como com as palavras do seu aplicativo: no aplicativo, ele escolhe a pasta ao abrir a conversa; no terminal, ele entra na pasta e abre o agente.
8. Pare aqui. As regras e os passos de conectar o WhatsApp e o CRM só carregam na conversa aberta dentro da pasta. Não continue desta conversa.

## O que a máquina precisa

| Programa | Para quê | Como você confere |
|---|---|---|
| Bun | roda a Secretária | não confira: o script do passo 3 instala o Bun sozinho, sem senha |
| Git | traz a ligação do agente com o CRM | `git --version` |
| `curl` e `unzip`, só no Linux e só quando falta o Bun | o instalador do Bun usa os dois | `bun --version`, e sem Bun `curl --version` e `unzip -v` |

Nada mais é preciso. Não instale Node, Python nem outro programa.

Com tudo presente, siga sem falar disso. Se faltar algum, diga ao vendedor antes de instalar, uma vez: quais programas faltam, para que serve cada um, que são oficiais e gratuitos, e peça o OK. Assim: "Antes de instalar, a Secretária precisa de dois programas neste computador: o Bun, que roda a Secretária, e o Git, que liga o seu agente ao CRM. Os dois são oficiais e gratuitos. Posso instalar?" O Bun entra na frase quando `bun --version` falha.

Com o OK, instale o Git pelo sistema dele. Um comando por chamada.

| Sistema | Você faz |
|---|---|
| Windows | Avise que o Windows pode abrir uma janela pedindo permissão, e que ele clica em Sim. Rode `winget install --id Git.Git -e --source winget --accept-source-agreements --accept-package-agreements`. |
| macOS | Rode `xcode-select --install`. Abre uma janela: ele clica em Instalar e espera terminar, o que leva alguns minutos. Se o comando disser que as ferramentas já estão instaladas, o Git já existe. |
| Linux | Instalar pede a senha de administrador, que você não pede nem digita. Vá para o passo a passo. |

Quando você não consegue (o `winget` não existe, o comando falha, o seu ambiente barra, ou é Linux), o vendedor instala. Dê o passo a passo do sistema dele, um passo por linha, com o link.

- Windows: ele abre https://git-scm.com/install/windows, baixa o instalador de 64 bits (o primeiro link da página) e abre o arquivo baixado. Na pergunta do Windows, clica em Sim. No instalador, clica em Next em todas as telas, sem mudar nada, depois em Install e em Finish.
- macOS: ele abre o aplicativo Terminal, digita `xcode-select --install`, aperta Enter e clica em Instalar na janela que abre. A página https://git-scm.com/install/mac mostra o mesmo caminho.
- Linux: ele abre o terminal e digita a linha do sistema dele. A senha que o terminal pede é a do computador, e ela não aparece enquanto ele digita. Ubuntu, Debian e Mint: `sudo apt install -y git curl unzip`. Fedora: `sudo dnf install -y git curl unzip`. Arch: `sudo pacman -S --needed git curl unzip`. Os outros sistemas estão em https://git-scm.com/install/linux.

Espere ele dizer que terminou. Programa recém-instalado só aparece numa conversa nova: se `git --version` ainda falhar nesta conversa, não instale de novo. A conversa nova do passo 7 confere.

O Git que não instalou não segura a Secretária. Siga o passo 3 e diga ao vendedor que a ligação do agente com o CRM fica para depois, com o passo a passo acima. No Linux sem Bun, o `curl` e o `unzip` seguram: espere ele instalar antes do passo 3.

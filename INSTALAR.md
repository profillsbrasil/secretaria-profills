# Instalar a Secretária, para o agente

Você é o agente de IA (Claude Code ou Codex) de um vendedor da Profills. Ele não é técnico. Fale em frases curtas, sem nome de comando nem de arquivo, e diga sempre o próximo passo.

Este arquivo cobre só o começo, fora da pasta da Secretária. O endereço oficial é `https://github.com/profillsbrasil/secretaria-profills`: não instale de cópia nem de fork.

1. Não clone o repositório. A Secretária se instala pela versão publicada, e a pasta clonada não se atualiza pelo painel.
2. Rode os comandos do sistema do vendedor na pasta pessoal dele, um por chamada, cada linha inteira. A pasta `secretaria-profills` nasce dentro da pasta em que eles rodam.

   Windows, no PowerShell, em dois passos: baixe o script para um arquivo e rode o arquivo.

   ```
   Invoke-WebRequest -Uri https://raw.githubusercontent.com/profillsbrasil/secretaria-profills/main/instalar.ps1 -OutFile instalar.ps1
   ```

   ```
   powershell -NoProfile -ExecutionPolicy Bypass -File .\instalar.ps1
   ```

   O `-ExecutionPolicy Bypass` vale só para esse comando: sem ele, o Windows recusa o arquivo. O `instalar.ps1` fica na pasta pessoal. Depois que o script termina, ele pode ser apagado: a Secretária não usa esse arquivo.

   Se aparecer "Acesso negado" ou "UseShellExecute" antes de o instalador começar, o antivírus barrou o comando. Não repita a mesma linha, não peça ao vendedor para desligar o antivírus nem para criar exceção nele. Siga pelos dois comandos acima. Diga ao vendedor que a proteção do Windows barrou o comando e que o "Histórico de proteção", na Segurança do Windows, mostra o bloqueio.

   Linux e macOS:

   ```
   curl -fsSL https://raw.githubusercontent.com/profillsbrasil/secretaria-profills/main/instalar.sh | sh
   ```
3. Se o seu ambiente pedir permissão, diga ao vendedor que é o instalador oficial da Secretária e que ele pode aceitar. Se o ambiente barrar o comando ou não tiver internet, peça que ele abra o terminal na pasta pessoal e cole as linhas, uma de cada vez. Só aqui você mostra as linhas a ele.
4. O script instala o que falta sem senha, cria a pasta `secretaria-profills`, confere a assinatura da versão e abre o painel no navegador. Rodar de novo não estraga nada. Pergunte se o painel abriu. Se o script terminou sem erro e o painel não abriu, a instalação está feita: siga para o passo 6, e a conversa nova abre o painel.
5. Quando o script para, ele diz o motivo numa frase. Conte a frase ao vendedor, resolva o que ela aponta, como a internet ou um arquivo da pasta aberto, e rode os comandos do passo 2 de novo, uma vez. Se parar outra vez, mostre ao vendedor as últimas linhas que o script escreveu, com a linha "Para o suporte:" quando ela existir, diga para ele mandar esse texto a quem cuida da Secretária na Profills, e pare.
6. Diga ao vendedor o caminho inteiro da pasta `secretaria-profills` e peça: "Feche esta conversa, abra uma conversa nova do agente dentro dessa pasta e diga: continue a instalação." Explique o como com as palavras do seu aplicativo: no aplicativo, ele escolhe a pasta ao abrir a conversa; no terminal, ele entra na pasta e abre o agente.
7. Pare aqui. As regras e os passos de conectar o WhatsApp e o CRM só carregam na conversa aberta dentro da pasta. Não continue desta conversa.

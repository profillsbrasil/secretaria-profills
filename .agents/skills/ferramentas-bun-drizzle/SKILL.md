---
name: ferramentas-bun-drizzle
description: Comandos de Bun e Drizzle usados neste repo (instalar pacote, testar, conferir tipos, gerar migração do núcleo). Use antes de rodar `bun`, `bunx drizzle-kit` ou mexer em `package.json`, `bun.lock` ou migrações.
---

# Bun e Drizzle neste repo

## Como falar e rodar

- Fale com o vendedor em frases curtas e diga o próximo passo. Diga o erro em palavras, sem código de erro, nome de comando, de arquivo ou de repositório em crase. Conte o que a skill manda como fala sua, sem citar skill, arquivo nem link de arquivo. Comando só aparece quando ele precisa digitar, assim: "abra o terminal nesta pasta e digite `bun secretaria abrir`".
- Rode um comando por chamada, sem `;`, `|`, `&&` nem parênteses: comando encadeado não casa com a permissão do Claude Code.

Bun 1.4.4, fixado em `package.json` (`packageManager` e `engines`). Os scripts de entrada (`instalar.sh`, `instalar.ps1`) instalam essa versão.

| Para | Comando |
|---|---|
| Instalar as dependências como estão no `bun.lock` | `bun install --frozen-lockfile` |
| Rodar todos os testes | `bun test` |
| Rodar os testes de uma pasta | `bun test nucleo/instalador` |
| Conferir tipos | `bun run tipos` |
| Auditar o índice do Git antes de publicar | `bun run auditar` |
| Usar a Secretária | `bun secretaria <comando> --json` (lista em `AGENTS.md`) |
| Adicionar ou ver componente do painel | `bunx --bun shadcn <comando>`, com o CLI fixado no `package.json` (skill `shadcn`) |

- Pacote novo: `bun add <pacote>@<versão exata>`. Confira licença e procedência antes. Commit leva `package.json` e `bun.lock` juntos.
- Nunca `npm install` nem `npx` para dependência do repo. Para rodar uma ferramenta do repo, `bunx <ferramenta>`, sem `@latest` nem versão no comando: a versão é a do `package.json`.
- Depois de `bunx --bun shadcn add`, troque `import { cn } from "cn"` por `@/lib/utils` e tire o pacote `cn` com `bun remove cn`. `git diff package.json` tem de vir sem pacote novo além das dependências do componente.
- Processo externo só por `nucleo/processos`. `bun:sqlite` só em `nucleo/banco`. `Bun.secrets` só em `nucleo/cofre`. `testes/conferencias/fronteiras.test.ts` reprova o resto.

## Drizzle

O esquema do núcleo está em `nucleo/banco/esquema.ts`. As migrações do núcleo são SQL gerado em `nucleo/banco/migracoes`. Não há `drizzle.config.ts`: os caminhos vão na linha de comando.

```sh
bunx drizzle-kit generate --dialect sqlite --schema nucleo/banco/esquema.ts --out nucleo/banco/migracoes
```

Isso vale só para o núcleo, que é da Profills. O vendedor escreve as dele à mão em `meu/migracoes` (skill `secretaria-estender`). Nenhuma das duas trilhas usa `drizzle-kit push` nem `migrate`: quem aplica é `nucleo/banco/migrar.ts`, no boot do servidor e em `bun secretaria instalar`.

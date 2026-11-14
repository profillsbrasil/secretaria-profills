import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PREFIXO_DO_VENDEDOR } from "../../nucleo/instalador/skills";

const REPO = join(import.meta.dir, "..", "..");
const SKILLS = join(REPO, ".agents", "skills");

/**
 * O repo é público e o agente do vendedor obedece ao que está nele. Uma permissão que aprova
 * sozinha, um MCP do projeto ou uma skill que pré-aprova comando mudam o que o agente roda sem
 * perguntar ao vendedor, então qualquer uma delas passa por revisão antes de entrar.
 */
const CHAVES_DO_SETTINGS = { raiz: ["$schema", "permissions"], permissions: ["ask", "deny"] };

function frontmatter(texto: string): string {
  const casamento = /^---\r?\n([\s\S]*?)\r?\n---/.exec(texto);
  return casamento?.[1] ?? "";
}

describe("instruções aos agentes", () => {
  test(".claude/settings.json só nega e pergunta: nada aprova sozinho", () => {
    const settings = JSON.parse(readFileSync(join(REPO, ".claude", "settings.json"), "utf8")) as { permissions?: Record<string, unknown> };
    expect(Object.keys(settings).sort()).toEqual(CHAVES_DO_SETTINGS.raiz);
    expect(Object.keys(settings.permissions ?? {}).sort()).toEqual(CHAVES_DO_SETTINGS.permissions);
  });

  test("nenhum .mcp.json está versionado", () => {
    const git = Bun.spawnSync(["git", "ls-files", "--", ".mcp.json", "**/.mcp.json"], { cwd: REPO });
    if (git.exitCode !== 0) throw new Error(`git ls-files falhou: ${git.stderr.toString()}`);
    expect(git.stdout.toString().trim()).toBe("");
  });

  test("nenhuma skill de .agents/skills pré-aprova ferramenta no frontmatter", () => {
    const daProfills = readdirSync(SKILLS).filter((nome) => !nome.startsWith(PREFIXO_DO_VENDEDOR));
    expect(daProfills.length).toBeGreaterThan(8);
    const comAllowedTools = daProfills.filter((nome) => /^allowed-tools\s*:/m.test(frontmatter(readFileSync(join(SKILLS, nome, "SKILL.md"), "utf8"))));
    expect(comAllowedTools).toEqual([]);
  });

  test("o CLI do shadcn vem travado no package.json", () => {
    const pacote = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { devDependencies?: Record<string, string> };
    expect(pacote.devDependencies?.shadcn).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("nenhuma SKILL.md de .agents/skills manda baixar o shadcn@latest", () => {
    const comLatest = readdirSync(SKILLS).filter((nome) => readFileSync(join(SKILLS, nome, "SKILL.md"), "utf8").includes("shadcn@latest"));
    expect(comLatest).toEqual([]);
  });

  // O registro do shadcn entrega componentes com `import { cn } from "cn"`, e o pacote `cn` chega
  // ao node_modules pelo próprio CLI: o import compila sem aviso. O painel usa o `cn` de @/lib/utils.
  test("nenhum arquivo do painel importa o pacote cn", () => {
    const comPacoteCn = [...new Bun.Glob("**/*.{ts,tsx}").scanSync(join(REPO, "nucleo", "painel"))].filter((arquivo) =>
      /from\s+["']cn(\/[^"']*)?["']/.test(readFileSync(join(REPO, "nucleo", "painel", arquivo), "utf8")),
    );
    expect(comPacoteCn).toEqual([]);
  });
});

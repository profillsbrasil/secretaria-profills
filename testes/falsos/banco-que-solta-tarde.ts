/**
 * O servidor do Windows visto de fora: o `TerminateProcess` mata o pid, e o sistema solta o lock do
 * banco só depois, quando sobra tempo (documentação do `UnlockFileEx`). No Linux o lock some junto
 * com o processo, então aqui um processo segura os dois bancos e anuncia no `servidor.json` e no
 * `servidor.pid` o pid de um filho. Quando o filho morre, os bancos ficam presos por mais `<ms>`
 * antes de soltar.
 *
 * Uso: `bun banco-que-solta-tarde.ts <pasta de dados> <ms>`. Escreve `pronto` quando segura os bancos.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { abrirExclusivo } from "../../nucleo/banco/abrir";
import { horaDeInicio } from "../../nucleo/processos";

const [dirDados = "", atrasoMs = "0"] = process.argv.slice(2);
const bancos = [abrirExclusivo(join(dirDados, "secretaria.db")), abrirExclusivo(join(dirDados, "meu.db"))];
const anunciado = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 60_000)"], { stdio: ["ignore", "ignore", "ignore"] });
writeFileSync(join(dirDados, "servidor.json"), JSON.stringify({ v: 1, origem: "http://127.0.0.1:9", pid: anunciado.pid }));
writeFileSync(join(dirDados, "servidor.pid"), JSON.stringify({ v: 1, pid: anunciado.pid, inicio: horaDeInicio(anunciado.pid) }));
process.stdout.write("pronto\n");
await anunciado.exited;
await Bun.sleep(Number(atrasoMs));
for (const banco of bancos) banco.close(true);

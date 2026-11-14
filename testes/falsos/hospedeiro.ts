/**
 * Processo que hospeda os conectores de produção, para o teste poder matá-lo sem aviso.
 * Roda como `[process.execPath, "testes/falsos/hospedeiro.ts", <arquivo de pedido>]`,
 * executa as ações do pedido e escreve em stdout uma linha JSON por retrato dos conectores.
 */
import { readFileSync } from "node:fs";
import { abrirCofre } from "../../nucleo/cofre";
import { criarConectores } from "../../nucleo/conectores";
import { instante, type Acao, type Fase, type IdConectorUnico } from "../../nucleo/dominio";
import { criarRegistro } from "../../nucleo/registro";
import { abrirOBanco, esperar, montarAmbiente } from "./bancada";

export interface PedidoAoHospedeiro {
  readonly dirDados: string;
  readonly dirFalso: string;
  readonly dirVazio: string;
  readonly crmRecurso: string | null;
  readonly crmClientId: string | null;
  readonly caExtra: string | null;
  /** `naFase` segura a ação até o conector chegar àquela fase. As de e-mail acham a conta pelo rótulo. */
  readonly acoes: readonly AcaoDoHospedeiro[];
}

export type AcaoDoHospedeiro =
  | { readonly id: IdConectorUnico; readonly acao: Acao; readonly dados?: unknown; readonly naFase?: Fase }
  | { readonly email: "adicionar"; readonly dados: unknown }
  | { readonly email: Acao; readonly rotulo: string; readonly dados?: unknown };

if (import.meta.main) {
  const pedido = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8")) as PedidoAoHospedeiro;
  const agora = () => instante(new Date());
  const ambiente = montarAmbiente(
    pedido.dirDados,
    pedido.dirFalso,
    {
      ...(pedido.crmRecurso === null ? {} : { crmRecurso: new URL(pedido.crmRecurso) }),
      crmClientId: pedido.crmClientId === null ? null : new URL(pedido.crmClientId),
      caExtra: pedido.caExtra,
    },
    agora,
  );
  const banco = abrirOBanco(pedido.dirDados, pedido.dirVazio, agora());
  const cofre = abrirCofre({ backend: "arquivo", idInstalacao: "bancada", dirDados: pedido.dirDados });
  const registro = criarRegistro({ escrever: () => {}, agora });
  const conectores = criarConectores(ambiente, banco, cofre, { registro, sincronizacaoAutomatica: false });
  const contar = () => process.stdout.write(JSON.stringify(conectores.estado()) + "\n");
  conectores.assinar(contar);
  await conectores.pronto;
  contar();
  for (const passo of pedido.acoes) {
    if ("id" in passo) {
      const { id, acao, dados, naFase } = passo;
      if (naFase !== undefined) await esperar(conectores, (estados) => estados[id].fase === naFase, naFase);
      await conectores.agir(id, acao, dados);
    } else if (passo.email === "adicionar") {
      await conectores.email.adicionar(passo.dados);
    } else {
      const { rotulo, email: acao, dados } = passo;
      const conta = conectores.estado().email.contas.find((c) => c.rotulo === rotulo);
      if (conta !== undefined) await conectores.email.agir(conta.id, acao, dados);
    }
    contar();
  }
  // Fica de pé até o teste matar o processo.
  setInterval(() => {}, 60_000);
}

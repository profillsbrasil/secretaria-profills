import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  INTERVALO_DO_AGENTE_MS,
  buscarVersao,
  deveBuscar,
  estadoDaAtualizacao,
  lerConferenciaGuardada,
  lerResposta,
  type Conferencia,
  type EstadoDaAtualizacao,
  type EstadoDaDescoberta,
  type FonteDasVersoes,
  type Impedimento,
  type VersaoPublicada,
} from "../atualizacao";
import { gravarConferenciaDeVersao, lerConferenciaDeVersao, type BancoAberto } from "../banco";
import { detalheComoDado, falha, ok, textoExterno, type Instante, type Resultado } from "../dominio";
import type { Registro } from "../registro";
import type { Aplicador } from "./aplicacao";
import type { Chamador } from "./guarda";
import { respostaJson, type Rota } from "./rotas";

export interface Descoberta {
  /** O estado da última conferência, sem buscar. */
  estado(): EstadoDaDescoberta;
  /** O painel abriu: busca só quando `deveBuscar` manda. */
  aoAbrirOPainel(): Promise<EstadoDaDescoberta>;
  /** Busca agora. Dois pedidos ao mesmo tempo dividem a mesma busca. */
  conferir(): Promise<EstadoDaDescoberta>;
  /** Segundos que o agente ainda espera para pedir outra conferência; 0 quando pode. */
  esperaDoAgenteS(): number;
}

/** O que o `diagnostico` mostra da atualização: sem o O que muda, que é texto de fora. */
export interface AtualizacaoNoDiagnostico {
  readonly fase: EstadoDaAtualizacao["fase"];
  readonly versaoNova: string | null;
  readonly impedimento: Impedimento | null;
  readonly ultimaConferencia: string | null;
}

export function criarDescoberta(deps: {
  readonly banco: BancoAberto;
  readonly registro: Registro;
  readonly fonte: FonteDasVersoes;
  readonly instalada: string;
  readonly dirRepo: string;
  agora(): Instante;
}): Descoberta {
  const instalacao = { instalada: deps.instalada, bun: Bun.version, desenvolvimento: existsSync(join(deps.dirRepo, ".git")) };
  const ultima = (): Conferencia | null => {
    const linha = lerConferenciaDeVersao(deps.banco);
    return linha === null ? null : lerConferenciaGuardada(linha.em, linha.resultado);
  };
  const estado = () => estadoDaAtualizacao(ultima(), instalacao);

  let emCurso: Promise<EstadoDaDescoberta> | null = null;
  const conferir = (): Promise<EstadoDaDescoberta> => {
    emCurso ??= (async () => {
      try {
        const em = deps.agora();
        const resposta = await buscarVersao(deps.fonte);
        const { resultado, aviso } = await lerResposta(resposta, { instalada: deps.instalada, chaves: deps.fonte.chaves });
        if (aviso !== null) deps.registro.aviso("atualizacao.busca_com_aviso", { motivo: aviso });
        gravarConferenciaDeVersao(deps.banco, em, resultado);
        return estado();
      } finally {
        emCurso = null;
      }
    })();
    return emCurso;
  };

  return {
    estado,
    conferir,
    aoAbrirOPainel: () => (emCurso !== null || deveBuscar(ultima(), deps.agora()) ? conferir() : Promise.resolve(estado())),
    esperaDoAgenteS() {
      const anterior = ultima();
      if (anterior === null) return 0;
      const passou = Date.parse(deps.agora()) - Date.parse(anterior.em);
      return passou >= 0 && passou < INTERVALO_DO_AGENTE_MS ? Math.ceil((INTERVALO_DO_AGENTE_MS - passou) / 1000) : 0;
    },
  };
}

/** O "O que muda" chega ao agente como dado citado: veio da rede, mesmo assinado. */
export function estadoPara(estado: EstadoDaAtualizacao, chamador: Chamador): EstadoDaAtualizacao {
  if (chamador !== "agente") return estado;
  const citada = (nova: VersaoPublicada): VersaoPublicada => ({ ...nova, oQueMuda: nova.oQueMuda.map((frase) => detalheComoDado(textoExterno(frase))) });
  return estado.fase === "versao_nova" || estado.fase === "falhou" ? { ...estado, nova: citada(estado.nova) } : estado;
}

/** A fase é a do estado inteiro; a hora da última conferência e o impedimento são os da descoberta. */
export function atualizacaoNoDiagnostico(estado: EstadoDaAtualizacao, descoberta: EstadoDaDescoberta): AtualizacaoNoDiagnostico {
  const versaoNova = estado.fase === "versao_nova" ? estado.nova.versao : estado.fase === "atualizando" || estado.fase === "falhou" ? estado.para : null;
  return {
    fase: estado.fase,
    versaoNova,
    impedimento: descoberta.fase === "versao_nova" ? descoberta.impedimento : null,
    ultimaConferencia: descoberta.fase === "em_dia" || descoberta.fase === "versao_nova" ? descoberta.conferidaEm : descoberta.fase === "sem_internet" ? descoberta.tentadaEm : null,
  };
}

function cedoDemais(esperaS: number): Resultado<never> {
  const recusa = falha("conferir_cedo_demais");
  return recusa.ok ? recusa : { ok: false, erro: { ...recusa.erro, esperaS } };
}

const SO_O_VENDEDOR_ATUALIZA =
  "Atualizar a Secretária é decisão do vendedor, no painel. Conte a ele o que muda e que a Secretária fica uns minutos fora do ar enquanto troca de versão.";

/** O erro do aplicar leva o estado em `atual`; ao agente, com o O que muda citado como dado. */
function recusaPara(resultado: Resultado<EstadoDaAtualizacao>, chamador: Chamador): Resultado<EstadoDaAtualizacao> {
  if (resultado.ok) return ok(estadoPara(resultado.dados, chamador));
  const { atual } = resultado.erro;
  return atual === undefined ? resultado : { ok: false, erro: { ...resultado.erro, atual: estadoPara(atual as EstadoDaAtualizacao, chamador) } };
}

/** Ler, conferir e aplicar. Aplicar é só do painel: o agente recebe `so_no_painel`. */
export function montarRotasDeAtualizacao(descoberta: Descoberta, aplicador: Aplicador): readonly Rota[] {
  return [
    {
      metodo: "GET",
      caminho: "/api/atualizacao",
      quem: ["painel", "agente"],
      async tratar({ chamador, url }) {
        // A releitura é o painel já aberto atrás de outro bloqueio: abrir o painel é só o carregamento da página.
        if (chamador === "painel" && url.searchParams.get("releitura") !== "1") await descoberta.aoAbrirOPainel();
        return respostaJson(ok(estadoPara(aplicador.estado(), chamador)), chamador);
      },
    },
    {
      metodo: "POST",
      caminho: "/api/atualizacao/conferir",
      quem: ["painel", "agente"],
      async tratar({ chamador }) {
        const espera = chamador === "agente" ? descoberta.esperaDoAgenteS() : 0;
        if (espera > 0) return respostaJson(cedoDemais(espera), chamador);
        await descoberta.conferir();
        return respostaJson(ok(estadoPara(aplicador.estado(), chamador)), chamador);
      },
    },
    {
      metodo: "POST",
      caminho: "/api/atualizacao/aplicar",
      quem: ["painel", "agente"],
      tratar({ req, chamador }) {
        if (chamador !== "painel") return respostaJson(falha("so_no_painel", SO_O_VENDEDOR_ATUALIZA), chamador);
        return respostaJson(recusaPara(aplicador.aplicar(req.headers.get("cookie")), chamador), chamador);
      },
    },
  ];
}

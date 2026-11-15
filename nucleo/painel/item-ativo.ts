interface Caixa {
  getBoundingClientRect(): { readonly top: number; readonly bottom: number };
}

export interface AreaQueRola extends Caixa {
  scrollTop: number;
  querySelector(seletor: string): Caixa | null;
}

interface Observador {
  observe(alvo: AreaQueRola): void;
  disconnect(): void;
}

type CriarObservador = new (aviso: () => void) => Observador;

/**
 * Rola só a área, o mínimo para o item ativo caber. O `scrollIntoView` rolaria também a página
 * e animaria conforme o CSS; mexer no `scrollTop` não move a página nem o foco.
 */
function mostrarItemAtivo(area: AreaQueRola): void {
  const item = area.querySelector('[aria-current="page"]');
  if (item === null) return;
  const visivel = area.getBoundingClientRect();
  const alvo = item.getBoundingClientRect();
  if (alvo.top < visivel.top) area.scrollTop -= visivel.top - alvo.top;
  else if (alvo.bottom > visivel.bottom) area.scrollTop += alvo.bottom - visivel.bottom;
}

/**
 * Mantém o item ativo do menu à vista. A área encolhe quando o cartão do pé cresce ou a janela baixa,
 * e o `ResizeObserver` avisa nesses casos e logo ao começar, o que cobre a troca de tela.
 */
export function vigiarItemAtivo(area: AreaQueRola, Criar: CriarObservador = ResizeObserver): () => void {
  const observador = new Criar(() => mostrarItemAtivo(area));
  observador.observe(area);
  return () => observador.disconnect();
}

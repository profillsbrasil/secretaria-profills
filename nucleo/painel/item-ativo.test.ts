import { describe, expect, test } from "bun:test";
import { vigiarItemAtivo, type AreaQueRola } from "./item-ativo";

/** Um menu de 400 px de conteúdo com o item ativo de 360 a 398, numa área que começa em 58 na tela. */
function menu(altura: number, ativo: { top: number; bottom: number } | null = { top: 360, bottom: 398 }) {
  const area = {
    altura,
    scrollTop: 0,
    getBoundingClientRect: () => ({ top: 58, bottom: 58 + area.altura }),
    querySelector: (seletor: string) =>
      seletor === '[aria-current="page"]' && ativo !== null ? { getBoundingClientRect: () => ({ top: 58 + ativo.top - area.scrollTop, bottom: 58 + ativo.bottom - area.scrollTop }) } : null,
  };
  return area;
}

/** O ResizeObserver do navegador avisa ao começar a observar e a cada mudança de tamanho; aqui o teste avisa. */
function observadorFalso() {
  const vivos: { avisar(): void; observando: unknown[] }[] = [];
  class Observador {
    observando: unknown[] = [];
    constructor(private readonly aviso: () => void) {
      vivos.push(this);
    }
    observe(alvo: unknown) {
      this.observando.push(alvo);
    }
    disconnect() {
      this.observando = [];
    }
    avisar() {
      if (this.observando.length > 0) this.aviso();
    }
  }
  return { Observador, avisarTodos: () => vivos.forEach((vivo) => vivo.avisar()) };
}

function vigiar(area: AreaQueRola) {
  const falso = observadorFalso();
  const parar = vigiarItemAtivo(area, falso.Observador);
  falso.avisarTodos();
  return { parar, avisar: falso.avisarTodos };
}

describe("item ativo do menu à vista", () => {
  test("ao começar, a área rola o mínimo para o item ativo caber embaixo", () => {
    const area = menu(326);
    vigiar(area);
    expect(area.scrollTop).toBe(398 - 326);
  });

  test("quando a área encolhe, porque o cartão do pé cresceu ou a janela baixou, o item volta à vista", () => {
    const area = menu(400);
    const { avisar } = vigiar(area);
    expect(area.scrollTop).toBe(0);
    area.altura = 246;
    avisar();
    expect(area.scrollTop).toBe(398 - 246);
  });

  test("o item acima do que se vê faz a área subir até ele", () => {
    const area = menu(200, { top: 20, bottom: 54 });
    area.scrollTop = 100;
    vigiar(area);
    expect(area.scrollTop).toBe(20);
  });

  test("o item já à vista não move a rolagem que o vendedor escolheu", () => {
    const area = menu(300, { top: 120, bottom: 150 });
    area.scrollTop = 40;
    vigiar(area);
    expect(area.scrollTop).toBe(40);
  });

  test("sem item ativo, nada rola", () => {
    const area = menu(100, null);
    area.scrollTop = 30;
    vigiar(area);
    expect(area.scrollTop).toBe(30);
  });

  test("depois de parar, mudar o tamanho não rola mais", () => {
    const area = menu(400);
    const { parar, avisar } = vigiar(area);
    parar();
    area.altura = 246;
    avisar();
    expect(area.scrollTop).toBe(0);
  });
});

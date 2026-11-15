export type PapelDaChave = "ativa" | "reserva";

/** Chave pública Ed25519 de quem pode assinar uma versão: os 32 bytes em base64. */
export interface ChavePublica {
  readonly papel: PapelDaChave;
  readonly publica: string;
}

/**
 * As chaves que esta instalação aceita. A ativa assina no workflow de release; a reserva fica
 * fora do GitHub e só assina a versão que troca a ativa. Lista vazia recusa toda versão.
 * Como gerar e cadastrar: `docs/arquitetura.md`, seção "Chaves de assinatura".
 */
export const CHAVES_PUBLICAS: readonly ChavePublica[] = [
  { papel: "ativa", publica: "X+A+9QrCu3g7Y3Ty1hrelht9QWwplrtiP1BnkWOpE3Q=" },
  { papel: "reserva", publica: "zM0h3uhXRuNG8HZN8e7IXHco1z6u5jwVtDZIr0r5JWE=" },
];

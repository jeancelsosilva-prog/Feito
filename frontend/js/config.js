// Configuração do frontend. Estes são os ÚNICOS três valores que você precisa editar
// antes de publicar (ver README.md, seção "Configurar a URL da API").
//
// Nenhum segredo mora aqui — tudo neste arquivo é necessariamente público, pois roda no
// navegador do usuário. A chave privada VAPID NUNCA deve aparecer neste arquivo.

export const CONFIG = {
  // URL base da API do Cloudflare Worker, SEM barra no final.
  // Exemplo: 'https://feito-app-api.seu-usuario.workers.dev'
  API_BASE_URL: 'https://feito-app-api.SEU-SUBDOMINIO.workers.dev',

  // Chave pública VAPID (a mesma cadastrada no backend em wrangler.toml VAPID_PUBLIC_KEY).
  VAPID_PUBLIC_KEY: 'COLE_AQUI_A_MESMA_CHAVE_PUBLICA_DO_WRANGLER_TOML',

  // Nome curto exibido em alguns lugares da UI.
  APP_NAME: 'Feito?',

  // Versão do app — usada para exibir o número em Ajustes e como parte do cache do Service
  // Worker (ver sw.js). Atualize ao publicar mudanças relevantes.
  APP_VERSION: '1.0.0'
};

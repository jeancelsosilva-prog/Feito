import { route } from './router.js';
import { runReminderSweep, runMaintenance } from './cron.js';

// Dois Cron Triggers distintos (ver wrangler.toml [triggers] crons):
//   "* * * * *"  -> varredura de lembretes, a cada minuto (runReminderSweep)
//   "0 * * * *"  -> manutenção (limpeza de logs antigos, expiração de abandonadas), 1x/hora
//
// Antes isso era decidido por um contador em memória (`tickCount % 60`). Isso é frágil em
// um runtime serverless: o isolate do Worker pode ser reciclado/recriado pela Cloudflare a
// qualquer momento (inclusive entre dois disparos consecutivos do cron), o que zera o
// contador e faz a manutenção rodar bem mais ou bem menos que "uma vez por hora" — sem
// garantia nenhuma. Usar dois Cron Triggers separados e o campo `event.cron` (que identifica
// qual expressão disparou aquela execução) não depende de estado nenhum guardado em memória.
export default {
  async fetch(request, env, ctx) {
    return route(request, env);
  },

  async scheduled(event, env, ctx) {
    if (event.cron === '0 * * * *') {
      ctx.waitUntil(runMaintenance(env));
      return;
    }
    // Qualquer outro cron cadastrado (o "* * * * *" de todo minuto) dispara a varredura.
    ctx.waitUntil(runReminderSweep(env));
  }
};

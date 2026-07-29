# Testes do "Feito?"

Todos os testes rodam com Node puro (sem Jest/Vitest) para manter o repositório enxuto.
Requer **Node 22 ou mais recente** (usa `node:sqlite`, ainda experimental — os avisos
`ExperimentalWarning` no terminal são esperados e inofensivos).

## Rodar tudo

```bash
node tests/run-all.mjs
```

## Rodar um arquivo específico

```bash
node tests/unit/time.test.mjs
node tests/unit/messages.test.mjs
node tests/unit/reminderEngine.test.mjs
node tests/unit/cron.test.mjs
node tests/unit/completeVsSend.test.mjs
node tests/unit/webpush.test.mjs
node tests/unit/webpushFailures.test.mjs
node tests/unit/vapid.test.mjs
node tests/api/api.test.mjs
```

Todos os testes que precisam de um banco carregam o schema com `loadFullSchemaSql()`
(`tests/api/fakeD1.mjs`), que lê e concatena **todas** as migrations de `backend/migrations/`
em ordem — não só `0001_init.sql`. Ao adicionar uma migration nova, os testes já passam a
rodar contra o schema atualizado automaticamente, sem precisar editar cada arquivo de teste.

## O que cada teste cobre

- **time.test.mjs** — horário silencioso (janelas que cruzam a meia-noite, limites exatos,
  janela desativada) e aritmética de datas.
- **messages.test.mjs** — seleção de estágio da mensagem e a regra de nunca repetir a mesma
  mensagem duas vezes seguidas.
- **reminderEngine.test.mjs** — cálculo de intervalo por intensidade (leve/normal/insistente),
  reforço de presença em casa, adiamento por horário silencioso, e a corrida entre duas
  execuções simultâneas do CRON sobre a mesma tarefa vencida (não podem gerar dois envios de
  push). Roda contra um D1 real (SQLite em memória via `node:sqlite`).
- **cron.test.mjs** — fumaça dos pontos de entrada reais do Worker agendado
  (`runReminderSweep` e `runMaintenance` de `backend/worker/src/cron.js`), e do roteamento de
  `src/index.js` `scheduled()` entre os dois Cron Triggers (`"* * * * *"` vs `"0 * * * *"`)
  via `event.cron` — nenhum desses pontos é exercitado pelos outros testes.
- **completeVsSend.test.mjs** — a OUTRA corrida da seção 16 do briefing, diferente da de
  `reminderEngine.test.mjs`: `handleCompleteTask()` (o handler real de
  `POST /api/tasks/:id/complete`, via `router.js`) disparado concorrentemente com
  `processDueTask()` real, 30 rodadas com bancos frescos. Mede a distribuição das duas ordens
  possíveis e comprova que o estado final da tarefa no banco é sempre `completed`,
  independentemente de quem "chegou primeiro".
- **webpush.test.mjs** — round-trip de criptografia RFC 8291 (aes128gcm): criptografa com o
  código real do Worker e descriptografa com uma implementação de referência independente
  (Node `crypto`), confirmando que o payload chega intacto.
- **webpushFailures.test.mjs** — respostas do push service: 201 (sucesso), 404/410
  (assinatura morta — `is_valid` deve zerar), 429/500/503 e erro de rede (falhas transitórias
  — a assinatura deve continuar válida). Também valida a classificação `PushSendError.isPermanent`.
- **vapid.test.mjs** — o JWT VAPID (ES256) gerado pelo Worker é validado por uma verificação
  de assinatura independente.
- **api/api.test.mjs** — exercita os handlers reais da API (`backend/worker/src/router.js`)
  fim a fim: autenticação por token de instalação, CORS restrito à origem configurada, CRUD e
  transições de tarefa (criar/ler/pausar/retomar/concluir/cancelar/home-boost), push
  (subscribe/unsubscribe/test), paginação real do histórico (com `limit`/`cursor` forçando
  duas páginas), validação de payloads inválidos (enum, datas, JSON malformado), e
  idempotência — incluindo replay com o mesmo payload, rejeição de payload divergente, e
  rejeição de reuso da mesma chave entre tarefas diferentes.

## O que NÃO está coberto aqui (e como testar)

Estes testes não sobem o runtime real do Cloudflare Workers nem enviam push de verdade.
Para validar isso:

1. **Localmente, com o Worker real**: `cd backend/worker && npm run dev` (usa
   `wrangler dev`, que roda o Worker de verdade com um D1 local). Use `curl` ou o app
   publicado apontando para `http://127.0.0.1:8787` para testar as rotas de ponta a ponta.
2. **Push de verdade em um iPhone**: siga o checklist manual em `docs/IPHONE-TEST-CHECKLIST.md`.
   Não existe forma de testar Web Push no Safari/iOS fora de um dispositivo real — o
   simulador do Xcode e navegadores desktop não reproduzem o comportamento do Safari iOS.

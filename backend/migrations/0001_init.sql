-- Migration 0001: schema inicial do "Feito?"
-- Todas as datas são armazenadas em UTC no formato ISO 8601 (ex: 2026-07-26T17:12:00.000Z).
-- O frontend é responsável por converter para o fuso horário local na exibição.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  applied_at  TEXT NOT NULL
);

-- Uma "instalação" representa um dispositivo/navegador único (sem login/conta).
CREATE TABLE IF NOT EXISTS installations (
  id              TEXT PRIMARY KEY,       -- installationId gerado no cliente (UUID v4)
  token_hash      TEXT NOT NULL,          -- hash SHA-256 do token secreto de autenticação da instalação
  timezone        TEXT,                   -- IANA timezone informado pelo cliente (ex: America/Sao_Paulo), best-effort
  platform        TEXT,                   -- 'ios-standalone' | 'ios-safari' | 'other'
  app_version     TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL
);

-- Assinatura Web Push (endpoint + chaves) associada a uma instalação.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  installation_id   TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  endpoint          TEXT NOT NULL UNIQUE,
  p256dh            TEXT NOT NULL,
  auth              TEXT NOT NULL,
  is_valid          INTEGER NOT NULL DEFAULT 1,  -- 0 quando o endpoint expirou/foi rejeitado pelo push service
  last_error        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_installation
  ON push_subscriptions(installation_id);

-- Tarefas temporizadas (o coração do produto).
CREATE TABLE IF NOT EXISTS tasks (
  id                        TEXT PRIMARY KEY,     -- UUID v4 gerado pelo backend
  installation_id           TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  module                    TEXT NOT NULL,        -- ex: 'laundry'
  task_type                 TEXT NOT NULL,        -- ex: 'take_out_machine' | 'hang_dry' | 'take_out_dryer' | 'custom'
  custom_title              TEXT,                 -- usado quando task_type = 'custom'
  started_at                TEXT NOT NULL,         -- UTC ISO
  first_reminder_at         TEXT NOT NULL,         -- UTC ISO
  next_reminder_at          TEXT,                  -- UTC ISO, NULL quando não há próximo lembrete agendado
  repeat_interval_minutes   INTEGER NOT NULL,
  intensity                 TEXT NOT NULL DEFAULT 'normal', -- 'light' | 'normal' | 'insistent'
  quiet_hours_enabled       INTEGER NOT NULL DEFAULT 1,
  quiet_hours_start         TEXT,                  -- 'HH:MM' local, ex: '22:30'
  quiet_hours_end           TEXT,                  -- 'HH:MM' local, ex: '07:00'
  quiet_hours_timezone      TEXT,                  -- IANA timezone usado para interpretar quiet hours
  status                    TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | reminding | completed | cancelled | paused
  reminder_count            INTEGER NOT NULL DEFAULT 0,
  last_notification_at      TEXT,
  last_message_key          TEXT,                  -- evita repetir a mesma mensagem duas vezes seguidas
  home_boost_until          TEXT,                   -- UTC ISO; enquanto ativo, cadência é intensificada
  completed_at              TEXT,
  cancelled_at              TEXT,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL
);

-- Índice composto essencial para o cron: busca tarefas vencidas por status.
-- Mantém a query performática mesmo se o motor migrar para Durable Object Alarms no futuro
-- (o índice continua útil para telas de histórico/depuração).
CREATE INDEX IF NOT EXISTS idx_tasks_status_next_reminder
  ON tasks(status, next_reminder_at);

CREATE INDEX IF NOT EXISTS idx_tasks_installation
  ON tasks(installation_id, status);

-- Histórico de notificações enviadas (para depuração, anti-duplicação e métricas do Histórico).
CREATE TABLE IF NOT EXISTS notification_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id           TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  installation_id   TEXT NOT NULL,
  stage             TEXT NOT NULL,      -- 'first' | 'follow_up' | 'later' | 'home_boost'
  message_key       TEXT NOT NULL,      -- identifica qual mensagem do pool foi usada
  sent_at           TEXT NOT NULL,
  success            INTEGER NOT NULL DEFAULT 1,
  error             TEXT,
  idempotency_key   TEXT NOT NULL UNIQUE  -- taskId + reminder_count no momento do envio: impede envio duplicado
);

CREATE INDEX IF NOT EXISTS idx_notification_log_task
  ON notification_log(task_id);

-- Chaves de idempotência para requisições de escrita da API pública (POST /api/tasks etc).
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key               TEXT PRIMARY KEY,     -- enviado pelo cliente no header Idempotency-Key
  installation_id   TEXT NOT NULL,
  endpoint          TEXT NOT NULL,
  response_status   INTEGER NOT NULL,
  response_body     TEXT NOT NULL,
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_idempotency_created_at
  ON idempotency_keys(created_at);

-- Controle simples de rate limiting (janela deslizante por instalação + rota).
CREATE TABLE IF NOT EXISTS rate_limit_events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  installation_id  TEXT NOT NULL,
  route            TEXT NOT NULL,
  created_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_lookup
  ON rate_limit_events(installation_id, route, created_at);

INSERT INTO schema_migrations (version, applied_at) VALUES (1, datetime('now'));

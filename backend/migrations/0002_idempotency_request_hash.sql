-- Migration 0002: guarda um hash do payload junto de cada Idempotency-Key.
-- Sem isso, reusar a mesma chave com um corpo de requisição DIFERENTE devolvia
-- silenciosamente a resposta da primeira chamada (que pode ter sido para uma tarefa
-- completamente diferente). Ver backend/worker/src/lib/idempotency.js.

ALTER TABLE idempotency_keys ADD COLUMN request_hash TEXT;

INSERT INTO schema_migrations (version, applied_at) VALUES (2, datetime('now'));

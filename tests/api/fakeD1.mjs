// Implementação mínima da interface do binding D1 (`prepare().bind().run/all/first()`)
// por cima de `node:sqlite` (nativo do Node 22+), usada apenas nos testes deste
// repositório para exercitar os handlers reais do Worker sem precisar subir o
// Cloudflare Workers runtime completo. Não é usada em produção.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Lê e concatena TODAS as migrations de backend/migrations, em ordem de nome de arquivo
 * (0001_..., 0002_..., ...). Usar isto em vez de ler só 0001_init.sql à mão garante que
 * os testes sempre rodam contra o schema completo e atual, sem precisar lembrar de atualizar
 * cada arquivo de teste toda vez que uma migration nova for adicionada.
 */
export function loadFullSchemaSql(migrationsDir) {
  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  return files.map((f) => fs.readFileSync(path.join(migrationsDir, f), 'utf8')).join('\n');
}

export function createFakeD1(schemaSql) {
  const db = new DatabaseSync(':memory:');
  db.exec(schemaSql);

  function makeBound(sql, params) {
    return {
      async run() {
        const stmt = db.prepare(sql);
        const info = stmt.run(...params);
        return { success: true, meta: { last_row_id: info.lastInsertRowid, changes: info.changes } };
      },
      async all() {
        const stmt = db.prepare(sql);
        const rows = stmt.all(...params);
        return { success: true, results: rows };
      },
      async first() {
        const stmt = db.prepare(sql);
        const row = stmt.get(...params);
        return row || null;
      }
    };
  }

  function wrapStatement(sql) {
    const unbound = makeBound(sql, []);
    return {
      bind(...params) {
        return makeBound(sql, params);
      },
      run: unbound.run,
      all: unbound.all,
      first: unbound.first
    };
  }

  return {
    prepare(sql) {
      return wrapStatement(sql);
    },
    _raw: db
  };
}

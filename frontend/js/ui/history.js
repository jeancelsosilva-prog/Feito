// Tela "Histórico" (seção 15 do briefing). Indicadores neutros — nunca valores
// financeiros/ambientais inventados.

import { el } from './components.js';
import { taskTitleFor } from '../modules/registry.js';
import { api } from '../api.js';
import { formatClock } from '../utils/time.js';

let nextCursor = null;
let loadedTasks = [];

export async function renderHistory(container) {
  const list = document.getElementById('history-list');
  const indicatorsRow = document.getElementById('history-indicators');
  const loadMoreBtn = document.getElementById('btn-history-load-more');
  const emptyHint = document.getElementById('history-empty');

  loadedTasks = [];
  nextCursor = null;
  list.innerHTML = '';
  indicatorsRow.innerHTML = '';
  emptyHint.hidden = true;
  loadMoreBtn.hidden = true;

  await loadPage({ list, indicatorsRow, loadMoreBtn, emptyHint });

  loadMoreBtn.onclick = () => loadPage({ list, indicatorsRow, loadMoreBtn, emptyHint, append: true });
}

async function loadPage({ list, indicatorsRow, loadMoreBtn, emptyHint, append = false }) {
  const result = await api.getHistory(append ? nextCursor : undefined);

  if (!result.ok) {
    if (!append) {
      emptyHint.hidden = false;
      emptyHint.textContent = result.offline
        ? 'Você está offline. Conecte-se para ver seu histórico.'
        : 'Não foi possível carregar o histórico agora.';
    }
    return;
  }

  const { tasks, nextCursor: cursor, indicators } = result.data;
  nextCursor = cursor;
  loadedTasks = append ? loadedTasks.concat(tasks) : tasks;

  renderIndicators(indicatorsRow, indicators);

  if (!append) list.innerHTML = '';
  for (const task of tasks) list.appendChild(renderHistoryItem(task));

  emptyHint.hidden = loadedTasks.length > 0;
  loadMoreBtn.hidden = !cursor;
}

function renderIndicators(container, indicators) {
  container.innerHTML = '';
  if (!indicators) return;
  container.appendChild(indicatorPill(String(indicators.completedInPage), 'Concluídas nesta página'));
  container.appendChild(indicatorPill(String(indicators.completedBeforeThirdReminder), 'Resolvidas antes do 3º aviso'));
  container.appendChild(indicatorPill(String(indicators.averageRemindersPerTask), 'Média de avisos por tarefa'));
}

function indicatorPill(value, label) {
  return el('div', { class: 'indicator-pill' }, [
    el('span', { class: 'value', text: value }),
    el('span', { class: 'label', text: label })
  ]);
}

function renderHistoryItem(task) {
  const isCancelled = task.status === 'cancelled';
  const dateLabel = new Date(task.created_at).toLocaleDateString(undefined, { day: '2-digit', month: '2-digit' });

  return el('li', { class: 'history-item' }, [
    el('div', { class: 'history-item-info' }, [
      el('h3', { text: taskTitleFor(task) }),
      el('p', { text: `${dateLabel} · começou às ${formatClock(task.started_at)} · ${task.reminder_count} aviso(s)` })
    ]),
    el('span', {
      class: `history-status-pill${isCancelled ? ' is-cancelled' : ''}`,
      text: isCancelled ? 'Cancelada' : 'Concluída'
    })
  ]);
}

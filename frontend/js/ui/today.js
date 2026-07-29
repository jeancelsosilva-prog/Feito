// Tela "Hoje" — o centro do app (seção 4 do briefing). Mostra o cartão do módulo
// (quando não há tarefa ativa) ou o cartão de acompanhamento (quando há).

import { el, confirmDialog, toast } from './components.js';
import { openStartTaskSheet } from './taskSheet.js';
import { getModule, taskTitleFor, listModules } from '../modules/registry.js';
import { api } from '../api.js';
import { formatClock, formatElapsed } from '../utils/time.js';

let elapsedTimer = null;

export function renderToday(container, { tasks, onTasksChanged, isOnline }) {
  container.innerHTML = '';
  if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }

  const activeTasks = tasks.filter((t) => t.status === 'scheduled' || t.status === 'reminding' || t.status === 'paused');

  if (activeTasks.length === 0) {
    renderEmptyState(container, { onTasksChanged });
    return;
  }

  for (const task of activeTasks) {
    container.appendChild(renderTaskCard(task, { onTasksChanged, isOnline }));
  }

  // Atualiza o "tempo decorrido" a cada 30s sem precisar re-renderizar tudo.
  elapsedTimer = setInterval(() => {
    container.querySelectorAll('[data-elapsed-for]').forEach((elNode) => {
      const startedAt = elNode.getAttribute('data-elapsed-for');
      elNode.textContent = formatElapsed(startedAt);
    });
  }, 30000);
}

function renderEmptyState(container, { onTasksChanged }) {
  for (const mod of listModules()) {
    const card = el('div', { class: 'module-card' }, [
      el('div', { class: 'module-card-icon', text: mod.icon }),
      el('h2', { text: mod.name }),
      el('p', { text: mod.tagline }),
      el('button', {
        class: 'btn btn-primary',
        type: 'button',
        text: `Iniciar ${mod.name === 'Lavanderia' ? 'lavagem' : 'tarefa'}`,
        onclick: () => openStartTaskSheet({
          moduleId: mod.id,
          onCreated: (task) => onTasksChanged()
        })
      })
    ]);
    container.appendChild(card);
  }
}

function isOverdue(task) {
  return task.reminder_count >= 3;
}

function renderTaskCard(task, { onTasksChanged, isOnline }) {
  const mod = getModule(task.module);
  const overdue = isOverdue(task);

  const card = el('div', { class: `task-card${overdue ? ' is-overdue' : ''}` });

  card.appendChild(el('div', { class: 'task-card-eyebrow', text: mod.name }));
  card.appendChild(el('h2', { text: `${taskTitleFor(task)}${overdue ? ' — atrasada' : ' em andamento'}` }));

  const statusLabel = {
    scheduled: 'Aguardando o primeiro aviso',
    reminding: 'Lembrando periodicamente',
    paused: 'Pausada'
  }[task.status] || task.status;
  card.appendChild(el('span', { class: `task-status-pill${task.status === 'reminding' ? ' is-reminding' : ''}`, text: statusLabel }));

  const grid = el('div', { class: 'task-meta-grid' }, [
    metaItem('Começou às', formatClock(task.started_at)),
    metaItem('Tempo decorrido', formatElapsed(task.started_at), { elapsedFor: task.started_at }),
    metaItem('Primeiro aviso', formatClock(task.first_reminder_at)),
    metaItem(task.status === 'scheduled' ? 'Próximo aviso' : 'Próximo aviso estimado', task.next_reminder_at ? formatClock(task.next_reminder_at) : '—'),
    metaItem('Avisos enviados', String(task.reminder_count))
  ]);
  card.appendChild(grid);

  card.appendChild(el('button', {
    class: 'btn btn-complete',
    type: 'button',
    text: mod.completionButtonLabel,
    onclick: () => completeTask(task, mod, { onTasksChanged })
  }));

  const secondaryRow = el('div', { class: 'task-secondary-actions' });
  secondaryRow.appendChild(el('button', {
    class: 'link-home-boost',
    type: 'button',
    text: '📍 Estou em casa',
    onclick: () => homeBoost(task, { onTasksChanged })
  }));
  secondaryRow.appendChild(el('button', {
    class: 'link-cancel',
    type: 'button',
    text: mod.cancelLabel,
    onclick: () => cancelTask(task, { onTasksChanged })
  }));
  card.appendChild(secondaryRow);

  if (!isOnline) {
    card.appendChild(el('p', { class: 'field-hint', text: 'Você está offline — as ações abaixo só funcionam quando a conexão voltar.' }));
  }

  return card;
}

function metaItem(label, value, opts = {}) {
  const valueEl = el('span', { class: 'value', text: value });
  if (opts.elapsedFor) valueEl.setAttribute('data-elapsed-for', opts.elapsedFor);
  return el('div', { class: 'task-meta-item' }, [
    el('span', { class: 'label', text: label }),
    valueEl
  ]);
}

async function completeTask(task, mod, { onTasksChanged }) {
  const result = await api.completeTask(task.id);
  if (!result.ok) {
    toast(result.offline ? 'Sem conexão — a conclusão não foi confirmada pelo servidor ainda.' : (result.error || 'Não foi possível concluir agora.'));
    return;
  }
  toast(mod.completionMessage);
  onTasksChanged();
}

async function cancelTask(task, { onTasksChanged }) {
  const confirmed = await confirmDialog({
    title: 'Cancelar esta tarefa?',
    message: 'Isso encerra o acompanhamento e nenhum novo aviso será enviado. Essa ação não pode ser desfeita.',
    confirmLabel: 'Cancelar tarefa',
    cancelLabel: 'Voltar',
    destructive: true
  });
  if (!confirmed) return;

  const result = await api.cancelTask(task.id);
  if (!result.ok) {
    toast(result.offline ? 'Sem conexão — tente cancelar de novo quando estiver online.' : (result.error || 'Não foi possível cancelar agora.'));
    return;
  }
  toast('Tarefa cancelada.');
  onTasksChanged();
}

async function homeBoost(task, { onTasksChanged }) {
  const result = await api.homeBoost(task.id);
  if (!result.ok) {
    toast(result.offline ? 'Sem conexão — tente de novo em instantes.' : (result.error || 'Não foi possível reforçar agora.'));
    return;
  }
  toast('Reforço ativado por 90 minutos.');
  onTasksChanged();
}

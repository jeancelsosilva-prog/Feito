// Bottom sheet "Iniciar lavagem" (seção 5 do briefing). Otimizado para uso com uma mão:
// chips grandes, horário de início padrão "Agora", resumo em linguagem humana antes de
// confirmar.

import { el, closeSheet, openSheet } from './components.js';
import { getModule } from '../modules/registry.js';
import { api } from '../api.js';
import { formatClock, currentTimeZone, localDateTimeInputToIso, isoToLocalDateTimeInputValue } from '../utils/time.js';
import { sanitizePlainText } from '../utils/sanitize.js';
import { toast } from './components.js';

const MIN_REPEAT_MINUTES = 1;
const MAX_REPEAT_MINUTES = 240;

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60000);
}

export function openStartTaskSheet({ moduleId = 'laundry', onCreated }) {
  const mod = getModule(moduleId);

  const state = {
    taskType: mod.taskTypes[0].id,
    customTitle: '',
    startedAt: new Date(), // objeto Date local; convertido para ISO só no envio
    startedAtManual: false,
    firstReminderMinutes: 60,
    firstReminderCustomIso: null,
    repeatMinutes: mod.defaultRepeatMinutes,
    repeatCustomMinutes: null, // quando preenchido, tem prioridade sobre repeatMinutes
    intensity: mod.defaultIntensity,
    quietHoursEnabled: mod.defaultQuietHours.enabled,
    quietHoursStart: mod.defaultQuietHours.start,
    quietHoursEnd: mod.defaultQuietHours.end
  };

  let submitting = false;
  let containerRef = null;

  openSheet((container) => { containerRef = container; render(container); });

  function computeFirstReminderDate() {
    if (state.firstReminderCustomIso) return new Date(state.firstReminderCustomIso);
    return addMinutes(state.startedAt, state.firstReminderMinutes);
  }

  function effectiveRepeatMinutes() {
    return state.repeatCustomMinutes != null ? state.repeatCustomMinutes : state.repeatMinutes;
  }

  function summaryText() {
    const firstReminder = computeFirstReminderDate();
    return `Você começou às ${formatClock(state.startedAt.toISOString())}. O primeiro aviso chegará às ${formatClock(firstReminder.toISOString())} e será repetido a cada ${effectiveRepeatMinutes()} minutos até você concluir a tarefa.`;
  }

  // Qualquer mudança de estado que afete qual chip aparece selecionado precisa de uma
  // re-renderização completa — atualizar só o texto do resumo deixa os chips "atrasados"
  // em relação ao estado real (bug relatado na revisão: o valor enviado ficava certo, mas
  // a interface continuava mostrando o chip antigo como selecionado).
  function rerender() {
    if (containerRef) render(containerRef);
  }

  function render(container) {
    container.innerHTML = '';

    const errorBox = el('p', { class: 'field-error', id: 'sheet-error' });
    errorBox.hidden = true;

    container.appendChild(el('h2', { text: 'Iniciar lavagem' }));

    // --- Tipo de lembrete ---
    const typeGroup = el('div', { class: 'field-group' }, [
      el('label', { class: 'field-label', text: 'Tipo de lembrete' }),
      el('div', { class: 'chip-row', id: 'chip-row-type' },
        mod.taskTypes.map((t) => chip(t.label, t.id === state.taskType, () => {
          state.taskType = t.id;
          rerender();
        }))
      )
    ]);
    container.appendChild(typeGroup);

    if (state.taskType === 'custom') {
      const customField = el('div', { class: 'field-group' }, [
        el('label', { class: 'field-label', for: 'custom-title-input', text: 'Título da tarefa' }),
        el('input', {
          class: 'text-field',
          id: 'custom-title-input',
          type: 'text',
          maxlength: '80',
          value: state.customTitle,
          placeholder: 'Ex: Retirar roupa de molho',
          oninput: (e) => { state.customTitle = e.target.value; }
        })
      ]);
      container.appendChild(customField);
    }

    // --- Horário de início ---
    const startGroup = el('div', { class: 'field-group' });
    startGroup.appendChild(el('label', { class: 'field-label', text: 'Horário de início' }));
    const startRow = el('div', { class: 'chip-row' }, [
      chip('Agora', !state.startedAtManual, () => {
        state.startedAtManual = false;
        state.startedAt = new Date();
        rerender();
      }),
      chip('Ajustar horário', state.startedAtManual, () => {
        state.startedAtManual = true;
        rerender();
      })
    ]);
    startGroup.appendChild(startRow);
    if (state.startedAtManual) {
      const input = el('input', {
        class: 'time-field',
        type: 'datetime-local',
        value: isoToLocalDateTimeInputValue(state.startedAt.toISOString()),
        style: 'margin-top:10px;',
        onchange: (e) => {
          const iso = localDateTimeInputToIso(e.target.value);
          if (iso) state.startedAt = new Date(iso);
          renderSummaryOnly();
        }
      });
      startGroup.appendChild(input);
    }
    container.appendChild(startGroup);

    // --- Primeiro aviso ---
    const firstGroup = el('div', { class: 'field-group' }, [
      el('label', { class: 'field-label', text: 'Quando o primeiro aviso deve chegar' }),
      el('div', { class: 'chip-row' },
        mod.firstReminderChipsMinutes.map((m) => chip(`${m} min`, !state.firstReminderCustomIso && state.firstReminderMinutes === m, () => {
          state.firstReminderMinutes = m;
          state.firstReminderCustomIso = null;
          rerender();
        })).concat([
          chip('Escolher horário', Boolean(state.firstReminderCustomIso), () => {
            state.firstReminderCustomIso = computeFirstReminderDate().toISOString();
            rerender();
          })
        ])
      )
    ]);
    container.appendChild(firstGroup);

    if (state.firstReminderCustomIso) {
      const customTimeInput = el('input', {
        class: 'time-field',
        type: 'datetime-local',
        value: isoToLocalDateTimeInputValue(state.firstReminderCustomIso),
        onchange: (e) => {
          const iso = localDateTimeInputToIso(e.target.value);
          if (iso) state.firstReminderCustomIso = iso;
          renderSummaryOnly();
        }
      });
      container.appendChild(el('div', { class: 'field-group' }, [customTimeInput]));
    }

    // --- Repetição ---
    const repeatGroup = el('div', { class: 'field-group' }, [
      el('label', { class: 'field-label', text: 'Repetição' }),
      el('div', { class: 'chip-row' },
        mod.repeatChipsMinutes.map((m) => chip(`a cada ${m} min`, state.repeatCustomMinutes == null && state.repeatMinutes === m, () => {
          state.repeatMinutes = m;
          state.repeatCustomMinutes = null;
          rerender();
        })).concat([
          chip('Personalizar', state.repeatCustomMinutes != null, () => {
            state.repeatCustomMinutes = state.repeatCustomMinutes ?? state.repeatMinutes;
            rerender();
          })
        ])
      )
    ]);
    container.appendChild(repeatGroup);

    if (state.repeatCustomMinutes != null) {
      const customRepeatInput = el('input', {
        class: 'time-field',
        type: 'number',
        min: String(MIN_REPEAT_MINUTES),
        max: String(MAX_REPEAT_MINUTES),
        step: '1',
        value: String(state.repeatCustomMinutes),
        onchange: (e) => {
          const value = Math.round(Number(e.target.value));
          state.repeatCustomMinutes = Number.isFinite(value) ? value : state.repeatMinutes;
          renderSummaryOnly();
        }
      });
      container.appendChild(el('div', { class: 'field-group' }, [
        customRepeatInput,
        el('p', { class: 'field-hint', text: `Entre ${MIN_REPEAT_MINUTES} e ${MAX_REPEAT_MINUTES} minutos.` })
      ]));
    }

    // --- Intensidade ---
    container.appendChild(el('div', { class: 'field-group' }, [
      el('label', { class: 'field-label', text: 'Intensidade' }),
      el('div', { class: 'chip-row' },
        mod.intensities.map((i) => chip(i.label, state.intensity === i.id, () => {
          state.intensity = i.id;
          rerender();
        }))
      ),
      el('p', { class: 'field-hint', text: mod.intensities.find((i) => i.id === state.intensity).description })
    ]));

    // --- Horário silencioso ---
    const quietGroup = el('div', { class: 'field-group' });
    quietGroup.appendChild(el('div', { class: 'toggle-row' }, [
      el('span', { class: 'field-label', text: 'Horário silencioso' }),
      el('input', {
        type: 'checkbox',
        checked: state.quietHoursEnabled ? 'checked' : null,
        onchange: (e) => { state.quietHoursEnabled = e.target.checked; rerender(); }
      })
    ]));
    quietGroup.appendChild(el('p', { class: 'field-hint', text: `Padrão sugerido: ${mod.defaultQuietHours.start} até ${mod.defaultQuietHours.end}. Lembretes ficam suspensos nesse período e retomam depois.` }));
    if (state.quietHoursEnabled) {
      quietGroup.appendChild(el('div', { class: 'chip-row', style: 'margin-top:8px;' }, [
        el('input', { class: 'time-field', type: 'time', value: state.quietHoursStart, style: 'flex:1;', onchange: (e) => { state.quietHoursStart = e.target.value; } }),
        el('input', { class: 'time-field', type: 'time', value: state.quietHoursEnd, style: 'flex:1;', onchange: (e) => { state.quietHoursEnd = e.target.value; } })
      ]));
    }
    container.appendChild(quietGroup);

    // --- Resumo ---
    const summaryBox = el('div', { class: 'summary-box', id: 'sheet-summary', text: summaryText() });
    container.appendChild(summaryBox);

    container.appendChild(errorBox);

    // --- Submit ---
    const submitBtn = el('button', {
      class: 'btn btn-primary btn-large',
      type: 'button',
      text: 'Começar acompanhamento',
      onclick: onSubmit
    });
    container.appendChild(submitBtn);

    function renderSummaryOnly() {
      const box = container.querySelector('#sheet-summary');
      if (box) box.textContent = summaryText();
    }
  }

  function chip(label, selected, onClick) {
    return el('button', {
      type: 'button',
      class: `chip${selected ? ' is-selected' : ''}`,
      text: label,
      onclick: onClick
    });
  }

  function validate() {
    const cleanTitle = sanitizePlainText(state.customTitle, 80);

    if (state.taskType === 'custom' && !cleanTitle) {
      return { error: 'Dê um nome para a tarefa personalizada.' };
    }

    const firstReminderDate = computeFirstReminderDate();
    if (firstReminderDate.getTime() < state.startedAt.getTime()) {
      return { error: 'O primeiro aviso não pode ser antes do horário de início.' };
    }

    const repeatMinutes = effectiveRepeatMinutes();
    if (!Number.isInteger(repeatMinutes) || repeatMinutes < MIN_REPEAT_MINUTES || repeatMinutes > MAX_REPEAT_MINUTES) {
      return { error: `Escolha um intervalo de repetição entre ${MIN_REPEAT_MINUTES} e ${MAX_REPEAT_MINUTES} minutos.` };
    }

    if (state.quietHoursEnabled && (!state.quietHoursStart || !state.quietHoursEnd)) {
      return { error: 'Defina o início e o fim do horário silencioso, ou desative essa opção.' };
    }

    return { cleanTitle, firstReminderDate, repeatMinutes };
  }

  async function onSubmit() {
    if (submitting) return;
    const errorBox = document.getElementById('sheet-error');

    const validation = validate();
    if (validation.error) {
      errorBox.textContent = validation.error;
      errorBox.hidden = false;
      return;
    }

    submitting = true;
    errorBox.hidden = true;

    const payload = {
      module: moduleId,
      task_type: state.taskType,
      custom_title: state.taskType === 'custom' ? validation.cleanTitle : null,
      started_at: state.startedAt.toISOString(),
      first_reminder_at: validation.firstReminderDate.toISOString(),
      repeat_interval_minutes: validation.repeatMinutes,
      intensity: state.intensity,
      quiet_hours_enabled: state.quietHoursEnabled,
      quiet_hours_start: state.quietHoursEnabled ? state.quietHoursStart : null,
      quiet_hours_end: state.quietHoursEnabled ? state.quietHoursEnd : null,
      quiet_hours_timezone: currentTimeZone()
    };

    const result = await api.createTask(payload);
    submitting = false;

    if (!result.ok) {
      errorBox.textContent = result.offline
        ? 'Você está offline. Conecte-se para iniciar o acompanhamento.'
        : (result.error || 'Não foi possível iniciar. Tente de novo.');
      errorBox.hidden = false;
      return;
    }

    closeSheet();
    toast('Acompanhamento iniciado.');
    onCreated(result.data.task);
  }
}

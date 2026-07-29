// Configuração do módulo Lavanderia — o primeiro (e único) módulo do MVP.
// Ver frontend/js/modules/registry.js para como novos módulos futuros se conectam
// sem precisar reescrever as telas.

export const laundryModule = {
  id: 'laundry',
  name: 'Lavanderia',
  icon: '🧺',
  tagline: 'Começou uma lavagem? Eu te lembro de tirar a roupa.',
  color: 'var(--color-accent)',

  taskTypes: [
    { id: 'take_out_machine', label: 'Tirar roupa da máquina' },
    { id: 'hang_dry', label: 'Estender roupa' },
    { id: 'take_out_dryer', label: 'Tirar roupa da secadora' },
    { id: 'custom', label: 'Personalizado' }
  ],

  // Chips de "quando o primeiro aviso deve chegar" (em minutos a partir do início).
  firstReminderChipsMinutes: [30, 45, 60, 75, 90],

  // Chips de repetição (em minutos).
  repeatChipsMinutes: [10, 15, 20, 30],
  defaultRepeatMinutes: 15,

  intensities: [
    { id: 'light', label: 'Leve', description: 'Lembretes mais espaçados.' },
    { id: 'normal', label: 'Normal', description: 'Persistente sem exagero.' },
    { id: 'insistent', label: 'Insistente', description: 'Reduz o intervalo depois de vários avisos.' }
  ],
  defaultIntensity: 'normal',

  defaultQuietHours: { start: '22:30', end: '07:00', enabled: true },

  completionButtonLabel: 'Roupa retirada',
  completionMessage: 'Resolvido. A roupa agradece e a conta de água também.',

  cancelLabel: 'Cancelar esta lavagem'
};

export function taskTitle(task) {
  if (task.task_type === 'custom' && task.custom_title) return task.custom_title;
  const found = laundryModule.taskTypes.find((t) => t.id === task.task_type);
  return found ? found.label : 'Tarefa pendente';
}

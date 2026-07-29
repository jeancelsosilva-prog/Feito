// Registro de módulos ativos no app. Adicionar um módulo novo (freezer, limpeza, etc. —
// ver roadmap no README) é: criar um arquivo modules/nome.js no mesmo formato de
// laundry.js, e registrá-lo aqui. Nenhuma tela (today.js, taskSheet.js, ...) referencia
// "laundry" diretamente pelo nome — todas usam MODULE_REGISTRY.

import { laundryModule, taskTitle as laundryTaskTitle } from './laundry.js';

export const MODULE_REGISTRY = {
  laundry: laundryModule
};

export function getModule(moduleId) {
  return MODULE_REGISTRY[moduleId] || laundryModule;
}

export function listModules() {
  return Object.values(MODULE_REGISTRY);
}

export function taskTitleFor(task) {
  if (task.module === 'laundry') return laundryTaskTitle(task);
  return task.custom_title || 'Tarefa pendente';
}

// Biblioteca de mensagens de notificação, organizada em pools por estágio.
// Tom: descontraído, levemente provocativo, nunca agressivo ou infantil (ver seção 7 do spec).
//
// Estrutura pensada para modularidade: cada módulo (ex: 'laundry') tem seus próprios pools.
// Quando novos módulos forem adicionados (freezer, limpeza, etc.), basta registrar novos
// pools aqui — o motor de seleção (pickMessage) é agnóstico de módulo.

export const MESSAGE_POOLS = {
  laundry: {
    first: [
      { key: 'laundry.first.1', text: 'A máquina terminou. O cheirinho ainda está garantido — por enquanto.' },
      { key: 'laundry.first.2', text: 'Lavagem concluída. Falta só resgatar a roupa.' },
      { key: 'laundry.first.3', text: 'Sua roupa terminou a parte dela. Agora é com você.' },
      { key: 'laundry.first.4', text: 'Tudo limpo. Bora tirar antes que o perfume desista?' },
      { key: 'laundry.first.5', text: 'A máquina parou. A missão ainda não.' }
    ],
    follow_up: [
      { key: 'laundry.follow.1', text: 'A roupa continua esperando. Educada, mas esperando.' },
      { key: 'laundry.follow.2', text: 'Passando para lembrar que a máquina não se esvazia sozinha.' },
      { key: 'laundry.follow.3', text: 'Ainda dá tempo de manter aquele cheiro de roupa limpa.' },
      { key: 'laundry.follow.4', text: 'Sua roupa marcou presença. Você ainda não.' },
      { key: 'laundry.follow.5', text: 'Ela já lavou. Agora falta o toque humano.' }
    ],
    later: [
      { key: 'laundry.later.1', text: 'A roupa está começando uma reunião sem você.' },
      { key: 'laundry.later.2', text: 'Último lembrete? Não. Você sabe que eu volto.' },
      { key: 'laundry.later.3', text: 'A máquina fez 99% do trabalho. O 1% restante está desaparecido.' },
      { key: 'laundry.later.4', text: 'Ainda dá para salvar o cheirinho sem ativar o modo segunda lavagem.' },
      { key: 'laundry.later.5', text: 'A roupa não virou picles ainda, mas está negociando.' },
      { key: 'laundry.later.6', text: 'Aquele gasto extra de água ainda pode ser evitado.' },
      { key: 'laundry.later.7', text: 'Eu preferia estar quieto. A roupa também preferia estar no varal.' },
      { key: 'laundry.later.8', text: 'A missão continua aberta. A máquina é testemunha.' },
      { key: 'laundry.later.9', text: 'A roupa está limpa. O suspense é saber até quando.' },
      { key: 'laundry.later.10', text: 'Você consegue resolver isso em menos tempo do que leva para apagar este aviso.' }
    ],
    home_boost: [
      { key: 'laundry.home.1', text: 'Você está em casa. A máquina também. Coincidência conveniente.' },
      { key: 'laundry.home.2', text: 'Já que você está por perto: a roupa continua na máquina.' },
      { key: 'laundry.home.3', text: 'Chegou em casa? Ótimo. Tem uma pequena missão na lavanderia.' },
      { key: 'laundry.home.4', text: 'A distância até a máquina diminuiu. A desculpa também.' },
      { key: 'laundry.home.5', text: 'Você e a roupa finalmente estão no mesmo endereço.' }
    ]
  }
};

const TASK_TYPE_LABELS = {
  take_out_machine: 'Tirar roupa da máquina',
  hang_dry: 'Estender roupa',
  take_out_dryer: 'Tirar roupa da secadora',
  custom: null // usa custom_title
};

export function taskTitle(task) {
  if (task.task_type === 'custom' && task.custom_title) return task.custom_title;
  return TASK_TYPE_LABELS[task.task_type] || 'Tarefa pendente';
}

/**
 * Determina o "estágio" da mensagem a partir do reminder_count (quantos avisos já
 * foram enviados ANTES deste), e se home_boost está ativo agora.
 */
export function resolveStage({ reminderCountBeforeThisSend, isHomeBoostActive }) {
  if (isHomeBoostActive) return 'home_boost';
  if (reminderCountBeforeThisSend === 0) return 'first';
  if (reminderCountBeforeThisSend <= 2) return 'follow_up';
  return 'later';
}

/**
 * Escolhe uma mensagem do pool do módulo/estágio, evitando repetir lastMessageKey
 * quando o pool tiver mais de uma opção.
 */
export function pickMessage({ module, stage, lastMessageKey }) {
  const modulePools = MESSAGE_POOLS[module] || MESSAGE_POOLS.laundry;
  const pool = modulePools[stage] || modulePools.later;

  let candidates = pool;
  if (pool.length > 1 && lastMessageKey) {
    candidates = pool.filter((m) => m.key !== lastMessageKey);
  }
  const index = Math.floor(Math.random() * candidates.length);
  return candidates[index];
}

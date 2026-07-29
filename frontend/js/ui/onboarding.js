// Lógica das duas telas de onboarding (seção 3 do briefing):
// 1. "Coloque o Feito? na sua Tela de Início" (Safari, ainda não instalado)
// 2. "Posso te lembrar na hora certa?" (já instalado, notificações ainda não pedidas)
//
// A troca de tela em si (qual delas mostrar) é decidida em app.js, que tem a visão
// completa do estado da plataforma. Este módulo só cuida do comportamento DENTRO de
// cada tela.

import { activateNotifications } from '../push.js';
import { toast } from './components.js';

export function wireInstallScreen({ onContinueAnyway }) {
  const btn = document.getElementById('btn-install-continue-anyway');
  btn.onclick = () => onContinueAnyway();
}

export function wireEnableNotificationsScreen({ onResolved }) {
  const btnEnable = document.getElementById('btn-enable-notifications');
  const btnSkip = document.getElementById('btn-skip-notifications');
  const deniedHelp = document.getElementById('notifications-denied-help');

  btnEnable.onclick = async () => {
    btnEnable.disabled = true;
    btnEnable.textContent = 'Ativando…';

    // Chamada direta dentro do handler de toque — é exatamente isso que o iOS Safari
    // exige para permitir Notification.requestPermission().
    const result = await activateNotifications();

    if (result.permission === 'granted' && result.ok) {
      toast('Lembretes ativados. Notificação de teste enviada.');
      onResolved({ granted: true });
      return;
    }

    if (result.permission === 'denied') {
      deniedHelp.hidden = false;
      btnEnable.disabled = false;
      btnEnable.textContent = 'Ativar lembretes';
      return;
    }

    if (result.permission === 'unsupported') {
      toast('Este iPhone/navegador não suporta notificações push no momento.');
      onResolved({ granted: false, unsupported: true });
      return;
    }

    // 'granted' mas falha ao registrar no backend (ex: offline) — deixa o usuário tentar de novo.
    btnEnable.disabled = false;
    btnEnable.textContent = 'Ativar lembretes';
    toast(result.error || 'Não deu para ativar agora. Tente de novo.');
  };

  btnSkip.onclick = () => onResolved({ granted: false, skipped: true });
}

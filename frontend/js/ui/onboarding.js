// Única tela de onboarding que resta: "Coloque o Feito? na sua Tela de Início",
// mostrada apenas no iOS quando o app ainda não está instalado (sem isso o iPhone nem
// permite notificações). A ativação de lembretes deixou de ser uma tela separada e virou
// um cartão dentro do app (#notif-cta, ver js/app.js) — menos etapas até usar o app.


export function wireInstallScreen({ onContinueAnyway }) {
  const btn = document.getElementById('btn-install-continue-anyway');
  btn.onclick = () => onContinueAnyway();
}

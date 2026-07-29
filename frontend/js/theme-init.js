// Aplica o tema escolhido pelo usuário antes da primeira pintura da tela.
//
// Precisa rodar de forma síncrona e o mais cedo possível: se esperássemos o módulo
// principal (js/app.js) carregar, o app apareceria por um instante no tema do sistema e
// só depois trocaria — o clássico "flash" de cor errada.
//
// Não é um módulo ES: <script type="module"> é sempre adiado (defer), o que anularia o
// propósito. Por isso este arquivo é carregado como script clássico e bloqueante.
(function () {
  try {
    var saved = localStorage.getItem('feito.theme');
    if (saved === 'light' || saved === 'dark') {
      document.documentElement.setAttribute('data-theme', saved);
    }
    // Sem preferência salva: nenhum atributo é definido e a folha de estilos segue o
    // tema do sistema via @media (prefers-color-scheme).
  } catch (e) {
    // Safari em modo privado pode bloquear o localStorage — segue o tema do sistema.
  }
})();

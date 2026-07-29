// Componentes de UI compartilhados: toast, diálogo de confirmação e bottom sheet genérico.
// Tudo vanilla DOM — sem framework, conforme premissa técnica do projeto.

export function toast(message, { duration = 2600 } = {}) {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

/**
 * Diálogo de confirmação genérico (usado no cancelamento de tarefa e em "apagar meus dados").
 * Retorna uma Promise<boolean> — true se o usuário confirmou.
 */
export function confirmDialog({ title, message, confirmLabel = 'Confirmar', cancelLabel = 'Voltar', destructive = true }) {
  const backdrop = document.getElementById('confirm-backdrop');
  const dialog = document.getElementById('confirm-dialog');
  const titleEl = document.getElementById('confirm-title');
  const messageEl = document.getElementById('confirm-message');
  const okBtn = document.getElementById('confirm-ok-btn');
  const cancelBtn = document.getElementById('confirm-cancel-btn');

  titleEl.textContent = title;
  messageEl.textContent = message;
  okBtn.textContent = confirmLabel;
  okBtn.className = destructive ? 'btn btn-danger' : 'btn btn-primary';
  cancelBtn.textContent = cancelLabel;

  backdrop.hidden = false;
  dialog.hidden = false;

  return new Promise((resolve) => {
    function cleanup(result) {
      backdrop.hidden = true;
      dialog.hidden = true;
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      backdrop.removeEventListener('click', onCancel);
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    backdrop.addEventListener('click', onCancel);
    okBtn.focus();
  });
}

export function openSheet(contentHtmlBuilder) {
  const backdrop = document.getElementById('sheet-backdrop');
  const sheet = document.getElementById('sheet-start-task');
  const content = document.getElementById('sheet-start-task-content');

  content.innerHTML = '';
  contentHtmlBuilder(content);

  backdrop.hidden = false;
  sheet.hidden = false;
  backdrop.onclick = closeSheet;
}

export function closeSheet() {
  document.getElementById('sheet-backdrop').hidden = true;
  document.getElementById('sheet-start-task').hidden = true;
  document.getElementById('sheet-start-task-content').innerHTML = '';
}

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (value !== null && value !== undefined) node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

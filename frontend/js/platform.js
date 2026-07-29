// Detecção de plataforma/capacidades. Tudo aqui é feature detection — nunca User-Agent
// sniffing frágil demais, exceto onde realmente não há alternativa (identificar iOS/Safari
// não tem uma API dedicada).

export function isIos() {
  const ua = navigator.userAgent || '';
  const isAppleMobile = /iPad|iPhone|iPod/.test(ua);
  // iPadOS 13+ finge ser Mac em desktop mode; detecta por touch + Mac.
  const isIpadOsDesktopMode = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  return isAppleMobile || isIpadOsDesktopMode;
}

export function isSafari() {
  const ua = navigator.userAgent || '';
  return /^((?!chrome|android|crios|fxios|edgios).)*safari/i.test(ua);
}

export function isStandalone() {
  // iOS Safari expõe navigator.standalone; outros navegadores usam a media query.
  return Boolean(window.navigator.standalone) || window.matchMedia('(display-mode: standalone)').matches;
}

export function iosMajorVersion() {
  const match = (navigator.userAgent || '').match(/OS (\d+)_/);
  return match ? Number(match[1]) : null;
}

export function supportsServiceWorker() {
  return 'serviceWorker' in navigator;
}

export function supportsPush() {
  return supportsServiceWorker() && 'PushManager' in window && 'Notification' in window;
}

export function supportsBadging() {
  return 'setAppBadge' in navigator;
}

export function notificationPermission() {
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission; // 'default' | 'granted' | 'denied'
}

/**
 * Resume o "estado de plataforma" que o resto do app usa para decidir qual tela mostrar.
 * Ver seção 3 do briefing: instalado / Safari / navegador não suportado / iOS antigo / permissões.
 */
export function getPlatformSnapshot() {
  return {
    isIos: isIos(),
    isSafari: isSafari(),
    isStandalone: isStandalone(),
    iosVersion: iosMajorVersion(),
    supportsServiceWorker: supportsServiceWorker(),
    supportsPush: supportsPush(),
    supportsBadging: supportsBadging(),
    notificationPermission: notificationPermission(),
    isOnline: navigator.onLine
  };
}

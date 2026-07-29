# Checklist manual de teste no iPhone

Use um iPhone real com iOS 16.4 ou mais recente (Web Push exige isso). Marque cada item.
Faça isso DEPOIS de completar as seções 3–5 do README (backend publicado, frontend
publicado, `frontend/js/config.js` preenchido).

## 0. Preparação

- [ ] Descobri a URL do GitHub Pages (ex: `https://usuario.github.io/feito-app/`).
- [ ] Testei `curl .../api/health` e recebi `{"ok":true,...}`.

## 1. Primeira visita (Safari, ainda não instalado)

- [ ] Abri a URL no Safari do iPhone.
- [ ] Vi a tela "Coloque o Feito? na sua Tela de Início", com a instrução de Compartilhar →
      Adicionar à Tela de Início.
- [ ] O app **não** pediu permissão de notificação nesta tela (é esperado que não peça).
- [ ] Toquei em Compartilhar (ícone de seta para cima) → "Adicionar à Tela de Início" →
      Adicionar.
- [ ] O ícone do Feito? apareceu na Tela de Início do iPhone (com a arte placeholder roxa,
      a menos que você já tenha trocado — ver `frontend/icons/README.txt`).

## 2. Abrindo a versão instalada

- [ ] Fechei o Safari e abri o Feito? pelo ícone na Tela de Início.
- [ ] O app abriu em tela cheia, sem a barra de endereço do Safari (modo standalone).
- [ ] Vi a tela "Posso te lembrar na hora certa?".
- [ ] Toquei em "Ativar lembretes" e o iOS mostrou o alerta nativo de permissão de
      notificação.
- [ ] Permiti. Recebi uma notificação de teste em poucos segundos.
- [ ] Fui direto para a tela "Hoje", vazia, com o cartão "Lavanderia".

## 3. Cenário principal (seção 17 do briefing)

- [ ] Toquei em "Iniciar lavagem".
- [ ] Configurei: tipo = "Tirar roupa da máquina", horário de início = Agora, primeiro
      aviso = **3 minutos** (usei "Escolher horário" para um teste rápido em vez de
      esperar 58 minutos), repetição = **2 minutos**, intensidade = Normal, horário
      silencioso desativado (para não interferir no teste).
- [ ] Vi o resumo em linguagem humana antes de confirmar.
- [ ] Toquei em "Começar acompanhamento" — voltei para "Hoje" e vi o cartão da tarefa ativa
      com horário de início, primeiro aviso e "próximo aviso".
- [ ] Saí do app (fui para a Tela de Início, ou bloqueei a tela) e esperei.
- [ ] **Por volta do horário configurado**, recebi uma notificação (o texto deve soar
      descontraído, nunca agressivo — ver seção 7 do briefing).
- [ ] Apaguei (dispensei) a notificação deslizando.
- [ ] **Passados ~2 minutos**, recebi uma SEGUNDA notificação, mesmo tendo apagado a
      primeira, e com um texto diferente da primeira.
- [ ] Toquei na notificação. O app abriu direto na tarefa ativa (não na tela genérica).
- [ ] Toquei em "Roupa retirada".
- [ ] Vi a mensagem de conclusão e o cartão da tarefa sumiu da tela "Hoje".
- [ ] **Esperei mais alguns minutos e confirmei que NENHUMA notificação nova chegou.**

## 4. Conclusão antecipada

- [ ] Iniciei uma nova tarefa com primeiro aviso em alguns minutos.
- [ ] Toquei em "Roupa retirada" ANTES do horário do primeiro aviso.
- [ ] Confirmei que nenhuma notificação chegou depois disso.

## 5. Cancelamento

- [ ] Iniciei uma tarefa.
- [ ] Toquei no link secundário "Cancelar esta lavagem".
- [ ] Vi o diálogo de confirmação (o cancelamento não pode acontecer sem confirmar).
- [ ] Confirmei o cancelamento.
- [ ] Nenhuma notificação chegou depois.
- [ ] A tarefa apareceu em "Histórico" como Cancelada.

## 6. Horário silencioso

- [ ] Iniciei uma tarefa com horário silencioso ATIVADO, cobrindo o horário atual do
      teste (ajuste o início/fim para os minutos seguintes ao momento do teste).
- [ ] Confirmei que nenhuma notificação chegou durante a janela silenciosa.
- [ ] Confirmei que a notificação chegou logo depois do fim da janela.

## 7. Permissão negada

- [ ] Em Ajustes do iPhone → Feito? → Notificações, desativei as notificações.
- [ ] Voltei ao app, fui em Ajustes (dentro do app) e vi o status "Bloqueadas", com a
      instrução de como reativar.
- [ ] Confirmei que o app continua utilizável como temporizador visual (consigo ver o
      cartão da tarefa, tempo decorrido etc.), mesmo sem notificação.

## 8. Várias tarefas

- [ ] Iniciei duas tarefas diferentes (ex: "Tirar roupa da máquina" e "Estender roupa").
- [ ] Confirmei que ambas aparecem na tela "Hoje", cada uma com seu próprio cartão.

## 9. Atualização da PWA

- [ ] Publiquei uma mudança pequena no frontend (ex: mudei um texto) e subi `CACHE_VERSION`
      em `frontend/sw.js`.
- [ ] Reabri o app no iPhone (sem apagar e reinstalar).
- [ ] Vi o banner "Tem uma versão nova pronta." com o botão "Atualizar agora".
- [ ] Toquei no botão, o app recarregou e a mudança apareceu.

## 10. Offline

- [ ] Ativei o Modo Avião no iPhone.
- [ ] Abri o app: o selo "Offline" apareceu, e as informações já carregadas continuaram
      visíveis.
- [ ] Tentei iniciar uma tarefa: recebi uma mensagem clara de que era preciso estar online,
      sem o app fingir que a ação foi concluída.
- [ ] Desativei o Modo Avião e confirmei que o app voltou a sincronizar sozinho.

## 11. Apagar meus dados

- [ ] Em Ajustes, toquei em "Apagar meus dados deste dispositivo" e confirmei o diálogo.
- [ ] O app cancelou tarefas ativas, voltou para a tela de onboarding, e o selo de badge no
      ícone (se estava com número) sumiu.

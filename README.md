# Feito?

Um app de tarefas temporizadas persistentes para iPhone. Você inicia uma lavagem, o Feito?
espera o tempo configurado e começa a te lembrar — e continua lembrando, mesmo se você apagar
a notificação — até você voltar ao app e tocar em **"Roupa retirada"**.

Este README assume que **você não é programador experiente**. Cada comando diz onde rodar,
o que esperar de resultado, e como resolver os erros mais comuns. Leia na ordem — a ordem
importa.

> Nome "Feito?" é temporário/de trabalho — troque à vontade em `frontend/js/config.js`,
> `frontend/manifest.webmanifest` e `frontend/index.html` antes de publicar de verdade.

---

## 1. O que você vai precisar antes de começar

- Um **Mac, Windows ou Linux** com Terminal.
- **Node.js 20 ou mais recente** instalado. Para checar: abra o Terminal e rode `node --version`.
  Se aparecer "command not found", instale em https://nodejs.org (baixe a versão "LTS").
- Uma **conta gratuita na Cloudflare** — crie em https://dash.cloudflare.com/sign-up (você
  mencionou que ainda não tem uma: é só um cadastro com e-mail, não precisa cartão de crédito
  para o que usamos aqui: Workers, D1 e Cron Triggers têm camada gratuita generosa).
- Uma **conta no GitHub** (você já tem) e um repositório vazio para este projeto.
- Um **iPhone real** para o teste final — o Safari de desktop e simuladores não reproduzem
  o comportamento de Web Push do iOS.

---

## 2. Estrutura do repositório

```
feito-app/
├── frontend/              → tudo que vai para o GitHub Pages (site estático)
│   ├── index.html
│   ├── styles.css
│   ├── manifest.webmanifest
│   ├── sw.js               (Service Worker)
│   ├── js/                 (código modular: app, api, db, push, ui/*, modules/*)
│   └── icons/               (ícones — placeholders, ver icons/README.txt)
├── backend/
│   ├── worker/              → o Cloudflare Worker (a API)
│   │   ├── src/
│   │   ├── scripts/generate-vapid-keys.mjs
│   │   ├── wrangler.toml    (sem segredos)
│   │   └── package.json
│   └── migrations/*.sql     (schema versionado do banco D1 — `wrangler d1 migrations apply`
│                              aplica todos os arquivos pendentes em ordem, automaticamente)
├── tests/                   → testes automatizados (rodam com Node puro)
├── docs/                    → checklist de teste no iPhone + tabela de QA
├── .env.example
└── README.md                → você está aqui
```

---

## 3. Configurar o backend (Cloudflare Worker + D1)

Todos os comandos desta seção rodam no **Terminal**, dentro da pasta `backend/worker`.

```bash
cd backend/worker
npm install
```

**Resultado esperado:** uma pasta `node_modules` aparece. Se der erro `npm: command not found`,
volte no passo 1 (instalar Node.js).

### 3.1. Fazer login na Cloudflare

```bash
npx wrangler login
```

Isso abre uma aba no navegador pedindo para autorizar. Clique em "Allow". **Resultado
esperado:** o Terminal mostra "Successfully logged in.".

*Erro comum:* se nada abrir no navegador, copie o link que aparece no Terminal e cole
manualmente no navegador.

### 3.2. Criar o banco D1

```bash
npx wrangler d1 create feito-app-db
```

**Resultado esperado:** um bloco de texto parecido com:

```
[[d1_databases]]
binding = "DB"
database_name = "feito-app-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Copie o valor de `database_id` — você vai colar no `wrangler.toml` no próximo passo.

### 3.3. Editar `backend/worker/wrangler.toml`

Abra o arquivo `backend/worker/wrangler.toml` em qualquer editor de texto e substitua:

- `database_id = "COLE_AQUI_O_DATABASE_ID"` → pelo ID que você copiou no passo 3.2.
- `ALLOWED_ORIGINS = "https://SEU-USUARIO.github.io"` → pela URL real do seu GitHub Pages
  (ver seção 5). Se o app vai ficar em `usuario.github.io/feito-app/`, o valor aqui é só
  `https://usuario.github.io` (sem o caminho do repositório, sem barra no final).
- `VAPID_SUBJECT = "mailto:seu-email@example.com"` → um e-mail de contato seu.
- `VAPID_PUBLIC_KEY` → você vai preencher no próximo passo (3.4).

### 3.4. Gerar as chaves VAPID (para o Web Push funcionar)

```bash
npm run vapid:generate
```

**Resultado esperado:** o Terminal mostra duas chaves. A **primeira** (chave pública) você
cola em `wrangler.toml`, no campo `VAPID_PUBLIC_KEY` (dentro de `[vars]`). A **segunda**
(um JSON, a chave privada) NÃO vai em nenhum arquivo — ela é um segredo, e vai direto para
a Cloudflare no próximo passo.

### 3.5. Cadastrar o segredo da chave privada

```bash
npx wrangler secret put VAPID_PRIVATE_KEY_JWK
```

O Terminal vai pedir para colar um valor. Cole o JSON de uma linha só que apareceu no passo
anterior (a parte depois de "Chave privada...") e aperte Enter.

**Resultado esperado:** "Success! Uploaded secret VAPID_PRIVATE_KEY_JWK".

### 3.6. Rodar a migração do banco (criar as tabelas)

Primeiro, localmente (para testar):

```bash
npm run d1:migrate:local
```

Depois, no banco de produção de verdade:

```bash
npm run d1:migrate:remote
```

**Resultado esperado:** mensagens confirmando que as migrations (`0001_init.sql`,
`0002_idempotency_request_hash.sql`, e quaisquer outras adicionadas depois) foram aplicadas.

*Erro comum:* "no migrations present" — confirme que você está rodando o comando dentro de
`backend/worker` (não na raiz do repositório).

### 3.7. Publicar o Worker

```bash
npm run deploy
```

**Resultado esperado:** o Terminal mostra uma URL parecida com
`https://feito-app-api.SEU-SUBDOMINIO.workers.dev` — **copie essa URL**, você vai usá-la
no frontend. Ele também confirma que o Cron Trigger (`* * * * *`, ou seja, a cada minuto)
foi registrado.

*Erro comum:* "Authentication error" → rode `npx wrangler login` de novo (passo 3.1).

### 3.8. Testar rapidamente que a API está no ar

```bash
curl https://feito-app-api.SEU-SUBDOMINIO.workers.dev/api/health
```

**Resultado esperado:** `{"ok":true,"time":"..."}`. Se der erro de conexão, confira se a
URL foi copiada certinha (sem barra sobrando no final) e se o deploy do passo 3.7 terminou
sem erros.

---

## 4. Configurar o frontend

Abra `frontend/js/config.js` em um editor de texto e preencha os três valores:

```js
export const CONFIG = {
  API_BASE_URL: 'https://feito-app-api.SEU-SUBDOMINIO.workers.dev', // sem barra no final
  VAPID_PUBLIC_KEY: 'A_MESMA_CHAVE_PUBLICA_QUE_VOCE_COLOU_NO_WRANGLER_TOML',
  APP_NAME: 'Feito?',
  APP_VERSION: '1.0.0'
};
```

Não precisa mexer em mais nada — o app já usa caminhos relativos (`./`) em todo lugar,
então funciona tanto em `usuario.github.io/feito-app/` quanto em um domínio próprio.

---

## 5. Publicar o frontend no GitHub Pages

1. Crie um repositório novo no GitHub (ex: `feito-app`) ou use um que você já tem.
2. Copie **o conteúdo da pasta `frontend/`** (não a pasta inteira, o conteúdo dela) para a
   raiz do seu repositório — ou configure o GitHub Pages para servir a partir de `/frontend`
   (ver passo 4 abaixo). Qualquer uma das duas formas funciona.
3. Envie os arquivos para o GitHub:
   ```bash
   git add .
   git commit -m "Publica o Feito?"
   git push
   ```
4. No GitHub, vá em **Settings → Pages** do seu repositório. Em "Source", escolha a branch
   `main` e a pasta (`/root` se você copiou o conteúdo de `frontend/` para a raiz, ou
   `/frontend` se manteve a estrutura original). Clique em "Save".
5. **Resultado esperado:** depois de 1–2 minutos, o GitHub mostra a URL do site, algo como
   `https://SEU-USUARIO.github.io/feito-app/`. Anote essa URL.
6. **Volte no passo 3.3** e confirme que `ALLOWED_ORIGINS` no `wrangler.toml` bate com o
   domínio dessa URL (só `https://SEU-USUARIO.github.io`, sem o `/feito-app/`). Se você
   mudou esse valor depois do deploy, rode `npm run deploy` de novo dentro de
   `backend/worker` para atualizar.

*Erro comum:* a página abre mas fica em branco / console mostra erro de CORS → confira o
item 6 acima; o navegador bloqueia a resposta da API se a origem não bater exatamente.

---

## 6. Rodar os testes automatizados

Não é obrigatório para publicar, mas é a forma mais rápida de confirmar que nada quebrou
antes de mexer no código. Requer Node 22+ (por causa do `node:sqlite`, usado só nos testes).

```bash
node tests/run-all.mjs
```

**Resultado esperado:** uma lista de "ok" terminando em "Todos os testes passaram.". Veja
`tests/README.md` para o que cada teste cobre.

---

## 7. Testar em um iPhone de verdade

Siga `docs/IPHONE-TEST-CHECKLIST.md` passo a passo. Resumo do fluxo principal:

1. Abra a URL do GitHub Pages no **Safari do iPhone** (não Chrome — no iOS, todo navegador
   usa o motor do Safari por baixo, mas só o próprio Safari mostra a opção "Adicionar à
   Tela de Início").
2. Toque em Compartilhar → Adicionar à Tela de Início.
3. Abra o app pela Tela de Início (não mais pelo Safari).
4. Toque em "Ativar lembretes" e permita as notificações.
5. Inicie uma lavagem, configure um aviso para poucos minutos à frente (para não esperar
   muito), e aguarde a notificação chegar.

---

## 8. Arquitetura — por que Cron + D1, e não Durable Objects, na v1

O motor de lembretes roda em duas peças separadas de propósito (`backend/worker/src/cron.js`
dispara, `backend/worker/src/lib/reminderEngine.js` decide e executa). Hoje, um **Cron
Trigger a cada minuto** varre a tabela `tasks` (índice composto em `(status,
next_reminder_at)`) e chama `processDueTask()` uma vez por tarefa vencida. Essa granularidade
de 1 minuto já é coerente com o que a própria interface promete ao usuário ("horário
estimado", nunca "no segundo exato").

Existe um **segundo Cron Trigger**, `"0 * * * *"` (uma vez por hora), dedicado só à
manutenção (`runMaintenance()`: expira tarefas abandonadas, limpa logs antigos). O Worker
decide qual rotina rodar olhando `event.cron` — de propósito, não guardamos nenhum contador
em memória para isso, porque o isolate do Worker pode ser reciclado pela Cloudflare a
qualquer momento, o que tornaria um contador em memória não confiável.

Se o volume de tarefas crescer a ponto do cron ficar caro ou impreciso, a peça que muda é
só o "disparador": um **Durable Object Alarm** por tarefa (via `setAlarm()`) chamaria a
mesma `processDueTask()` para a sua própria tarefa e se reagendaria sozinho, com garantia de
execução "ao menos uma vez" e retry com backoff automático da própria plataforma. A lógica
de negócio (checagem de horário silencioso, idempotência, seleção de mensagem, cálculo do
próximo horário) não muda uma linha — é por isso que ela foi isolada em
`reminderEngine.js` desde o início, e não misturada no loop do cron.

A proteção de idempotência (`notification_log.idempotency_key`, único por `(tarefa,
número do lembrete)`) reivindica o slot **antes** de enviar o Web Push, não depois — isso
foi verificado por teste (`tests/unit/reminderEngine.test.mjs`, cenário de duas execuções
concorrentes sobre a mesma tarefa) e é o que evita notificação duplicada tanto no cron atual
quanto em uma futura migração para alarmes.

---

## 9. Limitações conhecidas (não inventamos solução para o que o Safari/iOS não permite)

- **Sem geofencing real em segundo plano.** O reforço "estou em casa" (seção 8) só é
  verificado quando o app está aberto em primeiro plano, ou quando você toca no botão
  manual. Isso é dito explicitamente na tela de Ajustes — não fingimos rastreamento
  contínuo, porque o iOS não permite isso para uma PWA.
- **Horário do lembrete é estimado.** Web Push no iOS não garante entrega no segundo exato;
  o Cron roda a cada minuto e o push service (Apple) pode levar alguns segundos a mais para
  entregar.
- **Declarative Web Push** (mecanismo mais novo do Safari/iOS) não é a única estratégia de
  entrega usada aqui — o código usa Push API + Service Worker "clássicos", que têm suporte
  mais amplo entre versões do iOS. Ver `frontend/sw.js`.
- **iOS antigo (anterior ao iOS 16.4)** não suporta Web Push de forma alguma. O app detecta
  isso (`frontend/js/platform.js`) e cai para "temporizador visual" sem prometer notificação.
- **Badging API** (número no ícone) não é suportada em todo navegador — o app faz feature
  detection e simplesmente não mostra o selo onde não há suporte, sem quebrar nada.

---

## 10. Roadmap de módulos futuros

A arquitetura de módulos (`frontend/js/modules/`, mensagens em
`backend/worker/src/lib/messages.js`) foi pensada para que os módulos abaixo sejam
adicionados sem reescrever o motor de tarefas: Freezer e geladeira, Limpeza, Cozinha
temporizada (com aviso permanente de que não substitui timers de segurança do próprio
eletrodoméstico), Louças, Lixo e reciclagem, Plantas, Itens esquecíveis, Cuidados com
animais (sem se apresentar como substituto de orientação veterinária), e Rotinas
personalizadas criadas pelo próprio usuário.

---

## 11. Tabela de QA (rastreabilidade requisito → implementação → teste)

Ver `docs/TRACEABILITY.md` para a tabela completa exigida no briefing (requisito, arquivo
responsável, como foi implementado, como testar, limitações conhecidas).

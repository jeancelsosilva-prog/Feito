Ícones deste app — placeholders funcionais, não arte final.

Foram gerados a partir de icon-source.svg (fundo roxo #6C5CE7 + check branco) usando
ImageMagick. Servem para o app funcionar de ponta a ponta (instalar, aparecer na Tela de
Início, badge, etc) já no primeiro deploy, mas é esperado que você substitua por uma
identidade visual própria antes de considerar o app "pronto" de verdade.

Arquivos:
- icon-source.svg        fonte editável (abra em qualquer editor de SVG/Figma/Illustrator)
- apple-touch-icon.png   180x180 — usado pelo iOS ao adicionar à Tela de Início
- icon-192.png           192x192 — manifest.webmanifest (icons)
- icon-512.png           512x512 — manifest.webmanifest (icons, tela de splash do Android)
- icon-512-maskable.png  512x512 com margem de segurança — manifest.webmanifest (purpose: maskable)
- favicon-32.png         32x32 — aba do navegador

Para trocar por um ícone novo: substitua os arquivos PNG mantendo os mesmos nomes e
dimensões (ou gere os seus com `convert seu-icone.svg -resize 512x512 icon-512.png`, etc).
Nenhum outro arquivo do projeto precisa mudar.

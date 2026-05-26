# Weblist

Sistema local para importar playlists M3U/M3U8 e organizar filmes, series, temporadas, episodios e canais em uma interface estilo streaming.

## Requisitos

- Node.js 24 ou superior
- npm

O projeto usa o SQLite embutido do Node (`node:sqlite`), entao nao precisa instalar um banco separado.

## Como rodar

```bash
npm install
npm run seed
npm run dev
```

Depois abra:

- App: http://localhost:5173
- API: http://localhost:3333/api/health

Login do admin:

- Usuario: `admin`
- Senha: `admin123`

## Importar sua playlist

1. Abra `http://localhost:5173/admin`.
2. Entre com o login acima.
3. Envie um arquivo `.m3u` ou `.m3u8`, ou cole o conteudo no campo de texto.
4. Clique em `Importar`.

Se quiser usar o arquivo grande que ja esta nesta pasta (`Lista.m3u`), envie ele pelo painel admin. A importacao roda em segundo plano e mostra progresso, duplicados, erros e totais importados.

## Capas corretas com TMDB

O painel admin tem uma secao `TMDB` para buscar posters, backdrops e descricoes no The Movie Database.

1. Crie uma chave gratuita em uma conta TMDB.
2. Abra `Admin > TMDB`.
3. Cole a `API key` ou o `Access token`.
4. Clique em `Salvar TMDB`.
5. Clique em `Iniciar fila`.

O modo padrao e `So faltantes`, que atualiza apenas itens sem capa, backdrop, sinopse ou ID TMDB. Marque `Processar todos os lotes automaticamente` para o sistema continuar de 1000 em 1000 sem precisar clicar novamente. A fila pode ser pausada, retomada ou parada pelo painel.

Tambem e possivel configurar por variaveis de ambiente:

```bash
TMDB_API_KEY=sua_chave
TMDB_ACCESS_TOKEN=seu_token_opcional
TMDB_LANGUAGE=pt-BR
```

Por padrao, a atualizacao roda em lotes para evitar travar a biblioteca grande. Aumente o limite no painel se quiser processar mais itens por vez.

## Problemas e correcao manual

A pagina `Problemas` mostra:

- Itens sem capa ou sinopse
- Titulos duplicados provaveis
- Series suspeitas, como series com apenas um episodio

Nessa pagina, use o botao de busca para escolher manualmente o resultado correto do TMDB e aplicar a capa/sinopse certa.

## Busca e filtros

A busca usa um indice local SQLite FTS para pesquisar por titulo e categoria com mais velocidade. Os catalogos tambem permitem filtrar por:

- Categoria
- Ano
- Com/sem capa
- Com/sem sinopse
- Adultos ocultos por padrao

## Scripts

- `npm run dev`: inicia API Express e frontend Vite.
- `npm run dev:api`: inicia apenas a API em `localhost:3333`.
- `npm run dev:web`: inicia apenas o frontend em `localhost:5173`.
- `npm run seed`: limpa a biblioteca e importa `sample/playlist.m3u`.
- `npm run build`: gera o frontend de producao em `dist/`.
- `npm start`: inicia a API; se existir `dist/`, ela tambem serve o frontend.

## Estrutura

```text
server/
  db.js                  Banco SQLite, schema e usuario admin
  index.js               API Express
  parser/m3uParser.js    Parser e deteccao de filmes, series e canais
  services/importer.js   Importacao assincrona em lotes
  data/                  Banco local
  uploads/               Arquivos temporarios de importacao
src/
  components/            Layout, cards e carrosseis
  pages/                 Home, catalogos, detalhes, admin e player
sample/
  playlist.m3u           Dados de exemplo legais/publicos
```

## Padroes reconhecidos para series

- `Nome da Serie S01E01`
- `Nome da Serie 1x01`
- `Nome da Serie Temporada 1 Episodio 1`
- `Nome da Serie T01 E01`
- `Nome da Serie - S02E05 - Nome do Episodio`

## Banco SQLite

O banco fica em:

```text
server/data/weblist.sqlite
```

Tabelas criadas:

- `users`
- `movies`
- `series`
- `seasons`
- `episodes`
- `channels`
- `watch_progress`
- `categories`

## Observacoes

- Links duplicados sao ignorados durante a importacao.
- Links que nao parecem reproduziveis (`http`, `https` ou `file`) sao registrados como erro e a importacao continua.
- O player usa `hls.js` para `.m3u8`, suporta MP4 e tem controles customizados com retomada de progresso.
- O progresso de filme/episodio/canal e salvo no SQLite local.
- A integracao TMDB usa os endpoints oficiais de busca de filmes/series e monta imagens com `https://image.tmdb.org/t/p/{size}/{file_path}`.

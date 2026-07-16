# Research Acionável — Genial

## Modo atual: amostra embutida (sem API/Actions)

O painel está configurado para rodar **100% com dados de amostra embutidos** no
próprio `app.html` — sem depender da API da Resenha, do scraper do Genial nem dos
GitHub Actions. Isso deixa a demo estável e dinâmica para apresentação:

- **Fila de relatórios:** as datas são reancoradas no boot para o dia atual (nunca
  aparecem "atrasadas").
- **Notícias:** ~156 notícias de amostra, com o matching de carteira já calculado;
  duas seções ("Afetam sua base" e "Todas as notícias"). Datas também reancoradas.
- **Envios:** histórico pré-populado (vários clientes, canais e datas).

Para **religar as fontes reais** (API Resenha + scraper Genial + Bridgewise via
Actions), reative as chamadas no fim do `app.html` (procure por
`carregarReportsRemotos()` / `carregarBridgewise()`, que estão comentadas) e
configure os Secrets descritos acima. Os scripts em `scraper/` e os workflows
continuam prontos no repositório.



Site do assessor para distribuição de research, com notícias da Resenha Trader
cruzadas com a carteira dos clientes, chatbot consultor, alertas de carteira por
IA e camada quantitativa Bridgewise.

## Arquitetura (importante)

O site é **100% estático** (`index.html` + `app.html`) e roda em **GitHub Pages**.
Ele **nunca** contém chaves de API. Todo acesso a API com chave acontece no
**GitHub Actions** (lado servidor), que grava arquivos JSON no repositório; o site
apenas **lê** esses JSON no boot:

    GitHub Actions (chaves em Secrets)          Site estático (GitHub Pages)
      scraper/scrape.mjs      -> reports.json  -.
      scraper/news.mjs        -> news.json     -+-> app.html faz fetch dos .json
      scraper/bridgewise.mjs  -> bridgewise.json-'    (sem nenhuma chave no browser)

Esse é o mesmo padrão que o projeto já usava para `reports.json`.

> **Por que assim:** a documentação da API da Resenha exige que a chave `rnt_...`
> seja usada **só do lado servidor** e nunca apareça no código do browser. Como o
> GitHub Pages nao tem servidor, o "servidor" e o GitHub Actions. As chaves ficam
> em **Secrets**, fora do site e fora do historico do repositorio.

## Configurar os Secrets (uma vez)

No GitHub: **Settings -> Secrets and variables -> Actions -> New repository secret**.

Para as **noticias** (obrigatorio):

| Secret | Valor |
|--------|-------|
| `RESENHA_NEWS_API_KEY` | a chave `rnt_...` que o Filipe entregou |

Para a **Bridgewise** (quando for ligar a API real):

| Secret | Valor |
|--------|-------|
| `BRIDGEWISE_APP_ID` | Application ID |
| `BRIDGEWISE_TENANT_ID` | Tenant ID |
| `BRIDGEWISE_SECRET` | client secret / api key |
| `BRIDGEWISE_TOKEN_URL` | endpoint OAuth de token (ver doc Bridgewise) |
| `BRIDGEWISE_API_BASE` | base da API de analise |

Enquanto os 5 Secrets da Bridgewise nao estiverem preenchidos, o workflow gera
`bridgewise.json` a partir de `scraper/bridgewise-seed.json` (dados de exemplo),
para o site funcionar. Assim que preencher, ele passa a usar a API real.

## Workflows (GitHub Actions)

- `.github/workflows/atualizar-research.yml` — raspa o Genial Analisa -> `reports.json` (ja existia)
- `.github/workflows/atualizar-noticias.yml` — API Resenha + matching -> `news.json`
- `.github/workflows/atualizar-bridgewise.yml` — Bridgewise -> `bridgewise.json`

Todos rodam por agendamento e pelo botao **Run workflow**. Para gerar os JSON a
primeira vez, rode cada um manualmente por la.

## Rodar os scripts localmente (opcional, para testar)

    # noticias (precisa da chave no ambiente)
    RESENHA_NEWS_API_KEY=rnt_... node scraper/news.mjs --dry

    # bridgewise com dados de exemplo (sem chave)
    node scraper/bridgewise.mjs --seed --dry

## O que cada frente entrega

1. **Noticias Resenha + matching de carteira** — a aba "Noticias" le `news.json`,
   mostra quantos clientes cada noticia afeta e quanto patrimonio, e gera uma
   **mensagem por IA encaminhavel** ao cliente (WhatsApp).
2. **Chatbot consultor** — botao flutuante; responde sobre relatorios, clientes,
   noticias e Bridgewise. Com a IA conectada (botao "Conectar IA"), responde ao
   vivo com o contexto do site; sem chave, um motor local cobre as consultas comuns.
3. **Bridgewise** — a camada quantitativa passa a vir de `bridgewise.json`.
4. **Alertas de carteira por IA** — no drawer de cada cliente, o botao
   "Gerar alerta da carteira" cruza posicoes x relatorios x noticias x Bridgewise.
5. **WhatsApp/e-mail** — o disparo de teste ganhou um fallback `wa.me` que abre o
   WhatsApp com a mensagem pronta quando o CallMeBot nao confirma (parou de
   "falhar em silencio").

### Sobre a chave da Anthropic (chatbot e mensagens IA)

Essas funcoes usam a chave que o usuario cola em "Conectar IA", que roda no
browser (aceito para demo). **Sem** chave, tudo cai num modo de exemplo/local e o
site continua funcional. Se for para producao real, o correto e mover tambem essas
chamadas para o lado servidor (um proxy) — nao e o caso do GitHub Pages puro.

## Pendencias / proximos passos

- **Bridgewise real:** ajustar `getAccessToken()` e o mapeamento de campos em
  `normalizeBW()` (arquivo `scraper/bridgewise.mjs`) conforme a doc final de
  endpoints da Bridgewise, e preencher os 5 Secrets.
- **Fonte das noticias:** `scraper/news.mjs` usa `?source=analise`. Se a API expor
  outras fontes/pills que voce queira incluir, e so ajustar ali.

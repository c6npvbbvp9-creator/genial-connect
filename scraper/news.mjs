#!/usr/bin/env node
/**
 * news.mjs — API Resenha Trader → news.json
 * ---------------------------------------------------------------------------
 * Roda no GitHub Actions (lado servidor). A chave da API fica em
 * process.env.RESENHA_NEWS_API_KEY (GitHub Secret) e NUNCA é escrita no
 * arquivo de saída nem chega ao browser.
 *
 * O que faz:
 *   1) pagina GET /api/v1/news (respeitando 429 + Retry-After);
 *   2) para cada notícia, detecta tickers citados (tags/título/resumo);
 *   3) faz o matching contra a base de clientes (scraper/clients.mjs) —
 *      mesma lógica do app — e calcula quantos clientes e quanto patrimônio
 *      cada notícia afeta;
 *   4) grava ../news.json, que o app carrega no boot (com fallback embutido).
 *
 * Uso:
 *   RESENHA_NEWS_API_KEY=... node scraper/news.mjs
 *   node scraper/news.mjs --dry            # imprime, não escreve
 *   node scraper/news.mjs --limit 40       # teto de notícias (padrão 60)
 *   node scraper/news.mjs --out caminho.json
 */

import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIENTS, GENIAL_COVERED } from './clients.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const API = 'https://resenha-proxy.pages.dev/api/v1/news';
const KEY = process.env.RESENHA_NEWS_API_KEY;

const args = process.argv.slice(2);
const argVal = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const MAX = parseInt(argVal('--limit', '2000'), 10); // teto de segurança alto; a API para sozinha quando next_cursor acaba
const MAX_PAGES = parseInt(argVal('--max-pages', '60'), 10); // trava anti-loop (60 páginas x 100 = 6000 itens)
const DRY = args.includes('--dry');
const OUT = resolve(__dirname, argVal('--out', '../news.json'));
const PAGE = 100; // itens por página (máximo permitido pela API)

/* ------------------------------------------------------------------ utils */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Universo de tickers que sabemos reconhecer: os cobertos pela Genial +
// qualquer ticker que apareça de fato na carteira dos clientes.
const KNOWN_TICKERS = (() => {
  const s = new Set(GENIAL_COVERED);
  for (const c of CLIENTS) {
    for (const tk of Object.keys(c.posicoes)) {
      if (tk !== 'RENDA_FIXA') s.add(tk);
    }
  }
  return [...s];
})();

// Detecta tickers B3 (XXXX + dígito, ex.: PETR4, VALE3, SANB11) num texto,
// e cruza com o que a base de clientes realmente tem.
function detectTickers(item) {
  const found = new Set();

  // 1) tags estruturadas da API (mais confiáveis)
  if (Array.isArray(item.tags)) {
    for (const t of item.tags) {
      const up = String(t).toUpperCase().trim();
      if (KNOWN_TICKERS.includes(up)) found.add(up);
    }
  }

  // 2) varredura por regex no título + resumo
  const hay = `${item.title || ''} ${item.summary || ''}`.toUpperCase();
  const rx = /\b([A-Z]{4}\d{1,2})\b/g;
  let m;
  while ((m = rx.exec(hay)) !== null) {
    if (KNOWN_TICKERS.includes(m[1])) found.add(m[1]);
  }

  return [...found];
}

/* ---- Matching de carteira — espelha matchClients() do app ---- */
function matchPortfolio(tickers) {
  if (!tickers.length) {
    return { clientes: 0, patrimonioAfetado: 0, amostra: [] };
  }
  const afetados = [];
  for (const c of CLIENTS) {
    let valor = 0;
    const tickersDoCliente = [];
    for (const tk of tickers) {
      const v = c.posicoes[tk] || 0;
      if (v > 0) {
        valor += v;
        tickersDoCliente.push(tk);
      }
    }
    if (valor > 0) {
      afetados.push({
        id: c.id,
        nome: c.nome,
        valor,
        conc: Math.round((100 * valor) / c.patrimonio),
        tickers: tickersDoCliente,
      });
    }
  }
  afetados.sort((a, b) => b.valor - a.valor);
  return {
    clientes: afetados.length,
    patrimonioAfetado: afetados.reduce((s, c) => s + c.valor, 0),
    amostra: afetados.slice(0, 6), // top-6 p/ a UI, sem despejar a base toda
  };
}

/* ------------------------------------------------------------------ fetch */

async function fetchPage(cursor) {
  const url = new URL(API);
  url.searchParams.set('limit', String(PAGE));
  // A doc define `source` como bloomberg|bj|finance|infomoney. "analise" (do
  // link ?pills=analise da web) NÃO é valor válido de `source` e daria 400.
  // Por isso trazemos todas as fontes; se quiser uma só, defina FILTER_SOURCE.
  const FILTER_SOURCE = null; // ex.: 'infomoney' para filtrar uma fonte
  if (FILTER_SOURCE) url.searchParams.set('source', FILTER_SOURCE);
  if (cursor) url.searchParams.set('cursor', cursor);

  for (let tentativa = 0; tentativa < 4; tentativa++) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${KEY}`,
        'User-Agent': 'research-acionavel/1.0',
      },
    });

    if (res.status === 429) {
      const wait = parseInt(res.headers.get('retry-after') || '5', 10);
      console.warn(`[news] 429 — aguardando ${wait}s (Retry-After)…`);
      await sleep((wait + 1) * 1000);
      continue;
    }
    if (res.status === 401) {
      throw new Error('401 — chave da API ausente/errada (checar Secret RESENHA_NEWS_API_KEY).');
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ao buscar notícias.`);
    }
    return res.json();
  }
  throw new Error('Excesso de 429 — desisti após várias tentativas.');
}

/* ------------------------------------------------------------------- main */

async function main() {
  if (!KEY) {
    console.error('RESENHA_NEWS_API_KEY não definida — defina o Secret no GitHub.');
    process.exit(1);
  }

  const items = [];
  const vistos = new Set(); // dedup por id (a API pode repetir na virada de página)
  let cursor = null;
  let paginas = 0;
  do {
    const page = await fetchPage(cursor);
    const batch = page.items || [];
    for (const it of batch) {
      if (it && it.id && !vistos.has(it.id)) {
        vistos.add(it.id);
        items.push(it);
      }
    }
    cursor = page.next_cursor;
    paginas++;
    if (items.length >= MAX) break;
    if (paginas >= MAX_PAGES) {
      console.warn(`[news] atingi ${MAX_PAGES} páginas — parando por segurança.`);
      break;
    }
    if (cursor) await sleep(1100); // folga p/ não estourar 60 req/min
  } while (cursor);

  const noticias = items.slice(0, MAX).map((it) => {
    const tickers = detectTickers(it);
    const match = matchPortfolio(tickers);
    return {
      id: it.id,
      titulo: it.title,
      resumo: it.summary,
      fonte: it.source,
      categoria: it.category || null,
      tickers,
      publicado: it.published_at,
      data: it.date_ref,
      url: it.url,
      // resultado do matching — o que a UI usa para "N clientes afetados"
      afeta: match,
    };
  });

  // ordena TODAS por mais recente (a seção "Todas as notícias" é cronológica)
  noticias.sort((a, b) => new Date(b.publicado) - new Date(a.publicado));

  // subset "afeta sua base": só as com match, ordenadas por impacto (mais clientes primeiro)
  const comImpacto = noticias
    .filter((n) => n.afeta.clientes > 0)
    .sort((a, b) => {
      if (b.afeta.clientes !== a.afeta.clientes) return b.afeta.clientes - a.afeta.clientes;
      return new Date(b.publicado) - new Date(a.publicado);
    });

  const payload = {
    geradoEm: new Date().toISOString(),
    total: noticias.length,
    comImpacto: comImpacto.length,
    paginas,
    // a UI monta as duas seções a partir destes campos:
    idsComImpacto: comImpacto.map((n) => n.id), // ordem de impacto p/ a seção do topo
    noticias, // todas, cronológicas
  };

  if (DRY) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n');
  console.log(
    `[news] ${noticias.length} notícias em ${paginas} páginas · ${payload.comImpacto} com impacto de carteira → ${OUT}`
  );
}

main().catch((e) => {
  console.error('[news] falhou:', e.message);
  process.exit(1);
});

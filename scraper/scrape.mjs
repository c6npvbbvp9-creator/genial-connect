#!/usr/bin/env node
/**
 * scrape.mjs — Genial Analisa → reports.json
 * ---------------------------------------------------------------------------
 * Lê a página pública de Análises de Ações da Genial Analisa, abre os N
 * relatórios mais recentes e gera um `reports.json` no MESMO schema que o
 * array REPORTS do app. O app carrega esse arquivo no boot; se ele não existir
 * ou vier quebrado, o app cai no array embutido (nunca fica sem dados).
 *
 * Sem dependências: usa fetch nativo (Node 18+) e parsing por regex.
 *
 * Uso:
 *   node scrape.mjs                    # gera ../reports.json
 *   node scrape.mjs --out caminho.json
 *   node scrape.mjs --limit 12         # quantos relatórios buscar (padrão 10)
 *   node scrape.mjs --dry              # imprime o JSON, não escreve arquivo
 */

import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const BASE = 'https://analisa.genialinvestimentos.com.br';
const LISTA = `${BASE}/acoes/`;
const UA = 'Mozilla/5.0 (compatible; ResearchAcionavel-Demo/1.0)';

const args = process.argv.slice(2);
const argVal = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const LIMIT = parseInt(argVal('--limit', '10'), 10);
const DRY = args.includes('--dry');
const OUT = resolve(__dirname, argVal('--out', '../reports.json'));

/* ------------------------------------------------------------------ utils */

const MESES = {
  janeiro: 1, fevereiro: 2, março: 3, marco: 3, abril: 4, maio: 5, junho: 6,
  julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
};

const stripTags = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');

const decode = (s) =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#8217;|&rsquo;/g, '’')
    .replace(/&#8211;|&ndash;/g, '–')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d));

const clean = (s) => decode(stripTags(s)).replace(/\s+/g, ' ').trim();

const money = (s) => {
  if (!s) return null;
  const m = String(s).replace(/\./g, '').replace(',', '.').match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const v = parseFloat(m[0]);
  return Number.isFinite(v) ? v : null;
};

async function get(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
  return res.text();
}

/* --------------------------------------------------- 1) página de listagem */
/**
 * Extrai os relatórios da seção "Análises de Ações".
 * Cada card traz o link, o título e "Publicado em: dd/mm/aaaa".
 * Retorna [{url, titulo, data}] em ordem de publicação (mais recente primeiro).
 */
export function parseLista(html) {
  const out = [];
  const vistos = new Set();

  // pega só o trecho após o cabeçalho "Análises de Ações" (evita o bloco de
  // "Análises de Mercado", que não é relatório de ticker)
  const idx = html.indexOf('Análises de Ações');
  const trecho = idx > 0 ? html.slice(idx) : html;

  // <a href="/acoes/<empresa>/<slug>"> ... Publicado em: 13/07/2026 ...
  const re = /<a[^>]+href="((?:https?:\/\/[^"]+)?\/acoes\/[^"/]+\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(trecho)) !== null) {
    const href = m[1].startsWith('http') ? m[1] : BASE + m[1];
    const inner = m[2];
    const texto = clean(inner);

    const dm = texto.match(/Publicado em:?\s*(\d{2})\/(\d{2})\/(\d{4})/);
    if (!dm) continue; // não é card de relatório
    if (vistos.has(href)) continue;
    vistos.add(href);

    // título = texto antes de "Publicado em"
    let titulo = texto.split(/Publicado em/i)[0].trim();
    // o card começa com o setor (ex.: "- Imobiliário Multiplan (MULT3) | ...")
    titulo = titulo.replace(/^[-–·\s]+/, '');

    out.push({
      url: href,
      titulo,
      data: `${dm[3]}-${dm[2]}-${dm[1]}`, // ISO yyyy-mm-dd
    });
  }

  return out.sort((a, b) => (a.data < b.data ? 1 : a.data > b.data ? -1 : 0));
}

/* -------------------------------------------------- 2) página do relatório */
/**
 * Extrai os campos de um relatório individual.
 * Fonte da verdade do box "Leitura Dinâmica": recomendação, preço e preço-alvo.
 */
export function parseRelatorio(html, { url, titulo, data }) {
  const texto = clean(html);

  // --- ticker: dos parênteses do título, com fallback no box [TICKER]
  let ticker = (titulo.match(/\(([A-Z]{4}\d{1,2})\)/) || [])[1] || null;
  const boxTicker = (texto.match(/\[([A-Z]{4}\d{1,2})\]/) || [])[1] || null;
  // o box é a fonte oficial (ex.: a nota da "Axia" é precificada em ALUP11)
  if (boxTicker) ticker = boxTicker;
  if (!ticker) return null; // sem ticker não entra na fila

  // --- hora exata: "Publicado em 13 de Julho às 11:09:56"
  let hora = '09:00:00';
  const hm = texto.match(/Publicado em\s+\d{1,2}\s+de\s+([A-Za-zçÇãéêó]+)\s+às\s+(\d{2}:\d{2}:\d{2})/i);
  if (hm) hora = hm[2];
  const publicado = `${data}T${hora}`;

  // --- setor: breadcrumb "Ações > Metais > CSN > Relatório"
  let setor = null;
  const bc = texto.match(/Ações\s*>\s*([^>]+?)\s*>/);
  if (bc) setor = bc[1].trim();

  // --- título oficial: o <h1> da própria página (sem o prefixo de setor que
  //     aparece no card da listagem, ex.: "Imobiliário Multiplan (MULT3) | ...")
  const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1];
  const tituloLimpo = h1 ? clean(h1) : titulo.replace(/^.*?(?=[A-ZÁÉÍÓÚ][^\s(]*\s*\()/, '');

  // --- empresa: "Multiplan (MULT3) | ..." → antes do parêntese
  let empresa = (tituloLimpo.match(/^([^(|]+)\(/) || [])[1];
  empresa = empresa ? empresa.trim() : ticker;

  // --- analista: link /analistas/<slug>
  let analista = null;
  const am = html.match(/\/analistas\/[^"']+["'][^>]*>([^<]+)</i);
  if (am) analista = clean(am[1]).replace(/Analista.*$/i, '').trim();
  if (!analista) {
    const known = texto.match(/(João Caldas|Luca Vello|Vitor Sousa|Alan Frydman|Filipe Villegas|Thainá Rambaldo|Roberto Motta)/);
    analista = known ? known[1] : 'Genial Analisa';
  }

// --- Leitura Dinâmica: recomendação / preço / preço-alvo
  const li = texto.indexOf('Leitura Din');           // sem acento fixo
  const box = li >= 0 ? texto.slice(li, li + 500) : texto;

  let rec = (box.match(/Recomenda(?:ções|ção|coes|cao)\s*:?\s*(Compra(?:r)?|Manter|Vender|Em\s*Revis[ãa]o|Neutro)/i) || [])[1] || null;
  if (rec) {
    rec = rec.replace(/\s+/g, ' ').toUpperCase();
    if (rec === 'COMPRA') rec = 'COMPRAR';
  }

  // o ticker oficial é o do box (ex.: a nota "Axia" é precificada em ALUP11)
  const boxTk = (box.match(/\[\s*([A-Z]{4}\d{1,2})\s*\]/) || [])[1];
  if (boxTk) ticker = boxTk;

  // "Preço (13/07) R$ 30,29" — mas o site varia: pode não ter a data, pode ter
  // "Preço de Fechamento", quebras de linha, etc. Então pegamos TODOS os
  // "R$ x" do box em ordem: o 1º é o preço atual, o 2º é o preço-alvo.
  let precoAtual = null;
  let precoAlvo  = null;

  const alvoM = box.match(/Pre[çc]o\s*[- ]?\s*Alvo[^\d]{0,20}([\d.,]+)/i);
  if (alvoM) precoAlvo = money(alvoM[1]);

  const atualM = box.match(/Pre[çc]o\s*(?!Alvo)(?:de\s*Fechamento)?\s*(?:\(\s*\d{2}\/\d{2}\s*\))?[^\d]{0,20}([\d.,]+)/i);
  if (atualM) precoAtual = money(atualM[1]);

  // rede de segurança: se algum falhou, usa a ordem dos valores em R$
  if (precoAtual === null || precoAlvo === null) {
    const nums = [...box.matchAll(/R\$\s*([\d.,]+)/g)].map(m => money(m[1]));
    if (precoAtual === null && nums[0] != null) precoAtual = nums[0];
    if (precoAlvo  === null && nums[1] != null) precoAlvo  = nums[1];
  }

  // último recurso: o corpo quase sempre traz "preço-alvo de R$ 37,00"
  if (precoAlvo === null) {
    const m2 = texto.match(/pre[çc]o[- ]alvo[^\d]{0,25}([\d.,]+)/i);
    if (m2) precoAlvo = money(m2[1]);
  }

  // "R$ 0,00" = placeholder de recomendação suspensa → sem alvo
  if (precoAlvo === 0) precoAlvo = null;
  if (precoAtual === 0) precoAtual = null;

  // --- assunto: o que vem depois do "|" no título
  const assunto = (tituloLimpo.split('|')[1] || tituloLimpo).trim();

  // --- corpo: parágrafos do artigo (o suficiente para a IA resumir)
  const corpo = extrairCorpo(html);

  // --- tipo (heurística a partir do título)
  const t = tituloLimpo.toLowerCase();
  const tipo = /prévia|previa/.test(t) ? 'Prévia de resultado'
    : /resultado \d[tT]\d/.test(t) ? 'Resultado trimestral'
    : /leilão|leilao/.test(t) ? 'Nota setorial (leilão)'
    : /opa|aquisi|fusão|m&a|venda/.test(t) ? 'Nota de evento (M&A)'
    : /produção|producao|dados/.test(t) ? 'Dados operacionais'
    : 'Nota de análise';

  // --- relevância: derivada, pois o site não publica esse campo.
  //     ALTA quando o relatório tende a exigir ação do assessor.
  const potencial = (precoAlvo && precoAtual) ? Math.abs((precoAlvo - precoAtual) / precoAtual * 100) : 0;
  const relevancia =
    (rec === 'EM REVISÃO' || /prévia|previa|opa|aquisi/.test(t) || potencial >= 20) ? 'ALTA'
    : potencial >= 8 ? 'MÉDIA'
    : 'BAIXA';

  const dataBR = data.split('-').reverse().join('/');

  return {
    id: 'r-' + ticker.toLowerCase() + '-' + data.replace(/-/g, ''),
    ticker,
    empresa,
    setor: setor || '—',
    analista: `${analista} · Genial Analisa`,
    publicado,
    tipo,
    rec,
    recAnterior: rec,     // o site não expõe a recomendação anterior
    precoAlvo,
    precoAlvoAnterior: precoAlvo,
    precoAtual,
    relevancia,
    assunto,
    fonteTipo: 'real',
    fonteUrl: url,
    fonteLabel: `${tituloLimpo} — Genial Analisa (${dataBR})`,
    corpo,
    disclaimer: 'Este material foi elaborado pela Genial Investimentos e não constitui oferta de compra ou venda de valores mobiliários. Rentabilidade passada não garante resultados futuros.',
    _fonte: 'scraper',   // marca de origem (o app mostra "atualizado automaticamente")
  };
}

/** Junta os parágrafos do corpo do artigo, até ~1600 caracteres. */
function extrairCorpo(html) {
  // corta cabeçalho/menu e rodapé para não capturar navegação
  let h = html;
  const i1 = h.indexOf('Publicado em');
  const i2 = h.indexOf('Acesse o disclaimer');
  if (i1 > 0 && i2 > i1) h = h.slice(i1, i2);

  const paras = [];
  const re = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(h)) !== null) {
    const p = clean(m[1]);
    if (p.length < 60) continue;                      // pula legendas e "Fonte: ..."
    if (/^Fonte:/i.test(p)) continue;
    if (/Compartilh|whatsapp|linkedin/i.test(p)) continue;
    paras.push(p);
    if (paras.join(' ').length > 1600) break;
  }
  return paras.join('\n\n').slice(0, 1800) || '(corpo não extraído — ver relatório original)';
}

/* ----------------------------------------------------------------- runner */

async function main() {
  console.error(`→ lendo ${LISTA}`);
  const lista = parseLista(await get(LISTA)).slice(0, LIMIT);
  console.error(`→ ${lista.length} relatórios encontrados na listagem`);

  const reports = [];
  for (const item of lista) {
    try {
      const html = await get(item.url);
      const r = parseRelatorio(html, item);
      if (r) {
        reports.push(r);
        console.error(`  ✓ ${r.ticker.padEnd(7)} ${r.publicado}  ${r.rec ?? '—'}`);
      } else {
        console.error(`  · pulado (sem ticker): ${item.titulo.slice(0, 60)}`);
      }
      await new Promise((r) => setTimeout(r, 600)); // educado com o servidor
    } catch (e) {
      console.error(`  ✗ falhou ${item.url}: ${e.message}`);
    }
  }

  if (!reports.length) {
    console.error('✗ nenhum relatório extraído — abortando SEM sobrescrever o reports.json existente.');
    process.exit(1);
  }

  reports.sort((a, b) => new Date(b.publicado) - new Date(a.publicado));

  const payload = {
    geradoEm: new Date().toISOString(),
    fonte: LISTA,
    total: reports.length,
    reports,
  };

  const json = JSON.stringify(payload, null, 2);
  if (DRY) {
    console.log(json);
  } else {
    writeFileSync(OUT, json);
    console.error(`✓ ${reports.length} relatórios gravados em ${OUT}`);
  }
}

// só executa quando chamado direto (permite importar as funções em testes)
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error('✗ erro fatal:', e.message);
    process.exit(1);
  });
}

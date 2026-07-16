#!/usr/bin/env node
/**
 * bridgewise.mjs — Bridgewise API → bridgewise.json
 * ---------------------------------------------------------------------------
 * Roda no GitHub Actions. As credenciais ficam em Secrets:
 *   BRIDGEWISE_APP_ID    (Application ID)
 *   BRIDGEWISE_TENANT_ID (Tenant ID)
 *   BRIDGEWISE_SECRET    (client secret / api key — quando você tiver)
 *   BRIDGEWISE_TOKEN_URL (endpoint OAuth de token, se aplicável)
 *   BRIDGEWISE_API_BASE  (base da API de análise)
 * NENHUMA delas é escrita no arquivo de saída nem chega ao browser.
 *
 * A autenticação da Bridgewise é OAuth client-credentials (App ID + Tenant +
 * secret) — não pode rodar no browser com segurança, por isso vive aqui.
 *
 * Enquanto a doc de endpoints não estiver fechada, o script cai num SEED
 * (scraper/bridgewise-seed.json) para o Actions já produzir um bridgewise.json
 * válido e o app funcionar. Assim que você tiver o token URL + base da API,
 * preencha os Secrets e o bloco fetchReal() abaixo passa a valer.
 *
 * Uso:
 *   node scraper/bridgewise.mjs            # tenta API real; senão, seed
 *   node scraper/bridgewise.mjs --dry
 *   node scraper/bridgewise.mjs --seed     # força usar o seed (offline)
 */

import { writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GENIAL_COVERED, CLIENTS } from './clients.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const FORCE_SEED = args.includes('--seed');
const OUT = resolve(__dirname, '../bridgewise.json');
const SEED = resolve(__dirname, 'bridgewise-seed.json');

const {
  BRIDGEWISE_APP_ID,
  BRIDGEWISE_TENANT_ID,
  BRIDGEWISE_SECRET,
  BRIDGEWISE_TOKEN_URL,
  BRIDGEWISE_API_BASE,
} = process.env;

// Universo de tickers que nos interessa pedir à Bridgewise: cobertos pela
// Genial + o que os clientes de fato têm em carteira.
const UNIVERSE = (() => {
  const s = new Set(GENIAL_COVERED);
  for (const c of CLIENTS) {
    for (const tk of Object.keys(c.posicoes)) {
      if (tk !== 'RENDA_FIXA') s.add(tk);
    }
  }
  return [...s];
})();

/* ------------------------------------------------------------ auth (real) */

async function getAccessToken() {
  if (!BRIDGEWISE_TOKEN_URL) throw new Error('sem BRIDGEWISE_TOKEN_URL');
  // OAuth2 client-credentials. Ajuste os campos conforme a doc final da
  // Bridgewise (alguns tenants usam 'tenant_id' no corpo, outros no header).
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: BRIDGEWISE_APP_ID,
    client_secret: BRIDGEWISE_SECRET || '',
    tenant_id: BRIDGEWISE_TENANT_ID,
  });
  const res = await fetch(BRIDGEWISE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`token HTTP ${res.status}`);
  const j = await res.json();
  if (!j.access_token) throw new Error('resposta de token sem access_token');
  return j.access_token;
}

async function fetchReal() {
  if (!BRIDGEWISE_API_BASE) throw new Error('sem BRIDGEWISE_API_BASE');
  const token = await getAccessToken();
  const out = {};
  for (const ticker of UNIVERSE) {
    // Endpoint conforme doc: GET {base}/v1/securities/{ticker}/analysis
    const url = `${BRIDGEWISE_API_BASE.replace(/\/$/, '')}/v1/securities/${ticker}/analysis`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Tenant-Id': BRIDGEWISE_TENANT_ID,
      },
    });
    if (res.status === 404) continue; // ticker sem cobertura BW
    if (res.status === 429) {
      const wait = parseInt(res.headers.get('retry-after') || '5', 10);
      await new Promise((r) => setTimeout(r, (wait + 1) * 1000));
      continue;
    }
    if (!res.ok) {
      console.warn(`[bw] ${ticker}: HTTP ${res.status} — pulando`);
      continue;
    }
    const a = await res.json();
    // Normaliza para o shape que o app consome (score, sinal, fatores, peers, resumo)
    out[ticker] = normalizeBW(ticker, a);
    await new Promise((r) => setTimeout(r, 250)); // gentileza com rate-limit
  }
  if (!Object.keys(out).length) throw new Error('API real não retornou nada');
  return out;
}

// Ajuste este mapeamento quando a doc de campos da Bridgewise estiver fechada.
function normalizeBW(ticker, a) {
  return {
    score: a.score ?? a.overall_score ?? null,
    sinal: a.signal ?? a.rating ?? '—',
    tendencia: a.trend ?? a.tendencia ?? 'estável',
    fatores: a.factors ?? a.fatores ?? {},
    peers: a.peers ?? [],
    resumo: a.summary ?? a.resumo ?? '',
  };
}

/* ------------------------------------------------------------------- main */

async function main() {
  let dados;
  let fonte;

  if (FORCE_SEED) {
    dados = JSON.parse(readFileSync(SEED, 'utf8'));
    fonte = 'seed (--seed)';
  } else {
    try {
      dados = await fetchReal();
      fonte = 'Bridgewise API';
    } catch (e) {
      console.warn(`[bw] API real indisponível (${e.message}) → usando seed.`);
      dados = JSON.parse(readFileSync(SEED, 'utf8'));
      fonte = 'seed (fallback)';
    }
  }

  const payload = {
    geradoEm: new Date().toISOString(),
    fonte,
    cobertura: Object.keys(dados).length,
    bridgewise: dados,
  };

  if (DRY) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n');
  console.log(`[bw] ${payload.cobertura} ativos (${fonte}) → ${OUT}`);
}

main().catch((e) => {
  console.error('[bw] falhou:', e.message);
  process.exit(1);
});

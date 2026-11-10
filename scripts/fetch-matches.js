// scripts/fetch-matches.js
// Собирает матчи Dota 2 и CS2 из PandaScore API и пишет data/matches.json
//
// PandaScore endpoints:
//   GET /{game}/matches?filter[upcoming]=true&token=...
//   GET /{game}/matches?filter[running]=true&token=...
//   GET /{game}/matches/{id}/odds  (не всегда доступно на бесплатном тарифе)

const fs = require('fs');
const path = require('path');

const TOKEN = process.env.PANDASCORE_TOKEN;
if (!TOKEN) {
  console.error('PANDASCORE_TOKEN is not set');
  process.exit(1);
}

const GAMES = [
  { key: 'dota2', slug: 'dota-2' },
  { key: 'cs2',   slug: 'cs2'    },
];

async function fetchJSON(url) {
  const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}

async function fetchMatchesForGame(slug) {
  const base = `https://api.pandascore.co/${slug}/matches`;
  const [upcoming, running] = await Promise.all([
    fetchJSON(`${base}?filter[upcoming]=true&per_page=40&token=${TOKEN}`),
    fetchJSON(`${base}?filter[running]=true&per_page=20&token=${TOKEN}`),
  ]);
  return [...(running || []), ...(upcoming || [])];
}

async function fetchOddsForMatch(slug, matchId) {
  try {
    const url = `https://api.pandascore.co/${slug}/matches/${matchId}/odds?token=${TOKEN}`;
    const data = await fetchJSON(url);
    return data || [];
  } catch {
    return [];
  }
}

/* ---------- Построение рынков ---------- */

function buildWinnerMarket(match, oddsList) {
  const t1 = match.opponents?.[0]?.opponent;
  const t2 = match.opponents?.[1]?.opponent;
  if (!t1 || !t2) return null;

  // Пытаемся взять кефы из odds
  let o1 = null, o2 = null;
  const moneyline = (oddsList || []).find(o =>
    /moneyline|winner|match.?winner/i.test(o.name || '')
  );
  if (moneyline?.opponents) {
    o1 = moneyline.opponents.find(x => x.opponent?.id === t1.id)?.odds;
    o2 = moneyline.opponents.find(x => x.opponent?.id === t2.id)?.odds;
  }

  // Фоллбэк: кефы на основе win_rate
  if (!o1 || !o2) {
    const wr1 = t1.win_rate ?? 50;
    const wr2 = t2.win_rate ?? 50;
    const p1 = Math.max(0.1, Math.min(0.9, wr1 / 100));
    const p2 = 1 - p1;
    o1 = +(1 / (p1 * 0.92)).toFixed(2); // маржа ~8%
    o2 = +(1 / (p2 * 0.92)).toFixed(2);
  }

  return {
    id: 'winner',
    name: 'Победитель матча',
    selections: [
      { id: 't1', name: t1.name, odds: Number(o1) },
      { id: 't2', name: t2.name, odds: Number(o2) },
    ],
  };
}

function buildTotalMapsMarket(match, game) {
  // Для CS2 — tot. карт (bo3/bo5), для Dota — tot. карт
  const isBo5 = /bo5|grand final/i.test(match.name || match.tournament?.name || '');
  const line = isBo5 ? 3.5 : 2.5;
  // Простая генерация: около 50/50 с лёгким наклоном
  const over = +(1.85 + Math.random() * 0.15).toFixed(2);
  const under = +(1.95 + Math.random() * 0.15).toFixed(2);
  return {
    id: 'total_maps',
    name: game === 'cs2' ? 'Тотал карт' : 'Тотал карт',
    line,
    selections: [
      { id: 'over',  name: `Больше ${line}`, odds: over },
      { id: 'under', name: `Меньше ${line}`, odds: under },
    ],
  };
}

function buildHandicapMarket(match) {
  const t1 = match.opponents?.[0]?.opponent;
  const t2 = match.opponents?.[1]?.opponent;
  if (!t1 || !t2) return null;
  const line = -1.5;
  return {
    id: 'handicap_maps',
    name: 'Фора по картам',
    line,
    selections: [
      { id: 't1_h', name: `${t1.name} (${line})`, odds: +(2.6 + Math.random() * 0.4).toFixed(2) },
      { id: 't2_h', name: `${t2.name} (+${-line})`, odds: +(1.4 + Math.random() * 0.2).toFixed(2) },
    ],
  };
}

function buildDurationMarket(match, game) {
  // Разные диапазоны для Dota (длинные матчи) и CS2 (короткие)
  if (game === 'dota2') {
    return {
      id: 'duration',
      name: 'Длительность (средняя карта)',
      selections: [
        { id: 'short', name: 'до 30 мин',     odds: +(2.4 + Math.random() * 0.4).toFixed(2) },
        { id: 'mid',   name: '30–45 мин',     odds: +(1.75 + Math.random() * 0.2).toFixed(2) },
        { id: 'long',  name: 'более 45 мин',  odds: +(3.0 + Math.random() * 0.6).toFixed(2) },
      ],
    };
  } else {
    return {
      id: 'duration',
      name: 'Длительность матча',
      selections: [
        { id: 'short', name: 'до 60 мин',     odds: +(1.9 + Math.random() * 0.2).toFixed(2) },
        { id: 'mid',   name: '60–90 мин',     odds: +(2.1 + Math.random() * 0.3).toFixed(2) },
        { id: 'long',  name: 'более 90 мин',  odds: +(2.8 + Math.random() * 0.4).toFixed(2) },
      ],
    };
  }
}

function buildFirstBloodMarket() {
  return {
    id: 'first_blood',
    name: 'Первая кровь / Первый фрай',
    selections: [
      { id: 'yes', name: 'Да',  odds: +(1.85 + Math.random() * 0.1).toFixed(2) },
      { id: 'no',  name: 'Нет', odds: +(1.90 + Math.random() * 0.1).toFixed(2) },
    ],
  };
}

/* ---------- Главная ---------- */

async function main() {
  const allMatches = [];

  for (const g of GAMES) {
    const raw = await fetchMatchesForGame(g.slug);
    for (const m of raw) {
      const t1 = m.opponents?.[0]?.opponent;
      const t2 = m.opponents?.[1]?.opponent;
      if (!t1 || !t2) continue;

      // odds для матча (могут отсутствовать — это нормально)
      const odds = await fetchOddsForMatch(g.slug, m.id);

      const markets = [];
      const winner = buildWinnerMarket(m, odds);
      if (winner) markets.push(winner);
      markets.push(buildTotalMapsMarket(m, g.key));
      const handicap = buildHandicapMarket(m);
      if (handicap) markets.push(handicap);
      markets.push(buildDurationMarket(m, g.key));
      if (g.key === 'dota2') markets.push(buildFirstBloodMarket());

      allMatches.push({
        id: String(m.id),
        game: g.key,
        status: m.status === 'running' ? 'running' : 'not_started',
        start_time: m.begin_at || m.scheduled_at,
        tournament: m.league?.name || m.tournament?.name || '',
        league: m.series?.name || '',
        team1: { name: t1.name, image_url: t1.image_url || '' },
        team2: { name: t2.name, image_url: t2.image_url || '' },
        markets,
      });

      // Лёгкая задержка, чтобы не упереться в rate-limit
      await new Promise(r => setTimeout(r, 120));
    }
  }

  const out = {
    updated_at: new Date().toISOString(),
    matches: allMatches,
  };

  const outPath = path.join(__dirname, '..', 'data', 'matches.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`Wrote ${allMatches.length} matches to ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });

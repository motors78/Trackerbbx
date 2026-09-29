
const STORAGE_KEY = "scommesse_serieB_v2";
const BANKROLL_INI = 10;

const ODDS_HISTORY_KEY = "odds_history";
function leggiStorage(key, fallback) {
  try { const value = JSON.parse(localStorage.getItem(key) || "null"); return value ?? fallback; }
  catch { return fallback; }
}
function escapeHTML(value) { return String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]); }
let scommesse = leggiStorage(STORAGE_KEY, []);
let oddsHistory = leggiStorage(ODDS_HISTORY_KEY, {});
let editIdx = null, deleteIdx = null, eventiMultipla = [];
let pendingAdd = null, ultimiDatiPartite = [];

if (!Array.isArray(scommesse)) scommesse = [];
if (!oddsHistory || typeof oddsHistory !== "object" || Array.isArray(oddsHistory)) oddsHistory = {};

function salvaLS() { localStorage.setItem(STORAGE_KEY, JSON.stringify(scommesse)); }

// ===== FIX 1: Blocco segnali duplicati per partita =====
const ALERT_MATCH_KEY = "alertedMatches_v1";
const ALERT_COOLDOWN_MS = 3 * 60 * 60 * 1000; // 3 ore
let alertedMatches = leggiStorage(ALERT_MATCH_KEY, {});
if (!alertedMatches || typeof alertedMatches !== "object" || Array.isArray(alertedMatches)) alertedMatches = {};

function isMatchAlreadyAlerted(matchId) {
  const entry = alertedMatches[matchId];
  if (!entry) return false;
  if (Date.now() - entry.ts > ALERT_COOLDOWN_MS) {
    delete alertedMatches[matchId];
    salvaAlertedMatches();
    return false;
  }
  return true;
}

function markMatchAlerted(matchId, mercato) {
  alertedMatches[matchId] = { ts: Date.now(), mercato };
  salvaAlertedMatches();
}

function salvaAlertedMatches() {
  localStorage.setItem(ALERT_MATCH_KEY, JSON.stringify(alertedMatches));
}

function pulisciAlertScaduti() {
  let modificato = false;
  Object.keys(alertedMatches).forEach(id => {
    if (Date.now() - alertedMatches[id].ts > ALERT_COOLDOWN_MS) {
      delete alertedMatches[id];
      modificato = true;
    }
  });
  if (modificato) salvaAlertedMatches();
}

const NOTIF_SOGLIA = 0.08;

async function richiediPermessoNotifiche() {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  const perm = await Notification.requestPermission();
  return perm === "granted";
}

function inviaNotifica(titolo, testo) {
  if (Notification.permission !== "granted") return;
  new Notification(titolo, { body: testo, icon: "/icon-192.png", badge: "/icon-192.png", tag: titolo });
}

function controllaMovimentiQuote(nuoviDati) {
  if (!nuoviDati || !nuoviDati.length) return;
  const notifiche = [];
  nuoviDati.forEach(match => {
    ["home", "away"].forEach(tipo => {
      const team = tipo === "home" ? match.home_team : match.away_team;
      const key = `${match.id}_${team}`;
      const hist = oddsHistory[key];
      if (!hist || hist.length < 2) return;
      const first = hist[0].q, last = hist[hist.length - 1].q;
      const variazione = (last - first) / first;
      if (Math.abs(variazione) >= NOTIF_SOGLIA) {
        const matchKey = match.id; // FIX 1: chiave per partita, non per team
        if (!isMatchAlreadyAlerted(matchKey)) {
          const dir = variazione < 0 ? "📉 CALO" : "📈 SALITA";
          const pctVal = (Math.abs(variazione) * 100).toFixed(1);
          notifiche.push({
            titolo: `${dir} quota: ${team}`,
            testo: `${match.home_team} vs ${match.away_team} — quota ${tipo === "home" ? "1" : "2"}: ${last.toFixed(2)} (${variazione < 0 ? "-" : "+"}${pctVal}%)`,
            matchKey,
            mercato: tipo
          });
        }
      }
    });
  });
  // FIX 1: marca come alertata SOLO le partite che effettivamente mandiamo
  notifiche.slice(0, 3).forEach(n => {
    inviaNotifica(n.titolo, n.testo);
    markMatchAlerted(n.matchKey, n.mercato);
  });
  return notifiche.length;
}
function salvaOddsHistory() { localStorage.setItem(ODDS_HISTORY_KEY, JSON.stringify(oddsHistory)); }
function fmt(n) { return Number(n).toFixed(2); }
function pct(n) { return Number(n).toFixed(1) + "%"; }
// ===== STATS =====
function calcStats() {
  const vinte = scommesse.filter(s => s.risultato === "VINTO");
  const perse = scommesse.filter(s => s.risultato === "PERSO");
  const totalePuntato = scommesse.reduce((a, s) => a + (parseFloat(s.puntata) || 0), 0);
  const totalVinto = vinte.reduce((a, s) => {
    const q = s.tipo === "multipla" ? parseFloat(s.quotaTotale) : parseFloat(s.quota);
    return a + ((q - 1) * (parseFloat(s.puntata) || 0));
  }, 0);
  const totalPerso = perse.reduce((a, s) => a + (parseFloat(s.puntata) || 0), 0);
  const utile = totalVinto - totalPerso;
  const bankroll = BANKROLL_INI + utile;
  const roi = totalePuntato > 0 ? (utile / totalePuntato) * 100 : 0;
  const winRate = (vinte.length + perse.length) > 0 ? vinte.length / (vinte.length + perse.length) * 100 : 0;
  const value = scommesse.filter(s => s.value === "SÌ VALUE").length;
  const multiple = scommesse.filter(s => s.tipo === "multipla").length;
  return { vinte: vinte.length, perse: perse.length, totalePuntato, utile, bankroll, roi, winRate, value, multiple };
}

function profitto(s) {
  const q = s.tipo === "multipla" ? parseFloat(s.quotaTotale) : parseFloat(s.quota);
  if (s.risultato === "VINTO") return "+" + fmt((q - 1) * s.puntata) + "€";
  if (s.risultato === "PERSO") return "-" + fmt(s.puntata) + "€";
  return "—";
}
function profittoClass(s) { return s.risultato === "VINTO" ? "green" : s.risultato === "PERSO" ? "red" : "gray"; }
function risultatoClass(r) { return r === "VINTO" ? "green" : r === "PERSO" ? "red" : "gray"; }

// ===== KELLY CRITERION =====
function calcolaKelly() {
  const quota = parseFloat(document.getElementById("k-quota").value);
  const prob = parseFloat(document.getElementById("k-prob").value) / 100;
  const bankroll = parseFloat(document.getElementById("k-bankroll").value);
  const fraz = parseFloat(document.getElementById("k-fraz").value);
  const res = document.getElementById("kelly-result");
  if (isNaN(quota) || isNaN(prob) || isNaN(bankroll) || quota <= 1 || prob <= 0 || prob >= 1) {
    res.style.display = "none"; return;
  }
  const b = quota - 1, q = 1 - prob;
  const kelly = (b * prob - q) / b;
  const kellyFrazionato = kelly * fraz;
  const puntata = Math.max(0, kellyFrazionato * bankroll);
  res.style.display = "block";
  const warn = document.getElementById("kelly-warning");
  if (kelly <= 0) {
    document.getElementById("kelly-amount").textContent = "0€ — Non scommettere";
    document.getElementById("kelly-amount").style.color = "#fc8181";
    document.getElementById("kelly-detail").textContent = "Questa scommessa non ha valore atteso positivo.";
    warn.textContent = "⚠️ Kelly negativo: la quota non giustifica la probabilità stimata.";
    warn.style.color = "#fc8181";
  } else {
    document.getElementById("kelly-amount").textContent = fmt(puntata) + "€";
    document.getElementById("kelly-amount").style.color = "#48bb78";
    document.getElementById("kelly-detail").textContent =
      `Kelly pieno: ${pct(kelly * 100)} del bankroll | Frazionato ${fraz*100}%: ${fmt(puntata)}€`;
    // FIX 3: warning a 3 livelli invece di soglia fissa 0.3
    if (kelly > 0.5) {
      warn.textContent = "🔴 Kelly molto alto — rischio elevato, usa 25% fractional.";
      warn.style.color = "#fc8181";
    } else if (kelly > 0.25) {
      warn.textContent = "⚠️ Kelly alto — considera il 25% fractional per proteggere il bankroll.";
      warn.style.color = "#f6ad55";
    } else {
      warn.textContent = "✅ Kelly nella norma con frazione al 25%.";
      warn.style.color = "#48bb78";
    }
  }
}
// ===== ROI PER CATEGORIA E CAMPIONATO =====
function calcRoiPerGruppo(campo) {
  const gruppi = {};
  scommesse.filter(s => s.risultato === "VINTO" || s.risultato === "PERSO").forEach(s => {
    const key = (campo === "categoria"
      ? (s.tipo === "multipla" ? "Multipla" : s.categoria || "N/D")
      : (s.campionato || "N/D"));
    if (!gruppi[key]) gruppi[key] = { vinte: 0, perse: 0, puntato: 0, utile: 0 };
    const q = s.tipo === "multipla" ? parseFloat(s.quotaTotale) : parseFloat(s.quota);
    const p = parseFloat(s.puntata) || 0;
    gruppi[key].puntato += p;
    if (s.risultato === "VINTO") { gruppi[key].vinte++; gruppi[key].utile += (q - 1) * p; }
    else { gruppi[key].perse++; gruppi[key].utile -= p; }
  });
  return gruppi;
}

function renderCalibrazione() {
  const el = document.getElementById("calibrazione-chart");
  const conProb = scommesse.filter(s =>
    (s.risultato === "VINTO" || s.risultato === "PERSO") &&
    s.probStimata && !isNaN(parseFloat(s.probStimata))
  );
  if (conProb.length < 3) {
    el.innerHTML = '<div class="empty">Servono almeno 3 scommesse con probabilità stimata.</div>'; return;
  }
  const fasce = [
    { label: "<40%",  min: 0,  max: 40  },
    { label: "40-50%", min: 40, max: 50  },
    { label: "50-60%", min: 50, max: 60  },
    { label: "60-70%", min: 60, max: 70  },
    { label: ">70%",  min: 70, max: 100 },
  ];
  const dati = fasce.map(f => {
    const gruppo = conProb.filter(s => { const p = parseFloat(s.probStimata); return p >= f.min && p < f.max; });
    const vinte = gruppo.filter(s => s.risultato === "VINTO").length;
    const winRate = gruppo.length > 0 ? (vinte / gruppo.length * 100) : null;
    return { ...f, totale: gruppo.length, vinte, winRate };
  }).filter(d => d.totale > 0);
  if (!dati.length) { el.innerHTML = '<div class="empty">Nessun dato sufficiente.</div>'; return; }
  el.innerHTML = `
    <div style="font-size:12px;color:#718096;margin-bottom:16px">Confronto tra probabilità stimata e win rate reale per fascia.</div>
    ${dati.map(d => {
      const stimataCenter = (d.min + d.max) / 2;
      const color = d.winRate >= stimataCenter - 5 ? "#48bb78" : "#fc8181";
      return `<div style="margin-bottom:18px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <div style="font-weight:700;font-size:13px">${d.label}</div>
          <div style="font-size:12px;color:#718096">${d.vinte}V / ${d.totale - d.vinte}P (${d.totale})</div>
        </div>
        <div style="position:relative;height:28px;background:#0f1117;border-radius:6px;overflow:hidden">
          <div style="position:absolute;left:0;top:0;height:100%;width:${stimataCenter}%;background:#2d3748;border-radius:6px;opacity:0.5"></div>
          <div style="position:absolute;left:0;top:0;height:100%;width:${d.winRate !== null ? d.winRate : 0}%;background:${color};border-radius:6px;transition:.5s"></div>
          <div style="position:absolute;right:8px;top:50%;transform:translateY(-50%);font-size:12px;font-weight:700;color:#e2e8f0">
            Reale: ${d.winRate !== null ? d.winRate.toFixed(1)+"%" : "N/D"} <span style="color:#718096;font-weight:400">/ Stimata: ~${stimataCenter.toFixed(0)}%</span>
          </div>
        </div>
      </div>`;
    }).join("")}`;
}

// FIX 7: funzione ROI per range quota — aggiungila PRIMA di renderStatistiche
function calcRoiPerRangeQuota() {
  const ranges = [
    { label: "Bassa (1.01–1.50)", min: 1.01, max: 1.50 },
    { label: "Media (1.51–2.50)", min: 1.51, max: 2.50 },
    { label: "Alta (2.51–4.00)",  min: 2.51, max: 4.00 },
    { label: "Speculativa (4.01–10.00)", min: 4.01, max: 10.00 }, // FIX 2: cap a 10
  ];
  const risultato = {};
  ranges.forEach(r => { risultato[r.label] = { vinte: 0, perse: 0, puntato: 0, utile: 0 }; });
  scommesse.filter(s => s.risultato === "VINTO" || s.risultato === "PERSO").forEach(s => {
    const q = s.tipo === "multipla" ? parseFloat(s.quotaTotale) : parseFloat(s.quota);
    const p = parseFloat(s.puntata) || 0;
    if (isNaN(q)) return;
    const range = ranges.find(r => q >= r.min && q <= r.max);
    if (!range) return;
    const key = range.label;
    risultato[key].puntato += p;
    if (s.risultato === "VINTO") { risultato[key].vinte++; risultato[key].utile += (q - 1) * p; }
    else { risultato[key].perse++; risultato[key].utile -= p; }
  });
  return risultato;
}

function renderStatistiche() {
  renderCalibrazione();

  // ROI per categoria
  const catGruppi = calcRoiPerGruppo("categoria");
  const catEl = document.getElementById("roi-categoria");
  if (!Object.keys(catGruppi).length) { catEl.innerHTML = '<div class="empty">Nessun dato disponibile ancora.</div>'; }
  else {
    catEl.innerHTML = `<table class="stats-table"><thead><tr><th>Categoria</th><th>V/P</th><th>Puntato</th><th>Utile</th><th>ROI</th><th>Win Rate</th></tr></thead><tbody>
    ${Object.entries(catGruppi).sort((a,b) => b[1].utile - a[1].utile).map(([k, v]) => {
      const roi = v.puntato > 0 ? (v.utile / v.puntato * 100) : 0;
      const wr = (v.vinte + v.perse) > 0 ? (v.vinte / (v.vinte + v.perse) * 100) : 0;
      const roiColor = roi >= 0 ? "#48bb78" : "#fc8181";
      return `<tr><td style="font-weight:600">${k}</td><td><span style="color:#48bb78">${v.vinte}V</span> / <span style="color:#fc8181">${v.perse}P</span></td>
        <td>${fmt(v.puntato)}€</td><td style="color:${roiColor};font-weight:700">${v.utile >= 0 ? "+" : ""}${fmt(v.utile)}€</td>
        <td style="color:${roiColor};font-weight:700">${roi >= 0 ? "+" : ""}${pct(roi)}</td><td>${pct(wr)}</td></tr>`;
    }).join("")}</tbody></table>`;
  }

  // ROI per campionato
  const campGruppi = calcRoiPerGruppo("campionato");
  const campEl = document.getElementById("roi-campionato");
  if (!Object.keys(campGruppi).length) { campEl.innerHTML = '<div class="empty">Nessun dato — aggiungi il campo "Campionato" nelle scommesse.</div>'; }
  else {
    campEl.innerHTML = `<table class="stats-table"><thead><tr><th>Campionato</th><th>V/P</th><th>Puntato</th><th>Utile</th><th>ROI</th><th>Win Rate</th></tr></thead><tbody>
    ${Object.entries(campGruppi).sort((a,b) => b[1].utile - a[1].utile).map(([k, v]) => {
      const roi = v.puntato > 0 ? (v.utile / v.puntato * 100) : 0;
      const wr = (v.vinte + v.perse) > 0 ? (v.vinte / (v.vinte + v.perse) * 100) : 0;
      const roiColor = roi >= 0 ? "#48bb78" : "#fc8181";
      return `<tr><td style="font-weight:600">${k}</td><td><span style="color:#48bb78">${v.vinte}V</span> / <span style="color:#fc8181">${v.perse}P</span></td>
        <td>${fmt(v.puntato)}€</td><td style="color:${roiColor};font-weight:700">${v.utile >= 0 ? "+" : ""}${fmt(v.utile)}€</td>
        <td style="color:${roiColor};font-weight:700">${roi >= 0 ? "+" : ""}${pct(roi)}</td><td>${pct(wr)}</td></tr>`;
    }).join("")}</tbody></table>`;
  }

  // FIX 7: ROI per range quota
  const rangeGruppi = calcRoiPerRangeQuota();
  const rangeEl = document.getElementById("roi-range-quota");
  if (rangeEl) {
    const hasDati = Object.values(rangeGruppi).some(v => v.puntato > 0);
    if (!hasDati) {
      rangeEl.innerHTML = '<div class="empty">Nessun dato ancora.</div>';
    } else {
      rangeEl.innerHTML = `<table class="stats-table"><thead><tr><th>Range Quota</th><th>V/P</th><th>Puntato</th><th>Utile</th><th>ROI</th></tr></thead><tbody>
      ${Object.entries(rangeGruppi).map(([k, v]) => {
        if (v.puntato === 0) return `<tr><td style="font-weight:600">${k}</td><td colspan="4" style="color:#4a5568">Nessuna scommessa</td></tr>`;
        const roi = v.utile / v.puntato * 100;
        const roiColor = roi >= 0 ? "#48bb78" : "#fc8181";
        return `<tr><td style="font-weight:600">${k}</td>
          <td><span style="color:#48bb78">${v.vinte}V</span> / <span style="color:#fc8181">${v.perse}P</span></td>
          <td>${fmt(v.puntato)}€</td>
          <td style="color:${roiColor};font-weight:700">${v.utile >= 0 ? "+" : ""}${fmt(v.utile)}€</td>
          <td style="color:${roiColor};font-weight:700">${roi >= 0 ? "+" : ""}${pct(roi)}</td></tr>`;
      }).join("")}</tbody></table>`;
    }
  }

  const st = calcStats();
  const kb = document.getElementById("k-bankroll");
  if (!kb.value) kb.value = fmt(st.bankroll);
}

// ===== GRAFICO BANKROLL =====
function renderBankrollChart() {
  const el = document.getElementById("bankroll-chart");
  const risolte = scommesse.filter(s => s.risultato === "VINTO" || s.risultato === "PERSO");
  if (risolte.length < 2) {
    el.innerHTML = "<div class='empty'>Servono almeno 2 scommesse risolte per vedere il grafico.</div>";
    return;
  }

  // Costruisci punti
  const punti = [{ label: "Inizio", valore: BANKROLL_INI, tipo: "start", data: "" }];
  let bk = BANKROLL_INI;
  risolte.forEach((s, i) => {
    const q = s.tipo === "multipla" ? parseFloat(s.quotaTotale) : parseFloat(s.quota);
    const p = parseFloat(s.puntata) || 0;
    if (s.risultato === "VINTO") bk += (q - 1) * p;
    else bk -= p;
    punti.push({
      label: s.tipo === "multipla" ? "Multipla" : (s.evento || "#" + (i + 1)),
      valore: bk,
      tipo: s.risultato,
      data: s.data || ""
    });
  });

  const bankrollCorrente = punti[punti.length - 1].valore;
  const colore = bankrollCorrente >= BANKROLL_INI ? "#48bb78" : "#fc8181";
  const valori = punti.map(p => p.valore);
  const minV = Math.min(...valori), maxV = Math.max(...valori);
  const padding = (maxV - minV) * 0.1 || 0.5;
  const yMin = minV - padding, yMax = maxV + padding;

  // Dimensioni SVG in px assoluti (viewBox)
  const W = 700, H = 240;
  const padL = 54, padR = 16, padT = 16, padB = 32;
  const iW = W - padL - padR, iH = H - padT - padB;

  const toX = i => padL + (i / (punti.length - 1)) * iW;
  const toY = v => padT + iH - ((v - yMin) / (yMax - yMin)) * iH;

  // Linea path
  const pathD = punti.map((p, i) => `${i === 0 ? "M" : "L"}${toX(i).toFixed(1)},${toY(p.valore).toFixed(1)}`).join(" ");
  const areaD = `${pathD} L${toX(punti.length - 1).toFixed(1)},${(padT + iH).toFixed(1)} L${padL},${(padT + iH).toFixed(1)} Z`;

  // Asse Y: 5 label ben distanziate
  const step = (yMax - yMin) / 4;
  const yLabels = Array.from({ length: 5 }, (_, i) => {
    const v = yMin + step * i;
    const y = toY(v);
    return `<text x="${padL - 8}" y="${y.toFixed(1)}" fill="#718096" font-size="11" text-anchor="end" dominant-baseline="middle">${v.toFixed(1)}€</text>
    <line x1="${padL}" y1="${y.toFixed(1)}" x2="${(padL + iW).toFixed(1)}" y2="${y.toFixed(1)}" stroke="#2d3748" stroke-width="0.5" stroke-dasharray="3,4"/>`;
  }).join("");

  // Linea bankroll iniziale
  const yIni = toY(BANKROLL_INI);
  const iniLine = `<line x1="${padL}" y1="${yIni.toFixed(1)}" x2="${(padL + iW).toFixed(1)}" y2="${yIni.toFixed(1)}" stroke="#4a5568" stroke-width="1.2" stroke-dasharray="5,4"/>
  <text x="${padL + iW + 4}" y="${yIni.toFixed(1)}" fill="#4a5568" font-size="10" dominant-baseline="middle">ini</text>`;

  // Label asse X (max 8 per non sovrapporre)
  const maxXLabels = 8;
  const step2 = Math.max(1, Math.ceil(punti.length / maxXLabels));
  const xLabels = punti.map((p, i) => {
    if (i % step2 !== 0 && i !== punti.length - 1) return "";
    const x = toX(i);
    const shortLabel = p.label.length > 10 ? p.label.substring(0, 9) + "…" : p.label;
    return `<text x="${x.toFixed(1)}" y="${(padT + iH + 16).toFixed(1)}" fill="#4a5568" font-size="9" text-anchor="middle">${escapeHTML(shortLabel)}</text>`;
  }).join("");

  // Cerchi interattivi con tooltip HTML
  const cerchi = punti.map((p, i) => {
    const col = p.tipo === "VINTO" ? "#48bb78" : p.tipo === "PERSO" ? "#fc8181" : "#f4c430";
    const cx = toX(i).toFixed(1), cy = toY(p.valore).toFixed(1);
    const tooltip = JSON.stringify(`${p.label} — ${p.valore.toFixed(2)}€${p.data?" · "+p.data:""}`);
    return `<circle cx="${cx}" cy="${cy}" r="5" fill="${col}" stroke="#161b27" stroke-width="2" data-tooltip="${escapeHTML(tooltip)}"
      onmouseenter="showChartTooltip(event,JSON.parse(this.dataset.tooltip))"
      onmouseleave="hideChartTooltip()" style="cursor:pointer"/>`;
  }).join("");

  el.innerHTML = `
    <div style="position:relative">
      <div id="chart-tooltip" style="display:none;position:fixed;background:#1e2533;border:1px solid #2d3748;border-radius:8px;padding:7px 12px;font-size:12px;color:#e2e8f0;pointer-events:none;z-index:999;white-space:nowrap;box-shadow:0 4px 16px rgba(0,0,0,0.4)"></div>
      <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block">
        <defs>
          <linearGradient id="bkGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${colore}" stop-opacity="0.25"/>
            <stop offset="100%" stop-color="${colore}" stop-opacity="0.02"/>
          </linearGradient>
          <clipPath id="chartClip">
            <rect x="${padL}" y="${padT}" width="${iW}" height="${iH}"/>
          </clipPath>
        </defs>
        ${yLabels}
        ${iniLine}
        <g clip-path="url(#chartClip)">
          <path d="${areaD}" fill="url(#bkGrad)"/>
          <path d="${pathD}" fill="none" stroke="${colore}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
          ${cerchi}
        </g>
        ${xLabels}
      </svg>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px;flex-wrap:wrap;gap:8px">
        <div style="display:flex;gap:14px;font-size:12px">
          <span style="color:#718096">📍 Inizio: <b style="color:#e2e8f0">${BANKROLL_INI}€</b></span>
          <span style="color:#718096">📊 Scommesse: <b style="color:#e2e8f0">${risolte.length}</b></span>
        </div>
        <div style="font-size:14px;font-weight:700;color:${colore}">
          ${bankrollCorrente >= BANKROLL_INI ? "▲" : "▼"} Attuale: ${bankrollCorrente.toFixed(2)}€
          <span style="font-size:11px;font-weight:400;color:#718096;margin-left:6px">(${bankrollCorrente >= BANKROLL_INI ? "+" : ""}${(bankrollCorrente - BANKROLL_INI).toFixed(2)}€)</span>
        </div>
      </div>
    </div>`;
}

function showChartTooltip(e, text) {
  const t = document.getElementById("chart-tooltip");
  if (!t) return;
  t.textContent = text;
  t.style.display = "block";
  t.style.left = (e.clientX + 12) + "px";
  t.style.top = (e.clientY - 36) + "px";
}
function hideChartTooltip() {
  const t = document.getElementById("chart-tooltip");
  if (t) t.style.display = "none";
}

// ===== RISK ALERTS =====
const SOGLIA_DRAWDOWN = 0.20, SOGLIA_SERIE_NEG = 3, SOGLIA_ESPOSIZIONE = 0.10;
const STOP_LOSS_GIORNALIERO_PCT = 0.10; // FIX 4

function getPerditaOggi() {
  const oggi = new Date().toISOString().slice(0, 10);
  return scommesse
    .filter(s => s.data === oggi && s.risultato === "PERSO")
    .reduce((tot, s) => tot + (parseFloat(s.puntata) || 0), 0);
}

function calcRiskAlerts(st) {
  const alerts = [];

  // FIX 4: stop-loss giornaliero — primo controllo, priorità massima
  const perditaOggi = getPerditaOggi();
  const limiteGiornaliero = st.bankroll * STOP_LOSS_GIORNALIERO_PCT;
  if (perditaOggi >= limiteGiornaliero) {
    alerts.push({ tipo:"danger", icon:"🛑", titolo:`STOP-LOSS GIORNALIERO — Perso ${fmt(perditaOggi)}€ oggi`, sub:`Limite giornaliero (${(STOP_LOSS_GIORNALIERO_PCT*100)}% bankroll = ${fmt(limiteGiornaliero)}€) raggiunto. Stop alle scommesse per oggi.` });
  } else if (perditaOggi > limiteGiornaliero * 0.7) {
    alerts.push({ tipo:"warning", icon:"⚠️", titolo:`Stop-loss al ${((perditaOggi/limiteGiornaliero)*100).toFixed(0)}% — Perso oggi: ${fmt(perditaOggi)}€`, sub:`Ti stai avvicinando al limite giornaliero di ${fmt(limiteGiornaliero)}€. Procedi con cautela.` });
  }

  // drawdown globale
  const drawdown = (BANKROLL_INI - st.bankroll) / BANKROLL_INI;
  if (drawdown >= SOGLIA_DRAWDOWN) {
    alerts.push({ tipo:"danger", icon:"🔴", titolo:`Drawdown critico: -${(drawdown*100).toFixed(1)}%`, sub:`Hai perso ${fmt(BANKROLL_INI - st.bankroll)}€. Considera di ridurre le puntate.` });
  } else if (drawdown >= SOGLIA_DRAWDOWN * 0.6) {
    alerts.push({ tipo:"warning", icon:"🟡", titolo:`Drawdown in crescita: -${(drawdown*100).toFixed(1)}%`, sub:`Ti stai avvicinando alla soglia del 20%. Attenzione.` });
  }

  // serie negativa
  const risolte = scommesse.filter(s => s.risultato === "VINTO" || s.risultato === "PERSO");
  let serieNeg = 0;
  for (let i = risolte.length - 1; i >= 0; i--) { if (risolte[i].risultato === "PERSO") serieNeg++; else break; }
  if (serieNeg >= SOGLIA_SERIE_NEG) alerts.push({ tipo:"danger", icon:"📉", titolo:`Serie negativa: ${serieNeg} sconfitte di fila`, sub:`Valuta una pausa o riduci le puntate.` });

  // esposizione ultima puntata
  if (scommesse.length > 0) {
    const ultima = scommesse[scommesse.length - 1];
    const puntata = parseFloat(ultima.puntata) || 0;
    if ((puntata / st.bankroll) > SOGLIA_ESPOSIZIONE && ultima.risultato === "In corso")
      alerts.push({ tipo:"warning", icon:"⚠️", titolo:`Puntata alta: ${fmt(puntata/st.bankroll*100)}% del bankroll`, sub:`La tua ultima puntata (${fmt(puntata)}€) supera il 10% del bankroll.` });
  }

  // ROI recente
  const ultime10 = risolte.slice(-10);
  if (ultime10.length >= 5) {
    const puntato = ultime10.reduce((a,s) => a+(parseFloat(s.puntata)||0), 0);
    const vinto = ultime10.filter(s=>s.risultato==="VINTO").reduce((a,s) => { const q=s.tipo==="multipla"?parseFloat(s.quotaTotale):parseFloat(s.quota); return a+(q-1)*(parseFloat(s.puntata)||0); }, 0);
    const perso = ultime10.filter(s=>s.risultato==="PERSO").reduce((a,s) => a+(parseFloat(s.puntata)||0), 0);
    const roiRecente = puntato > 0 ? ((vinto-perso)/puntato*100) : 0;
    if (roiRecente < -15) alerts.push({ tipo:"info", icon:"📊", titolo:`ROI recente negativo: ${roiRecente.toFixed(1)}%`, sub:`Ultime ${ultime10.length} scommesse sotto -15%. Analizza la strategia.` });
  }

  return alerts;
}

function renderRiskAlerts(st) {
  const alerts = calcRiskAlerts(st);
  const el = document.getElementById("risk-alerts");
  if (!alerts.length) { el.innerHTML = ""; return; }
  el.innerHTML = alerts.map(a => `<div class="risk-alert ${escapeHTML(a.tipo)}">
    <div class="risk-alert-icon">${escapeHTML(a.icon)}</div>
    <div><div class="risk-alert-title">${escapeHTML(a.titolo)}</div><div class="risk-alert-sub">${escapeHTML(a.sub)}</div></div>
  </div>`).join("");
}

// ===== RENDER DASHBOARD =====
function renderDashboard() {
  const st = calcStats();
  document.getElementById("bankroll-sub").textContent = `Bankroll: ${fmt(st.bankroll)}€`;
  renderRiskAlerts(st);
  renderBankrollChart();
  document.getElementById("stats-grid").innerHTML = `
    ${statCard("Bankroll Attuale", fmt(st.bankroll)+"€", st.bankroll>=BANKROLL_INI?"#48bb78":"#fc8181", "Iniziale: "+BANKROLL_INI+"€")}
    ${statCard("Utile Netto", (st.utile>=0?"+":"")+fmt(st.utile)+"€", st.utile>=0?"#48bb78":"#fc8181")}
    ${statCard("ROI", pct(st.roi), st.roi>=0?"#48bb78":"#fc8181", "Su "+fmt(st.totalePuntato)+"€ puntati")}
    ${statCard("Win Rate", pct(st.winRate), "#f4c430", st.vinte+"V / "+st.perse+"P")}
    ${statCard("Value Bet", st.value, "#f6ad55", "scommesse con value")}
    ${statCard("Multiple", st.multiple, "#b794f4", "scommesse combinate")}
  `;
  const ul = document.getElementById("last-bets");
  const recent = [...scommesse].reverse().slice(0, 6);
  if (!recent.length) { ul.innerHTML = '<div class="empty">Nessuna scommessa ancora.</div>'; return; }
  ul.innerHTML = recent.map(s => {
    const qNum = s.tipo==="multipla" ? parseFloat(s.quotaTotale) : parseFloat(s.quota);
    const probD = qNum > 1 && s.tipo !== "multipla" ? `<span style="background:#292718;color:#f4c430;font-size:11px;font-weight:700;border-radius:5px;padding:2px 8px;margin-left:6px">📊 ${(1/qNum*100).toFixed(0)}%</span>` : "";
    return `<div class="bet-row">
      <div><div class="bet-name">${escapeHTML(s.tipo==="multipla"?"🎯 "+s.nome:s.evento)}</div>
      <div class="bet-meta">${escapeHTML(s.data)} · Q ${escapeHTML(s.tipo==="multipla"?fmt(s.quotaTotale):s.quota)} · ${escapeHTML(s.puntata)}€${s.campionato?" · "+escapeHTML(s.campionato):""}${probD}</div></div>
      <div class="bet-right">
        ${s.tipo==="multipla"?'<span class="badge-multi">MULTIPLA</span>':""}
        ${s.value==="SÌ VALUE"?'<span class="badge">💰 VALUE</span>':""}
        <span class="profit ${profittoClass(s)}">${profitto(s)}</span>
        <span class="status-badge ${risultatoClass(s.risultato)}">${escapeHTML(s.risultato||"—")}</span>
      </div></div>`;
  }).join("");
}

function statCard(label, value, color, sub="") {
  return `<div class="stat-card"><div class="stat-label">${label}</div><div class="stat-value" style="color:${color}">${value}</div>${sub?`<div class="stat-sub">${sub}</div>`:""}</div>`;
}

function resetFiltri() {
  ["f-dal","f-al","f-cat","f-ris","f-val"].forEach(id => document.getElementById(id).value="");
  renderScommesse();
}
function getScommesseFiltrate() {
  const dal=document.getElementById("f-dal").value, al=document.getElementById("f-al").value;
  const cat=document.getElementById("f-cat").value, ris=document.getElementById("f-ris").value;
  const val=document.getElementById("f-val").value;
  return scommesse.map((s,i)=>({...s,_idx:i})).filter(s => {
    if (dal && s.data && s.data<dal) return false;
    if (al && s.data && s.data>al) return false;
    if (ris && s.risultato!==ris) return false;
    if (val && s.value!==val) return false;
    if (cat) {
      if (cat==="multipla" && s.tipo!=="multipla") return false;
      if (cat!=="multipla" && s.tipo==="multipla") return false;
      if (cat!=="multipla" && s.categoria!==cat) return false;
    }
    return true;
  });
}

function renderScommesse() {
  const filtrate = getScommesseFiltrate();
  const tot = scommesse.length;
  document.getElementById("bet-count").textContent = filtrate.length===tot ? `Tutte le scommesse (${tot})` : `Filtrate: ${filtrate.length} di ${tot}`;
  const list = document.getElementById("bet-list");
  if (!filtrate.length) { list.innerHTML='<div class="card empty">Nessuna scommessa trovata.</div>'; return; }
  list.innerHTML = [...filtrate].reverse().map(s => {
    const idx=s._idx, isMulti=s.tipo==="multipla";
    const quota=isMulti?fmt(s.quotaTotale):s.quota;
    const nome=escapeHTML(isMulti?"🎯 "+s.nome:s.evento);
    const eventiHtml=isMulti&&s.eventi?s.eventi.map(e=>`<span class="multi-event-tag">${escapeHTML(e.nome)} <b>@${escapeHTML(e.quota)}</b></span>`).join(""):"";
    const quotaNum = isMulti ? parseFloat(s.quotaTotale) : parseFloat(s.quota);
    const probAuto = quotaNum > 1 ? (1/quotaNum*100).toFixed(0) : null;
    return `<div class="bet-list-item">
      <div style="flex:1;min-width:180px">
        <div class="bet-name">${nome}</div>
        <div class="bet-meta">${escapeHTML(s.data)} · Q ${escapeHTML(quota)} · ${escapeHTML(s.puntata)}€${s.categoria?" · "+escapeHTML(s.categoria):""}${s.campionato?" · "+escapeHTML(s.campionato):""}</div>
        ${probAuto && !isMulti ? `<div style="margin-top:4px"><span style="background:#292718;color:#f4c430;font-size:11px;font-weight:700;border-radius:5px;padding:2px 8px">📊 Prob. implicita: ${probAuto}%</span></div>` : ""}
        ${isMulti?`<div class="multi-events-list">${eventiHtml}</div>`:""}
        ${s.note?`<div style="color:#4a5568;font-size:11px;margin-top:4px">📝 ${escapeHTML(s.note)}</div>`:""}
      </div>
      <div class="bet-right">
        ${isMulti?'<span class="badge-multi">MULTIPLA</span>':""}
        ${s.value==="SÌ VALUE"?'<span class="badge">💰 VALUE</span>':""}
        <span class="profit ${profittoClass(s)}">${profitto(s)}</span>
        <span class="status-badge ${risultatoClass(s.risultato)}">${s.risultato||"—"}</span>
        <div class="row-actions">
          <button onclick="modificaScommessa(${idx})" style="color:#f4c430">✏️</button>
          <button onclick="chiediElimina(${idx})" style="color:#fc8181">🗑️</button>
        </div>
      </div>
    </div>`;
  }).join("");
}

function renderAll() { renderDashboard(); renderScommesse(); renderStatistiche(); }

function showTab(tab) {
  const tabs = ["dashboard","scommesse","statistiche","analisi","pro","imparato-tecnica"];
  tabs.forEach(t => {
    document.getElementById("page-"+t).style.display = t===tab?"block":"none";
  });
  document.querySelectorAll(".tab-btn").forEach((b,i) => {
    b.classList.toggle("active", tabs[i]===tab);
  });
  if (tab==="statistiche") renderStatistiche();
  if (tab==="pro") aggiornaSelezionePartite();
  if (tab==="imparato-tecnica") caricaImparatoTecnica();
}

function apriForms(tipo) {
  chiudiForms();
  if (tipo==="singola") {
    editIdx=null; resetSingola();
    document.getElementById("form-singola-title").textContent="➕ Nuova scommessa singola";
    document.getElementById("form-singola").style.display="block";
  } else {
    eventiMultipla=[{nome:"",quota:""},{nome:"",quota:""}];
    resetMultipla(); renderEventiMultipla();
    document.getElementById("form-multipla").style.display="block";
  }
}
function chiudiForms() {
  document.getElementById("form-singola").style.display="none";
  document.getElementById("form-multipla").style.display="none";
  editIdx=null;
}
function resetSingola() {
  ["s-data","s-evento","s-quota","s-puntata","s-note","s-categoria","s-campionato","s-prob"].forEach(id=>document.getElementById(id).value="");
  document.getElementById("s-risultato").value=""; document.getElementById("s-value").value="";
}
function aggiornaProb() {
  const quota = parseFloat(document.getElementById("s-quota").value);
  const probEl = document.getElementById("s-prob");
  if (!isNaN(quota) && quota > 1) { probEl.value = (1/quota*100).toFixed(0); probEl.style.color = "#f4c430"; }
}
function salvaSingola() {
  const evento=document.getElementById("s-evento").value.trim();
  const quota=parseFloat(document.getElementById("s-quota").value);
  const puntata=parseFloat(document.getElementById("s-puntata").value);
  if (!evento||isNaN(quota)||isNaN(puntata)) { alert("Compila almeno Evento, Quota e Puntata!"); return; }
  const s={tipo:"singola",data:document.getElementById("s-data").value,evento,quota,puntata,
    risultato:document.getElementById("s-risultato").value,value:document.getElementById("s-value").value,
    categoria:document.getElementById("s-categoria").value,campionato:document.getElementById("s-campionato").value,
    note:document.getElementById("s-note").value,probStimata:document.getElementById("s-prob").value};
  if (editIdx!==null) { scommesse[editIdx]=s; editIdx=null; } else { scommesse.push(s); }
  salvaLS(); chiudiForms(); renderAll();
}
function resetMultipla() {
  ["m-data","m-puntata","m-note"].forEach(id=>document.getElementById(id).value="");
  document.getElementById("m-risultato").value="";
}
function renderEventiMultipla() {
  document.getElementById("eventi-multipla").innerHTML=eventiMultipla.map((e,i)=>`
    <div class="multi-event-row">
      <div class="form-group">${i===0?"<label>Evento</label>":""}
        <input type="text" placeholder="Es: Napoli vs Roma — 1" value="${escapeHTML(e.nome)}" oninput="eventiMultipla[${i}].nome=this.value">
      </div>
      <div class="form-group">${i===0?"<label>Quota</label>":""}
        <input type="number" step="0.01" placeholder="1.80" value="${escapeHTML(e.quota)}" oninput="eventiMultipla[${i}].quota=this.value;aggiornaQuotaTotale()">
      </div>
      <button class="btn-rm" onclick="rimuoviEvento(${i})" ${eventiMultipla.length<=2?"disabled style='opacity:.3'":""}>✕</button>
    </div>`).join("");
  aggiornaQuotaTotale();
}
function aggiungiEventoMultipla() { eventiMultipla.push({nome:"",quota:""}); renderEventiMultipla(); }
function rimuoviEvento(i) { if (eventiMultipla.length<=2) return; eventiMultipla.splice(i,1); renderEventiMultipla(); }
function aggiornaQuotaTotale() {
  const puntata=parseFloat(document.getElementById("m-puntata").value)||0;
  const qt=eventiMultipla.reduce((a,e)=>{const q=parseFloat(e.quota);return isNaN(q)?a:a*q;},1);
  const valide=eventiMultipla.filter(e=>!isNaN(parseFloat(e.quota))).length;
  if (valide<2) { document.getElementById("quota-totale-display").innerHTML="Quota totale: — | Vincita potenziale: —"; return; }
  document.getElementById("quota-totale-display").innerHTML=`Quota totale: <b>${fmt(qt)}</b> | Vincita potenziale: <b>${puntata>0?fmt(qt*puntata)+"€":"—"}</b>`;
}
function salvaMultipla() {
  const puntata=parseFloat(document.getElementById("m-puntata").value);
  const eventiValidi=eventiMultipla.filter(e=>e.nome.trim()&&!isNaN(parseFloat(e.quota)));
  if (eventiValidi.length<2) { alert("Inserisci almeno 2 eventi con nome e quota!"); return; }
  if (isNaN(puntata)) { alert("Inserisci la puntata!"); return; }
  const quotaTotale=eventiValidi.reduce((a,e)=>a*parseFloat(e.quota),1);
  const nomi=eventiValidi.map(e=>e.nome).join(" + ");
  const s={tipo:"multipla",nome:nomi.length>50?nomi.substring(0,47)+"…":nomi,
    eventi:eventiValidi.map(e=>({nome:e.nome,quota:parseFloat(e.quota)})),
    quotaTotale,data:document.getElementById("m-data").value,puntata,
    risultato:document.getElementById("m-risultato").value,note:document.getElementById("m-note").value,value:""};
  if (editIdx!==null) { scommesse[editIdx]=s; editIdx=null; } else { scommesse.push(s); }
  salvaLS(); chiudiForms(); renderAll();
}
function modificaScommessa(idx) {
  const s=scommesse[idx]; chiudiForms(); editIdx=idx;
  if (s.tipo==="multipla") {
    eventiMultipla=s.eventi.map(e=>({nome:e.nome,quota:String(e.quota)}));
    document.getElementById("m-data").value=s.data||""; document.getElementById("m-puntata").value=s.puntata||"";
    document.getElementById("m-risultato").value=s.risultato||""; document.getElementById("m-note").value=s.note||"";
    renderEventiMultipla();
    document.getElementById("form-multipla-title").textContent="✏️ Modifica multipla";
    document.getElementById("form-multipla").style.display="block";
  } else {
    document.getElementById("s-data").value=s.data||""; document.getElementById("s-evento").value=s.evento||"";
    document.getElementById("s-quota").value=s.quota||""; document.getElementById("s-puntata").value=s.puntata||"";
    document.getElementById("s-risultato").value=s.risultato||""; document.getElementById("s-value").value=s.value||"";
    document.getElementById("s-categoria").value=s.categoria||""; document.getElementById("s-campionato").value=s.campionato||"";
    document.getElementById("s-note").value=s.note||""; document.getElementById("s-prob").value=s.probStimata||"";
    document.getElementById("form-singola-title").textContent="✏️ Modifica scommessa";
    document.getElementById("form-singola").style.display="block";
  }
}
function chiediElimina(idx) {
  deleteIdx=idx;
  document.getElementById("modal-evento").textContent=scommesse[idx].tipo==="multipla"?scommesse[idx].nome:scommesse[idx].evento;
  document.getElementById("modal").style.display="flex";
}
function chiudiModal() { document.getElementById("modal").style.display="none"; deleteIdx=null; }
function confermaElimina() { if (deleteIdx!==null) { scommesse.splice(deleteIdx,1); salvaLS(); renderAll(); } chiudiModal(); }

async function attivaNotifiche() {
  const ok = await richiediPermessoNotifiche();
  const btn = document.getElementById("btn-notif");
  if (ok) { btn.textContent="🔔 Notifiche attive"; btn.style.color="#48bb78"; inviaNotifica("Notifiche attivate!","Alert automatico quando una quota cambia di oltre l'8%."); }
  else { btn.textContent="🔕 Bloccate dal browser"; btn.style.color="#fc8181"; }
}

// ===== FETCH QUOTE CON PROXY CLOUDFLARE =====
async function fetchOdds() {
  pulisciAlertScaduti(); // FIX 1
  const lega=document.getElementById("lega-select").value;
  const btn=document.getElementById("btn-fetch");
  const res=document.getElementById("analisi-results");
  btn.disabled=true; btn.innerHTML='<span class="spinner"></span> Caricamento...';
  res.innerHTML='<div class="empty"><span class="spinner"></span> Recupero quote...</div>';
  document.getElementById("btn-ai").style.display="none";
  document.getElementById("ai-box").style.display="none";
  try {
    const r = await fetch(`/api/proxy?action=odds&league=${encodeURIComponent(lega)}`);
    if (!r.ok) { const error = await r.json().catch(() => ({})); throw new Error(error.error || `Quote non disponibili (HTTP ${r.status})`); }
    const data = await r.json();
    const rem = r.headers.get("x-requests-remaining");
    const used = r.headers.get("x-requests-used");
    if (rem !== null) document.getElementById("calls-left").innerHTML=`Chiamate rimaste: <span>${rem}</span> / usate: <span>${used}</span>`;
    if (!data.length) { res.innerHTML='<div class="card empty">Nessuna partita disponibile.</div>'; return; }

    const now = Date.now();
    const MAX_QUOTA = 10.0; // FIX 2
    let quoteFiltrateCount = 0; // FIX 2: counter per debug

    data.forEach(match => {
      match.bookmakers.forEach(bk => {
        bk.markets.forEach(mkt => {
          if (mkt.key !== "h2h") return;
          mkt.outcomes.forEach(o => {
            if (o.price > MAX_QUOTA) { quoteFiltrateCount++; return; } // FIX 2: salta quote assurde
            const hKey = `${match.id}_${o.name}`;
            if (!oddsHistory[hKey]) oddsHistory[hKey] = [];
            oddsHistory[hKey].push({t: now, q: o.price});
            if (oddsHistory[hKey].length > 10) oddsHistory[hKey].shift();
          });
        });
      });
    });

    salvaOddsHistory();
    controllaMovimentiQuote(data);
    ultimiDatiPartite = data;
    document.getElementById("btn-ai").style.display = "inline-block";

    // FIX 2: mostra quante quote sono state filtrate (opzionale, utile per debug)
    const filterMsg = quoteFiltrateCount > 0
      ? `<div style="font-size:11px;color:#f6ad55;margin-bottom:10px">⚠️ ${quoteFiltrateCount} quota/e anomale (>10.0) escluse dall'analisi</div>`
      : "";
    res.innerHTML = filterMsg + data.map(match => buildMatchCard(match)).join("");

  } catch(e) {
    res.innerHTML=`<div class="card empty" style="color:#fc8181">❌ Errore: ${e.message}</div>`;
  }
  btn.disabled=false; btn.innerHTML='🔍 Cerca partite';
}

function getOddsMovement(matchId, teamName) {
  const key=`${matchId}_${teamName}`;
  const hist=oddsHistory[key];
  if (!hist||hist.length<2) return null;
  const first=hist[0].q, last=hist[hist.length-1].q;
  const diff=last-first;
  const pct=((diff/first)*100).toFixed(1);
  return {diff, pct, first, last};
}

// ===== ANALISI AI — GROQ via CLOUDFLARE WORKER (VERSIONE POTENZIATA) =====
const GROQ_MODEL = "llama-3.3-70b-versatile";

// Caratteristiche note per campionato
const CAMPIONATO_TRAITS = {
  "soccer_italy_serie_b":              { nome: "Serie B", note: "Alta frequenza di pareggi (30-33%). Partite tattiche e chiuse. Draw bias reale e documentato.", drawBias: true },
  "soccer_italy_serie_a":              { nome: "Serie A", note: "Campionato equilibrato. Difese solide, pochi gol nelle big match. Mercato liquido.", drawBias: false },
  "soccer_epl":                        { nome: "Premier League", note: "Alta intensità, molti gol. Squadre di bassa classifica sorprendono in casa. Pochi pareggi.", drawBias: false },
  "soccer_england_championship":       { nome: "Championship", note: "Molto equilibrato, mercato meno efficiente. Alta frequenza pareggi simile alla Serie B.", drawBias: true },
  "soccer_spain_la_liga":              { nome: "La Liga", note: "Dominio tecnico. Gap netto tra top 3 e resto. Mercato efficiente, edge difficili.", drawBias: false },
  "soccer_germany_bundesliga":         { nome: "Bundesliga", note: "Tanti gol, pochi pareggi. Quote draw spesso sovrastimate dal mercato.", drawBias: false },
  "soccer_france_ligue_one":           { nome: "Ligue 1", note: "Mercato meno liquido, possibili inefficienze. PSG domina, resto equilibrato.", drawBias: false },
  "soccer_netherlands_eredivisie":     { nome: "Eredivisie", note: "Campionato offensivo, tanti gol. Ajax/PSV dominano ma sorprese frequenti fuori casa.", drawBias: false },
  "soccer_portugal_primeira_liga":     { nome: "Primeira Liga", note: "Mercato poco liquido, buone opportunità edge. Benfica/Porto/Sporting dominano.", drawBias: false },
  "soccer_brazil_campeonato":          { nome: "Brasileirão", note: "Alta variabilità, mercato inefficiente. Molti pareggi nel girone di ritorno.", drawBias: true },
  "soccer_uefa_champs_league":         { nome: "Champions League", note: "Mercato molto efficiente, edge difficili. Favoriti spesso sovravvalutati.", drawBias: false },
  "soccer_uefa_european_championship": { nome: "Europei", note: "Partite tattiche. Alta frequenza pareggi nei gironi tra squadre simili.", drawBias: true },
  "soccer_fifa_world_cup":             { nome: "Mondiali FIFA", note: "Mercato efficiente. Pareggi frequenti nella fase gironi tra squadre simili.", drawBias: true },
};

function getLeagaAttuale() {
  const sel = document.getElementById("lega-select");
  return sel ? sel.value : "";
}

function buildDatiPartitePerAI(dati) {
  return dati.map(match => {
    const allOdds = { home: [], away: [], draw: [] };
    match.bookmakers.forEach(bk => {
      bk.markets.forEach(mkt => {
        if (mkt.key !== "h2h") return;
        mkt.outcomes.forEach(o => {
          if (o.name === match.home_team) allOdds.home.push(o.price);
          else if (o.name === match.away_team) allOdds.away.push(o.price);
          else allOdds.draw.push(o.price);
        });
      });
    });
    if (!allOdds.home.length) return null;

    const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
    const avgH = avg(allOdds.home), avgA = avg(allOdds.away), avgD = avg(allOdds.draw);
    const maxH = Math.max(...allOdds.home), maxA = Math.max(...allOdds.away);
    const maxD = allOdds.draw.length ? Math.max(...allOdds.draw) : null;

    // Probabilità implicite (media bookmaker = stima mercato)
    const probMercatoH = avgH ? (1 / avgH * 100).toFixed(1) : null;
    const probMercatoA = avgA ? (1 / avgA * 100).toFixed(1) : null;
    const probMercatoD = avgD ? (1 / avgD * 100).toFixed(1) : null;

    // Edge: differenza tra quota max e quota media
    const edgeH = avgH && maxH > avgH * 1.02 ? ((maxH / avgH - 1) * 100).toFixed(1) : "0";
    const edgeA = avgA && maxA > avgA * 1.02 ? ((maxA / avgA - 1) * 100).toFixed(1) : "0";
    const edgeD = avgD && maxD > avgD * 1.02 ? ((maxD / avgD - 1) * 100).toFixed(1) : "0";

    // CLV proxy: confronto tra prob implicita media e prob implicita massima
    const clvH = avgH && maxH ? ((1/avgH - 1/maxH) * 100).toFixed(2) : "0";
    const clvA = avgA && maxA ? ((1/avgA - 1/maxA) * 100).toFixed(2) : "0";
    const clvD = avgD && maxD ? ((1/avgD - 1/maxD) * 100).toFixed(2) : "0";

    // Movimento quote (segnale smart money)
    const movH = getOddsMovement(match.id, match.home_team);
    const movA = getOddsMovement(match.id, match.away_team);

    const dt = new Date(match.commence_time);

    const lines = [
      `PARTITA: ${match.home_team} vs ${match.away_team}`,
      `Data: ${dt.toLocaleDateString("it-IT")} ${dt.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}`,
      `Bookmaker analizzati: ${match.bookmakers.length}`,
      `Quote MAX disponibili: 1=${maxH.toFixed(2)} | X=${maxD ? maxD.toFixed(2) : "N/D"} | 2=${maxA.toFixed(2)}`,
      `Quote MEDIE mercato:   1=${avgH ? avgH.toFixed(2) : "N/D"} | X=${avgD ? avgD.toFixed(2) : "N/D"} | 2=${avgA ? avgA.toFixed(2) : "N/D"}`,
      `Probabilità implicita (mercato): 1=${probMercatoH}% | X=${probMercatoD ? probMercatoD + "%" : "N/D"} | 2=${probMercatoA}%`,
      `Edge (max vs media):  1=+${edgeH}% | X=+${edgeD}% | 2=+${edgeA}%`,
      `CLV proxy (dispersione mercato): 1=${clvH}% | X=${clvD}% | 2=${clvA}%`,
    ];

    if (movH) {
      const dir = movH.diff < 0 ? "CALO" : "SALITA";
      lines.push(`Movimento quota 1: ${dir} di ${Math.abs(parseFloat(movH.pct))}% (${movH.first.toFixed(2)} → ${movH.last.toFixed(2)}) — ${movH.diff < -0.05 ? "⚠️ SMART MONEY segnale forte" : "variazione lieve"}`);
    }
    if (movA) {
      const dir = movA.diff < 0 ? "CALO" : "SALITA";
      lines.push(`Movimento quota 2: ${dir} di ${Math.abs(parseFloat(movA.pct))}% (${movA.first.toFixed(2)} → ${movA.last.toFixed(2)}) — ${movA.diff < -0.05 ? "⚠️ SMART MONEY segnale forte" : "variazione lieve"}`);
    }

    return lines.join("\n");
  }).filter(Boolean).join("\n\n---\n\n");
}

async function analizzaConAI() {
  if (!ultimiDatiPartite.length) { alert("Prima cerca le partite!"); return; }

  const btn = document.getElementById("btn-ai");
  const box = document.getElementById("ai-box");
  const risposta = document.getElementById("ai-risposta");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> AI sta analizzando...';
  box.style.display = "block";
  risposta.innerHTML = '<div style="color:#718096;font-size:13px">⏳ Analisi in corso con strategia professionale...</div>';

  const st = calcStats();
  const legaKey = getLeagaAttuale();
  const legaInfo = CAMPIONATO_TRAITS[legaKey] || { nome: legaKey, note: "Campionato generico.", drawBias: false };
  const datiPartite = buildDatiPartitePerAI(ultimiDatiPartite);

  const prompt = `Sei un analista professionista di scommesse sportive che usa metodi quantitativi.
Il tuo obiettivo è trovare VALUE BET reali, non scommesse vincenti qualsiasi.

CONTESTO CAMPIONATO: ${legaInfo.nome}
Note specifiche: ${legaInfo.note}
${legaInfo.drawBias ? "⚠️ In questo campionato il pareggio è storicamente sovrarappresentato rispetto alle quote di mercato. Consideralo nelle tue stime." : ""}

BANKROLL UTENTE: ${fmt(st.bankroll)}€
STRATEGIA: Kelly Criterion al 50% (frazionato, conservativo)

METODOLOGIA DA APPLICARE:
1. VALUE BET: sei in presenza di value quando la TUA probabilità stimata supera quella implicita del mercato (1/quota_media). Cerca edge > 3%.
2. MOVIMENTO QUOTE (Smart Money): se una quota è in CALO significa che scommettitori professionali stanno puntando su quell'esito. È un segnale forte.
3. CLV PROXY: alta dispersione tra bookmaker (CLV alto) indica mercato inefficiente = più opportunità.
4. KELLY: formula = ((quota-1)*prob_stimata - (1-prob_stimata)) / (quota-1) * 0.5 * bankroll
5. CAMPIONATO: usa le note sul campionato per calibrare le tue stime di probabilità.

DATI PARTITE:
${datiPartite}

ISTRUZIONI OUTPUT:
Seleziona esattamente 3 scommesse. Per ognuna rispondi SOLO in questo formato JSON (array di 3 oggetti):

[
  {
    "partita": "Squadra A vs Squadra B",
    "esito": "1",
    "descrizione_esito": "Vittoria Squadra A",
    "quota_consigliata": 2.15,
    "prob_mercato": 42.5,
    "prob_stimata": 48.0,
    "edge": 5.5,
    "kelly_puntata": 1.20,
    "segnali": ["Edge positivo +5.5%", "Smart money: quota in calo", "Mercato inefficiente (CLV alto)"],
    "ragionamento": "Breve spiegazione in 2-3 frasi del perché questa è una value bet.",
    "confidenza": "ALTA"
  }
]

confidenza può essere: ALTA / MEDIA / BASSA
Rispondi SOLO con il JSON, nessun testo prima o dopo.`;

  try {
    const response = await fetch("/api/proxy?action=ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 2000,
        temperature: 0.3
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error("Groq: " + (err.error?.message || response.status));
    }

    const data = await response.json();
    const testo = data.choices?.[0]?.message?.content || "";

    // Prova a parsare JSON
    let picks = null;
    try {
      const clean = testo.replace(/```json|```/g, "").trim();
      picks = JSON.parse(clean);
    } catch (e) {
      // fallback testo
    }

    if (picks && Array.isArray(picks)) {
risposta.innerHTML = renderAIPicks(picks, st.bankroll);
// Invia alert Telegram per ogni pick con confidenza ALTA o MEDIA
picks.forEach(pick => {
  if ((pick.confidenza === "ALTA" || pick.confidenza === "MEDIA") && pick.edge >= 5) {
    inviaAlertTelegram(pick);
  }
});   } else {
      // fallback: mostra testo grezzo
      risposta.style.whiteSpace = "pre-wrap";
      risposta.textContent = testo;
    }

  } catch (e) {
    risposta.innerHTML = `<div style="color:#fc8181">❌ Errore: ${e.message}</div>`;
  }

  btn.disabled = false;
  btn.innerHTML = "🤖 Analizza con AI";
}

function renderAIPicks(picks, bankroll) {
  const confidenzaColor = { "ALTA": "#48bb78", "MEDIA": "#f6ad55", "BASSA": "#fc8181" };
  const confidenzaIcon  = { "ALTA": "🟢", "MEDIA": "🟡", "BASSA": "🔴" };

  return picks.map((p, i) => {
    const edgeColor = p.edge >= 5 ? "#48bb78" : p.edge >= 3 ? "#f6ad55" : "#fc8181";
    const conf = p.confidenza || "MEDIA";
    const segnaliHtml = (p.segnali || []).map(s =>
      `<span style="display:inline-block;background:#292718;color:#f4d56e;font-size:11px;border-radius:5px;padding:2px 9px;margin:2px 3px 2px 0">${escapeHTML(s)}</span>`
    ).join("");

    return `
    <div style="background:#171a1d;border:1px solid #68551b;border-radius:12px;padding:18px 20px;margin-bottom:14px">
      <!-- Header pick -->
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;margin-bottom:12px">
        <div>
          <div style="font-size:11px;color:#4a7fa5;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">
            Pick #${i + 1}
          </div>
          <div style="font-weight:800;font-size:15px;color:#e2e8f0">${escapeHTML(p.partita)}</div>
          <div style="color:#f4c430;font-size:13px;font-weight:600;margin-top:2px">
            Esito: <b>${escapeHTML(p.esito)}</b> — ${escapeHTML(p.descrizione_esito)}
          </div>
        </div>
        <div style="text-align:right">
          <div style="font-size:22px;font-weight:900;color:#48bb78">${fmt(p.quota_consigliata)}</div>
          <div style="font-size:11px;color:#718096">quota consigliata</div>
        </div>
      </div>

      <!-- Metriche -->
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px;margin-bottom:14px">
        <div style="background:#0d1116;border-radius:8px;padding:10px;text-align:center">
          <div style="font-size:10px;color:#718096;text-transform:uppercase;margin-bottom:4px">Prob. Mercato</div>
          <div style="font-size:18px;font-weight:800;color:#a0aec0">${p.prob_mercato}%</div>
        </div>
        <div style="background:#0d1116;border-radius:8px;padding:10px;text-align:center">
          <div style="font-size:10px;color:#718096;text-transform:uppercase;margin-bottom:4px">Prob. Stimata</div>
          <div style="font-size:18px;font-weight:800;color:#f4c430">${p.prob_stimata}%</div>
        </div>
        <div style="background:#0d1116;border-radius:8px;padding:10px;text-align:center">
          <div style="font-size:10px;color:#718096;text-transform:uppercase;margin-bottom:4px">Edge</div>
          <div style="font-size:18px;font-weight:800;color:${edgeColor}">+${p.edge}%</div>
        </div>
        <div style="background:#0d1116;border-radius:8px;padding:10px;text-align:center">
          <div style="font-size:10px;color:#718096;text-transform:uppercase;margin-bottom:4px">Kelly 50%</div>
          <div style="font-size:18px;font-weight:800;color:#48bb78">${fmt(p.kelly_puntata)}€</div>
        </div>
        <div style="background:#0d1116;border-radius:8px;padding:10px;text-align:center">
          <div style="font-size:10px;color:#718096;text-transform:uppercase;margin-bottom:4px">Confidenza</div>
          <div style="font-size:16px;font-weight:800;color:${confidenzaColor[conf] || '#f6ad55'}">${confidenzaIcon[conf] || '🟡'} ${conf}</div>
        </div>
      </div>

      <!-- Segnali rilevati -->
      ${segnaliHtml ? `<div style="margin-bottom:10px">${segnaliHtml}</div>` : ""}

      <!-- Ragionamento -->
      <div style="background:#0d1116;border-radius:8px;padding:12px;font-size:13px;color:#a0aec0;line-height:1.7;border-left:3px solid #68551b">
        💡 ${escapeHTML(p.ragionamento)}
      </div>
    </div>`;
  }).join("") + `
  <div style="margin-top:16px;padding:12px 16px;background:#1a1500;border:1px solid #4a3800;border-radius:8px;font-size:11px;color:#718096;line-height:1.6">
    ⚠️ <b>Disclaimer:</b> Le analisi AI sono basate esclusivamente sui dati di mercato disponibili (quote, movimenti, dispersione tra bookmaker). Non tengono conto di informazioni non pubbliche come infortuni, formazioni ufficiali o condizioni meteo. Scommetti sempre in modo responsabile.
  </div>`;
}


// ===== MINI GRAFICO STORICO QUOTE =====
function miniChartQuota(matchId, teamName) {
  const key = `${matchId}_${teamName}`;
  const hist = oddsHistory[key];
  if (!hist || hist.length < 2) return "";
  const valori = hist.map(h => h.q);
  const min = Math.min(...valori), max = Math.max(...valori);
  const range = max - min || 0.01;
  const W = 80, H = 30, pad = 4;
  const toX = i => pad + (i / (valori.length - 1)) * (W - pad * 2);
  const toY = v => H - pad - ((v - min) / range) * (H - pad * 2);
  const pathD = valori.map((v, i) => `${i === 0 ? "M" : "L"} ${toX(i)} ${toY(v)}`).join(" ");
  const first = valori[0], last = valori[valori.length - 1];
  const color = last <= first ? "#48bb78" : "#fc8181";
  const trend = last < first ? `📉 -${((first-last)/first*100).toFixed(1)}%` : last > first ? `📈 +${((last-first)/first*100).toFixed(1)}%` : "—";
  return `<div style="display:inline-flex;align-items:center;gap:6px;background:#0f1117;border-radius:8px;padding:4px 8px;margin-top:6px">
    <svg width="${W}" height="${H}" style="overflow:visible">
      <path d="${pathD}" fill="none" stroke="${color}" stroke-width="1.5"/>
      <circle cx="${toX(valori.length-1)}" cy="${toY(last)}" r="2.5" fill="${color}"/>
    </svg>
    <div style="font-size:10px;color:#a0aec0">${trend} <span style="color:${color};font-weight:700">${last.toFixed(2)}</span></div>
  </div>`;
}

// ===== BUILD MATCH CARD =====
function buildMatchCard(match) {
  const dt=new Date(match.commence_time);
  const dataStr=dt.toLocaleDateString("it-IT")+" "+dt.toLocaleTimeString("it-IT",{hour:"2-digit",minute:"2-digit"});
  const allOdds={home:[],away:[],draw:[]};
  const bkNames=[];

  match.bookmakers.forEach(bk=>{
    bkNames.push(bk.title);
    bk.markets.forEach(mkt=>{
      if (mkt.key!=="h2h") return;
      mkt.outcomes.forEach(o=>{
        if (o.price > 10.0) return; // FIX 2: salta quote assurde
        if (o.name===match.home_team) allOdds.home.push(o.price);
        else if (o.name===match.away_team) allOdds.away.push(o.price);
        else allOdds.draw.push(o.price);
      });
    });
  });

  if (!allOdds.home.length) return "";

  const maxH=Math.max(...allOdds.home),maxA=Math.max(...allOdds.away);
  const maxD=allOdds.draw.length?Math.max(...allOdds.draw):null;
  const avgH=allOdds.home.reduce((a,b)=>a+b,0)/allOdds.home.length;
  const avgA=allOdds.away.reduce((a,b)=>a+b,0)/allOdds.away.length;
  const avgD=allOdds.draw.length?allOdds.draw.reduce((a,b)=>a+b,0)/allOdds.draw.length:null;
  const probH=(1/avgH*100),probA=(1/avgA*100),probD=avgD?(1/avgD*100):0;
  const isValH=maxH>avgH*1.04,isValA=maxA>avgA*1.04,isValD=avgD&&maxD>avgD*1.04;
  const edge=(mx,avg)=>mx>0&&avg>0?(((1/avg)-(1/mx))*100).toFixed(1):null;

  // FIX 6: calcola overround e verifica coerenza probabilità
  const overround = avgD
    ? (1/avgH) + (1/avgD) + (1/avgA)
    : (1/avgH) + (1/avgA);
  const overroundPct = ((overround - 1) * 100).toFixed(1);
  const overroundAnomalo = overround > 1.10;
  const overroundBadge = overroundAnomalo
    ? `<div style="background:#2d1515;border:1px solid #fc8181;border-radius:8px;padding:6px 12px;font-size:11px;color:#fc8181;margin-bottom:10px">⚠️ Overround anomalo: ${overroundPct}% — dati poco affidabili, valuta con cautela</div>`
    : `<div style="color:#4a5568;font-size:11px;margin-bottom:10px">Margine bookie: ${overroundPct}%</div>`;

  const movH=getOddsMovement(match.id,match.home_team);
  const movA=getOddsMovement(match.id,match.away_team);
  const isDropH=movH&&movH.diff<-0.05;
  const isDropA=movA&&movA.diff<-0.05;

  const movHtml=(mov)=>{
    if (!mov) return "";
    if (mov.diff<-0.05) return `<div class="odd-movement" style="color:#f6ad55">📉 ${mov.pct}% (soldi in entrata)</div>`;
    if (mov.diff>0.05) return `<div class="odd-movement" style="color:#718096">📈 +${mov.pct}%</div>`;
    return "";
  };

  const oddBox=(label,max,prob,isVal,edgeVal,payload,mov,isDrop,teamName)=>`
    <div class="odd-box ${isVal?"value-detected":isDrop?"odds-dropped":""}">
      <div class="odd-label">${label}</div>
      <div class="odd-quota" style="color:${isVal?"#48bb78":isDrop?"#f6ad55":"#e2e8f0"}">${fmt(max)}</div>
      <div class="odd-prob">Prob: ${pct(prob)}</div>
      ${isVal?`<div class="odd-value">🔥 +${edgeVal}% edge</div>`:isDrop?`<div class="odd-movement" style="color:#f6ad55">📉 Quota in calo</div>`:`<div class="odd-novalue">—</div>`}
      ${movHtml(mov)}
      ${miniChartQuota(match.id, teamName)}
      <button class="btn-add-to-tracker" data-payload="${escapeHTML(JSON.stringify(payload))}" onclick="apriModalAddFromButton(this)">+ Tracker</button>
    </div>`;

  return `<div class="match-card">
    <div class="match-title">${escapeHTML(match.home_team)} vs ${escapeHTML(match.away_team)}</div>
    <div class="match-meta">📅 ${dataStr} · ${bkNames.length} bookmaker</div>
    ${overroundBadge}
    <div class="odds-grid">
      ${oddBox("1 — "+match.home_team.split(" ").pop(),maxH,probH,isValH,edge(maxH,avgH),{evento:match.home_team+" vs "+match.away_team,quota:maxH,esito:"1 — "+match.home_team,isValue:isValH,prob:probH/100},movH,isDropH,match.home_team)}
      ${maxD!==null?oddBox("X — Pareggio",maxD,probD,isValD,edge(maxD,avgD),{evento:match.home_team+" vs "+match.away_team,quota:maxD,esito:"X — Pareggio",isValue:isValD,prob:probD/100},null,false,"Draw"):""}
      ${oddBox("2 — "+match.away_team.split(" ").pop(),maxA,probA,isValA,edge(maxA,avgA),{evento:match.home_team+" vs "+match.away_team,quota:maxA,esito:"2 — "+match.away_team,isValue:isValA,prob:probA/100},movA,isDropA,match.away_team)}
    </div>
  </div>`;
}
function apriModalAdd(data) {
  pendingAdd=data;
  const st=calcStats();
  const prob=data.prob||0, quota=data.quota||0;
  let kellySuggerito="";
  if (prob>0&&quota>1) {
    const b=quota-1, q=1-prob;
    const kelly=Math.max(0,(b*prob-q)/b)*0.5;
    const puntata=kelly*st.bankroll;
    if (puntata>0) kellySuggerito=`(Kelly suggerisce: ${fmt(puntata)}€)`;
  }
  document.getElementById("kelly-suggerimento").textContent=kellySuggerito;
  document.getElementById("modal-add-info").innerHTML=
    `<b>${escapeHTML(data.evento)}</b><br>Esito: <b>${escapeHTML(data.esito)}</b> · Quota: <b>${fmt(data.quota)}</b><br>
    ${data.isValue?'<span style="color:#48bb78;font-weight:700">🔥 Value bet rilevata!</span>':""}`;
  document.getElementById("modal-puntata").value="";
  document.getElementById("modal-add").style.display="flex";
}
function chiudiModalAdd() { document.getElementById("modal-add").style.display="none"; pendingAdd=null; }
function apriModalAddFromButton(button) {
  try { apriModalAdd(JSON.parse(button.dataset.payload || "{}")); }
  catch { alert("Dati partita non validi. Ricarica l’analisi."); }
}
function confermaAggiungi() {
  if (!pendingAdd) return;
  const puntata=parseFloat(document.getElementById("modal-puntata").value);
  if (isNaN(puntata)||puntata<=0) { alert("Inserisci una puntata valida!"); return; }
  scommesse.push({tipo:"singola",data:new Date().toISOString().split("T")[0],
    evento:pendingAdd.evento,quota:parseFloat(fmt(pendingAdd.quota)),puntata,
    risultato:"In corso",value:pendingAdd.isValue?"SÌ VALUE":"NO",categoria:"1X2",note:"Aggiunta da Analisi"});
  salvaLS(); renderAll(); chiudiModalAdd();
  alert("✅ Scommessa aggiunta al tracker!");
}

// ===== ANALISI PRO — football-data.org + Groq + Ritardi =====
const WORKER_URL_PRO = "/api/proxy";

const LEGA_MAP = {
  "soccer_italy_serie_a":         { code: "SA",  nome: "Serie A 🇮🇹" },
  "soccer_italy_serie_b":         { code: "SB",  nome: "Serie B 🇮🇹" },
  "soccer_epl":                   { code: "PL",  nome: "Premier League 🏴󠁧󠁢󠁥󠁮󠁧󠁿" },
  "soccer_spain_la_liga":         { code: "PD",  nome: "Primera Division 🇪🇸" },
  "soccer_germany_bundesliga":    { code: "BL1", nome: "Bundesliga 🇩🇪" },
  "soccer_france_ligue_one":      { code: "FL1", nome: "Ligue 1 🇫🇷" },
  "soccer_uefa_champs_league":    { code: "CL",  nome: "Champions League 🏆" },
  "soccer_netherlands_eredivisie":{ code: "DED", nome: "Eredivisie 🇳🇱" },
  "soccer_brazil_campeonato":     { code: "BSA", nome: "Brasileirão 🇧🇷" },
  "soccer_england_championship":  { code: "ELC", nome: "Championship 🏴󠁧󠁢󠁥󠁮󠁧󠁿" },
  "soccer_portugal_primeira_liga":{ code: "PPL", nome: "Primeira Liga 🇵🇹" },
  "soccer_uefa_european_championship": { code: "EC", nome: "Europei 🌍" },
  "soccer_fifa_world_cup":        { code: "WC",  nome: "Mondiali FIFA 🌍" },
};
const footballMatchesPromises = new Map();

function aggiornaSelezionePartite() {
  const sel = document.getElementById("pro-match-select");
  const btn = document.getElementById("btn-pro-analizza");
  if (!ultimiDatiPartite || !ultimiDatiPartite.length) {
    sel.innerHTML = "<option value=''>— Vai prima in 🔍 Analisi e cerca le partite —</option>";
    btn.disabled = true;
    return;
  }
  sel.innerHTML = "<option value=''>— Seleziona una partita —</option>" +
    ultimiDatiPartite.map((m, i) => {
      const dt = new Date(m.commence_time).toLocaleDateString("it-IT");
      return `<option value="${i}">${escapeHTML(m.home_team)} vs ${escapeHTML(m.away_team)} (${dt})</option>`;
    }).join("");
  sel.onchange = () => { btn.disabled = sel.value === ""; };
  btn.disabled = true;
  const legaKey = document.getElementById("lega-select")?.value || "";
  const legaInfo = LEGA_MAP[legaKey];
  document.getElementById("pro-lega-info").textContent = legaInfo ? `Campionato: ${legaInfo.nome}` : "";
}

async function fetchSquadraMatches(teamName) {
  try {
    const code = LEGA_MAP[document.getElementById("lega-select")?.value || ""]?.code;
    if (!code) return null;
    if (!footballMatchesPromises.has(code)) {
      footballMatchesPromises.set(code, fetch(`${WORKER_URL_PRO}?action=football&competition=${encodeURIComponent(code)}`)
        .then(response => { if (!response.ok) throw new Error("Risultati non disponibili"); return response.json(); })
        .then(data => data.matches || []));
    }
    const matches = await footballMatchesPromises.get(code);
    const norm = value => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const team = matches.flatMap(m => [m.homeTeam, m.awayTeam]).find(t => norm(t.name) === norm(teamName));
    if (!team) return null;
    const teamMatches = matches.filter(m => m.homeTeam?.id === team.id || m.awayTeam?.id === team.id).sort((a,b) => b.utcDate.localeCompare(a.utcDate)).slice(0,10);
    return { team, matches: teamMatches };
  } catch (e) { return null; }
}

function calcolaStatSquadra(matches, teamName) {
  if (!matches || !matches.length) return null;
  const risultati = matches.map(m => {
    const isHome = m.homeTeam?.name === teamName;
    const gf = isHome ? m.score?.fullTime?.home : m.score?.fullTime?.away;
    const gs = isHome ? m.score?.fullTime?.away : m.score?.fullTime?.home;
    if (gf === null || gf === undefined) return null;
    return { esito: gf > gs ? "W" : gf < gs ? "L" : "D", gf, gs, isHome };
  }).filter(Boolean);
  if (!risultati.length) return null;
  const ritardo = (e) => { let c=0; for(const r of risultati){if(r.esito!==e)c++;else break;} return c; };
  const vinte=risultati.filter(r=>r.esito==="W").length;
  const pareggiate=risultati.filter(r=>r.esito==="D").length;
  const perse=risultati.filter(r=>r.esito==="L").length;
  const casa=risultati.filter(r=>r.isHome);
  const fuori=risultati.filter(r=>!r.isHome);
  return {
    totale: risultati.length, vinte, pareggiate, perse,
    forma: risultati.slice(0,5).map(r=>r.esito),
    ritardoW: ritardo("W"), ritardoD: ritardo("D"), ritardoL: ritardo("L"),
    goiMedia: (risultati.reduce((a,r)=>a+r.gf,0)/risultati.length).toFixed(2),
    goiSubiti: (risultati.reduce((a,r)=>a+r.gs,0)/risultati.length).toFixed(2),
    wrCasa: casa.length ? (casa.filter(r=>r.esito==="W").length/casa.length*100).toFixed(0) : "N/D",
    wrFuori: fuori.length ? (fuori.filter(r=>r.esito==="W").length/fuori.length*100).toFixed(0) : "N/D",
  };
}

async function avviaAnalisiPro() {
  const sel = document.getElementById("pro-match-select");
  const idx = parseInt(sel.value);
  if (isNaN(idx)) return;
  const match = ultimiDatiPartite[idx];
  const legaKey = document.getElementById("lega-select")?.value || "";
  const legaInfo = LEGA_MAP[legaKey];
  const res = document.getElementById("pro-result");
  const btn = document.getElementById("btn-pro-analizza");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Analisi in corso...';
  res.innerHTML = `<div class="pro-score-card"><div style="color:#718096;font-size:13px"><span class="spinner"></span> Recupero statistiche per <b>${match.home_team}</b> e <b>${match.away_team}</b>...</div></div>`;

  try {
    // Quote
    const allOdds={home:[],away:[],draw:[]};
    match.bookmakers.forEach(bk=>bk.markets.forEach(mkt=>{if(mkt.key!=="h2h")return;mkt.outcomes.forEach(o=>{if(o.name===match.home_team)allOdds.home.push(o.price);else if(o.name===match.away_team)allOdds.away.push(o.price);else allOdds.draw.push(o.price);});}));
    const avg=arr=>arr.length?arr.reduce((a,b)=>a+b,0)/arr.length:null;
    const avgH=avg(allOdds.home),avgA=avg(allOdds.away),avgD=avg(allOdds.draw);

    // Stats reali
    let statsHome=null, statsAway=null;
    if (legaInfo) {
      const [rH,rA] = await Promise.all([fetchSquadraMatches(match.home_team), fetchSquadraMatches(match.away_team)]);
      if (rH) statsHome = calcolaStatSquadra(rH.matches, match.home_team);
      if (rA) statsAway = calcolaStatSquadra(rA.matches, match.away_team);
    }

    // === CALCOLO POISSON REALE ===
    let poissonResult = null;
    if (statsHome && statsAway) {
      const LEAGUE_AVG = 1.35;
      const attH = parseFloat(statsHome.goiMedia) || LEAGUE_AVG;
      const difH = parseFloat(statsHome.goiSubiti) || LEAGUE_AVG;
      const attA = parseFloat(statsAway.goiMedia) || LEAGUE_AVG;
      const difA = parseFloat(statsAway.goiSubiti) || LEAGUE_AVG;

      const lambdaHome = (attH / LEAGUE_AVG) * (difA / LEAGUE_AVG) * LEAGUE_AVG * 1.15;
      const lambdaAway = (attA / LEAGUE_AVG) * (difH / LEAGUE_AVG) * LEAGUE_AVG;

      poissonResult = calcPoisson(lambdaHome, lambdaAway);
      poissonResult.lambdaHome = lambdaHome.toFixed(2);
      poissonResult.lambdaAway = lambdaAway.toFixed(2);
    }

    // Prompt Groq
    const statStr = (label, s) => !s ? `${label}: dati non disponibili` :
      `${label}: forma=${s.forma.join("-")} | ${s.vinte}V${s.pareggiate}P${s.perse}L | gol segnati/g=${s.goiMedia} subiti/g=${s.goiSubiti} | wrCasa=${s.wrCasa}% wrFuori=${s.wrFuori}% | ritardi: V=${s.ritardoW}pt X=${s.ritardoD}pt L=${s.ritardoL}pt`;

    const movH=getOddsMovement(match.id,match.home_team);
    const movA=getOddsMovement(match.id,match.away_team);

    // === TASK 3: PROMPT AGGIORNATO CON DATI REALI ===
    const prompt = `Analizza questa partita: ${match.home_team} vs ${match.away_team}.
CAMPIONATO: ${legaInfo?.nome||legaKey}

QUOTE mercato: 1=${avgH?.toFixed(2)} (${avgH?(1/avgH*100).toFixed(1):"-"}%) X=${avgD?.toFixed(2)} 2=${avgA?.toFixed(2)}

${poissonResult ? `
PROBABILITÀ POISSON REALI (Calcolate su statistiche ultime 10 partite):
λ home = ${poissonResult.lambdaHome} | λ away = ${poissonResult.lambdaAway}
Prob 1 = ${(poissonResult.p1*100).toFixed(1)}% | Prob X = ${(poissonResult.pX*100).toFixed(1)}% | Prob 2 = ${(poissonResult.p2*100).toFixed(1)}%
Edge 1 = ${avgH ? ((poissonResult.p1 - 1/avgH)*100).toFixed(1) : "N/D"}%
Edge X = ${avgD ? ((poissonResult.pX - 1/avgD)*100).toFixed(1) : "N/D"}%
Edge 2 = ${avgA ? ((poissonResult.p2 - 1/avgA)*100).toFixed(1) : "N/D"}%
` : "Statistiche insufficienti per il modello Poisson."}

DATI SQUADRE:
${statStr(match.home_team, statsHome)}
${statStr(match.away_team, statsAway)}
MOVIMENTI: quota1=${movH?(movH.diff<0?"CALO "+movH.pct+"%":"salita "+movH.pct+"%"):"stabile"} quota2=${movA?(movA.diff<0?"CALO "+movA.pct+"%":"salita "+movA.pct+"%"):"stabile"}

REGOLE TASSATIVE:
1. NON inventare probabilità. Usa come base le probabilità Poisson fornite sopra.
2. Aggiusta i valori di massimo ±5% in base a contesto qualitativo (infortuni, motivazioni, stanchezza).
3. Rispondi SOLO con JSON.

Rispondi SOLO con JSON:
{"prob_1":${(poissonResult?.p1*100 || 33).toFixed(1)},"prob_x":${(poissonResult?.pX*100 || 33).toFixed(1)},"prob_2":${(poissonResult?.p2*100 || 33).toFixed(1)},"raccomandazione":"1","giudizio":"GIOCA","edge_1":0,"edge_x":0,"edge_2":0,"componenti":{"quote_prob_1":0,"forma_prob_1":0,"ritardo_segnale":""},"segnali":[],"ritardi_note":"","ragionamento":"","confidenza":"ALTA"}`;

    const groqResp=await fetch(`${WORKER_URL_PRO}?action=ai`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:GROQ_MODEL,messages:[{role:"user",content:prompt}],max_tokens:1200,temperature:0.2})});
    if(!groqResp.ok) throw new Error("Groq "+groqResp.status);
    const groqData=await groqResp.json();
    const testo=groqData.choices?.[0]?.message?.content||"";
    let score=null;
    try{score=JSON.parse(testo.replace(/```json|```/g,"").trim());}catch(e){}
    if(score) res.innerHTML=renderProScoreCard(match,score,statsHome,statsAway,avgH,avgA,avgD);
    else res.innerHTML=`<div class="pro-score-card"><div style="color:#fc8181">❌ Errore parsing risposta AI. Riprova.</div><pre style="font-size:10px;color:#718096;white-space:pre-wrap;margin-top:10px">${testo}</pre></div>`;
  } catch(e) {
    res.innerHTML=`<div class="pro-score-card"><div style="color:#fc8181">❌ Errore: ${e.message}</div></div>`;
  }
  btn.disabled=false; btn.innerHTML="🎯 Analizza partita";
}

function renderProScoreCard(match,score,statsHome,statsAway,avgH,avgA,avgD){
  const gjClass={GIOCA:"gioca",ATTENDI:"attendi",EVITA:"evita"}[score.giudizio]||"attendi";
  const gjEmoji={GIOCA:"✅",ATTENDI:"⏳",EVITA:"❌"}[score.giudizio]||"⏳";
  const confColor={ALTA:"#48bb78",MEDIA:"#f6ad55",BASSA:"#fc8181"}[score.confidenza]||"#f6ad55";
  const barCol=v=>v>=45?"#48bb78":v>=30?"#f4c430":"#fc8181";
  const safeNumber = value => Number.isFinite(Number(value)) ? Math.max(0, Math.min(100, Number(value))) : 0;
  const dots=s=>!s?.forma?"":s.forma.map(e=>`<div class="pro-dot" style="background:${e==="W"?"#48bb78":e==="D"?"#f6ad55":"#fc8181"}"></div>`).join("");
  const ritRow=(label,n,soglia)=>`<div class="pro-ritardo-row"><span style="color:#a0aec0">${label}</span><span style="color:${n>=soglia?"#f6ad55":"#4a5568"};font-weight:700">${n} partite${n>=soglia?" ⚠️":""}</span></div>`;

  return `<div class="pro-score-card">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px;margin-bottom:20px">
      <div>
        <div style="font-size:11px;color:#4a7fa5;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">🎯 Analisi Pro</div>
        <div style="font-size:17px;font-weight:800">${escapeHTML(match.home_team)} vs ${escapeHTML(match.away_team)}</div>
        <div style="font-size:12px;color:#718096;margin-top:3px">${new Date(match.commence_time).toLocaleDateString("it-IT")} · ${match.bookmakers.length} bookmaker</div>
      </div>
      <div style="text-align:right">
        <span class="pro-badge ${gjClass}" style="font-size:15px;padding:8px 16px">${gjEmoji} ${escapeHTML(score.giudizio)}</span>
        <div style="font-size:11px;color:${confColor};font-weight:700;margin-top:6px">Confidenza: ${escapeHTML(score.confidenza)}</div>
      </div>
    </div>

    <div style="font-size:11px;color:#718096;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">Score Finale — Probabilità combinate</div>
    ${[{l:"1",p:score.prob_1,e:score.edge_1,q:avgH},{l:"X",p:score.prob_x,e:score.edge_x,q:avgD},{l:"2",p:score.prob_2,e:score.edge_2,q:avgA}].map(r=>`
    <div class="pro-bar-wrap">
      <div class="pro-bar-label">${r.l}</div>
      <div class="pro-bar-track"><div class="pro-bar-fill" style="width:${safeNumber(r.p)}%;background:${barCol(safeNumber(r.p))}">${safeNumber(r.p)}%</div></div>
      <div style="min-width:90px;text-align:right;font-size:12px;color:#718096">Q:<b style="color:#e2e8f0;margin-left:3px">${r.q?r.q.toFixed(2):"N/D"}</b>${r.e>0?`<span style="color:#48bb78;margin-left:5px">+${r.e}%</span>`:r.e<0?`<span style="color:#fc8181;margin-left:5px">${r.e}%</span>`:""}</div>
    </div>`).join("")}

    <div class="pro-components" style="margin-top:18px">
      <div class="pro-comp-box"><div class="pro-comp-label">Quote mercato (40%)</div><div class="pro-comp-val">${score.componenti?.quote_prob_1??"—"}%</div><div class="pro-comp-weight">prob. 1 dal mercato</div></div>
      <div class="pro-comp-box"><div class="pro-comp-label">Forma/Stats (35%)</div><div class="pro-comp-val">${score.componenti?.forma_prob_1??"—"}%</div><div class="pro-comp-weight">prob. 1 da statistiche</div></div>
      <div class="pro-comp-box"><div class="pro-comp-label">Segnale ritardo (25%)</div><div class="pro-comp-val" style="font-size:13px;color:#f6ad55">${score.componenti?.ritardo_segnale?"Attivo":"—"}</div><div class="pro-comp-weight" style="font-size:9px">${escapeHTML((score.componenti?.ritardo_segnale||"Nessun segnale forte").substring(0,50))}</div></div>
    </div>

    ${statsHome||statsAway?`
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:16px 0">
      ${statsHome?`<div style="background:#0d1116;border-radius:8px;padding:12px"><div style="font-size:11px;color:#718096;font-weight:700;margin-bottom:6px">${match.home_team.split(" ").slice(-1)[0]}</div><div class="pro-form-dots">${dots(statsHome)}</div><div style="font-size:11px;color:#4a5568;margin-top:6px">${statsHome.vinte}V ${statsHome.pareggiate}P ${statsHome.perse}L · ⚽${statsHome.goiMedia}/g</div></div>`:""}
      ${statsAway?`<div style="background:#0d1116;border-radius:8px;padding:12px"><div style="font-size:11px;color:#718096;font-weight:700;margin-bottom:6px">${match.away_team.split(" ").slice(-1)[0]}</div><div class="pro-form-dots">${dots(statsAway)}</div><div style="font-size:11px;color:#4a5568;margin-top:6px">${statsAway.vinte}V ${statsAway.pareggiate}P ${statsAway.perse}L · ⚽${statsAway.goiMedia}/g</div></div>`:""}
    </div>`:`<div style="background:#0d1116;border-radius:8px;padding:12px;margin:12px 0;font-size:12px;color:#718096">⚠️ Statistiche reali non disponibili — analisi basata su quote e AI.</div>`}

    ${statsHome?`
    <div style="margin-bottom:14px">
      <div style="font-size:11px;color:#718096;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">📊 Ritardi — ${escapeHTML(match.home_team)}</div>
      <div style="background:#0d1116;border-radius:8px;padding:10px 14px">
        ${ritRow("Vittoria non esce da",statsHome.ritardoW,5)}
        ${ritRow("Pareggio non esce da",statsHome.ritardoD,4)}
        ${ritRow("Sconfitta non esce da",statsHome.ritardoL,5)}
      </div>
      ${score.ritardi_note?`<div style="font-size:11px;color:#4a5568;margin-top:6px">${escapeHTML(score.ritardi_note)}</div>`:""}
    </div>`:""}

    ${score.segnali?.length?`<div class="pro-signals">${score.segnali.map(s=>`<span class="pro-signal">${escapeHTML(s)}</span>`).join("")}</div>`:""}

    <div style="background:#0d1116;border-radius:8px;padding:14px;margin-top:14px;font-size:13px;color:#a0aec0;line-height:1.7;border-left:3px solid #68551b">
      💡 ${escapeHTML(score.ragionamento)}
    </div>
    <div style="margin-top:10px;font-size:11px;color:#4a5568">⚠️ Score combinato da dati reali e AI. Non garantisce vincite. Scommetti responsabilmente.</div>
  </div>`;
}

// ===== TELEGRAM ALERT =====
const alertInviati = new Set();

async function inviaAlertTelegram(pick) {
  const chiave = `${pick.partita}_${pick.esito}_${new Date().toLocaleDateString("it-IT")}`;
  if (alertInviati.has(chiave)) {
    console.log("[Telegram] Alert già inviato, skip:", chiave);
    return;
  }
  alertInviati.add(chiave);
  try {
    await fetch("/api/proxy?action=telegram", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        homeTeam:    pick.partita.split(" vs ")[0] || pick.partita,
        awayTeam:    pick.partita.split(" vs ")[1] || "",
        league:      document.getElementById("lega-select")?.options[document.getElementById("lega-select")?.selectedIndex]?.text || "—",
        market:      pick.descrizione_esito || pick.esito,
        poissonProb: (pick.prob_stimata || 0) / 100,
        bookOdds:    pick.quota_consigliata || 0,
        edge:        (pick.edge || 0) / 100,
        kellyStake:  (pick.kelly_puntata || 0) / calcStats().bankroll,
        matchTime:   new Date().toLocaleDateString("it-IT"),
      }),
    });
    console.log("[Telegram] Alert inviato:", pick.partita);
  } catch(e) {
    console.error("[Telegram] Errore:", e);
  }
}
renderAll();



// ===== POISSON ENGINE =====
function poissonProb(lambda, k) {
  let logP = k * Math.log(lambda) - lambda;
  for (let i = 1; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

function calcPoisson(lambdaHome, lambdaAway, maxGoals = 8) {
  let p1 = 0, pX = 0, p2 = 0;
  for (let h = 0; h <= maxGoals; h++) {
    for (let a = 0; a <= maxGoals; a++) {
      const p = poissonProb(lambdaHome, h) * poissonProb(lambdaAway, a);
      if (h > a) p1 += p;
      else if (h === a) pX += p;
      else p2 += p;
    }
  }
  return { p1, pX, p2 };
}




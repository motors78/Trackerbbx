(() => {
  const CACHE_KEY = "imparato_tecnica_cache_v1";
  const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

  function teamRows(matches) {
    const teams = new Map();
    for (const match of matches) {
      const hs = match.score?.fullTime?.home, as = match.score?.fullTime?.away;
      if (!Number.isFinite(hs) || !Number.isFinite(as) || !match.utcDate) continue;
      for (const [team, gf, ga] of [[match.homeTeam, hs, as], [match.awayTeam, as, hs]]) {
        if (!team?.name) continue;
        if (!teams.has(team.name)) teams.set(team.name, []);
        teams.get(team.name).push({ date: match.utcDate, round: match.matchday, result: gf === ga ? "D" : gf > ga ? "W" : "L" });
      }
    }
    const raw = [];
    for (const [team, games] of teams) {
      games.sort((a, b) => a.date.localeCompare(b.date));
      const drawIndexes = games.flatMap((g, i) => g.result === "D" ? [i] : []);
      const lastDrawIndex = drawIndexes.at(-1);
      const lastDraw = lastDrawIndex === undefined ? null : games[lastDrawIndex];
      const delay = lastDrawIndex === undefined ? games.length : games.length - lastDrawIndex - 1;
      const gaps = drawIndexes.slice(1).map((idx, i) => idx - drawIndexes[i] - 1);
      const meanGap = gaps.length ? gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length : null;
      raw.push({ team, lastDraw, delay, games, drawCount: drawIndexes.length, meanGap, wins: games.slice(lastDrawIndex === undefined ? 0 : lastDrawIndex + 1).filter(g => g.result === "W").length, losses: games.slice(lastDrawIndex === undefined ? 0 : lastDrawIndex + 1).filter(g => g.result === "L").length });
    }
    // The score ranks delay relative to each team's observed draw intervals. It is descriptive, not predictive.
    return raw.map(row => {
      const ratio = row.meanGap === null ? null : row.delay / Math.max(1, row.meanGap);
      const score = ratio === null ? null : Math.max(0, Math.min(100, Math.round(100 * (1 - Math.exp(-Math.max(0, ratio) / 2)))));
      const pct = row.games.length ? Math.round(row.drawCount / row.games.length * 100) : 0;
      return { ...row, score, pct };
    }).sort((a, b) => b.score - a.score || a.team.localeCompare(b.team, "it"));
  }

  window.caricaImparatoTecnica = async function () {
    const status = document.getElementById("imparato-status"), table = document.getElementById("imparato-table"), button = document.getElementById("btn-imparato-refresh");
    if (!status || button.disabled) return;
    button.disabled = true; status.style.display = "block"; status.textContent = "Recupero dei risultati Serie B…"; table.style.display = "none";
    try {
      let cached;
      try { cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "null"); } catch { cached = null; }
      let payload;
      if (cached?.expiresAt > Date.now() && Array.isArray(cached.matches)) payload = cached;
      else {
        const response = await fetch("/api/proxy?action=imparato-tecnica", { headers: { Accept: "application/json" } });
        if (!response.ok) throw new Error(response.status === 503 ? "Servizio risultati non configurato: verificare FOOTBALL_DATA_TOKEN nei secret Cloudflare Pages." : `Servizio risultati: HTTP ${response.status}`);
        payload = await response.json();
        if (!Array.isArray(payload.matches)) throw new Error("Il provider non ha restituito una lista di partite.");
        try { localStorage.setItem(CACHE_KEY, JSON.stringify({ matches: payload.matches, expiresAt: Date.now() + 10 * 60_000 })); } catch { /* Cache best effort. */ }
      }
      const rows = teamRows(payload.matches);
      if (!rows.length) throw new Error("Non ci sono risultati conclusi disponibili.");
      table.innerHTML = `<table class="stats-table"><thead><tr><th>Squadra</th><th>Ultimo X</th><th>Partite senza X</th><th>Giornate*</th><th>Vittorie</th><th>Sconfitte</th><th>Frequenza X</th><th>Ritardo relativo</th><th>Coefficiente</th></tr></thead><tbody>${rows.map(r => `<tr><td>${escapeHTML(r.team)}</td><td>${r.lastDraw ? new Date(r.lastDraw.date).toLocaleDateString("it-IT") : "Nessun X nei dati"}</td><td>${r.delay}</td><td>${r.lastDraw?.round != null && r.games.at(-1)?.round != null ? Math.max(0, r.games.at(-1).round - r.lastDraw.round) : "n/d"}</td><td>${r.wins}</td><td>${r.losses}</td><td>${r.pct}% (${r.drawCount}/${r.games.length})</td><td>${r.meanGap === null ? "Dati insufficienti" : `${(r.delay / Math.max(1, r.meanGap)).toFixed(2)}× la media personale`}</td><td><b>${r.score === null ? "n/d" : `${r.score}/100`}</b></td></tr>`).join("")}</tbody></table><p style="font-size:11px;color:#718096;margin-top:12px">* Differenza tra giornate quando il provider le espone. Il coefficiente confronta il ritardo attuale con l’intervallo medio personale tra pareggi nella stagione disponibile, trasformato su scala 0–100; non è una probabilità. ${payload.matches.length} risultati analizzati.</p>`;
      status.style.display = "none"; table.style.display = "block";
      document.getElementById("imparato-updated").textContent = `Dati aggiornati: ${new Date().toLocaleString("it-IT")}`;
    } catch (error) { status.style.display = "block"; status.textContent = error.message || "Errore nel caricamento dei risultati."; }
    finally { button.disabled = false; }
  };
})();

(() => {
  // Chiavi degli avvisi confermati da Telegram (solo in memoria, come prima) e di quelli in corso.
  const alertInviati = new Set();
  const alertInCorso = new Set();

  // Un avviso viene registrato come inviato SOLO se il server conferma { ok: true } con HTTP 2xx.
  // In caso di errore (rete, rate limit, Telegram non disponibile) la chiave non viene registrata,
  // quindi una chiamata successiva puo' riprovare. Restituisce true/false.
  async function inviaAlertTelegram(pick) {
    const chiave = `${pick.partita}_${pick.esito}_${new Date().toLocaleDateString("it-IT")}`;
    if (alertInviati.has(chiave) || alertInCorso.has(chiave)) {
      console.log("[Telegram] Alert già inviato o in corso, skip:", chiave);
      return false;
    }
    alertInCorso.add(chiave);
    try {
      const lega = document.getElementById("lega-select");
      const bankroll = calcStats().bankroll;
      const response = await fetch("/api/proxy?action=telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          homeTeam:    pick.partita.split(" vs ")[0] || pick.partita,
          awayTeam:    pick.partita.split(" vs ")[1] || "",
          league:      lega?.options[lega.selectedIndex]?.text || "—",
          market:      pick.descrizione_esito || pick.esito,
          poissonProb: (pick.prob_stimata || 0) / 100,
          bookOdds:    pick.quota_consigliata || 0,
          edge:        (pick.edge || 0) / 100,
          kellyStake:  bankroll ? (pick.kelly_puntata || 0) / bankroll : 0,
          matchTime:   new Date().toLocaleDateString("it-IT"),
        }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result || result.ok !== true) {
        throw new Error(result?.error || `HTTP ${response.status}`);
      }
      alertInviati.add(chiave);
      console.log("[Telegram] Alert inviato:", pick.partita);
      return true;
    } catch (e) {
      console.error("[Telegram] Invio non riuscito, nuovo tentativo consentito:", e);
      return false;
    } finally {
      alertInCorso.delete(chiave);
    }
  }

  window.inviaAlertTelegram = inviaAlertTelegram;
})();

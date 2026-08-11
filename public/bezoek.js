/*
 * Eenvoudige bezoekersteller voor doggyfew.com
 *
 * Slaat per paginabezoek één regeltje op: de datum, welke pagina, via welke
 * website de bezoeker binnenkwam, telefoon of computer, en de taal van de
 * browser.
 *
 * Bewust NIET: geen cookies, geen herkenning van terugkerende bezoekers,
 * geen IP-adres, geen enkel gegeven waarmee iemand te herleiden is. Daardoor
 * is hier geen toestemmingsvenster voor nodig.
 *
 * Wordt geteld bij een echt bezoek — niet wanneer de server zelf de pagina
 * ophaalt om de snapshot te maken, en niet in een geautomatiseerde browser.
 */
(function () {
  'use strict';

  var PROJECT = 'the-doggy-few';
  var SLEUTEL = 'AIzaSyD7j7nLLpLnH8vNznqiGWyBXvZrwZ6-Jjs';

  function tekst(v) {
    return { stringValue: String(v == null ? '' : v) };
  }

  try {
    // De snapshot-generator laadt de pagina met ?live=1. Dat is geen bezoeker.
    if (location.search.indexOf('live=1') !== -1) return;
    // Geautomatiseerde browsers (waaronder onze eigen snapshot-generator).
    if (navigator.webdriver) return;
    // In een iframe geladen: niet meetellen.
    if (window.top !== window.self) return;

    var verwijzer = '';
    try {
      if (document.referrer) verwijzer = new URL(document.referrer).hostname;
    } catch (e) { /* onbruikbare verwijzer, laat leeg */ }
    if (verwijzer === location.hostname) verwijzer = '';   // klik binnen de eigen site

    var nu = new Date();
    var regel = {
      fields: {
        datum:    tekst(nu.getFullYear() + '-' +
                        String(nu.getMonth() + 1).padStart(2, '0') + '-' +
                        String(nu.getDate()).padStart(2, '0')),
        pad:      tekst(location.pathname.slice(0, 120)),
        verwijzer: tekst(verwijzer.slice(0, 80)),
        apparaat: tekst(window.matchMedia('(max-width: 820px)').matches ? 'telefoon' : 'computer'),
        taal:     tekst((navigator.language || '').slice(0, 8)),
        tijdstip: { timestampValue: nu.toISOString() }
      }
    };

    fetch('https://firestore.googleapis.com/v1/projects/' + PROJECT +
          '/databases/(default)/documents/bezoeken?key=' + SLEUTEL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(regel),
      keepalive: true
    }).catch(function () { /* meten mag nooit de site in de weg zitten */ });
  } catch (e) {
    /* stil: een kapotte teller mag de website niet raken */
  }
})();

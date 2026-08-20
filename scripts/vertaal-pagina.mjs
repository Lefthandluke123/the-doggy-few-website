/**
 * Vertaalt een landingspagina naar een andere taal.
 *
 *   node scripts/vertaal-pagina.mjs <bronbestand> <doelbestand> <taal> <pad>
 *   bijv. node scripts/vertaal-pagina.mjs public/en/irish-party-band/index.html \
 *              public/de/irische-band-buchen/index.html de de/irische-band-buchen
 *
 * Alleen de zichtbare tekst en de teksten in de gestructureerde gegevens gaan
 * naar het vertaalmodel; opmaak, links en code blijven onaangeroerd. Adres,
 * telefoonnummer en de bandnaam blijven zoals ze zijn.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const [bron, doel, taal, pad] = process.argv.slice(2);
if (!bron || !doel || !taal || !pad) { console.error('gebruik: <bron> <doel> <taal> <pad>'); process.exit(1); }

const SLEUTEL = process.env.GEMINI_API_KEY;
if (!SLEUTEL) { console.error('GEMINI_API_KEY ontbreekt'); process.exit(1); }

const TAALNAAM = { de: 'Duits (formeel, met "Sie")', en: 'Engels (Brits)', nl: 'Nederlands' }[taal] || taal;

async function vertaal(stukken) {
  const prompt =
`Vertaal de onderstaande teksten van een website van de Ierse folkband The Doggy Few naar ${TAALNAAM}.

Regels:
- Geef exact evenveel regels terug als je krijgt, in dezelfde volgorde, genummerd zoals hieronder.
- Behoud HTML-entiteiten (&mdash; &euro; &amp; enzovoort) en laat leestekens intact.
- Laat eigennamen staan: The Doggy Few, Groningen, St. Patrick's Day, bodhrán, ceili, box, whistle.
- Bedragen, maten, telefoonnummers en e-mailadressen niet omrekenen of veranderen.
- Toon: warm, nuchter, geen verkooppraat. Geen aanhalingstekens toevoegen.

${stukken.map((s, i) => `${i + 1}. ${s}`).join('\n')}`;

  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${SLEUTEL}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 32000 },
    }),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  const uit = d.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
  const regels = uit.split('\n').map(l => l.match(/^\s*(\d+)\.\s?(.*)$/)).filter(Boolean);
  const kaart = new Map(regels.map(m => [Number(m[1]), m[2].trim()]));
  if (kaart.size !== stukken.length) {
    throw new Error(`${kaart.size} vertalingen terug op ${stukken.length} teksten`);
  }
  return stukken.map((_, i) => kaart.get(i + 1));
}

let h = await readFile(bron, 'utf8');

// 1. zichtbare tekst: alles tussen > en < dat echte woorden bevat, buiten script/style
const verboden = [];
h.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/g, (m, _t, i) => { verboden.push([i, i + m.length]); return m; });
const inCode = (i) => verboden.some(([a, b]) => i >= a && i < b);

const treffers = [];
const re = />([^<>{}]{3,})</g;
let m;
while ((m = re.exec(h))) {
  const tekst = m[1];
  if (inCode(m.index)) continue;
  if (!/[a-zA-Z]{3}/.test(tekst)) continue;
  if (/^\s*[\d\s.,:€%-]+\s*$/.test(tekst)) continue;
  treffers.push({ start: m.index + 1, eind: m.index + 1 + tekst.length, tekst });
}

// 2. teksten in de gestructureerde gegevens (JSON-LD)
const jsonBlokken = [...h.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];

const zichtbaar = treffers.map(t => t.tekst.replace(/\s+/g, ' ').trim());
console.log(`zichtbare teksten: ${zichtbaar.length}`);

const vertaald = [];
for (let i = 0; i < zichtbaar.length; i += 40) {
  const deel = zichtbaar.slice(i, i + 40);
  process.stdout.write(`  vertalen ${i + 1}-${i + deel.length}… `);
  vertaald.push(...await vertaal(deel));
  console.log('klaar');
}

// terugschrijven, van achter naar voren zodat de posities kloppen
for (let i = treffers.length - 1; i >= 0; i--) {
  h = h.slice(0, treffers[i].start) + vertaald[i] + h.slice(treffers[i].eind);
}

// 3. de gestructureerde gegevens
for (const blok of jsonBlokken) {
  let data;
  try { data = JSON.parse(blok[1]); } catch { continue; }
  const paden = [];
  const loop = (o, p) => {
    if (typeof o === 'string') { if (/[a-zA-Z]{4}/.test(o) && !/^https?:/.test(o)) paden.push(p); return; }
    if (Array.isArray(o)) return o.forEach((v, i) => loop(v, [...p, i]));
    if (o && typeof o === 'object') return Object.entries(o).forEach(([k, v]) => {
      if (['@type', '@context', 'url', 'sameAs', 'image', 'telephone', 'email', 'priceCurrency', 'inLanguage'].includes(k)) return;
      loop(v, [...p, k]);
    });
  };
  loop(data, []);
  const waarden = paden.map(p => p.reduce((o, k) => o[k], data));
  const nieuw = [];
  for (let i = 0; i < waarden.length; i += 40) {
    nieuw.push(...await vertaal(waarden.slice(i, i + 40)));
  }
  paden.forEach((p, i) => {
    const laatste = p.pop();
    p.reduce((o, k) => o[k], data)[laatste] = nieuw[i];
  });
  h = h.replace(blok[0], `<script type="application/ld+json">\n${JSON.stringify(data, null, 4)}\n    </script>`);
  console.log(`gegevens vertaald: ${paden.length} velden`);
}

// 4. taal, webadres en verwijzingen naar de andere talen
h = h.replace(/<html lang="[a-z-]+"/, `<html lang="${taal}"`);
h = h.replace(/content="(en_US|nl_NL|de_DE)"/g, `content="${taal === 'de' ? 'de_DE' : taal === 'en' ? 'en_US' : 'nl_NL'}"`);
h = h.replace(/https:\/\/doggyfew\.com\/(en\/)?[a-z-]+\/(?=")/g, `https://doggyfew.com/${pad}/`);

await mkdir(dirname(doel), { recursive: true });
await writeFile(doel, h);
console.log(`geschreven: ${doel}`);

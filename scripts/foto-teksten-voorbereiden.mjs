/**
 * Haalt de foto's van doggyfew.com op die nog geen echte alt-tekst hebben,
 * en zet ze klaar om te bekijken.
 *
 * Waarom dit bestaat: Lucas vraagt "schrijf teksten voor de nieuwe foto's".
 * Dan moet ik ze eerst zien. Dit script doet het opzoeken en downloaden, zodat
 * dat niet elke keer opnieuw uitgevonden hoeft te worden.
 *
 *   node scripts/foto-teksten-voorbereiden.mjs [map]
 *
 * Lezen mag zonder inloggen (de galerij is openbaar). Schrijven kan dit script
 * niet en hoeft ook niet: de teksten gaan naar public/fototeksten.json en
 * worden daarna met de knop "Alt-teksten & tags nakijken" weggeschreven.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const SLEUTEL = 'AIzaSyD7j7nLLpLnH8vNznqiGWyBXvZrwZ6-Jjs';   // publieke websleutel, staat ook in app.html
const PROJECT = 'the-doggy-few';
const MAP = process.argv[2] || 'foto-werkmap';

const veld = (v) => v?.stringValue ?? v?.integerValue ?? (v?.arrayValue?.values || []).map(veld);

async function collectie(naam) {
  const uit = [];
  let token = '';
  do {
    const url = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/${naam}?pageSize=300&key=${SLEUTEL}${token ? `&pageToken=${token}` : ''}`;
    const d = await (await fetch(url)).json();
    if (d.error) throw new Error(d.error.message);
    for (const doc of d.documents || []) {
      const velden = Object.fromEntries(Object.entries(doc.fields || {}).map(([k, v]) => [k, veld(v)]));
      uit.push({ id: doc.name.split('/').pop(), ...velden, _ruw: doc.fields });
    }
    token = d.nextPageToken || '';
  } while (token);
  return uit;
}

const galerienaam = (g) => {
  const t = g._ruw?.title;
  if (t?.stringValue) return t.stringValue;
  const f = t?.mapValue?.fields || {};
  return f.nl?.stringValue || f.en?.stringValue || f.de?.stringValue || g.id;
};

const fotos = await collectie('photos');
const galerieen = await collectie('galleries');
const naam = Object.fromEntries(galerieen.map((g) => [g.id, galerienaam(g)]));

// Concept-teksten tellen niet als "echte" tekst: die zijn automatisch bedacht.
const tekortkomend = fotos.filter((f) => !f.alt || f._ruw?.altConcept?.booleanValue === true);

await mkdir(MAP, { recursive: true });
let opgehaald = 0;
for (const [i, f] of tekortkomend.entries()) {
  const bestand = `${String(i + 1).padStart(2, '0')}_${(naam[f.galleryId] || 'zonder-galerie').replace(/\W+/g, '-')}_${f.id}.webp`;
  try {
    if (String(f.url).startsWith('data:')) {
      await writeFile(join(MAP, bestand.replace('.webp', '.jpg')), Buffer.from(String(f.url).split(',')[1], 'base64'));
    } else {
      const r = await fetch(f.url);
      await writeFile(join(MAP, bestand), Buffer.from(await r.arrayBuffer()));
    }
    opgehaald++;
  } catch (e) {
    console.error('  niet gelukt:', f.id, e.message);
  }
}

console.log(`foto's in het archief:      ${fotos.length}`);
console.log(`nog zonder echte tekst:     ${tekortkomend.length}`);
console.log(`opgehaald naar ${MAP}/:  ${opgehaald}`);
console.log('\nDaarna: teksten in public/fototeksten.json zetten (per foto-id),');
console.log('uitrollen, en in het beheerscherm op "Alt-teksten & tags nakijken" klikken.');

/* ══════════════════════════════════════════════════════════════════════════
   AUTOMATISCH AANKONDIGEN VAN OPTREDENS OP FACEBOOK EN INSTAGRAM

   Hoe het werkt, in drie stappen:

   1. Zet je in Kantoor of in het beheerscherm een optreden op "Bevestigd",
      dan wordt hier een aankondiging klaargezet. Er wordt nog niets geplaatst.

   2. De aankondiging blijft tien minuten in de wacht staan. Zie je een typfout
      of klopt de datum niet, dan kun je hem in die tijd nog weggooien.

   3. Daarna plaatst het systeem hem op de Facebook-pagina en op Instagram.
      Wat er geplaatst is, wordt bewaard met de link erbij.

   Veiligheidskleppen:
   - er wordt niets geplaatst zolang de schakelaar uit staat
     (settings/social, veld automatischAankondigen);
   - zonder toegangssleutels draait alles in de proefstand: de tekst wordt
     samengesteld en bewaard, maar er gaat niets naar buiten;
   - elk optreden wordt hooguit één keer aangekondigd;
   - optredens in het verleden en afgezegde optredens worden overgeslagen.
   ══════════════════════════════════════════════════════════════════════════ */

const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

const META_TOKEN = defineSecret("META_TOKEN");
const META_PAGE_ID = defineSecret("META_PAGE_ID");
const META_IG_USER_ID = defineSecret("META_IG_USER_ID");

const GRAPH = "https://graph.facebook.com/v21.0";
const WACHTTIJD_MS = 10 * 60 * 1000;      // bedenktijd voor het plaatsen
const INSTELLINGEN_DOC = "settings/social";
const WACHTRIJ = "social_wachtrij";

/* ── Tekst samenstellen ─────────────────────────────────────────────────── */

const DAGEN = ["zondag", "maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag"];
const MAANDEN = ["januari", "februari", "maart", "april", "mei", "juni",
                 "juli", "augustus", "september", "oktober", "november", "december"];

function datumInWoorden(isoDatum) {
  const d = new Date(isoDatum + "T12:00:00Z");
  if (isNaN(d.getTime())) return isoDatum;
  return `${DAGEN[d.getUTCDay()]} ${d.getUTCDate()} ${MAANDEN[d.getUTCMonth()]}`;
}

function isBinnenkort(isoDatum) {
  const d = new Date(isoDatum + "T12:00:00Z");
  const dagen = (d.getTime() - Date.now()) / 86400000;
  return dagen >= 0 && dagen <= 21;
}

// Besloten feesten worden nooit aangekondigd: dat is geen publiek optreden,
// en de gastheer zit niet te wachten op ongenode gasten.
function isBesloten(gig) {
  const tekst = `${gig.venue || ""} ${gig.description || ""} ${gig.location || ""}`;
  return /\(?\s*(private|besloten|priv[ée])\s*\)?/i.test(tekst);
}

function stelTekstSamen(gig) {
  const wanneer = datumInWoorden(gig.date);
  const venue = String(gig.venue || "").replace(/\s*\(.*?\)\s*/g, " ").trim();
  const plaats = String(gig.location || "").trim();
  // "Glimmen in Glimmen" voorkomen.
  const waar = (plaats && venue && !venue.toLowerCase().includes(plaats.toLowerCase()))
    ? `${venue} in ${plaats}`
    : (venue || plaats);
  const tijd = gig.startTime ? ` vanaf ${gig.startTime}` : "";

  const regels = [];
  regels.push(`🎶 ${isBinnenkort(gig.date) ? "Deze" : "Op"} ${wanneer} spelen we bij ${waar}${tijd}.`);
  if (gig.description) regels.push(gig.description);
  regels.push("Kom je ook? Alle optredens staan op doggyfew.com");
  regels.push("");
  regels.push("#thedoggyfew #iersemuziek #irishfolk #keltischemuziek #livemuziek #groningen");

  return regels.join("\n");
}

/* ── Praten met Facebook en Instagram ───────────────────────────────────── */

async function graphAanroep(pad, body, token) {
  const antwoord = await fetch(`${GRAPH}/${pad}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(Object.assign({ access_token: token }, body)),
  });
  const uitkomst = await antwoord.json().catch(() => ({}));
  if (!antwoord.ok || uitkomst.error) {
    const melding = (uitkomst.error && uitkomst.error.message) || `HTTP ${antwoord.status}`;
    throw new Error(melding);
  }
  return uitkomst;
}

async function plaatsOpFacebook(tekst, paginaId, token) {
  const uitkomst = await graphAanroep(`${paginaId}/feed`, {
    message: tekst,
    link: "https://doggyfew.com/#gigs",
  }, token);
  return {
    id: uitkomst.id || null,
    link: uitkomst.id ? `https://www.facebook.com/${uitkomst.id}` : null,
  };
}

async function plaatsOpInstagram(tekst, afbeelding, igId, token) {
  // Instagram wil altijd een afbeelding, en aantoonbaar een JPEG.
  if (!afbeelding) throw new Error("geen afbeelding beschikbaar");
  if (!/\.(jpe?g)(\?|$)/i.test(afbeelding)) {
    throw new Error("Instagram accepteert alleen JPEG; deze afbeelding is dat niet");
  }
  // Twee stappen: eerst een houder maken, dan publiceren.
  const houder = await graphAanroep(`${igId}/media`, {
    image_url: afbeelding,
    caption: tekst,
  }, token);
  if (!houder.id) throw new Error("Instagram gaf geen houder terug");
  const geplaatst = await graphAanroep(`${igId}/media_publish`, {
    creation_id: houder.id,
  }, token);
  return {
    id: geplaatst.id || null,
    link: geplaatst.id ? `https://www.instagram.com/p/${geplaatst.id}/` : null,
  };
}

/* ── Stap 1: aankondiging klaarzetten ───────────────────────────────────── */

exports.bereidAankondigingVoor = onDocumentWritten(
  { document: "gigs/{gigId}", region: "europe-west1" },
  async (event) => {
    const na = event.data && event.data.after && event.data.after.exists
      ? event.data.after.data() : null;
    if (!na) return;

    if (na.status !== "confirmed") return;
    if (!na.date) return;
    if (na.date < new Date().toISOString().slice(0, 10)) return;   // verleden
    if (isBesloten(na)) return;                                     // besloten feest

    const db = admin.firestore();
    const gigId = event.params.gigId;

    // Nooit twee keer hetzelfde optreden aankondigen.
    const bestaat = await db.collection(WACHTRIJ).doc(gigId).get();
    if (bestaat.exists) return;

    const instellingen = (await db.doc(INSTELLINGEN_DOC).get()).data() || {};
    const afbeelding = instellingen.afbeelding || "";

    await db.collection(WACHTRIJ).doc(gigId).set({
      gigId,
      tekst: stelTekstSamen(Object.assign({ id: gigId }, na)),
      afbeelding,
      optreden: {
        datum: na.date || "",
        venue: na.venue || "",
        plaats: na.location || "",
      },
      status: "wacht",
      plaatsenVanaf: admin.firestore.Timestamp.fromMillis(Date.now() + WACHTTIJD_MS),
      aangemaaktOp: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
);

/* ── Stap 2: plaatsen wat aan de beurt is ───────────────────────────────── */

exports.plaatsAankondigingen = onSchedule(
  {
    schedule: "every 5 minutes",
    timeZone: "Europe/Amsterdam",
    region: "europe-west1",
    secrets: [META_TOKEN, META_PAGE_ID, META_IG_USER_ID],
  },
  async () => {
    const db = admin.firestore();

    const instellingen = (await db.doc(INSTELLINGEN_DOC).get()).data() || {};
    const aan = instellingen.automatischAankondigen === true;

    // Alleen op status vragen, en de wachttijd hier nakijken. Vragen op twee
    // velden tegelijk vereist een extra index bij Firestore, en dat is voor
    // een handjevol aankondigingen overbodige complexiteit.
    const alles = await db.collection(WACHTRIJ)
      .where("status", "==", "wacht")
      .limit(25)
      .get();
    const nu = Date.now();
    const wachtenden = alles.docs.filter((d) => {
      const t = d.data().plaatsenVanaf;
      return t && typeof t.toMillis === "function" && t.toMillis() <= nu;
    }).slice(0, 5);
    if (!wachtenden.length) return;

    const token = process.env.META_TOKEN || "";
    const paginaId = process.env.META_PAGE_ID || "";
    const igId = process.env.META_IG_USER_ID || "";
    const proefstand = !aan || !token || !paginaId;

    for (const doc of wachtenden) {
      const item = doc.data();

      if (proefstand) {
        const reden = !aan
          ? "de schakelaar staat uit"
          : "er zijn nog geen toegangssleutels ingesteld";
        await doc.ref.set({
          status: "proef",
          resultaat: { reden, zouGeplaatstZijn: true },
          verwerktOp: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        continue;
      }

      const resultaat = { facebook: null, instagram: null, fouten: [] };

      try {
        resultaat.facebook = await plaatsOpFacebook(item.tekst, paginaId, token);
      } catch (err) {
        resultaat.fouten.push("Facebook: " + err.message);
      }

      if (igId) {
        try {
          resultaat.instagram = await plaatsOpInstagram(item.tekst, item.afbeelding, igId, token);
        } catch (err) {
          resultaat.fouten.push("Instagram: " + err.message);
        }
      } else {
        resultaat.fouten.push("Instagram: geen account ingesteld");
      }

      const gelukt = !!(resultaat.facebook || resultaat.instagram);
      await doc.ref.set({
        status: gelukt ? "geplaatst" : "mislukt",
        resultaat,
        verwerktOp: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }
  }
);

/* ── Handmatig uitproberen vanuit het beheerscherm ──────────────────────── */

exports.testAankondiging = onCall(
  {
    region: "europe-west1",
    secrets: [META_TOKEN, META_PAGE_ID, META_IG_USER_ID],
  },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Je moet ingelogd zijn.");

    const token = process.env.META_TOKEN || "";
    const paginaId = process.env.META_PAGE_ID || "";
    const igId = process.env.META_IG_USER_ID || "";

    if (!token || !paginaId) {
      return {
        klaar: false,
        melding: "Er zijn nog geen toegangssleutels ingesteld. Zolang dat zo is wordt er niets geplaatst.",
      };
    }

    // Alleen kijken of de sleutel werkt — er wordt niets geplaatst.
    const controle = { pagina: null, instagram: null, fouten: [] };
    try {
      const r = await fetch(`${GRAPH}/${paginaId}?fields=name,username&access_token=${encodeURIComponent(token)}`);
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      controle.pagina = j.name || paginaId;
    } catch (err) {
      controle.fouten.push("Facebook-pagina: " + err.message);
    }

    if (igId) {
      try {
        const r = await fetch(`${GRAPH}/${igId}?fields=username&access_token=${encodeURIComponent(token)}`);
        const j = await r.json();
        if (j.error) throw new Error(j.error.message);
        controle.instagram = j.username || igId;
      } catch (err) {
        controle.fouten.push("Instagram: " + err.message);
      }
    }

    return {
      klaar: !controle.fouten.length,
      pagina: controle.pagina,
      instagram: controle.instagram,
      fouten: controle.fouten,
      voorbeeldtekst: stelTekstSamen({
        date: new Date(Date.now() + 9 * 86400000).toISOString().slice(0, 10),
        venue: "Folkclub Katwijk",
        location: "Katwijk",
        startTime: "20:30",
        description: "Een avond Ierse folk",
      }),
    };
  }
);

// Voor het testen los van Firebase.
exports._intern = { stelTekstSamen, datumInWoorden, isBinnenkort, isBesloten };

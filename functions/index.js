const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onRequest } = require("firebase-functions/v2/https");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const chromium = require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");
const zlib = require("zlib");

admin.initializeApp();
const db = admin.firestore();

const HOMEPAGE_URL = "https://the-doggy-few.web.app/app.html?live=1";
const SNAPSHOT_DOC = "settings/snapshot";

// De site bestaat in drie talen, elk met een eigen webadres. Van elke taal
// wordt een eigen kopie bewaard, anders kan Google de Engelse en Duitse
// teksten niet vinden.
const TALEN = [
  { code: "nl", pad: "/",    doc: "settings/snapshot" },
  { code: "en", pad: "/en/", doc: "settings/snapshot-en" },
  { code: "de", pad: "/de/", doc: "settings/snapshot-de" },
];
const WIJZIGING_DOC = "settings/snapshot-status";

// Collecties waarvan de inhoud op de homepage staat. Een wijziging hierin
// betekent dat de opgeslagen kopie van de homepage verouderd is.
const HOMEPAGE_COLLECTIES = [
  "gigs", "blog", "photos", "galleries", "videos",
  "members", "pages", "links", "lyrics",
  "settings",   // hierin zitten ook de beheerde teksten en de vormgeving
  "admin",      // hierin zit de hero-afbeelding
];

// Uitzonderingen binnen settings: de kopieën zelf en het statusvlaggetje.
// Zonder deze uitzondering zou het maken van een kopie een nieuwe wijziging
// melden, en zou het systeem zichzelf eindeloos blijven vernieuwen.
const NIET_MELDEN = [
  "settings/snapshot",
  "settings/snapshot-en",
  "settings/snapshot-de",
  "settings/snapshot-status",
];

// Zo lang wachten na de laatste wijziging voordat de site wordt bijgewerkt.
// Wie tien optredens achter elkaar invoert, krijgt zo één keer een update in
// plaats van tien keer.
const RUSTPERIODE_MS = 3 * 60 * 1000;

// Maakt de statische kopie van de homepage en zet die live.
// Gebruikt door de knop in het beheerscherm én door het automatisch bijwerken.
async function maakEnBewaarSnapshot() {
  let browser;
  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: { width: 1280, height: 900 },
      executablePath: await chromium.executablePath(),
      headless: true,
    });

    const resultaten = [];
    for (const taal of TALEN) {
      const page = await browser.newPage();
      try {
        await page.goto(HOMEPAGE_URL + "&taal=" + taal.code, { waitUntil: "networkidle2", timeout: 45000 });
        await page.waitForFunction(
          () => {
            if (document.documentElement.getAttribute("data-hydrated") !== "true") return false;
            const ids = ["gigsContainer", "blogContainer", "membersContainer", "photosContainer", "videosContainer"];
            return ids.every((id) => { const el = document.getElementById(id); return el && el.children.length > 0; });
          },
          { timeout: 30000 }
        ).catch(() => {});
        await new Promise((r) => setTimeout(r, 1500));
        const html = await page.evaluate(() => {
          document.documentElement.setAttribute("data-snapshot", "true");
          return "<!DOCTYPE html>\n" + document.documentElement.outerHTML;
        });

        // Controles vóór opslaan. Liever de oude kopie laten staan dan een
        // halve pagina live zetten.
        if (!html.includes("The Doggy Few")) {
          throw new Error("kopie lijkt niet de bandsite te zijn");
        }
        if (html.length < 100000) {
          throw new Error("kopie is verdacht klein (" + Math.round(html.length / 1024) + " kB)");
        }

        await db.doc(taal.doc).set({
          html: html,
          taal: taal.code,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          sizeKb: Math.round(html.length / 1024),
        });
        resultaten.push({ taal: taal.code, sizeKb: Math.round(html.length / 1024) });
      } finally {
        await page.close().catch(() => {});
      }
    }

    await browser.close();
    browser = null;
    return {
      sizeKb: resultaten.length ? resultaten[0].sizeKb : 0,
      talen: resultaten,
    };
  } finally {
    if (browser) { try { await browser.close(); } catch (e) {} }
  }
}

exports.makeSnapshot = onCall(
  { memory: "1GiB", timeoutSeconds: 120, region: "europe-west1" },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Je moet ingelogd zijn om een snapshot te maken.");
    }
    try {
      const uitkomst = await maakEnBewaarSnapshot();
      await db.doc(WIJZIGING_DOC).set({ openstaandeWijzigingSinds: null }, { merge: true });
      return { success: true, sizeKb: uitkomst.sizeKb, message: "Snapshot gemaakt en live gezet." };
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      throw new HttpsError("internal", "Snapshot mislukt: " + err.message);
    }
  }
);

// ══════════════════════════════════════════════════════════════════════════
//  De website automatisch bijwerken
//
//  De homepage wordt geserveerd uit een opgeslagen kopie. Wie iets wijzigde
//  en daarna de knop "Snapshot maken" vergat, zag zijn wijziging niet terug
//  op de site — en Google al helemaal niet. Dat hoeft nu niet meer.
//
//  Werkt in twee stappen:
//   1. Elke wijziging in de inhoud noteert alleen het tijdstip.
//   2. Elke vijf minuten kijkt een controle of er iets openstaat dat al even
//      rustig ligt; pas dan wordt de kopie opnieuw gemaakt.
//
//  Die tussenstap is er zodat tien wijzigingen achter elkaar één keer werk
//  opleveren in plaats van tien keer.
// ══════════════════════════════════════════════════════════════════════════

exports.merkWijzigingOp = onDocumentWritten(
  { document: "{collectie}/{document}", region: "europe-west1" },
  async (event) => {
    const collectie = event.params.collectie;
    if (!HOMEPAGE_COLLECTIES.includes(collectie)) return;
    if (NIET_MELDEN.includes(collectie + "/" + event.params.document)) return;
    await db.doc(WIJZIGING_DOC).set({
      openstaandeWijzigingSinds: admin.firestore.FieldValue.serverTimestamp(),
      laatsteCollectie: collectie,
    }, { merge: true });
  }
);

exports.werkWebsiteBij = onSchedule(
  {
    schedule: "every 5 minutes",
    timeZone: "Europe/Amsterdam",
    region: "europe-west1",
    memory: "1GiB",
    timeoutSeconds: 180,
  },
  async () => {
    const status = await db.doc(WIJZIGING_DOC).get();
    const sinds = status.exists ? status.data().openstaandeWijzigingSinds : null;
    if (!sinds) return;                                   // niets gewijzigd

    const verstreken = Date.now() - sinds.toMillis();
    if (verstreken < RUSTPERIODE_MS) return;              // nog druk bezig, later

    try {
      const uitkomst = await maakEnBewaarSnapshot();
      await db.doc(WIJZIGING_DOC).set({
        openstaandeWijzigingSinds: null,
        laatsteAutomatischeUpdate: admin.firestore.FieldValue.serverTimestamp(),
        laatsteFout: null,
      }, { merge: true });
      console.log("Website automatisch bijgewerkt, " + uitkomst.sizeKb + " kB.");
    } catch (err) {
      // Het openstaande vlaggetje blijft staan, zodat het over vijf minuten
      // opnieuw geprobeerd wordt.
      await db.doc(WIJZIGING_DOC).set({
        laatsteFout: String(err.message).slice(0, 500),
        laatsteFoutOp: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      console.error("Automatisch bijwerken mislukt:", err);
    }
  }
);

// Onthoudt de ingepakte versie zolang deze instantie leeft, zodat dezelfde
// snapshot niet bij elk bezoek opnieuw ingepakt hoeft te worden.
const ingepakteCache = new Map();   // taalcode -> { bron, gzip }

function pakIn(taalcode, html) {
  const eerder = ingepakteCache.get(taalcode);
  if (eerder && eerder.bron === html) return eerder.gzip;
  const gzip = zlib.gzipSync(Buffer.from(html, "utf8"), { level: 6 });
  ingepakteCache.set(taalcode, { bron: html, gzip });
  return gzip;
}

exports.serveSnapshot = onRequest(
  { memory: "256MiB", region: "europe-west1", invoker: "public" },
  async (req, res) => {
    try {
      // Welke taalversie hoort bij dit adres?
      const pad = (req.path || "/").toLowerCase();
      const taal = TALEN.find((t) => t.code !== "nl" && (pad === t.pad || pad === "/" + t.code))
                || TALEN[0];

      const snap = await db.doc(taal.doc).get();
      if (snap.exists && snap.data().html) {
        const html = snap.data().html;
        res.set("Content-Type", "text/html; charset=utf-8");
        res.set("Cache-Control", "public, max-age=300, s-maxage=300");
        res.set("Vary", "Accept-Encoding");

        // De homepage is ongeveer 270 kB aan tekst. Firebase Hosting pakt
        // gewone bestanden vanzelf in, maar niet wat via een functie komt.
        // Zonder dit downloadt elke bezoeker die 270 kB helemaal; ingepakt
        // is het ruwweg een zesde daarvan.
        const accepteert = String(req.headers["accept-encoding"] || "");
        if (/\bgzip\b/.test(accepteert)) {
          res.set("Content-Encoding", "gzip");
          res.status(200).send(pakIn(taal.code, html));
        } else {
          res.status(200).send(html);
        }
        return;
      }
      // Nog geen kopie voor deze taal: toon de live pagina in die taal.
      res.redirect(302, "/app.html?taal=" + taal.code);
    } catch (err) {
      res.redirect(302, "/app.html?taal=nl");
    }
  }
);

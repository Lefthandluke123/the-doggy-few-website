const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const chromium = require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");
const zlib = require("zlib");

admin.initializeApp();
const db = admin.firestore();

const HOMEPAGE_URL = "https://the-doggy-few.web.app/app.html?live=1";
const SNAPSHOT_DOC = "settings/snapshot";

exports.makeSnapshot = onCall(
  { memory: "1GiB", timeoutSeconds: 120, region: "europe-west1" },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Je moet ingelogd zijn om een snapshot te maken.");
    }
    let browser;
    try {
      browser = await puppeteer.launch({
        args: chromium.args,
        defaultViewport: { width: 1280, height: 900 },
        executablePath: await chromium.executablePath(),
        headless: true,
      });
      const page = await browser.newPage();
      await page.goto(HOMEPAGE_URL, { waitUntil: "networkidle2", timeout: 45000 });
      await page.waitForFunction(
        () => {
          if (document.documentElement.getAttribute("data-hydrated") !== "true") return false;
          const ids = ["gigsContainer", "blogContainer", "membersContainer", "photosContainer", "videosContainer"];
          return ids.every((id) => { const el = document.getElementById(id); return el && el.children.length > 0; });
        },
        { timeout: 30000 }
      ).catch(() => {});
      await new Promise((r) => setTimeout(r, 2000));
      const html = await page.evaluate(() => {
        document.documentElement.setAttribute("data-snapshot", "true");
        return "<!DOCTYPE html>\n" + document.documentElement.outerHTML;
      });
      await browser.close();
      browser = null;
      if (!html.includes("Celtic Folk Band")) {
        throw new HttpsError("internal", "De gegenereerde snapshot lijkt niet de bandsite te zijn. Niet opgeslagen.");
      }
      await db.doc(SNAPSHOT_DOC).set({
        html: html,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        sizeKb: Math.round(html.length / 1024),
      });
      return { success: true, sizeKb: Math.round(html.length / 1024), message: "Snapshot gemaakt en live gezet." };
    } catch (err) {
      if (browser) { try { await browser.close(); } catch (e) {} }
      if (err instanceof HttpsError) throw err;
      throw new HttpsError("internal", "Snapshot mislukt: " + err.message);
    }
  }
);

// Onthoudt de ingepakte versie zolang deze instantie leeft, zodat dezelfde
// snapshot niet bij elk bezoek opnieuw ingepakt hoeft te worden.
let ingepakteCache = { bron: null, gzip: null };

function pakIn(html) {
  if (ingepakteCache.bron === html && ingepakteCache.gzip) return ingepakteCache.gzip;
  const gzip = zlib.gzipSync(Buffer.from(html, "utf8"), { level: 6 });
  ingepakteCache = { bron: html, gzip };
  return gzip;
}

exports.serveSnapshot = onRequest(
  { memory: "256MiB", region: "europe-west1", invoker: "public" },
  async (req, res) => {
    try {
      const snap = await db.doc(SNAPSHOT_DOC).get();
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
          res.status(200).send(pakIn(html));
        } else {
          res.status(200).send(html);
        }
        return;
      }
      res.redirect(302, "/app.html?live=1");
    } catch (err) {
      res.redirect(302, "/app.html?live=1");
    }
  }
);

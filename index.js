#!/usr/bin/env node
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import arg from "arg";
import chalk from "chalk";
import Table from "cli-table3";
import pLimit from "p-limit";
import { chromium, firefox, webkit } from "playwright";
import { input, confirm, password as promptPassword } from "@inquirer/prompts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = arg({
  "--url": String,
  "--users": String,
  "--browser": String,         // chromium | firefox | webkit
  "--headless": Boolean,       // OFF по умолчанию
  "--concurrency": Number,     // параллельные сессии
  "--timeout": Number,         // мс до таймаута подключения
  "--keep-open": Boolean,      // держать окна открытыми (дефолт ON)
  "--no-audio": Boolean,       // не просить доступ к устройствам (диагностика)
  "--auto-join-audio": Boolean,// авто-нажатие "Join Audio by Computer" (дефолт ON)
  "--enforce-mute": Boolean,   // гарантировать mute/cam-off (дефолт ON)
  "--profile-root": String,    // корневая папка профилей, дефолт ~/.zoom-multi/profiles
  "-u": "--url",
  "-f": "--users",
  "-b": "--browser",
  "-h": "--headless",
  "-c": "--concurrency",
  "-t": "--timeout"
});

const CONFIG = {
  url: args["--url"] || "",
  usersPath: args["--users"] || path.join(__dirname, "users.txt"),
  browser: (args["--browser"] || "chromium").toLowerCase(),
  headless: !!args["--headless"],
  concurrency: args["--concurrency"] || 4,
  connectTimeoutMs: args["--timeout"] || 120_000,
  keepOpen: args["--keep-open"] !== undefined ? !!args["--keep-open"] : true,
  noAudio: !!args["--no-audio"],
  autoJoinAudio: args["--auto-join-audio"] !== undefined ? !!args["--auto-join-audio"] : true,
  enforceMute: args["--enforce-mute"] !== undefined ? !!args["--enforce-mute"] : true,
  profileRoot: args["--profile-root"] || path.join(os.homedir(), ".zoom-multi", "profiles")
};

const BROWSERS = { chromium, firefox, webkit };

// ----- глобальная блокировка перерисовки и мьютекс пароля -----
let redrawEnabled = true;
function setRedrawEnabled(v) { redrawEnabled = v; }
let passwordPromise = null;
let sharedPassword = undefined;
let askedPassword = false;

function die(msg) {
  console.error(chalk.red("✖ " + msg));
  process.exit(1);
}

function now() {
  const d = new Date();
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

function printHeader() {
  console.log(chalk.bold.cyan("\nZoom Multi-Join CLI"));
  console.log(chalk.gray(`Time: ${now()}`));
  console.log(chalk.gray(`Browser: ${CONFIG.browser}, headless=${CONFIG.headless}, concurrency=${CONFIG.concurrency}`));
  console.log(chalk.gray(`keepOpen=${CONFIG.keepOpen}, autoJoinAudio=${CONFIG.autoJoinAudio}, enforceMute=${CONFIG.enforceMute}`));
  console.log(chalk.gray(`Profiles: ${CONFIG.profileRoot}\n`));
}

function readUsers(file) {
  if (!fs.existsSync(file)) die(`Не найден файл пользователей: ${file}`);
  const raw = fs.readFileSync(file, "utf-8");
  const users = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (users.length === 0) die("Файл users.txt пуст.");
  return users;
}

const State = {
  INIT: "INIT",
  PASSWORD_REQUIRED: "PASSWORD_REQUIRED",
  CONNECTING: "CONNECTING",
  WAITING_ROOM: "WAITING_ROOM",
  HOST_NOT_STARTED: "HOST_NOT_STARTED",
  IN_MEETING: "IN_MEETING",
  ENDED_BY_HOST: "ENDED_BY_HOST",
  FAILED: "FAILED"
};

function statusColor(s) {
  switch (s) {
    case State.IN_MEETING: return chalk.green(s + " (OK)");
    case State.WAITING_ROOM: return chalk.yellow(s);
    case State.CONNECTING: return chalk.cyan(s);
    case State.PASSWORD_REQUIRED: return chalk.magenta(s);
    case State.HOST_NOT_STARTED: return chalk.yellow(s);
    case State.ENDED_BY_HOST: return chalk.gray(s);
    case State.FAILED: return chalk.red(s);
    default: return s;
  }
}

function sanitizeName(n) {
  return n.replace(/[^\p{L}\p{N}\s#\-\._]/gu, "").slice(0, 64).trim() || "Participant";
}

function getBrowser() {
  const b = BROWSERS[CONFIG.browser];
  if (!b) die(`Неверный --browser: ${CONFIG.browser}. Используйте chromium|firefox|webkit.`);
  return b;
}

function extractMeetingIdFromUrl(url) {
  const m = url.match(/\/j\/(\d+)/);
  return m ? m[1] : null;
}

function hasPwdInUrl(url) {
  return /[?&]pwd=/.test(url);
}

async function ensureUrl() {
  if (CONFIG.url) return;
  const u = await input({ message: "Вставьте Zoom-ссылку:" });
  CONFIG.url = u.trim();
  if (!/^https?:\/\/.+zoom\.us\/j\/\d+/.test(CONFIG.url)) {
    die("Похоже, это не валидная Zoom-ссылка формата https://*.zoom.us/j/<meetingId>");
  }
}

function ensureProfileDirFor(userName) {
  const dir = path.join(CONFIG.profileRoot, userName.replace(/\s+/g, "_"));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function printTable(statusMap) {
  if (!redrawEnabled) return;
  const table = new Table({
    head: [chalk.white("User"), chalk.white("Status"), chalk.white("Details")],
    wordWrap: true,
    colWidths: [28, 24, 60]
  });
  for (const [user, info] of statusMap.entries()) {
    table.push([chalk.bold(user), statusColor(info.state), info.detail || ""]);
  }
  console.clear();
  printHeader();
  console.log(table.toString());
}

// ---------- безопасное чтение текста ----------
async function safeBodyText(page) {
  try {
    return await page.evaluate(() => {
      try {
        const d = globalThis.document;
        if (!d || !d.body) return "";
        return d.body.innerText || d.body.textContent || "";
      } catch { return ""; }
    });
  } catch { return ""; }
}

// ---------- детект статуса ----------
async function detectState(page) {
  let url = "";
  try { url = page.url(); } catch { url = ""; }
  const bodyText = await safeBodyText(page);

  // явный DOM признака пароля
  try {
    if (await page.$('input#input-for-pwd') || await page.$('input[type="password"]')) {
      return State.PASSWORD_REQUIRED;
    }
  } catch {}

  if (await page.$('div[class="wr-information"]')) {
    return State.WAITING_ROOM;
  }
  if (/Joining|Connecting|Идёт подключение|Launch Meeting/i.test(bodyText)) {
    return State.CONNECTING;
  }
  if (/has ended|ended by host|Meeting has ended|Эта конференция завершена организатором/i.test(bodyText)) {
    return State.ENDED_BY_HOST;
  }

  try {
    const inMeeting =
      (await page.$('button:has-text("Leave")')) ||
      (await page.$('button[aria-label*="Leave"]')) ||
      (await page.$('div[role="toolbar"]')) ||
      (await page.$('video'));
    if (inMeeting) return State.IN_MEETING;
  } catch {}

  if (/\/wc\/\d+\/join/.test(url)) return State.CONNECTING;
  if (/\/wc\/\d+\/waiting/.test(url)) return State.WAITING_ROOM;

  return State.CONNECTING;
}

// ---------- согласие / cookie ----------
async function clickIfExists(scope, selectors) {
  for (const sel of selectors) {
    try {
      const el = await scope.$(sel);
      if (el) { await el.click().catch(() => {}); return true; }
    } catch {}
  }
  return false;
}
async function clickConsentByText(scope) {
  const texts = [
    'button:has-text("I agree")','button:has-text("Agree")','button:has-text("I AGREE")',
    'button:has-text("Я согласен")','button:has-text("Согласен")','button:has-text("Принять")',
    'button:has-text("Accept")','button:has-text("Allow")',
    'button[aria-label*="Agree"]','button[aria-label*="Принять"]',
    'a:has-text("I agree")','a:has-text("Принять")','a:has-text("Agree")'
  ];
  return clickIfExists(scope, texts);
}
async function handleConsentAndCookies(page, maxPasses = 5) {
  for (let pass = 0; pass < maxPasses; pass++) {
    let clicked = false;
    try { clicked = (await clickConsentByText(page)) || clicked; } catch {}
    if (!clicked) {
      for (const frame of page.frames()) {
        try { if (await clickConsentByText(frame)) { clicked = true; break; } } catch {}
      }
    }
    if (clicked) { await page.waitForTimeout(500); continue; }
    break;
  }
}

// ---------- гарантировать mic/cam off ----------
async function enforceMuteVideo(page) {
  try {
    const muteBtn = await page.$('button[aria-label="Выключить звук"], button[aria-label="mute my microphone"]');
    if (muteBtn) await muteBtn.click().catch(() => {});
  } catch {}
  try {
    const stopVideoBtn = await page.$('button[aria-label="Остановить показ видеоизображения"], button[aria-label="stop my video"]');
    if (stopVideoBtn) await stopVideoBtn.click().catch(() => {});
  } catch {}
}

// ---------- единый запрос пароля (с блокировкой UI) ----------
async function askPasswordOnce() {
  if (askedPassword) return sharedPassword;
  if (!passwordPromise) {
    passwordPromise = (async () => {
      setRedrawEnabled(false);
      console.log(chalk.magenta("\nПароль требуется для входа в конференцию (будет применён ко всем участникам):"));
      const pwd = await promptPassword({
        message: "Введите пароль:",
        mask: "•",
        validate: (v) => v && v.trim().length > 0 ? true : "Пароль не может быть пустым"
      });
      sharedPassword = pwd;
      askedPassword = true;
      setRedrawEnabled(true);
      return pwd;
    })();
  }
  return passwordPromise;
}

// ---------- одно подключение с live-апдейтами ----------
async function joinOne(browserType, baseUrl, userName, onStatus) {
  const result = { user: userName, state: State.INIT, detail: "" };
  const userDataDir = ensureProfileDirFor(userName);

  const launchArgs = [
    "--allow-http-screen-capture",
    "--autoplay-policy=no-user-gesture-required",
    ...(CONFIG.headless ? ["--use-fake-device-for-media-stream"] : []),
    "--use-fake-ui-for-media-stream"
  ];

  const context = await browserType.launchPersistentContext(userDataDir, {
    headless: CONFIG.headless,
    args: launchArgs,
    viewport: { width: 1280, height: 800 }
  });

  const page = await context.newPage();

  const origin = (() => { try { return new URL(baseUrl).origin; } catch { return "https://zoom.us"; }})();
  if (!CONFIG.noAudio) {
    await context.grantPermissions(["microphone", "camera"], { origin }).catch(() => {});
  }

  let url = baseUrl;
  if (/\/j\/\d+/.test(baseUrl) && !/\/wc\/\d+\/join/.test(baseUrl)) {
    const id = extractMeetingIdFromUrl(baseUrl);
    const u = new URL(baseUrl);
    const pwd = u.searchParams.get("pwd");
    url = `${u.origin}/wc/${id}/join${pwd ? `?pwd=${encodeURIComponent(pwd)}` : ""}`;
  }

  function setStatus(state, detail) {
    if (state) result.state = state;
    if (detail !== undefined) result.detail = detail;
    onStatus?.(userName, result.state, result.detail);
  }
  // сразу отрисуем INIT
  setStatus(State.INIT, "Открываю страницу…");

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  } catch (e) {
    setStatus(State.FAILED, `Не удалось открыть страницу: ${e.message}`);
    if (!CONFIG.keepOpen) await context.close().catch(() => {});
    return { ...result, _context: CONFIG.keepOpen ? context : undefined };
  }

  await handleConsentAndCookies(page).catch(() => {});
  setStatus(State.CONNECTING, "Загружается веб-клиент…");

  const deadline = Date.now() + CONFIG.connectTimeoutMs;
  let nameSubmitted = false;
  let passwordSubmitted = false;
  let inMeetingSince = 0;

  async function update() {
    try {
      const currentUrl = page.url();
      if (currentUrl === "about:blank") {
        await page.waitForLoadState("domcontentloaded", { timeout: 2000 }).catch(() => {});
      }
    } catch {}
    await handleConsentAndCookies(page).catch(() => {});
    const newState = await detectState(page);
    if (newState !== result.state) setStatus(newState, result.detail);
    return newState;
  }

  while (Date.now() < deadline) {
    const st = await update();

    // Имя
    if (!nameSubmitted) {
      try {
        const nameInput =
          await page.$('input[name="inputname"]') ||
          await page.$('input#input-for-name') ||
          await page.$('input[aria-label*="Your Name"], input[placeholder*="Your Name"], input[placeholder*="Ваше имя"]');
        if (nameInput) {
          await nameInput.fill(sanitizeName(userName));
          nameSubmitted = true;
          setStatus(result.state, "Имя введено");
        }
      } catch {}
    }

    // Пароль
    if (st === State.PASSWORD_REQUIRED && !passwordSubmitted) {
      try {
        const passInput =
          await page.$('input[type="password"]') ||
          await page.$('input#input-for-pwd');
        if (passInput) {
          setStatus(State.PASSWORD_REQUIRED, "Требуется пароль, жду ввод…");
          const pwd = await askPasswordOnce();
          await passInput.fill(pwd);
          if (CONFIG.enforceMute) { await enforceMuteVideo(page).catch(() => {}); }
          const submitBtn =
            await page.$('button[type="submit"]') ||
            await page.$('button:has-text("Join")') ||
            await page.$('button:has-text("Войти")') ||
            await page.$('button:has-text("Присоединиться")');
          if (submitBtn) await submitBtn.click().catch(() => {});
          passwordSubmitted = true;
          setStatus(State.CONNECTING, "Пароль введён, подключаюсь…");
          await page.waitForTimeout(800);
        }
      } catch {}
    } else if (nameSubmitted && st !== State.PASSWORD_REQUIRED) {
        if (CONFIG.enforceMute) { await enforceMuteVideo(page).catch(() => {}); }
        try {
        const joinBtn =
          await page.$('button[type="submit"]') ||
          await page.$('button:has-text("Join")') ||
          await page.$('button:has-text("Войти")') ||
          await page.$('button:has-text("Присоединиться")');
        if (joinBtn) { await joinBtn.click().catch(() => {}); setStatus(State.CONNECTING, "Подключаюсь…"); }
      } catch {}
    }

    // Join from browser
    try {
      const jfb =
        await page.$('a:has-text("Join from Your Browser"), a:has-text("Join from your browser"), a:has-text("Join from Browser"), a:has-text("Присоединиться из браузера")');
      if (jfb) {
        await jfb.click().catch(() => {});
        setStatus(State.CONNECTING, "Открыл веб-клиент");
        await page.waitForTimeout(400);
      }
    } catch {}

    // Подключить аудио
    if (CONFIG.autoJoinAudio) {
      try {
        const joinAudioBtn =
          await page.$('button:has-text("Join Audio by Computer"), button:has-text("Join Audio"), button[aria-label*="Join Audio"]');
        if (joinAudioBtn) {
          await joinAudioBtn.click().catch(() => {});
          setStatus(result.state, "Аудио компьютера подключено");
          if (CONFIG.enforceMute) { await enforceMuteVideo(page).catch(() => {}); setStatus(result.state, "Микрофон/камера выключены"); }
        }
      } catch {}
    }

    // Состояния ожидания
    if (st === State.WAITING_ROOM) {
      setStatus(State.WAITING_ROOM, "Ожидание апрува организатора (Waiting Room)");
    } else if (st === State.HOST_NOT_STARTED) {
      setStatus(State.HOST_NOT_STARTED, "Организатор ещё не начал встречу");
    } else if (st === State.ENDED_BY_HOST) {
      setStatus(State.ENDED_BY_HOST, "Встреча завершена организатором");
      break;
    }

    // Внутри — удержание для «OK»
    if (st === State.IN_MEETING) {
      if (inMeetingSince === 0) inMeetingSince = Date.now();
      if (CONFIG.enforceMute) { await enforceMuteVideo(page).catch(() => {}); }
      const elapsed = (Date.now() - inMeetingSince) / 1000;
      setStatus(State.IN_MEETING, `Подключено (mic/cam OFF), удержание ${elapsed.toFixed(1)}s`);
    }

    await page.waitForTimeout(600);
  }

  // Финал
  const finalState = await detectState(page);
  if (finalState === State.IN_MEETING) {
    setStatus(State.IN_MEETING, "Подключено (OK)");
  } else if (finalState === State.CONNECTING) {
    setStatus(State.FAILED, result.detail || "Таймаут подключения");
  } else {
    setStatus(finalState, result.detail);
  }

  if (!CONFIG.keepOpen) {
    await context.close().catch(() => {});
  }
  return { ...result, _context: CONFIG.keepOpen ? context : undefined };
}

// ---------- main ----------
async function main() {
  printHeader();
  await ensureUrl();
  const users = readUsers(CONFIG.usersPath);

  console.log(chalk.white("Ссылка: "), CONFIG.url);
  console.log(chalk.white("Пользователей: "), users.length);
  console.log(chalk.white("Файл имён: "), CONFIG.usersPath);
  console.log(chalk.white("keepOpen: "), CONFIG.keepOpen ? "ON" : "OFF");
  console.log(chalk.white("headless: "), CONFIG.headless ? "ON" : "OFF");
  console.log("");

  const proceed = await confirm({ message: "Стартуем подключение для всех?", default: true });
  if (!proceed) process.exit(0);

  const browserType = getBrowser();

  const statusMap = new Map(users.map(u => [u, { state: State.INIT, detail: "В очереди" }]));
  function onStatus(user, state, detail) {
    statusMap.set(user, { state, detail });
    printTable(statusMap);
  }
  printTable(statusMap);

  const limit = pLimit(CONFIG.concurrency);
  const contexts = [];
  const tasks = users.map(user => limit(async () => {
    const res = await joinOne(browserType, CONFIG.url, user, onStatus);
    // финальная синхронизация (на случай, если последние апдейты не успели прорисоваться)
    onStatus(user, res.state, res.detail);
    if (CONFIG.keepOpen && res._context) contexts.push(res._context);
    return res;
  }));

  // периодическая подстраховка перерисовки (можно убрать, но пусть будет)
  const ticker = setInterval(() => printTable(statusMap), 3000);

  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(ticker);
    for (const ctx of contexts) { try { await ctx.close(); } catch {} }
    process.exit(0);
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    const results = await Promise.all(tasks);
    clearInterval(ticker);
    printTable(statusMap);

    const ok = results.filter(r => r.state === State.IN_MEETING).length;
    const waiting = results.filter(r => r.state === State.WAITING_ROOM).length;

    console.log("\n" + chalk.bold("Итог:"));
    console.log(chalk.green(`  OK (внутри встречи): ${ok}`));
    console.log(chalk.yellow(`  Ожидают апрув:      ${waiting}`));
    console.log(chalk.white(`  Прочие статусы:     ${results.length - ok - waiting}\n`));

    if (!CONFIG.keepOpen) {
      process.exit(0);
    } else {
      console.log(chalk.gray("Сессии оставлены открытыми. Нажми Ctrl+C, чтобы завершить и закрыть всех участников."));
      while (true) await new Promise(r => setTimeout(r, 10000));
    }
  } catch (e) {
    clearInterval(ticker);
    die(`Неожиданная ошибка: ${e.message}`);
  }
}

main().catch(e => die(e.message));

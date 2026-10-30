/**
 * Приёмник событий приглашения для статического хостинга (GitHub Pages).
 *
 * Что делает:
 *  - doPost  — принимает событие от index.html и пишет строку в Google Таблицу
 *  - doGet   — отдаёт админке JSON со списком событий (?action=list) или чистит ленту (?action=reset)
 *
 * Установка (5 минут, без сервера и без карты):
 *  1. Открыть script.google.com → New project → вставить этот файл целиком.
 *  2. Вписать ADMIN_KEY ниже (любая длинная строка) — она попадёт в ссылку админки.
 *     SHEET_ID можно оставить пустым: скрипт сам создаст таблицу "date-events"
 *     на твоём Диске при первом событии и запомнит её ID в свойствах скрипта.
 *     Если хочешь свою таблицу — вставь её ID из URL:
 *     https://docs.google.com/spreadsheets/d/<ЭТОТ_ID>/edit
 *  3. Deploy → New deployment → тип "Web app":
 *       Execute as: Me
 *       Who has access: Anyone
 *     Скопировать URL вида https://script.google.com/macros/s/AKfy.../exec
 *  4. Проверка: открыть <URL>?key=<ADMIN_KEY>&action=ping — должен прийти {"ok":true,"pong":true}
 *  5. Этот URL вписать в admin.html: ?api=<URL>&key=<ADMIN_KEY>
 */

var SHEET_ID   = '';                  // пусто = создать таблицу автоматически
var SHEET_NAME = 'events';
var ADMIN_KEY  = 'dt-7f3a91c4e2b85d60'; // ключ доступа к админке (doGet)
var MAX_ROWS   = 5000;

/* Секрет для записи событий. Пусто = принимаем всех.
   Если задать — index.html должен слать его в поле "k", иначе doPost ответит 403.
   Зачем: URL /exec публичный, без секрета любой желающий может писать в таблицу. */
var POST_KEY   = '';

var PROP_SHEET_ID = 'SHEET_ID';

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (POST_KEY && String(body.k || '') !== POST_KEY) {
      return json({ ok: false, error: 'forbidden' });
    }
    var type = String(body.type || '').slice(0, 40);
    if (!type) return json({ ok: false, error: 'no type' });
    if (type === 'visit') body.note = body.note || 'открыла приглашение';

    var sheet = getSheet();
    sheet.appendRow([
      new Date(),
      type,
      String(body.session || '').slice(0, 64),
      String(body.place || '').slice(0, 200),
      String(body.when || '').slice(0, 120),
      String(body.note || '').slice(0, 300),
      String((e && e.parameter && e.parameter.ua) || '').slice(0, 200)
    ]);
    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  var cb = String(p.callback || '');

  /* JSONP: админка на GitHub Pages не может читать ответ через fetch —
     Google не отдаёт CORS-заголовки на preflight. <script src> CORS не подчиняется,
     поэтому при наличии callback оборачиваем JSON в вызов функции. */
  function out(obj) {
    if (cb && /^[A-Za-z_$][\w$.]{0,80}$/.test(cb)) {
      return ContentService
        .createTextOutput(cb + '(' + JSON.stringify(obj) + ');')
        .setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    return json(obj);
  }

  if (!ADMIN_KEY || String(p.key || '') !== ADMIN_KEY) return out({ ok: false, error: 'forbidden' });

  /* action=ping — проверка связи из админки: не трогает таблицу, отвечает быстро */
  if (p.action === 'ping') return out({ ok: true, pong: true, ts: Date.now() });

  var sheet = getSheet();

  if (p.action === 'reset') {
    var last = sheet.getLastRow();
    if (last > 1) sheet.deleteRows(2, last - 1);
    return out({ ok: true, events: [] });
  }

  var values = sheet.getDataRange().getValues();
  var events = [];
  for (var i = 1; i < values.length; i++) {
    var r = values[i];
    if (!r[1]) continue;
    var ts = r[0] instanceof Date ? r[0].getTime() : new Date(r[0]).getTime();
    if (!isFinite(ts)) ts = Date.now();
    events.push({
      id: 'r' + i,
      ts: ts,
      type: String(r[1]),
      session: String(r[2] || ''),
      place: String(r[3] || ''),
      when: String(r[4] || ''),
      note: String(r[5] || '')
    });
  }
  if (events.length > MAX_ROWS) events = events.slice(-MAX_ROWS);
  return out({ ok: true, source: 'sheets', total: events.length, events: events });
}

/* Возвращает лист событий. Если SHEET_ID не задан — создаёт таблицу один раз
   и запоминает её ID в свойствах скрипта, чтобы не плодить копии. */
function getSheet() {
  var id = SHEET_ID || PropertiesService.getScriptProperties().getProperty(PROP_SHEET_ID);
  var ss = null;

  if (id) {
    try {
      ss = SpreadsheetApp.openById(id);
    } catch (err) {
      ss = null; // таблицу удалили или нет доступа — создадим новую
    }
  }

  if (!ss) {
    ss = SpreadsheetApp.create('date-events');
    PropertiesService.getScriptProperties().setProperty(PROP_SHEET_ID, ss.getId());
  }

  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(['Время', 'Событие', 'Сессия', 'Место', 'Когда', 'Заметка', 'UA']);
  }
  return sheet;
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* Проверка после деплоя: открой в браузере
   <URL>?key=<ADMIN_KEY>&action=ping — должен прийти JSON {"ok":true,"pong":true}.
   Если приходит HTML страницы входа Google — в деплое стоит доступ «Anyone with Google account»,
   нужно «Anyone». */

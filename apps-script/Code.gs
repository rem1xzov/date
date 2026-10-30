/**
 * Приёмник событий приглашения для статического хостинга (GitHub Pages).
 *
 * Что делает:
 *  - doPost  — принимает событие от index.html и пишет строку в Google Таблицу
 *  - doGet   — отдаёт админке JSON со списком событий (?action=list) или чистит ленту (?action=reset)
 *
 * Установка (5 минут, без сервера и без карты):
 *  1. Создать таблицу на drive.google.com — из её URL взять ID:
 *     https://docs.google.com/spreadsheets/d/<ЭТОТ_ID>/edit
 *  2. Открыть script.google.com → New project → вставить этот файл целиком.
 *  3. Вписать SHEET_ID и ADMIN_KEY ниже.
 *  4. Deploy → New deployment → тип "Web app":
 *       Execute as: Me
 *       Who has access: Anyone
 *     Скопировать URL вида https://script.google.com/macros/s/AKfy.../exec
 *  5. Этот URL вписать в index.html: <meta name="track-endpoint" content="URL">
 *     и в admin.html: const API = 'URL';
 */

var SHEET_ID  = 'ВСТАВЬ_ID_ТАБЛИЦЫ';
var SHEET_NAME = 'events';
var ADMIN_KEY = 'ВСТАВЬ_СВОЙ_КЛЮЧ';   // придумай длинную строку — она попадёт в ссылку админки
var MAX_ROWS  = 5000;

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var type = String(body.type || '').slice(0, 40);
    if (!type) return json({ ok: false, error: 'no type' });

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
  if (String(p.key || '') !== ADMIN_KEY) return json({ ok: false, error: 'forbidden' });

  var sheet = getSheet();

  if (p.action === 'reset') {
    var last = sheet.getLastRow();
    if (last > 1) sheet.deleteRows(2, last - 1);
    return json({ ok: true, events: [] });
  }

  var values = sheet.getDataRange().getValues();
  var events = [];
  for (var i = 1; i < values.length; i++) {
    var r = values[i];
    if (!r[1]) continue;
    events.push({
      id: 'r' + i,
      ts: r[0] instanceof Date ? r[0].getTime() : new Date(r[0]).getTime(),
      type: String(r[1]),
      session: String(r[2] || ''),
      place: String(r[3] || ''),
      when: String(r[4] || ''),
      note: String(r[5] || '')
    });
  }
  if (events.length > MAX_ROWS) events = events.slice(-MAX_ROWS);
  return json({ ok: true, events: events });
}

function getSheet() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
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

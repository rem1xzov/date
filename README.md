# Приглашение на свидание + админка

Две страницы и один сервер:

| Файл | Что это |
|---|---|
| `index.html` | приглашение, которое открывает она |
| `admin.html` | админка: кто нажал, что выбрал, во сколько |
| `server.js` | сервер: статика + приём событий + лента + live-поток |
| `apps-script/Code.gs` | приёмник для GitHub Pages (Google Таблица вместо БД) |

## Быстрый старт (локально, с PostgreSQL)

```powershell
npm install
$env:DATABASE_URL='postgresql://postgres:ПАРОЛЬ@127.0.0.1:5432/date_invite'
node server.js
```

- приглашение — http://localhost:8099/
- админка — http://localhost:8099/admin

Таблицу сервер создаёт сам при старте (`CREATE TABLE IF NOT EXISTS events`).
Если `DATABASE_URL` не задан — события пишутся в `data/events.jsonl`, как раньше.

## Переменные окружения

| Переменная | По умолчанию | Смысл |
|---|---|---|
| `PORT` | `8099` | порт |
| `HOST` | `0.0.0.0` | интерфейс |
| `DATABASE_URL` | — | строка подключения PostgreSQL; без неё — файл |
| `PGSSL` | — | `1` для облачных баз (Neon, Supabase, Render) |
| `ADMIN_TOKEN` | — | если задан, лента и очистка требуют `?token=…` |

## Схема таблицы

```sql
CREATE TABLE events (
  id          BIGSERIAL PRIMARY KEY,
  session     TEXT        NOT NULL,
  type        TEXT        NOT NULL,
  place       TEXT,
  when_at     TEXT,
  ua          TEXT,
  ip          TEXT,
  data        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## Облачная база (если ПК выключен)

1. Зарегистрироваться на neon.tech (free tier) → создать проект → скопировать
   `Connection string` вида `postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require`.
2. Запустить сервер с этой строкой и `PGSSL=1`:

```powershell
$env:DATABASE_URL='postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require'
$env:PGSSL='1'
node server.js
```

3. Чтобы ссылка была доступна ей без твоего ПК, сервер надо держать на хостинге
   с Node (Render, Railway, Fly.io) — GitHub Pages для этого не подходит:
   он раздаёт только статику, `/api/*` там не работает.

## GitHub Pages (без сервера)

Pages умеет только статику, поэтому события принимает Google Apps Script:

1. Создать таблицу на drive.google.com, взять её ID из URL.
2. script.google.com → New project → вставить `apps-script/Code.gs`,
   заполнить `SHEET_ID` и `ADMIN_KEY`.
3. Deploy → New deployment → Web app: Execute as **Me**, access **Anyone**.
4. URL `…/exec` вписать в `index.html` и `admin.html` в
   `<meta name="track-endpoint" content="…">`.
5. Админка открывается как `admin.html?key=ТВОЙ_КЛЮЧ`.

## API

| Метод | Путь | Что делает |
|---|---|---|
| `POST` | `/api/event` | принять событие `{type, session, place?, when?}` |
| `GET` | `/api/events?limit=200` | последние события (JSON) |
| `GET` | `/api/stream` | SSE-поток новых событий |
| `POST` | `/api/reset` | очистить ленту |

Типы событий: `visit`, `yes`, `no`, `place`, `custom_place`, `when`, `final`, `modal_close`.

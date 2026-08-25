# Проверка окружения

Снято до начала работы, одной командой в каждом окружении. Вывод приведён целиком,
без правок. Используется как фактическая база для раздела «Изоляция» в отчёте.

**Дата снятия:** 2026-08-25, 11:02 UTC (14:02 MSK)

---

## Окружение 1 — локальная машина (`desktop-i6ngvep`)

Рабочее окружение: здесь лежит репозиторий и здесь будет собираться приложение.

```
=== ENV CHECK · device (desktop-i6ngvep) · 2026-08-25T11:02:35Z ===
--- node --version
v22.23.2
exit=0
--- git --version
git version 2.34.1
exit=0
--- npm ping
npm notice PING https://registry.npmjs.org/
npm error code E403
npm error 403 403 Forbidden - GET https://registry.npmjs.org/-/ping
npm error 403 In most cases, you or one of your dependencies are requesting
npm error 403 a package version that is forbidden by your security policy, or
npm error 403 on a server you do not have access to.
exit=1
--- curl registry.npmjs.org
curl: (56) Received HTTP code 403 from proxy after CONNECT
000
exit=56
--- npx --no-install playwright --version
npm error code E403
npm error 403 403 Forbidden - GET https://registry.npmjs.org/playwright
npm error 403 In most cases, you or one of your dependencies are requesting
npm error 403 a package version that is forbidden by your security policy, or
npm error 403 on a server you do not have access to.
exit=1
```

## Окружение 2 — облачный контейнер сессии

Изолированное окружение агента. Приведено для сравнения границ.

```
=== ENV CHECK · cloud container · 2026-08-25T11:02:44Z ===
--- node --version
v22.22.2
exit=0
--- git --version
git version 2.43.0
exit=0
--- npm ping
npm notice PING https://registry.npmjs.org/
npm error code E403
npm error 403 403 Forbidden - GET https://registry.npmjs.org/-/ping
npm error 403 In most cases, you or one of your dependencies are requesting
npm error 403 a package version that is forbidden by your security policy, or
npm error 403 on a server you do not have access to.
exit=1
--- curl registry.npmjs.org
403
exit=0
--- npx --no-install playwright --version
Version 1.56.0
exit=0
--- chromium (preinstalled)
chromium
chromium-1194
chromium_headless_shell-1194
ffmpeg-1011
```

---

## Что из этого следует

| Факт | Вывод |
|---|---|
| `node` и `git` есть в обоих окружениях | Локальная разработка и git-история не блокированы |
| `npm ping` → **E403** в обоих окружениях | Реестр пакетов **недоступен**. Установить что-либо через npm нельзя |
| `curl` на локальной машине → `HTTP 403 from proxy after CONNECT` | Отказ выдаёт **исходящий прокси**, а не сеть: соединение перехвачено на CONNECT |
| `curl` в контейнере → `403` без ошибки транспорта | Та же политика, но отказ приходит как ответ, а не как обрыв |
| `npx --no-install playwright` на локальной машине → E403 | **Playwright недоступен** там, где будет работать приложение |
| `npx --no-install playwright` в контейнере → `Version 1.56.0`, Chromium предустановлен | Playwright доступен **только** в облачном контейнере, из локального кеша, без обращения в реестр |

**Прямое следствие для плана работ:**

1. Никакой шаг не должен зависеть от `npm install`. Приложение и проверки собираются
   на том, что уже есть: Node.js без внешних зависимостей.
2. UI-проверки через Playwright возможны **только** в облачном контейнере, куда файлы
   надо переносить явно. Локально этот путь закрыт.
3. Отказ прокси на `CONNECT` — готовое доказательство границы изоляции: попытка выйти
   наружу зафиксирована и отклонена, вывод неудачной попытки сохранён выше.

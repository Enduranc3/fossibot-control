# Fossibot Hub

Неофіційний хаб для зарядної станції **Fossibot F1800**: працює на Android-смартфоні (Termux) поруч
зі станцією, збирає дані 24/7 і віддає веб-застосунок (PWA) для iPhone через Tailscale Funnel.

- `shared/` — кодек протоколу станції (див. [PROTOCOL.md](PROTOCOL.md)), спільний для хаба й сайту
- `hub/` — сервер: зв'язок зі станцією, історія (SQLite), API, вхід за паролем
- `tools/station-sim.ts` — симулятор станції для розробки без заліза; `tools/station_probe.py` — діагностика

Розробка: `npm install`, `npm test`, `npm run typecheck`.
Проєкт не пов'язаний із Fossibot.

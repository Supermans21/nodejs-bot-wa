# Bot WA (Supermans21/nodejs-bot-wa, branch main)
- Entry: index.js (Baileys v7, node:sqlite, Gemini AI). Runtime: Node 24 (panel nodejs_24).
- Login: PAIRING_NUMBER di .env (kode pairing di console). Tanpa itu QR.
- Port: app listen HTTP di 0.0.0.0:PORT (10003) lewat server http bawaan.
- Config: ENV_DEFAULTS di index.js + override tabel settings SQLite (auth/database.db).
- .env berisi OWNER, TARGET_NUMBER, TARGET_LID, PAIRING_NUMBER, GEMINI_API_KEY, GEMINI_MODEL, DB_RETENTION_DAYS. Jangan tampilkan nilainya. .env tidak ikut GitHub.
- AI Gemini: fetch ke generativelanguage.googleapis.com/v1/interactions (header x-goog-api-key). Di console sempat AI: OFF walau .env terisi; penyebab belum pasti.
- Keamanan review 20 Nov: tidak ada child_process/eval. process.exit saat logout (hapus ./auth) dan error fatal.
- Commit terakhir ditarik: 94b51f9 (pull 10:17).

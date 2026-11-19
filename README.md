# 🤖 Private WhatsApp Bot (Baileys v7 + Node.js Built-in SQLite + Gemini AI)

Bot WhatsApp pribadi yang ringan (hanya 5 dependency, tanpa Express & tanpa compile native `sqlite3`) dengan fitur *Couple Analytics*, *Memory Vault*, *AI Multimodal*, *Live Config* langsung dari chat WhatsApp, serta tombol darurat *Panic / Stealth Mode*.

---

## ⚙️ Kebutuhan Sistem (Best Practice Panel Bot)

* **Rekomendasi Utama:** **Node.js 24 LTS** (`24.x`) — mendukung penuh `node:sqlite`, native `fetch`, dan `baileys@7`.
* **Minimum:** **Node.js 22.13+** (`22 LTS`). *(Jika muncul warning Experimental SQLite di Node 22, jalankan dengan `node --no-warnings index.js`.)*
* **Tidak mendukung Node.js 18 / 20** (belum memiliki `node:sqlite`).

---

## 🚀 Cara Instalasi & Menjalankan

### 1. Install Dependency
```bash
git clone <url-repo-kamu>
cd nodejs-bot-wa
npm install
```

### 2. Konfigurasi `.env`
Salin file contoh lalu isi nomor Owner & Target:
```bash
cp .env.example .env
```

> **Login Tanpa QR (Cocok untuk Panel Bot):** Isi `PAIRING_NUMBER="628xxxxxxxxxx"` di `.env` — saat dijalankan, kode pairing `XXXX-XXXX` akan muncul di console. Jika `PAIRING_NUMBER` dikosongkan, bot otomatis menampilkan QR Code di terminal.

### 3. Jalankan Bot
* **Lokal / Bot Panel (Pterodactyl, dll.):**
  ```bash
  npm start
  ```
* **VPS dengan PM2:**
  ```bash
  pm2 start ecosystem.config.js
  pm2 save
  ```
* **Docker:**
  ```bash
  docker build -t bot-wa .
  docker run -d --name bot-wa --env-file .env -v $(pwd)/auth:/app/auth -v $(pwd)/memories:/app/memories -v $(pwd)/downloads:/app/downloads bot-wa
  ```

---

## 🔒 Aturan Keamanan & Privasi

1. **Prefix `//` (Double Slash) & Owner-Only:** Semua perintah memakai `//` dan hanya merespons Owner. Kontak lain atau grup tidak bisa memicu perintah apa pun.
2. **Khusus Target:** Semua fitur otomatis (Anti-Delete, Anti-Edit, Auto-Capture Media/Status, Memory Vault, Reply-Speed, Couple Wrapped) hanya aktif untuk chat & status Target.
3. **Output Privat ke Owner:** Semua laporan, hasil download, analisis AI, dan statistik selalu dikirim langsung ke chat **Owner**, tidak pernah dikirim ke chat Target.
4. **Live Config Tanpa Edit Kode:** Pengaturan seperti `owner`, `target`, `ultah`, `anniv`, `gemini_key`, hingga saklar ON/OFF setiap fitur bisa diubah langsung lewat chat Owner dan tersimpan permanen di SQLite (`auth/database.db`).

---

## 📋 Daftar Lengkap Perintah WhatsApp (`//`)

> **Tip:** Ketik perintah di **chat dirimu sendiri (*Message Yourself*)** untuk cek statistik/config secara privat, atau reply langsung pesan di chat Target (hasil tetap dikirim ke Owner).

### 🚨 Darurat / Stealth Mode
| Perintah | Fungsi |
| :--- | :--- |
| `//panic` | Matikan semua fitur otomatis seketika (menyimpan snapshot status sebelumnya). |
| `//panic wipe` | Matikan semua fitur otomatis **+ hapus cache pesan DB** (`VACUUM`). |
| `//resume` | Nyalakan kembali semua fitur otomatis sesuai status sebelum `//panic`. |

### ⚙️ Live Config (Ubah Langsung dari WA)
| Perintah | Contoh & Fungsi |
| :--- | :--- |
| `//config` / `//cfg` | Lihat seluruh konfigurasi aktif & status ON/OFF fitur. |
| `//set target <nomor>` | `//set target 62895xxxx` — ubah target + auto-detect LID baru. |
| `//set owner <nomor>` | `//set owner 62851xxxx` — ubah nomor Owner penerima laporan. |
| `//set target_lid <lid>` | `//set target_lid 12345@lid` atau `clear`. |
| `//ultah <YYYY-MM-DD>` | `//ultah 2005-08-17` — set Ultah Pasangan (+ auto-reminder). |
| `//set ultah_owner <tgl>` | `//set ultah_owner 2005-05-10` — set Ultah Kamu. |
| `//set anniv <tgl> [Nama]` | `//set anniv 2025-02-14 Anniversary Kita` — set tanggal jadian. |
| `//set gemini_key <key>` | `//set gemini_key AIza...` atau `clear` — aktifkan/matikan AI. |
| `//set gemini_model <mdl>` | `//set gemini_model gemini-4-hydrogen` — ganti model AI. |
| `//set retention_days <n>` | `//set retention_days 14` — atur auto-cleanup cache pesan (hari). |
| `//set <saklar> on\|off` | Saklar: `anti_delete`, `anti_edit`, `auto_capture`, `auto_status`, `auto_vault`, `image_log`. |
| `//config reset <key\|all>` | Kembalikan pengaturan ke default `.env`. |

### 💑 Couple & Analytics (Khusus Target)
| Perintah | Fungsi |
| :--- | :--- |
| `//speed [hari\|all]` | Statistik kecepatan balas & *Read-to-Reply* (default 7 hari). |
| `//wrapped [hari\|all]` | *Couple Wrapped* ala Spotify (default 30 hari): chat terbanyak, jam aktif, streak, skor kata manis, top 5 kata favorit. |
| `//vault` | Ringkasan arsip *Memory Vault* (`memories/YYYY-MM/`). |
| `//vault random` / `//vault fav` | Kirim throwback kenangan acak atau favorit (reaksi ❤️/⭐ di chat Target = Favorit). |
| `//anniv` | Cek lama bersama & countdown tanggal penting (auto-reminder H-7, H-3, H-1, Hari H). |
| `//anniv add <tgl> \| <Nama>` | Tambah tanggal penting baru. |
| `//anniv del <nomor>` | Hapus tanggal penting berdasarkan nomor urut. |

### 🤖 AI Multimodal & Penerjemah Kode (Gemini v1 API)
| Perintah | Fungsi |
| :--- | :--- |
| `//vn` / `//transcribe` | Reply Voice Note → transkrip + ringkasan + analisis mood/intonasi + makna tersirat + 2 saran balasan. |
| `//kode` | Reply chat teks/VN/screenshot → terjemahkan "kode" pasangan + level mood + 3 opsi balasan. |
| `//ocr` | Reply foto (atau caption foto) → ekstrak seluruh teks di gambar. |
| `//ai <pertanyaan>` | Tanya AI bebas (mendukung reply teks, foto, VN, video, & PDF hingga 18 MB). |

### 📥 Media, Utilitas & WhatsApp Modern (Baileys v7)
| Perintah | Fungsi |
| :--- | :--- |
| `//menu` / `//help` | Tampilkan panduan lengkap bot di chat Owner. |
| `//stats` | Cek mode bot, versi Node.js, RAM, uptime, ukuran DB, & status AI. |
| `//dl` / `//download` | Reply foto, video, atau VN (termasuk *view-once*) → simpan ke `downloads/` & kirim ke Owner. |
| `//vo` | Reply/kirim foto, video, atau VN → kirim ulang sebagai *View-Once*. |
| `//pin [24h\|7d\|30d]` | Reply pesan untuk pin di chat (default `24h`). |
| `//unpin` | Reply pesan untuk melepas pin. |
| `//poll [--multi] Tanya \| Opsi 1 \| Opsi 2` | Buat polling WhatsApp native. |
| `//event Nama \| YYYY-MM-DD HH:mm \| Catatan` | Buat jadwal WhatsApp Event native. |

---

## 🛡️ Fitur Otomatis di Latar Belakang

* **Anti-Delete & Anti-Edit:** Pesan Target yang dihapus atau diedit otomatis dilaporkan ke Owner (perbandingan *Sebelum vs Sesudah*).
* **Auto-Capture Media Target:** Saat Owner membalas foto, video, atau Voice Note (*view-once* / biasa) di chat Target, media otomatis diarsipkan dan dikirim ke Owner.
* **Auto-Capture Status WA Target:** Status foto, video, audio, maupun teks dari Target otomatis disimpan ke `memories/` dan diteruskan ke Owner.
* **Auto Memory Vault:** Semua media dari chat & status Target otomatis tersimpan rapi di `memories/YYYY-MM/`.
* **Reply Image Console Logger:** Setiap kali Owner membalas gambar di chat mana pun, `Chat JID`, `Nomor`, dan `LID` otomatis dicatat di console (tidak mengirim pesan WA).
* **Auto-Cleanup SQLite:** Cache pesan Anti-Delete/Edit lebih tua dari `DB_RETENTION_DAYS` otomatis dibersihkan setiap 6 jam + `VACUUM` tanpa menghapus statistik couple maupun arsip vault.

# NALARA API

API REST NALARA untuk akun Guru, portal Siswa/Orang Tua, siswa, jadwal, presensi, target belajar, laporan, notifikasi, keluarga, referral, dan langganan. Backend menggunakan NestJS + MongoDB replica set + Redis.

## Jalankan dari nol (development)

### Prasyarat

- Node.js `24.13.x` (sesuai `engines` pada `package.json`).
- npm dan Docker Desktop/Engine yang sedang berjalan.
- Port lokal yang tersedia: `3100` (API), `27018` (MongoDB), dan `6379` (Redis).

### Pilihan A — API di host, MongoDB dan Redis di Docker (disarankan untuk development)

> Jalankan perintah dari root repository Nalara, bukan dari dalam `backend_bimbel`.

1. Buat file environment lokal. Jangan commit file ini.

   ```sh
   cp backend_bimbel/.env.example backend_bimbel/.env
   ```

   Untuk mode ini, nilai lokal yang penting adalah:

   ```dotenv
   NODE_ENV=development
   PORT=3100
   MONGODB_URI=mongodb://127.0.0.1:27018/nalara?replicaSet=rs0&directConnection=true
   CORS_ORIGINS=http://localhost:8080,http://127.0.0.1:8080
   REDIS_HOST=127.0.0.1
   REDIS_PORT=6379
   ```

   Isi `RESEND_API_KEY` dan `RESEND_FROM_EMAIL` jika ingin menguji pengiriman OTP sungguhan. Untuk development, `RESEND_TEST_RECIPIENT` dapat diarahkan ke email pengujian.

2. Nyalakan MongoDB **dan Redis** melalui Docker Compose. Redis diperlukan untuk OTP lupa password, cooldown, percobaan OTP, dan reset token.

   ```sh
   docker compose up -d mongo redis
   docker compose ps
   docker compose exec redis redis-cli ping
   ```

   Output Redis yang benar adalah `PONG`. Tunggu sampai service `mongo` dan `redis` berstatus `healthy`. Compose menginisialisasi replica set MongoDB `rs0` melalui healthcheck; tidak perlu menjalankan `rs.initiate` manual.

3. Install dependency dan jalankan API.

   ```sh
   cd backend_bimbel
   npm ci
   npm run build
   npm start
   ```

   Untuk development dengan auto-reload:

   ```sh
   npm run start:dev
   ```

4. Verifikasi API, database, dan Redis.

   ```sh
   curl http://localhost:3100/api/v1/health/live
   curl http://localhost:3100/api/v1/health/ready
   ```

   Buka Swagger di [http://localhost:3100/api/docs](http://localhost:3100/api/docs). Readiness harus menunjukkan database dan Redis `up`.

5. Seed data demo (opsional, hanya development). Set credential sendiri melalui `.env` atau environment shell, lalu jalankan dari `backend_bimbel`:

   ```sh
   SEED_EMAIL=guru@nalara.example.test \
   SEED_PHONE=081234567890 \
   SEED_PASSWORD='DevNalara2026!' \
   npm run seed
   ```

   Seed membuat Guru, siswa demo, bidang belajar, jadwal mingguan, plan, target, progress, dan draft laporan. Seed tidak menimpa workspace yang sudah memiliki siswa dan dilarang pada `NODE_ENV=production`.

### Pilihan B — Semua service termasuk API di Docker

Pastikan `backend_bimbel/.env` sudah dibuat, lalu jalankan dari root repository:

```sh
docker compose up --build -d
docker compose ps
docker compose logs -f api
```

Pada mode ini API memakai hostname internal Compose: MongoDB `mongo:27017` dan Redis `redis:6379`. Jangan menjalankan `npm start` di host bersamaan dengan mode ini karena keduanya memakai port API `3100`. Healthcheck API dapat dicek dengan:

```sh
curl http://localhost:3100/api/v1/health/ready
```

### Stop service

```sh
docker compose stop
```

`docker compose down` menghentikan dan menghapus container, tetapi volume data tetap ada. Jangan gunakan `docker compose down -v` kecuali memang ingin menghapus data MongoDB dan Redis development.

## Portal Siswa

`/portal/student` memakai PortalAuthGuard dan satu studentId dari akun server, bukan query/payload klien atau keanggotaan keluarga. Dashboard/profile tidak mengirim catatan internal Guru, familyId atau metadata referral. Jadwal, rencana, target, riwayat, laporan dan notifikasi hanya data siswa tersebut. Laporan harus published dan visibility student/shared; history hanya student/shared. Inbox memeriksa ulang resource/visibilitas saat ini, termasuk unread dan mark-read; notifikasi untuk saudara atau laporan yang menjadi internal tidak ditampilkan.

`GET /portal/student/sessions/:id/overview` menyediakan occurrence, schedule asli (timezone/recurrence) dan laporan yang boleh dilihat untuk UI detail sesi bersama Guru. Dashboard memakai helper batas midnight timezone yang sama dengan Guru, jumlah sesi harian lengkap dan maksimal tiga preview. Agregat plan/dashboard menggunakan progress.rules; tanpa target eligible = null. Target mengirim konteks nama siswa/bidang/periode/agregat rencana serta maksimal 50 history bersama tanpa actorId. Tugas & Materi tetap memakai portal assignments yang mengikat satu siswa, bukan seluruh saudara.

Perubahan diverifikasi statis (`typecheck`, lint, syntax source test). Jangan menjalankan backend/build/seed/E2E tanpa permintaan eksplisit pengguna; source E2E baru belum dieksekusi.

Node 24.13.0, NestJS 12.1.3, Express 5.1.0, TypeScript 6.0.2, Mongoose 9.11.2. Dependency dipin; gunakan `npm ci` dan lockfile. [Migrasi resmi Nest 12](https://docs.nestjs.com/migration-guide) menjelaskan perubahan ESM dan dukungan Jest/Node.

## Konfigurasi dan dependency

```sh
cp .env.example .env
npm ci
npm run build
npm start
```

Perintah di atas adalah versi singkat jika MongoDB dan Redis sudah berjalan. `npm run start:dev` melakukan build lalu memantau hasil `dist`; setelah edit TypeScript, jalankan `npm run build` pada terminal lain. Tidak ada upgrade major otomatis.

Environment wajib: `MONGODB_URI`, `CORS_ORIGINS` eksplisit, dan `PORT` valid. `.env` diabaikan Git. Default lokal adalah API `3100`, MongoDB replica set `rs0` pada port `27018`, dan Redis pada port `6379`. URI host memakai `directConnection=true`; API container memakai URI internal `mongo:27017` dan `redis:6379` yang dioverride oleh Compose. Redis harus hidup sebelum request OTP dikirim. Jika Redis unavailable, endpoint reset password mengembalikan `503 UNAVAILABLE`, bukan `500`.

| Kelompok | Environment | Keterangan |
| --- | --- | --- |
| Runtime | `NODE_ENV`, `PORT`, `LOG_LEVEL` | `development`, `test`, atau `production`; port default `3100` |
| Database | `MONGODB_URI` | Wajib MongoDB URI; development memakai replica set `rs0` |
| CORS | `CORS_ORIGINS` | Daftar origin HTTPS/HTTP lokal dipisahkan koma; wildcard tidak boleh |
| Redis | `REDIS_HOST`, `REDIS_PORT` | Default `127.0.0.1:6379`; wajib untuk reset password |
| OTP | `PASSWORD_RESET_OTP_TTL_MINUTES` | TTL OTP 1–60 menit, default 5 |
| Email | `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `RESEND_TEST_RECIPIENT` | API key/from wajib production; recipient test hanya non-production |
| Firebase | `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` atau `GOOGLE_APPLICATION_CREDENTIALS` | Verifikasi Google dan FCM; credential hanya di environment backend |
| Notifikasi | `NOTIFICATION_DELIVERY_URL`, `NOTIFICATION_DELIVERY_TOKEN`, `NOTIFICATION_SCHEDULER_INTERVAL_MINUTES` | Adapter delivery opsional; interval default 15 menit |
| Seed | `SEED_EMAIL`, `SEED_PHONE`, `SEED_PASSWORD` | Hanya untuk seed development |
| Pembayaran | `SINGAPAY_ENABLED`, `SINGAPAY_ENVIRONMENT`, `SINGAPAY_*` | Default nonaktif; credential wajib jika diaktifkan |

Semua nama dan contoh nilai tersedia di [.env.example](.env.example). Jangan memasukkan password, API key, Firebase service account, private key, token OTP, atau credential database ke source code, README, log, atau Git.

Jika Docker belum tersedia, MongoDB lokal dapat dijalankan dari root Nalara:

```sh
mkdir -p .local/mongo
mongod --dbpath "$PWD/.local/mongo" --port 27018 --bind_ip 127.0.0.1 --replSet rs0 --logpath "$PWD/.local/mongo.log"
```

Pada terminal lain, inisialisasi satu kali:

```sh
mongosh 'mongodb://127.0.0.1:27018/admin' --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27018"}]})'
```

Transaksi memerlukan replica set; backend sengaja tidak mengganti transaksi dengan write parsial jika database standalone. Jangan menjalankan `rs.initiate` lagi jika replica set sudah aktif. Persistent database lokal berada di `.local/mongo`, bukan di repository.

## Struktur repository dan data

### Struktur folder

```text
backend_bimbel/
├── src/
│   ├── main.ts                    # bootstrap NestJS, prefix API, CORS, Swagger, filter
│   ├── app.module.ts              # wiring module, MongoDB, throttling, guard global
│   ├── config/                    # validasi environment
│   ├── common/                    # response envelope, scope workspace, query, calendar lock
│   ├── database/                  # koneksi, schema dasar, collection type, seed
│   ├── health/                    # liveness/readiness database + Redis
│   └── modules/                   # domain module, DTO, schema, service, controller
├── test/                          # unit, policy, contract, dan E2E
├── .env.example                   # template environment yang aman untuk Git
├── .gitignore                     # aturan secret/dependency/build backend
├── Dockerfile                     # image production API
├── package.json                   # script dan dependency
└── tsconfig.json
```

Setiap module domain umumnya memiliki `*.module.ts`, DTO, schema Mongoose, service, dan controller. `AppModule` mendaftarkan module berikut: auth, health, dashboard, students, families, invitations, subjects, schedules, learning-plans, lesson-reports, notifications, parent-portal, student-portal, subscriptions, dan tutor-tools.

### Konvensi data

- Semua dokumen mempunyai `_id` UUID v4, `createdAt`, dan `updatedAt`.
- Data Guru terscope dengan `workspaceId`; client tidak boleh mengirim workspace sebagai sumber otorisasi.
- Password/token/credential disimpan dalam bentuk hash atau environment, bukan plaintext pada response.
- Tanggal disimpan sebagai UTC `Date`; timezone dipakai untuk perhitungan hari dan jadwal lokal.
- Transaksi MongoDB dipakai untuk operasi multi-collection yang harus atomik. Karena itu MongoDB harus berjalan sebagai replica set.
- Schema memakai `strict: 'throw'`; field tambahan pada payload ditolak oleh validation pipe.
- Index dibuat/diinisialisasi ketika module database startup melalui `model.init()`; repository ini belum memakai file migration terpisah.

### Relasi inti

```text
Workspace
├── User/Guru ── AuthSession
├── Student ── Family ── PortalAccount/PortalSession
│   ├── Subject
│   ├── Schedule ── Session ── LessonReport
│   │                         └── RescheduleRequest
│   ├── LearningPlan ── Target ── ProgressHistory
│   ├── Invitation
│   ├── Assignment ── Submission
│   └── Notification/NotificationDevice
├── Subscription ── SubscriptionOrder ── BillingEvent
├── ReportTemplate
├── TutorPreferences
└── AuditEvent
```

### Koleksi MongoDB

Field `workspaceId` berarti data hanya boleh dibaca oleh Guru/portal yang mempunyai scope yang sesuai. Field `createdAt` dan `updatedAt` tidak diulang pada tabel karena otomatis ada di semua koleksi.

| Collection | Field utama dan arti |
| --- | --- |
| `users` | `name`, `email` unik, `phone?` canonical `+628...` unik parsial, `passwordHash`, `firebaseUid?`, `role=teacher`, `workspaceId`, `timezone` |
| `workspaces` | `name`, `ownerId`, `scheduleVersion` untuk lock kalender |
| `authSessions` | `userId`, `accessHash`, `refreshHash`, `accessExpiresAt`, `expiresAt` TTL |
| `students` | `workspaceId`, `name`, `grade`, `notes`, `status=active\|archived`, `familyId?`, `invitationVersion` |
| `families` | `workspaceId`, `name`, `parentName`, `parentPhone` canonical, `version`, `invitationVersion`; satu nomor unik per workspace |
| `portalAccounts` | `workspaceId`, `role=student\|parent`, `familyId?`, `studentId?`, `status=active\|revoked` |
| `portalSessions` | `accountId`, `accessHash`, `refreshHash`, `accessExpiresAt`, `expiresAt` TTL |
| `subjects` | `workspaceId`, `name`; nama unik dalam workspace |
| `schedules` | `workspaceId`, `studentId`, `subjectId`, `startAt`, `endAt`, `timezone`, `recurrence=none\|weekly`, `repeatCount`, `status=scheduled\|cancelled` |
| `sessions` | `workspaceId`, `scheduleId`, `studentId`, `subjectId`, `startAt`, `endAt`, `status=scheduled\|completed\|cancelled`, `attendance=pending\|present\|excused\|absent\|cancelled` |
| `plans` | `workspaceId`, `studentId`, `subjectId`, `title`, `startAt`, `endAt` |
| `targets` | `workspaceId`, `planId`, `studentId`, `subjectId`, `title`, `description`, `successCriteria`, `priority=low\|normal\|high`, `status=active\|completed\|archived\|cancelled`, `progress=0..100`, `version` |
| `histories` | `workspaceId`, `targetId`, `planId`, `studentId`, `before`, `after`, `note`, `actorId`, `sessionId?`, `visibility=teacher\|student\|shared` |
| `reports` | `workspaceId`, `sessionId` unik per sesi, `studentId`, `topic`, `summary`, `targetIds[]`, `observations`, `difficulties`, `homework`, `recommendation`, `visibility`, `status=draft\|published`, `publishedAt?` |
| `invitations` | `workspaceId`, `studentId?`, `familyId?`, `audience=student\|parent`, `tokenHash`, `expiresAt`, `revokedAt?`, `redeemedAt?` |
| `notifications` | `workspaceId`, `recipientAccountId?`, `title`, `body`, `route`, `readAt?`, `eventKey` unik per workspace, `deliveryStatus=pending\|delivering\|delivered`, `deliveryAttempts`, `lastDeliveryError?` |
| `notificationDevices` | `workspaceId`, `accountId`, `accountType=teacher\|parent\|student`, `token` unik, `platform=android\|ios\|web`, `lastSeenAt` |
| `rescheduleRequests` | `workspaceId`, `sessionId`, `familyId`, `parentAccountId`, `studentId`, waktu lama/permintaan/usulan, `reason`, `status=pending\|approved\|rejected\|cancelled\|expired`, reviewer dan waktu review |
| `audits` | `workspaceId`, `actorId`, `action`, `resourceId` |
| `subscriptions` | `workspaceId` unik, `plan=trial\|basic\|pro`, `trialStartedAt`, `trialEndsAt`, `paidThrough?`, `usageVersion` |
| `subscriptionOrders` | `workspaceId`, `plan=basic\|pro`, `amount`, `currency`, `reference` unik, `status=creating\|pending\|paid\|failed`, `open`, checkout/provider/payment timestamps |
| `billingEvents` | `eventHash` unik, `type?`, `reference?` |
| `assignments` | `workspaceId`, `studentId`, `subjectId`, `kind=task\|material`, `title`, `content`, `dueAt?`, `status=draft\|published\|archived`, `visibility=student\|shared` |
| `submissions` | `workspaceId`, `assignmentId`, `studentId`, `text`, `feedback`, `reviewedAt?`, `version` |
| `reportTemplates` | `workspaceId`, `name`, `topic`, `summary`, `observations`, `difficulties`, `homework`, `recommendation` |
| `tutorPreferences` | `workspaceId` unik, `displayName`, `tagline`, `footer`, `accentColor`, flag `reminders/progress/reports/assignments` |

Redis bukan sumber data utama MongoDB. Redis menyimpan sementara hash OTP reset password, cooldown request, dan reset token sekali pakai dengan TTL. Redis juga harus tersedia saat API memproses flow lupa password.

## API & data

Langganan tutor dan adapter SingaPay tersedia: Trial 14 hari/5 siswa, Basic Rp39.000/30 siswa, Pro Rp79.000/tanpa batas siswa. Feature gate dan kuota dijaga server. Modul `tutor-tools` menyediakan template/PDF, analytics, tugas/materi teks, branding, preferences dan CSV tanpa upload. SingaPay default nonaktif dan credential hanya di environment. [Setup/kontrak](../docs/SUBSCRIPTIONS.md); isolated `npm run test:subscriptions` tidak memulai server/database atau menulis build output.

Sinkronisasi pembayaran memakai `POST /subscriptions/sync` untuk order terbuka workspace sendiri. History `reff_no` adalah nomor transaksi; order dicocokkan dengan `payment_link_reff_no`/nested payment-link reference, link ID, akun, nominal dan status paid. Callback membaca `payment.additional_info.payment_link`; aktivasi tetap memakai requery provider dan transaksi idempoten. Restart manual `npm run start:dev` diperlukan bila proses masih menjalankan dist sebelum perubahan. Tidak perlu membuat order atau pembayaran baru.

Istilah di produk dan pesan API kini **Bidang belajar**, mencakup mata pelajaran akademik maupun keterampilan privat. Resource `/subjects`, DTO/field `subjectId` dan `subjectName`, serta penyimpanan data tetap memakai kontrak yang sama; perubahan istilah tidak membutuhkan migrasi database.

Bidang belajar dapat dibaca melalui `GET /subjects/:id` dan diganti namanya melalui `PATCH /subjects/:id` dengan `{name}`. Validasi nama dilakukan setelah trim (2–100 karakter), field tambahan ditolak dan semua query memakai workspace principal; nama duplikat dalam workspace menghasilkan 409. Rename mempertahankan `_id`; jadwal/sesi/plan/target tetap memakai `subjectId`, laporan memakai `sessionId`. Enrichment daftar/detail mengambil nama terbaru pada saat baca, termasuk laporan lewat sesi dan preview Home. Tidak membutuhkan fan-out rewrite/migrasi atau mengubah progres/history/isi laporan.

Prefix `/api/v1`, Swagger `/api/docs`, JSON spec `/api/docs-json`, liveness `/api/v1/health/live`, readiness `/api/v1/health/ready`. Operasi pengelolaan menggunakan sesi Guru dan filter workspace server. `/portal/me` memakai guard portal terpisah dan `/portal/logout` mencabut sesi berdasarkan refresh credential; kode referral tidak memberikan akses API Guru. ID berupa UUID v4, daftar memakai `page=1&limit=30` (maksimum 100). Input tambahan di luar DTO ditolak.

Response sukses `{data: ...}`; list `{data:{items,total,page,limit}}`; error `{error:{code,message,requestId}}`. Kontrak route terdapat di [../docs/API.md](../docs/API.md).

Password Argon2id; access token acak 15 menit dan refresh token acak 30 hari. Server menyimpan SHA-256 token, refresh dirotasi secara atomik, access lama dicabut saat refresh, logout langsung mencabut sesi, reset mencabut seluruh sesi user. Reset password memakai OTP Redis dengan TTL/cooldown/attempt limit dan email Resend (`RESEND_API_KEY`, `RESEND_FROM_EMAIL`); `RESEND_TEST_RECIPIENT` opsional untuk development. Jika Redis belum tersedia, endpoint reset mengembalikan `503 UNAVAILABLE` dengan request ID dan tidak meninggalkan cooldown parsial. Role client dan workspace payload tidak dipercaya. Hanya role teacher yang diizinkan mengakses API Guru.

Registrasi Guru baru membutuhkan `name`, `email`, `phone`, `password`, dan `passwordConfirmation`; login menerima tepat satu `email` atau `phone` bersama `password`. Password baru pada register/reset wajib minimal 8/maksimal 128 karakter, huruf besar, huruf kecil, angka, dan simbol; konfirmasi register wajib identik dan tidak disimpan. Reset juga menolak password yang sama dengan password lama dengan `409 CONFLICT`, tanpa mengonsumsi resetToken, sehingga pengguna dapat mencoba password lain. DTO dan service memvalidasi aturan ini. Duplicate email/nomor saat register memberi pesan jelas sesuai kontrak [API](../docs/API.md), termasuk konflik index saat request bersamaan. Kegagalan login untuk identitas yang tidak dikenal dan password yang salah memakai pesan `401` generik yang sama agar tidak membocorkan keberadaan akun. Flutter hanya menampilkan pesan backend; rate limit tetap aktif.

Nomor HP Indonesia `08…`/`628…`/`+628…` dinormalisasi ke `+628…` dan mempunyai index unik parsial. Akun lama tanpa field phone tetap kompatibel untuk login email dengan kata sandi tersimpan; nomor tidak diisi otomatis dan tidak ada perubahan data/migrasi yang dijalankan pada pembaruan source ini. Pada startup berikutnya yang diminta pengguna, inisialisasi model akan membuat index schema. Nomor HP belum diverifikasi SMS/OTP. Reset tetap memakai email.

Update progress membutuhkan `version` dari GET target. Konflik menghasilkan 409. Target, history, audit, dan event notifikasi dibuat dalam transaksi yang sama. Agregat dihitung hanya dari plan yang sama: bobot setara, completed=100, archived/cancelled dikecualikan, tanpa target menghasilkan `null`. Flutter menampilkan agregat dari server.

Detail siswa memakai `GET /students/:id/summary`: mean kanonis seluruh target eligible siswa, jumlah target, tujuh hari tren berdasarkan history target yang masih eligible, serta jumlah/rate target selesai pada plan yang periodenya beririsan dengan minggu Senin–Minggu menurut timezone principal. Tidak bergantung pagination daftar; tidak ada target menghasilkan null dan tanpa history menghasilkan tren kosong. Query read-only melakukan UUID/workspace authorization, lookup history/plan terscope, satu aggregate snapshot dan batas waktu 10 detik; tidak menerima clock/ownership client. Nilai hari ini memakai snapshot yang sama dengan angka utama. Detail semantics terdapat di [API](../docs/API.md#ringkasan-detail-siswa). Endpoint baru ini memerlukan backend source terbaru; pembaruan source tidak menjalankan backend, build, migrasi atau seed.

Catatan `teacher` tidak menghasilkan notifikasi dibagikan. Laporan draft tidak mengirim notifikasi; publish idempoten menghasilkan notifikasi hanya ke Orang Tua yang terhubung dengan keluarga siswa. Provider notifikasi berjalan setelah commit. Record tetap terlihat dalam aplikasi jika provider eksternal gagal, dan `POST /notifications/:id/retry` dapat mencoba ulang maksimal 10 kali. Lease pengiriman yang terhenti dapat dicoba ulang setelah 5 menit.

Push Firebase memakai `NotificationDevice` yang terikat pada `accountId`, `workspaceId`, dan token perangkat. Backend mengirim push ke penerima yang tepat: Guru berdasarkan akun Guru, sedangkan Orang Tua/Siswa berdasarkan relasi portal aktif siswa. Event presensi hadir, target baru, laporan terbit, target H-1, dan jadwal les H-1 memakai `eventKey` idempoten. Record dibuat durable dalam transaksi untuk event teaching utama, lalu delivery FCM dilakukan setelah commit. `NOTIFICATION_SCHEDULER_INTERVAL_MINUTES` mengatur pemeriksaan pengingat H-1 (default 15 menit).

Flutter mendaftarkan token setelah login portal/Guru, menangani foreground melalui local notification, dan menangani background/terminated melalui Firebase Messaging. Payload membawa `notificationId` dan `route`; tap menandai record dibaca lalu membuka route yang sesuai. Adapter HTTPS tetap opsional melalui `NOTIFICATION_DELIVERY_URL` dan `NOTIFICATION_DELIVERY_TOKEN`. FCM production membutuhkan `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, dan `FIREBASE_PRIVATE_KEY` pada backend; Android/iOS juga membutuhkan konfigurasi Firebase/APNs dari console. Jika provider belum tersedia, record in-app tetap tersimpan. Jangan mencatat API key, token perangkat, OTP, atau resetToken ke log.

## Progres daftar siswa

`GET /students` menambahkan learningSummary pada item halaman yang terscope, tanpa mengubah filter/status/search/pagination/total. StudentListProgressService memakai satu aggregate untuk rencana yang beririsan minggu Senin–Minggu pada zona Guru, target eligible dan nama bidang belajar. Mean target memakai progressFromTotals: completed=100, archived/cancelled dikecualikan, tanpa target=null/count 0, bukan 0%. Target lebih dari satu halaman tetap dihitung seluruhnya, berbobot per target dan bukan rata-rata per rencana. Field ini berbeda dari completion rate pada summary detail siswa. Subject tanpa nama/relasi milik workspace lain tidak dibocorkan.

Setiap join memakai workspace principal dan relasi plan/student; readConcern snapshot dan maxTimeMS 10000 menjaga konsistensi/batas query. Halaman kosong tidak menjalankan aggregate, tidak ada request summary per siswa atau write database. Flutter terbaru memakai respons ini untuk bar progres; kontrak lengkap ada di docs/API.md.

## Presensi sesi

`PATCH /sessions/:id/attendance` hanya dapat mencatat presensi ketika `attendance` masih `pending`. Setelah satu status tersimpan, sesi dikunci secara atomik; perubahan berikutnya mengembalikan `409 CONFLICT` dengan pesan `Presensi sudah dikunci dan tidak dapat diubah.`. Filter `attendance: pending` pada write menjaga dua request bersamaan tidak dapat saling menimpa.

## Home Guru

`GET /dashboard` hanya menerima sesi Guru dan seluruh query dibatasi workspace principal server. `activeStudents` menghitung status active, `sessionsToday` menghitung seluruh sesi non-cancelled pada hari lokal Guru, dan `todaySessions` hanya preview maksimal tiga (urut startAt/id) dengan studentName/studentGrade/subjectName dari record milik workspace yang sama. Catatan privat siswa tidak ikut enrichment.

`pendingReports` mempertahankan aturan sesi non-cancelled yang endAt sudah lewat dan belum memiliki laporan published, termasuk tanpa laporan/draft serta hari sebelumnya. `unreadNotifications` berasal dari record notifikasi yang belum dibaca. Date contract mencakup generatedAt, timezone, localDate, dayStart inklusif/dayEnd eksklusif; midnight masing-masing dihitung terpisah agar perpindahan DST tidak memakai asumsi 24 jam. Client tidak dapat memilih clock/workspace. Plan periode aktif tetap dikirim untuk kompatibilitas, meskipun tidak lagi ditampilkan pada Home.

Source tests baru mencakup timezone/batas hari/DST, total lebih dari tiga, cancel/draft/published, scope tenant, grade, empty, dan server clock. Test E2E memakai database disposable bernama nalara_test_<UUID>. Perubahan ini hanya diperiksa statis; tidak menjalankan server, tes, build, seed, atau migrasi database.

## Keluarga dan referral

`families` menyimpan Orang Tua berdasarkan nomor HP canonical yang unik dalam workspace Guru. `students.familyId` menghubungkan beberapa anak ke satu keluarga. Family editor memakai optimistic `version`; perubahan melalui profil siswa juga menaikkan versi keluarga agar edit usang tidak menimpa hubungan baru. Pengelompokan dan audit atomik dalam transaksi MongoDB. Tidak ada penggabungan lintas workspace atau OTP verifikasi nomor Orang Tua.

Guru membuat kode keluarga pada `/families/:id/invitations`, kode Siswa pada `/students/:id/invitations`. Kode tampil `NLR-XXXXX-XXXXX-XXXXX-XXXXX` (20 simbol acak/100-bit), disimpan hanya sebagai SHA-256, berlaku 7 hari, dan ditukar sekali. Pembuatan kode baru mencabut kode target yang belum dipakai. Redeem memvalidasi role/target/status/expiry, lalu membuat `portalAccounts`/`portalSessions` terpisah dari akun Guru. Access 15 menit, refresh inactivity 30 hari, rotation atomik; role dan anak dibaca server dari relasi aktif pada setiap `/portal/me`/refresh. Hanya nama/kelas anak yang dipaparkan pada tahap referral, tidak catatan Guru atau data pembelajaran.

Cabut kode belum dipakai tidak mencabut sesi yang sudah aktif. `/families/:id/access/revoke` atau `/students/:id/access/revoke` mencabut semua sesi dan kode target itu. Kode fresh dapat memberi akses kembali tanpa menghapus anak/keluarga. Token portal tidak diterima AuthGuard Guru dan token Guru tidak diterima PortalAuthGuard. Public verify tidak mengirim PII; redeem/verify rate limited 10/menit, refresh 30/menit. Kode legacy per-anak tanpa audience/family tidak dapat dipakai untuk akses Orang Tua; buat kode keluarga baru. Tidak ada migrasi data/database/index yang dieksekusi selama perubahan source.

Respons redeem yang hilang karena koneksi/penyimpanan perangkat bermasalah tidak otomatis dicoba ulang: kode sudah mungkin terpakai, sehingga Guru perlu menerbitkan kode baru. Tidak ada jalur pemulihan OTP/nomor HP untuk parent pada fase ini. Kontrak baca parent tersedia di `/portal/dashboard`, `/portal/students`, `/portal/students/:id`, `/portal/plans/:id` dan `/portal/targets/:id`, memakai guard portal dan keanggotaan keluarga saat ini; resource tidak terhubung menghasilkan 404.

Dashboard menerima optional studentId, mempertahankan seluruh children/childrenCount keluarga untuk switcher, menghitung hari dari midnight kalender timezone Guru, serta mengirim weeklyProgress integer nullable dan masing-masing maksimal tiga preview sesi/laporan/target perhatian. Total sesi tetap dihitung terpisah. Daftar siswa default limit 5 memakai StudentListProgressService yang sama dengan Guru; detail siswa selalu menyertakan StudentSummaryService dengan shape persis endpoint summary Guru dan family publik `{id,name,parentName,parentPhone}`. Student publik tidak menyertakan notes/metadata akses; laporan published dan history hanya visibility shared/parent. Plan memuat studentStatus aktual dan progres kanonis. Detail field, pagination/history limits, reschedule expiration dan batas konkurensi terdokumentasi pada [Portal Orang Tua](../docs/API.md#portal-orang-tua). Perubahan source tidak membuild/menjalankan backend, membuat index, atau menulis database.

`GET /portal/sessions/:id/overview` mengembalikan lesson terscope keluarga, schedule asli termasuk timezone/recurrence, serta published shared/parent reports persis sesi itu. Reschedule mendukung cancelled melalui parent DELETE, teacher availability/offer (pending dengan proposedStartAt/proposedEndAt), lalu parent PATCH action accept/decline; accept mengecek ulang benturan dan mengubah hanya satu occurrence secara atomik. Cancel/decline tidak mengubah kalender dan tetap dapat menutup request ketika entitlement habis; pemindahan tetap mengikuti subscription. Semua penulis interval kalender memakai lock workspace dalam transaksi sebelum membaca slot, termasuk create seri dan edit Guru. Inbox parent juga memvalidasi ulang resource terhadap keluarga saat ini, sehingga notifikasi anak yang telah pindah tidak ikut terbaca.

Guard verify/redeem menggunakan pesan backend terpusat: kode salah meminta pengguna memeriksa kode dan meminta kode baru bila masih salah; kode expired/dicabut/diganti/sudah dipakai atau target unavailable memakai “Kode referral sudah tidak aktif. Silakan minta kode referral terbaru kepada Guru.” Kode aktif yang salah peran diberi arahan memilih peran yang sesuai. DTO memberi pesan kode salah yang sama untuk input kosong/malformed/non-string, tanpa duplikasi validator. Flutter hanya menampilkan `error.message`. Conditional claim, transaksi, rate limit, dan pemisahan izin Guru tetap berlaku; error database tidak disamarkan menjadi kode salah.

## Seed & tes

```sh
SEED_EMAIL=guru@nalara.example.test SEED_PHONE=081234567890 SEED_PASSWORD='DevNalara2026!' npm run seed
npm test
npm run test:e2e
npm run typecheck
npm run lint
npm audit --omit=dev
```

`npm test` membutuhkan replica set lokal di port 27018 untuk E2E. Tes membuat database sementara tersendiri dan membersihkannya setelah selesai. Jest menjalankan hasil kompilasi dengan VM modules untuk dependency Nest 12 yang ESM. Peringatan VM modules dari Node adalah expected; kegagalan tes tetap menghasilkan exit nonzero.

Seed tidak dijalankan di production dan tidak menimpa workspace yang berisi siswa. Seed password tidak dicatat pada log. Library Pino meredaksi authorization, cookies, dan request body; log server menggunakan JSON dan request ID.

`SEED_PHONE` diperlukan hanya saat seed membuat akun baru. Rerun terhadap akun lama tidak menambahkan/mengganti nomor HP akun tersebut. Jangan menjalankan backend, seed, tes, atau build tanpa permintaan eksplisit pengguna; perintah di atas adalah referensi manual, bukan instruksi untuk dieksekusi otomatis.

## Troubleshooting

- `Transaction numbers are only allowed...`: Mongo belum replica set; periksa `rs.status()` dan URI `replicaSet=rs0`.
- `ECONNREFUSED 27018`: nyalakan Mongo lokal atau Docker; periksa port, jangan menghapus volume untuk mengatasi masalah koneksi.
- Host tidak mengenali `mongo`: tambahkan `directConnection=true` jika backend/seed berjalan di host dan Mongo di Compose.
- Error ESM pada tes: gunakan Node 24.9+ dan script `npm test`, bukan Jest tanpa flag VM modules.
- CORS: samakan origin Flutter dengan `CORS_ORIGINS`; contoh browser memakai port 8080.
- 409 update progress: GET target kembali untuk versi terbaru; jangan menyimpan ulang memakai versi lama.
- 503 reset: periksa readiness database dan Redis pada `/api/v1/health/ready`, lalu konfigurasi Redis serta `RESEND_API_KEY` dan `RESEND_FROM_EMAIL`; untuk development, `RESEND_TEST_RECIPIENT` dapat diarahkan ke email pengujian.
- Jika OTP pertama setelah restart API gagal, pastikan Redis hidup. Kode sekarang menunggu koneksi Redis singkat saat startup/request; kegagalan dependency dikembalikan sebagai `503`, bukan `500`.

Compose adalah konfigurasi development. Production membutuhkan MongoDB yang diautentikasi, TLS, backup, monitoring, provider delivery, dan konfigurasi secret yang sesuai lingkungan.

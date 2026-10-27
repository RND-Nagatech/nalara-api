# NALARA API

## Log development dan compile watch

`npm run start:dev` memakai Nest CLI 12.0.8 (`nest start --watch --preserveWatchOutput`), sama dengan alur Invoice Kilat. Terminal menampilkan `Starting compilation in watch mode`, hasil kompilasi, inisialisasi modul, `RoutesResolver`/`RouterExplorer`, `Nest application successfully started`, lalu `API listening on port 3100` setelah `listen()` berhasil. Perubahan pada `src/**/*.ts` dikompilasi ulang dan proses API dimuat ulang otomatis; tidak perlu build dari terminal kedua. Output sebelumnya tetap terlihat.

Pada `NODE_ENV=development`, log aplikasi/lifecycle menggunakan ConsoleLogger Nest dengan timestamp dan warna. Log request serta filter error tetap memakai Pino dengan request ID/redaction; `.env` lokal menggunakan `LOG_LEVEL=info` agar request sukses terlihat. `LOG_LEVEL=warn` menyaring pesan info Pino dan sebelumnya membuat startup terlihat berhenti setelah InstanceLoader, meskipun API telah listening. Production tetap menggunakan Pino terstruktur sesuai `LOG_LEVEL`.

Swagger tetap aktif untuk development (`SWAGGER_ENABLED=true`), tersedia di `/api/docs` dan `/api/docs-json`, serta didaftarkan sebelum listener/handler 404. Default production tetap nonaktif. URL API dan liveness ditampilkan setelah listener siap. Jika baru menarik perubahan ini, jalankan `npm ci` untuk memasang CLI, hentikan proses development lama dengan Ctrl+C, lalu jalankan `npm run start:dev` lagi. `npm start` tetap menjalankan hasil `dist` untuk deployment.

`npm run test:startup` memeriksa format/visibilitas logger, pemilihan Pino production, serta konfigurasi Swagger memakai fake application tanpa bootstrap Nest, listener, build atau koneksi provider. [Hasil verifikasi](../docs/VERIFICATION.md#log-development-backend--27-oktober-2026).

## Identitas client Android

Client Android beralih ke `id.giapp.nalara`; iOS tetap `id.nalara.nalara`. Endpoint, token/session dan scope backend tidak berubah. Android Firebase baru harus didaftarkan pada project yang sama (`nalara-749db`) sebelum memakai config Android baru, agar tetap sesuai project Firebase Admin backend; jangan mengganti credential Admin atau project backend untuk sekadar rename package. Registrasi/config Android baru belum tersedia pada pemeriksaan read-only 26 Oktober 2026. [Prasyarat aplikasi](../flutter-apk/README.md#rilis-android-ke-google-play).

## Alasan pembatalan sesi

Guru wajib mengirim `cancellationReason` (string trimmed 3–500 karakter) saat membatalkan sesi/seri, termasuk jalur presensi cancelled legacy. Validasi DTO dan service menolak alasan kosong/tidak valid atau reason-only edit sebelum menulis. Field optional baru disimpan pada schedule/session agar data batal lama tetap kompatibel; tidak ada migrasi/backfill, dependency atau env baru.

Pembatalan satu occurrence/kelompok, following, dan seluruh seri tetap dibatasi workspace dan transaksi calendar lock. Hanya sesi scheduled/pending yang berubah; completed dan alasan pembatalan sebelumnya tidak ditimpa. Portal existing mengirim alasan sesi anak yang berhak, bukan roster atau alasan permintaan reschedule privat. Tidak menambah push otomatis. Terapkan backend/Flutter bersama lalu restart API; client lama tanpa alasan akan ditolak. [Payload dan batas](../docs/API.md#alasan-pembatalan-sesi).

## Izin notifikasi di aplikasi

Flutter sekarang memakai dialog pembuka NALARA sebelum memanggil izin resmi perangkat/browser. Startup/aktivasi role tidak meminta izin otomatis; perangkat hanya mendaftar setelah status OS authorized/provisional dan sesi akun aktif. Nanti saja adalah keputusan lokal instalasi, bukan preferensi notifikasi server atau perubahan entitlement. Tidak ada endpoint/env/schema/worker baru dan tidak perlu deploy backend khusus perubahan dialog ini. Scope perangkat, visibilitas data, event/outbox, FCM/APNs dan preferensi Guru existing tetap berlaku. Lihat [alur Flutter](../flutter-apk/README.md#dialog-izin-notifikasi-nalara).

## Laporan sesi untuk beberapa siswa

`POST /api/v1/sessions/:sessionId/reports/batch` menerima konten bersama, `status: draft|published`, `visibility` existing dan 1–100 `entries` unik `{sessionId,targetIds?}`. Semua harus peserta occurrence/interval/bidang yang sama dalam workspace Guru. Target evaluasi diverifikasi per anak. Transaksi di bawah calendar lock membuat record privat laporan/audit/outbox per siswa, bukan satu laporan berisi roster. Satu peserta invalid atau sudah punya laporan menolak seluruh batch tanpa overwrite; unique workspace/session tetap dijaga. Draft tidak mengirim notifikasi; publish mengirim sesuai visibilitas, hanya setelah commit. Endpoint single/edit/publish tetap kompatibel. Tidak menambah env/dependency/schema/index.

`npm run test:report-batch` memeriksa DTO, relasi/privasi, rollback, duplicate dan audience dengan fake/source checks; termasuk `verify:source`, bukan bukti transaksi Mongo atau push perangkat nyata. Terapkan backend/Flutter terbaru bersama dan restart API. [Kontrak](../docs/API.md#laporan-sesi-untuk-beberapa-siswa).

## Badge laporan draf di Flutter

Catatan badge laporan Flutter: client membaca `GET /api/v1/reports?page=1&limit=1&status=draft` dan memakai metadata `total` pada PageResult existing untuk menghitung seluruh draf workspace principal. Tidak ada endpoint/counter/schema baru atau perubahan kontrak; daftar portal tetap published-only sesuai visibilitas. UI membaca ulang setelah write terkonfirmasi, kembali ke menu atau resume, bukan polling. [Panduan badge](../flutter-apk/README.md#badge-laporan-yang-masih-draf).

## Preferensi zona waktu Guru

Di Flutter, zona akun diubah hanya dari Pengaturan. Form jadwal baru mengikuti hasil simpan yang sudah dikonfirmasi dan menawarkan shortcut ke Pengaturan, tanpa dropdown zona terpisah. Endpoint jadwal tetap menerima `timezone` untuk menyimpan zona seri dan kompatibilitas client lama; tidak ada perubahan kontrak/validasi backend atau penulisan ulang jadwal existing untuk pemusatan UI ini.

`PATCH /api/v1/me/timezone` menerima tepat `{ "timezone": "Asia/Makassar" }`. Pilihan valid Asia/Jakarta (WIB/UTC+7), Asia/Makassar (WITA/UTC+8), Asia/Jayapura (WIT/UTC+9); respons envelope `data:{timezone}`. Endpoint authenticated/self-only mengikat akun/workspace dari principal, menolak field tambahan, role portal, akun hilang atau sedang dihapus. Tersedia tanpa entitlement Pro atau paket aktif. Update atomik hanya `users.timezone`; credential/avatar, UTC sessions dan zona/pola schedules tidak disentuh. Default schema akun lama tetap Jakarta; tidak perlu seed atau migrasi.

Pembacaan principal berikutnya mengambil timezone user terkini dari DB, sehingga Home/rentang kalender, ringkasan dan pengingat biaya/target mengikuti zona akun. Scheduler H-1 **sesi** mencari kandidat mendatang terbatas 72 jam, lalu memilih hari esok berdasarkan zona seri dalam workspace yang sama; label WIB/WITA/WIT (atau IANA legacy) disertakan di pesan. Deadline delivery adalah midnight zona seri. Pergantian preferensi akun tidak mengubah eventKey/deadline seri yang sama, repeat, gate Pro/Trial, preferensi notifikasi, grouping Guru atau privasi pesan per-anak. Fallback zona akun hanya untuk legacy occurrence tanpa seri yang ditemukan. Tidak ada notifikasi nyata dipicu dari update preferensi.

`npm run test:teacher-profile` dan `test:hardening` mencakup scope, whitelist, pelestarian jadwal serta perbedaan midnight WIB/WITA/WIT; masuk `verify:source`. Ini fake/source checks, bukan pengujian push atau database nyata. Deploy/restart API dan hot restart Flutter terbaru bersama. [Kontrak](../docs/API.md#zona-waktu-akun-guru).

## Status pengajuan perubahan jadwal di detail Parent

`GET /portal/sessions/:id/overview` menambah boolean `reschedulePending`. Hanya sesi milik anak dalam keluarga aktif yang diotorisasi; flag mengikuti satu request pending pada interval sesi dan keluarga terkini dengan waktu diminta/tawaran masih di masa depan. Tidak mengirim ID/identitas/alasan request milik akun Parent lain; satu sesi tetap terkunci bila diajukan akun lain dalam keluarga yang sama. Request resolved/stale tidak mengunci pengajuan baru.

Request ganda mendapat HTTP 409 dengan code `RESCHEDULE_PENDING` dan pesan Indonesia existing; shared calendar lock, unique partial index `one_pending_reschedule_per_session`, expiry dan validasi slot dalam transaksi tetap dipertahankan. Tidak ada perubahan schema/index/migrasi dan tidak ada update waktu sesi dari flag ini. Ini bukan endpoint pembayaran/langganan. `test:schedule-groups` juga mencakup scope pending flag dan pemulihan ketika response gagal setelah commit. Restart/deploy API dan hot restart Flutter terbaru bersama.

## Presensi dibuka saat sesi dimulai

Endpoint presensi tunggal dan batch kelompok memvalidasi `startAt <= waktu server` di transaksi kalender yang sama setelah pemeriksaan pending/scheduled. Sebelum waktunya, response 400 dengan pesan “Presensi tersedia saat sesi dimulai.”; tidak ada penulisan presensi/outbox dan batch tetap all-or-nothing. Boundary tepat jam mulai diperbolehkan, termasuk pencatatan setelah jam berakhir; write-once dan workspace/member guard tetap berlaku. Pembatalan melalui endpoint kelola jadwal tidak diblokir aturan presensi ini. Tidak ada perubahan DTO, timezone penyimpanan, schema, scheduler atau notifikasi push. `test:schedule-groups` mencakup future single/batch, rollback, tepat start, terlambat dan cancellation. Status timeline Flutter hanya tampilan waktu, bukan completion otomatis. Restart/deploy API dan hot restart Flutter terbaru bersama.

Catatan client Chrome: startup web sekarang terpisah dari inisialisasi Google/Firebase Web opsional. Email/nomor HP/reset/referral tetap memakai API existing. Google web memakai public Web config project Firebase yang sama dengan Firebase Admin backend, bukan menyalin service-account JSON ke Flutter. Provider Google dan authorized domains perlu disiapkan pemilik project; tidak ada perubahan credential, endpoint, scope atau CORS otomatis pada backend. [Panduan web](../flutter-apk/README.md#chrome-startup-logo-dan-viewport-portrait).

## Tugas & Materi untuk beberapa siswa

`POST /api/v1/tutor-tools/assignments/batch` menerima `studentIds` berisi 1–100 UUID unik dan konten Assignment existing (tanpa `studentId` tunggal). Entitlement `assignments` Pro/Trial tetap berlaku. Validasi seluruh siswa aktif dan bidang di workspace principal dilakukan dalam transaksi sebelum penulisan; seluruh aktivitas/audit/outbox berhasil bersama atau rollback. Notifikasi hanya setelah commit dan tetap per anak/visibilitas; jawaban tidak dibagikan kepada teman satu grup. Response `{items,total}` berisi record privat per siswa; POST lama dan PATCH satu aktivitas tetap kompatibel. Grup dipakai Flutter sebagai shortcut snapshot; tidak ada groupId/ownership dari client yang dipercaya atau roster otomatis pada aktivitas lama. Tidak menambah schema/env/dependency. [Kontrak](../docs/API.md#tugas-dan-materi-untuk-beberapa-siswa).

`npm run test:assignment-batch` menjalankan source-only fake checks dan masuk `verify:source`; bukan bukti transaksi Mongo/provider nyata. Deploy/restart API dan hot restart Flutter terbaru bersama.

## Repeat jadwal dan seri lanjutan

Schedules mendukung repeatDays (Senin=1–Minggu=7), repeatEnd never/count/until dan tanggal akhir lokal. Payload weekly/repeatCount lama tetap kompatibel. Pola baru menyiapkan hingga delapan minggu di bawah calendar lock yang sama dengan semua penulis jadwal; worker Mongo di SchedulesModule memeriksa setiap 15 menit, maksimal 25 record due, dan menjadwalkan ulang satu jam setelah scan seri. Cursor/child occurrences atomik, tidak ada queue/provider atau Docker tambahan. Requires `recurringSchedules` Pro/Trial aktif; worker tidak membuat trial. Benturan/paket/siswa tidak aktif meninggalkan pesan aman recurrenceError di detail, tanpa menghapus riwayat atau slot lain. Tanggal di luar horizon belum dipesan.

Guru dapat memakai `POST /schedules/:id/repeat` untuk pola lanjutan, atau PATCH sessions dengan scope following untuk ubah waktu/berhenti dari occurrence tertentu. Siswa/bidang diambil dari seri server, presensi tersimpan/exception individual tetap dilindungi. `npm run test:schedule-repeat` adalah pemeriksaan source-only dan masuk `verify:source`. Deploy backend/Flutter bersama; worker hidup saat API aktif. [Kontrak lengkap](../docs/SCHEDULE_REPEAT.md).

## Nomor HP profil Guru

`PATCH /api/v1/me/phone` menerima tepat `{phone:string}` dari sesi Guru, untuk akun Google maupun registrasi biasa. Nomor dinormalisasi dari 08…/628…/+628… ke `+628…`; kosong/format salah/field kepemilikan ditolak 400. Target akun/workspace berasal dari principal dan akun yang sedang dihapus tidak boleh diubah. Unique index canonical `users.phone` menolak nomor yang sudah dipakai akun lain (409), termasuk konflik saat bersamaan. Respons minimal `{phone}` tidak membawa credential atau profil akun lain; email, password, UID Google dan avatar tidak berubah. Tidak ada OTP/verifikasi kepemilikan nomor baru atau perubahan paket. Endpoint self-service tetap tersedia setelah langganan berakhir. Nomor terkini digunakan pada login nomor HP dan kontak WhatsApp Guru dari biaya bimbel Parent.

`npm run test:teacher-profile` adalah source-only checks dengan database tiruan, termasuk DTO, scope, akun Google/normal, konflik indeks dan guard. Masuk `verify:source`; bukan uji Mongo/HP/provider nyata. Terapkan backend dan Flutter terbaru bersama. [Kontrak](../docs/API.md#nomor-hp-profil-guru).

## Biaya bimbel dan pengingat Orang Tua

Aturan terbaru: pengingat Guru mulai hari jatuh tempo, maksimal sekali per hari kalender zona waktu Guru per siswa selama belum lunas. Orang Tua tetap H-1/hari jatuh tempo saja; Siswa tidak menerima. `tuitionTeacherReminders` dan `tuitionParentReminders` disimpan terpisah (default true, termasuk record lama), melalui GET/PATCH `/tutor-tools/notification-preferences`. Audience memeriksa ulang preferensi sebelum push/adapter. Kunci harian Guru tetap saat fee direvisi, sehingga tidak ada event kedua di hari sama; versi terkini dipakai hari berikutnya. Lunasi biaya menghentikan kedua pengingat berikutnya; membaca notifikasi tidak melunasi biaya. Inbox Guru dan badge Home memfilter fee terkini sebelum pagination/count. Tidak ada env/dependency baru. [Kontrak](../docs/API.md#preferensi-pengingat-biaya).

Modul `src/modules/tuition-fees` menyimpan nominal/tanggal/status biaya per siswa dalam koleksi `tuitionFees`. Satu record aktif per workspace+siswa dengan optimistic version; bukan langganan Nalara atau invoice payment gateway. Guru memakai `GET/PATCH /api/v1/students/:id/tuition-fee`, Orang Tua memakai `GET /api/v1/portal/students/:id/tuition-fee` read-only dengan pengecekan membership keluarga terkini. Portal Siswa tidak memperoleh nominal, tanggal, atau endpoint biaya.

Guru mengisi nominal rupiah utuh dan tanggal kalender; penanda lunas menghentikan pengingat berikutnya. Periode berikutnya diisi manual dan mengganti pengaturan aktif sebelumnya. Tidak ada histori invoice, autodebit atau verifikasi transfer. Response menyediakan nomor pemilik workspace yang valid untuk tombol WhatsApp Orang Tua; nomor kosong tetap null. [Kontrak dan batas fitur](../docs/API.md#biaya-bimbel-per-siswa).

Scheduler notifikasi existing mengikuti entitlement `automaticReminders` Pro/Trial aktif; nominal/detail tetap dapat dipakai pada paket lain sesuai akses normal. Revisi/lunas/arsip/pindah keluarga diperiksa ulang sebelum delivery; unique event key menghindari pengulangan scan. Inbox Parent memfilter biaya terkini, dan route kedua peran membuka tab Biaya bimbel. Biaya ikut account-erasure per-workspace.

Tidak ada env/dependency/server baru. Gunakan API dan Flutter terbaru bersama, restart proses API setelah deploy. Scheduler API harus terus berjalan, dan push FCM existing memerlukan konfigurasi/perizinan perangkat yang sudah dipakai notifikasi lain. `npm run test:tuition-fees` menjalankan source checks tanpa server/DB/provider, termasuk dalam `verify:source`; bukan pengujian push nyata.

## Grup siswa tersimpan

Modul `src/modules/student-groups` menyediakan CRUD `/api/v1/student-groups` khusus sesi Guru, scoped workspace. Koleksi `studentGroups` menyimpan nama, 1–100 `studentIds` unik dan `version`; response menambahkan nama/kelas/status/avatar anggota terbaru tanpa notes internal. Edit/delete memakai conditional version dan menolak stale request dengan 409. Siswa asing/tidak aktif tidak dapat ditambahkan. Record grup dihapus oleh worker saat workspace dihapus.

Flutter menempatkan kelola grup pada Lainnya dan pilihan cepat pada form jadwal. Payload jadwal tetap memakai snapshot `studentIds`, sehingga aturan konflik/transaksi jadwal existing tetap berlaku; mengganti/hapus grup tidak merombak jadwal lama. Bukan family/referral dan bukan `groupId` dari seri/occurrence. Tidak ada layanan, env, paket premium atau dependency baru. Deploy/restart API terbaru untuk mendaftarkan modul/schema; data lama tidak perlu diubah.

`npm run test:student-groups` menjalankan pemeriksaan source terisolasi DTO/scope/membership/pagination/version/penghapusan, termasuk dalam `verify:source`. Tidak bootstrap Nest, menjalankan Mongo/Redis atau mengubah database development. [Kontrak lengkap](../docs/API.md#grup-siswa-tersimpan).

API REST NALARA untuk akun Guru, portal Siswa/Orang Tua, siswa, jadwal, presensi, target belajar, laporan, notifikasi, keluarga, referral, dan langganan. Backend menggunakan NestJS + MongoDB replica set + Redis.

## Karakter foto profil

Profil Guru dan Siswa memakai katalog `assets/nalara_avatar_assets/manifest.json`. Guru memilih enam karakter `teacher`; Siswa memilih dua belas karakter `student`/`adult`. Endpoint Guru `GET /api/v1/me/avatars` dan `PATCH /api/v1/me/avatar`; Siswa memakai `GET /api/v1/portal/student/profile/avatars` dan `PATCH /api/v1/portal/student/profile/avatar`. PATCH menerima tepat `{avatarId:string|null}`. Server menetapkan pemilik dari sesi; Guru/Orang Tua tidak dapat mengganti avatar siswa melalui endpoint edit data siswa. `null` kembali ke inisial; pilihan disimpan pada user Guru atau record siswa, bukan perangkat/akun referral sementara. Avatar tetap dapat diganti Guru setelah langganan berakhir.

`GET /api/v1/avatars/:id/image` hanya menyajikan WebP karakter katalog yang memang publik, tanpa data pengguna, traversal path atau akses ke uploads privat. Folder aset beserta manifest wajib ikut deployment; Dockerfile sudah menyalinnya ke image runtime. URL asli pada manifest adalah referensi aset, sedangkan `imagePath` katalog API memakai prefix API existing. Tidak ada upload/kamera/dependensi native baru. `npm run test:avatars` memeriksa katalog, scope/peran, validasi payload dan routing secara source-only dengan database tiruan.

## Logo privat dan PDF laporan

Logo termasuk entitlement **branding Tutor Pro dan Trial aktif**; Basic tidak mendapat custom branding. Tidak mengubah harga atau menambah paket. `GET/POST/DELETE /api/v1/tutor-tools/branding/logo` memakai sesi Guru/workspace server, bukan URL publik atau workspace dari client. POST multipart hanya menerima satu field file bernama `file`; PNG/JPEG maksimal 2 MB dan 4 megapiksel. Sharp memeriksa/men-decode gambar, membuang metadata dan menormalisasi ke PNG maksimal 512 × 512. SVG, URL remote dan attachment umum tidak didukung.

Default penyimpanan `backend_bimbel/uploads/branding/<workspace-UUID>/<logo-UUID>.png` ketika API dijalankan dari folder backend. `UPLOADS_DIR` dapat menunjuk direktori privat lain; path relatif mengikuti working directory. Direktori/file dibatasi 0700/0600, nama dihasilkan server, validasi path menolak traversal/symlink. Jangan mengekspos folder ini melalui static hosting. API logo memakai `Cache-Control: no-store`; preview dikirim sebagai base64 ke Guru yang berhak. Penyimpanan logo terpisah dari tombol simpan teks identitas.

Compose memasang volume `uploads-data:/app/uploads` dan `UPLOADS_DIR=/app/uploads`. **Cadangkan volume bersama database**; jangan memakai volume sementara. Beberapa replika API harus berbagi penyimpanan yang sama atau nanti dimigrasikan ke object storage. Logo lama dibersihkan setelah transaksi penggantian/penghapusan berhasil; kegagalan cleanup dicatat `branding.logo.cleanup_pending` untuk tindak lanjut operator, belum ada worker GC penggantian tersendiri. Worker penghapusan akun menghapus seluruh logo generated workspace tersebut, termasuk sisa penggantian, dan retry saat penyimpanan gagal (`account.deletion.logo_cleanup_pending`). Tidak menghapus file workspace lain atau backup di luar volume.

Ekspor PDF memakai data laporan aktual, timezone jadwal, logo/nama/tagline/warna/footer, metadata siswa dan presensi, bagian bernomor, label draf/visibilitas serta halaman lanjutan/nomor halaman. Kontrak JSON `{filename,mimeType,contentBase64}` tetap sama, dibuat di memori; PDF tidak disimpan ke uploads. Font static `assets/report-fonts` ikut image Docker dan tidak diunduh saat request. Turunan Inter/Lora diberi nama NalaraSans/NalaraSerif dan menyertakan lisensi OFL. Regenerasi dev opsional: pasang FontTools lalu jalankan `python scripts/prepare-report-fonts.py`; font sumber Flutter tidak diubah.

`npm run test:branding` masuk `verify:source`: pemeriksaan normalisasi gambar, tenant/path, transaksi, kegagalan penyimpanan, entitlement serta renderer PDF terisolasi. Preview fiktif opsional `node scripts/preview-report-pdf.cjs` hanya memanggil renderer, tidak memulai aplikasi atau mengakses data pengguna. [Kontrak](../docs/API.md) dan [hasil pemeriksaan](../docs/VERIFICATION.md).

## Hapus akun Guru

Menu Flutter **Lainnya → Hapus akun** memakai `GET /api/v1/account-deletion` (ringkasan aktual) dan `DELETE` path yang sama. Backend memverifikasi kata sandi atau Firebase ID token Google yang sama, belum dicabut, dengan `auth_time` maksimal 5 menit. Memerlukan persetujuan dan konfirmasi eksplisit; tidak menerima target user/workspace dari client. Tetap tersedia ketika langganan berakhir.

Respons **202/pending** berarti permintaan diterima, bukan seluruh data telah hilang. Transaksi segera menutup akses Guru/portal, sesi, perangkat, kode referral dan push tertunda; job Mongo durable menghapus data workspace permanen secara otomatis, tanpa tinjauan admin. Worker mencoba ulang saat database/Firebase/SingaPay bermasalah. Identitas Firebase aplikasi dihapus, **bukan akun Google pengguna**. Link pembayaran terbuka diperiksa/dibatalkan melalui alur provider existing; tidak ada refund/charge baru. Catatan provider/backup di luar database tidak diklaim terhapus oleh worker ini.

Default `ACCOUNT_DELETION_INTERVAL_SECONDS=60`, `ACCOUNT_DELETION_BATCH_SIZE=5` (lihat `.env.example`). Per koleksi maksimal 500 record per pass, order maksimal 20. Lease dan checkpoint difence dengan claim ID. Penanda teknis minimal (ID internal, status/waktu, fingerprint UID) diperiksa kembali harian untuk membersihkan late writes; UID asli dihapus dari job setelah cleanup Firebase. Operator perlu memantau `account.deletion.*`, permintaan tertunda dan status completion; jangan menghapus tombstone sebagai troubleshooting.

`npm run test:account-deletion` termasuk `verify:source`: fake database/provider, tanpa server atau data nyata. Restart/deploy backend terbaru perlu dilakukan pengguna; proses berjalan tidak diubah otomatis. Self-service penghapusan portal tersedia pada `DELETE /portal/account` untuk Orang Tua dan `DELETE /portal/student/account` untuk Siswa; tindakan ini menghapus identitas portal, sesi, perangkat, dan inbox tanpa menghapus data pembelajaran milik Guru. URL web penghapusan dan kebijakan retensi/backup produksi tetap harus dipublish/diverifikasi sebelum rilis. [Kontrak](../docs/API.md), [verifikasi](../docs/VERIFICATION.md).

## Panduan persiapan mengajar

`GET /api/v1/teaching-guide` mengembalikan milestone bidang belajar, siswa, jadwal, dan target dari record workspace milik principal Guru. Client tidak dapat menandai langkah selesai. Data existing/arsip/batal dikenali sebagai langkah persiapan yang pernah dilakukan. Langkah opsional Orang Tua membutuhkan akun parent aktif dengan siswa aktif pada family/workspace yang sama; respons hanya boolean, bukan data akun atau anak.

`PATCH /api/v1/teaching-guide/preferences` menerima tepat `{tutorialSeen:true}` dan menyimpan `users.teachingTutorialSeen` secara monoton untuk akun/workspace principal. `GET` mengembalikan `tutorialSeen` bersama milestone; akun lama tanpa field memakai false. Preferensi ringkas/tampilkan Beranda telah dihapus. Field ini hanya mencatat penawaran tutorial otomatis, tidak menandai milestone selesai atau mengurangi badge sisa panduan. Penyimpanan tetap boleh setelah langganan berakhir tanpa mengaktifkan paket/mutasi belajar. Kedua endpoint menggunakan AuthGuard Guru existing, tidak public/portal. Terapkan backend dan Flutter versi kontrak ini bersamaan.

`npm run test:teaching-guide` menjalankan pemeriksaan source terisolasi dengan fake database; sekarang termasuk dalam `verify:source`. Tidak bootstrap Nest, menjalankan server, menghasilkan dist atau menghubungi Mongo/Redis/provider. [Kontrak API](../docs/API.md) dan [hasil verifikasi](../docs/VERIFICATION.md).

## Pemeriksaan source dan hardening SaaS

`npm run verify:source` menjalankan typecheck tanpa emit, lint, tes hardening terisolasi dan tes kebijakan langganan. Tidak memulai Nest, listener, koneksi database/Redis/Firebase/SingaPay, atau menghasilkan dist. Jangan gunakan `npm test` sebagai pengganti ketika build/runtime tidak diizinkan: script tersebut membuild aplikasi dan menjalankan E2E.

OTP kini diverifikasi melalui satu script Lua Redis (termasuk counter, TTL, konsumsi dan reset token). Tes Redis nyata tersedia opt-in melalui `RUN_REDIS_INTEGRATION=true npm run test:otp:redis`, hanya terhadap Redis development/disposable yang sudah berjalan; default host lokal, DB 15, prefix email UUID. Tidak memakai FLUSHDB/FLUSHALL dan belum dijalankan dalam batch ini. Set `REDIS_TEST_HOST`, `REDIS_TEST_PORT`, `REDIS_TEST_DB`, `REDIS_TEST_PASSWORD` bila diperlukan. Redis standalone 7.4 existing didukung; script dua key belum ditujukan untuk Redis Cluster.

Target distribusi adalah Google Play dan App Store. Integrasi pembelian store, opsi login iOS, signing produksi, penghapusan akun, backup/monitoring dan validasi runtime masih menjadi gerbang rilis terpisah. [Roadmap dan status aktual](../docs/SAAS_ROADMAP.md).

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
   REDIS_URL=
   REDIS_HOST=127.0.0.1
   REDIS_PORT=6379
   REDIS_USERNAME=
   REDIS_PASSWORD=
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

`docker compose down` menghentikan dan menghapus container, tetapi volume data tetap ada. Jangan gunakan `docker compose down -v` kecuali memang ingin menghapus data MongoDB, Redis dan logo uploads development.

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

Perintah di atas adalah versi singkat jika MongoDB dan Redis sudah berjalan. `npm run start:dev` memakai Nest CLI watch untuk mengompilasi dan memuat ulang perubahan TypeScript otomatis; tidak perlu menjalankan build di terminal kedua. Tidak ada upgrade major otomatis.

Environment wajib: `MONGODB_URI`, `CORS_ORIGINS` eksplisit, dan `PORT` valid. `.env` diabaikan Git. Default lokal adalah API `3100`, MongoDB replica set `rs0` pada port `27018`, dan Redis pada port `6379`. URI host memakai `directConnection=true`; API container memakai URI internal `mongo:27017` dan `redis:6379` yang dioverride oleh Compose. Redis harus hidup sebelum request OTP dikirim. Jika Redis unavailable, endpoint reset password mengembalikan `503 UNAVAILABLE`, bukan `500`.

| Kelompok | Environment | Keterangan |
| --- | --- | --- |
| Runtime | `NODE_ENV`, `PORT`, `LOG_LEVEL` | `development`, `test`, atau `production`; port default `3100` |
| Database | `MONGODB_URI` | Wajib MongoDB URI; development memakai replica set `rs0` |
| CORS | `CORS_ORIGINS` | Daftar origin HTTPS/HTTP lokal dipisahkan koma; wildcard tidak boleh |
| Redis | `REDIS_URL` atau `REDIS_HOST`, `REDIS_PORT`, `REDIS_USERNAME`, `REDIS_PASSWORD` | Jika `REDIS_URL` diisi, URL dipakai sebagai prioritas. Jika kosong, backend memakai host/port/username/password. Default lokal `127.0.0.1:6379`; wajib untuk reset password |
| OTP | `PASSWORD_RESET_OTP_TTL_MINUTES` | TTL OTP 1–60 menit, default 5 |
| Email | `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `RESEND_TEST_RECIPIENT` | API key/from wajib production; recipient test hanya non-production |
| Firebase | `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` atau `GOOGLE_APPLICATION_CREDENTIALS` | Verifikasi Google dan FCM; credential hanya di environment backend |
| Notifikasi | `NOTIFICATION_DELIVERY_URL`, `NOTIFICATION_DELIVERY_TOKEN`, `NOTIFICATION_SCHEDULER_INTERVAL_MINUTES`, `NOTIFICATION_DELIVERY_INTERVAL_SECONDS`, `NOTIFICATION_DELIVERY_BATCH_SIZE` | Adapter opsional; generator H-1 15 menit, worker delivery 15 detik/25 event |
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
- Index dibuat/diinisialisasi ketika module database startup melalui `model.init()` secara paralel. Startup menunggu seluruh index selesai, dengan timeout 30 detik per model; jika ada index yang gagal atau macet, API tidak dibuka dan nama model dicetak di log agar masalah MongoDB bisa diperbaiki sebelum menerima request. Repository ini belum memakai file migration terpisah.

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
| `invitations` | `workspaceId`, `studentId?`, `familyId?`, `audience=student\|parent`, `tokenHash`, `expiresAt=null`, `revokedAt?`, `lastUsedAt?`, `useCount`; `redeemedAt?` legacy |
| `notifications` | `workspaceId`, `recipientAccountId?`, `title`, `body`, `route`, `readAt?`, `eventKey` unik per workspace, `deliveryStatus=pending\|delivering\|delivered\|suppressed\|failed`, attempts/backoff/claim/lease, hash hasil perangkat, adapter checkpoint, optional expiry |
| `notificationDevices` | `workspaceId`, `accountId`, `accountType=teacher\|parent\|student`, `token` unik, `platform=android\|ios\|web`, `lastSeenAt` |
| `rescheduleRequests` | `workspaceId`, `sessionId`, `familyId`, `parentAccountId`, `studentId`, waktu lama/permintaan/usulan, `reason`, `status=pending\|approved\|rejected\|cancelled\|expired`, reviewer dan waktu review |
| `audits` | `workspaceId`, `actorId`, `action`, `resourceId` |
| `subscriptions` | `workspaceId` unik, `plan=trial\|basic\|pro`, `trialStartedAt`, `trialEndsAt`, `paidThrough?`, `usageVersion` |
| `subscriptionOrders` | `workspaceId`, `plan=basic\|pro`, `amount`, `currency`, `reference` unik, `status=creating\|pending\|paid\|failed\|cancelled`, `open`, checkout/provider/payment timestamps |
| `billingEvents` | `eventHash` unik, `type?`, `reference?` |
| `assignments` | `workspaceId`, `studentId`, `subjectId`, `kind=task\|material`, `title`, `content`, `dueAt?`, `status=draft\|published\|archived`, `visibility=student\|shared` |
| `submissions` | `workspaceId`, `assignmentId`, `studentId`, `text`, `feedback`, `reviewedAt?`, `version` |
| `reportTemplates` | `workspaceId`, `name`, `topic`, `summary`, `observations`, `difficulties`, `homework`, `recommendation` |
| `tutorPreferences` | `workspaceId` unik, `displayName`, `tagline`, `footer`, `accentColor`, flag `reminders/progress/reports/assignments` |

Redis bukan sumber data utama MongoDB. Redis menyimpan sementara hash OTP reset password, cooldown request, dan reset token sekali pakai dengan TTL. Redis juga harus tersedia saat API memproses flow lupa password.

## API & data

Langganan tutor dan adapter SingaPay tersedia: Trial 14 hari/5 siswa, Basic Rp39.000/30 siswa, Pro Rp79.000/tanpa batas siswa. Feature gate dan kuota dijaga server. Modul `tutor-tools` menyediakan template/PDF, analytics, tugas/materi teks, branding, preferences dan CSV tanpa upload. SingaPay default nonaktif dan credential hanya di environment. [Setup/kontrak](../docs/SUBSCRIPTIONS.md); isolated `npm run test:subscriptions` tidak memulai server/database atau menulis build output.

Sinkronisasi pembayaran memakai `POST /subscriptions/sync` untuk order terbuka workspace sendiri, termasuk pemulihan link existing. History `reff_no` adalah nomor transaksi; order dicocokkan dengan `payment_link_reff_no`/nested payment-link reference, link ID, akun, nominal dan status paid. Callback membaca `payment.additional_info.payment_link`; aktivasi tetap memakai requery provider dan transaksi idempoten. Restart manual `npm run start:dev` diperlukan bila proses masih menjalankan dist sebelum perubahan.

Perbaikan checkout/pembatalan: order tanpa ID tidak lagi buntu selamanya. Setelah creation lease/jeda dua menit, tombol Batal melakukan inquiry riwayat/link lengkap; jika reference benar-benar tidak ditemukan order ditutup sebagai `cancelled`, sedangkan link yang ditemukan dibatalkan di provider terlebih dahulu. Paid tidak bisa dibatalkan melalui jalur ini. Unknown outcome/timeout atau scan tidak lengkap tetap ditahan. Rejection create definitif menutup row `failed`; metadata error provider disimpan/log secara terbatas tanpa rahasia. Riwayat lama dipertahankan; setelah pembatalan sukses, user dapat checkout lagi dengan ID/reference/link baru. Tidak ada reset database/manual-paid, tagihan pengganti otomatis, atau migrasi wajib. Paket dan row paid tidak ditimpa oleh late create/cancel. Tes regresi source-only ada di `test/checkout-recovery.check.cjs` dan ikut `npm run test:subscriptions`/`verify:source`.

Istilah di produk dan pesan API kini **Bidang belajar**, mencakup mata pelajaran akademik maupun keterampilan privat. Resource `/subjects`, DTO/field `subjectId` dan `subjectName`, serta penyimpanan data tetap memakai kontrak yang sama; perubahan istilah tidak membutuhkan migrasi database.

Bidang belajar dapat dibaca melalui `GET /subjects/:id` dan diganti namanya melalui `PATCH /subjects/:id` dengan `{name}`. Validasi nama dilakukan setelah trim (2–100 karakter), field tambahan ditolak dan semua query memakai workspace principal; nama duplikat dalam workspace menghasilkan 409. Rename mempertahankan `_id`; jadwal/sesi/plan/target tetap memakai `subjectId`, laporan memakai `sessionId`. Enrichment daftar/detail mengambil nama terbaru pada saat baca, termasuk laporan lewat sesi dan preview Home. Tidak membutuhkan fan-out rewrite/migrasi atau mengubah progres/history/isi laporan.

Prefix `/api/v1`, Swagger `/api/docs`, JSON spec `/api/docs-json`, liveness `/api/v1/health/live`, readiness `/api/v1/health/ready`. Operasi pengelolaan menggunakan sesi Guru dan filter workspace server. `/portal/me` memakai guard portal terpisah dan `/portal/logout` mencabut sesi berdasarkan refresh credential; kode referral tidak memberikan akses API Guru. ID berupa UUID v4, daftar memakai `page=1&limit=30` (maksimum 100). Input tambahan di luar DTO ditolak.

Response sukses `{data: ...}`; list `{data:{items,total,page,limit}}`; error `{error:{code,message,requestId}}`. Kontrak route terdapat di [../docs/API.md](../docs/API.md).

Password Argon2id; access token acak 15 menit dan refresh token acak 30 hari. Server menyimpan SHA-256 token, refresh dirotasi secara atomik, access lama dicabut saat refresh, logout langsung mencabut sesi, reset mencabut seluruh sesi user. Reset password memakai OTP Redis dengan TTL/cooldown/attempt limit dan email Resend (`RESEND_API_KEY`, `RESEND_FROM_EMAIL`); `RESEND_TEST_RECIPIENT` opsional untuk development. Jika Redis belum tersedia, endpoint reset mengembalikan `503 UNAVAILABLE` dengan request ID dan tidak meninggalkan cooldown parsial. Role client dan workspace payload tidak dipercaya. Hanya role teacher yang diizinkan mengakses API Guru.

Registrasi Guru baru membutuhkan `name`, `email`, `phone`, `password`, dan `passwordConfirmation`; login menerima tepat satu `email` atau `phone` bersama `password`. Password baru pada register/reset wajib minimal 8/maksimal 128 karakter, huruf besar, huruf kecil, angka, dan simbol; konfirmasi register wajib identik dan tidak disimpan. Reset juga menolak password yang sama dengan password lama dengan `409 CONFLICT`, tanpa mengonsumsi resetToken, sehingga pengguna dapat mencoba password lain. DTO dan service memvalidasi aturan ini. Duplicate email/nomor saat register memberi pesan jelas sesuai kontrak [API](../docs/API.md), termasuk konflik index saat request bersamaan. Kegagalan login untuk identitas yang tidak dikenal dan password yang salah memakai pesan `401` generik yang sama agar tidak membocorkan keberadaan akun. Flutter hanya menampilkan pesan backend; rate limit tetap aktif.

Nomor HP Indonesia `08…`/`628…`/`+628…` dinormalisasi ke `+628…` dan mempunyai index unik parsial. Akun lama tanpa field phone tetap kompatibel untuk login email dengan kata sandi tersimpan; nomor tidak diisi otomatis dan tidak ada perubahan data/migrasi yang dijalankan pada pembaruan source ini. Pada startup berikutnya yang diminta pengguna, inisialisasi model akan membuat index schema. Nomor HP belum diverifikasi SMS/OTP. Reset tetap memakai email.

Update progress membutuhkan `version` dari GET target. Konflik menghasilkan 409. Target, history, audit, dan event notifikasi dibuat dalam transaksi yang sama. Agregat dihitung hanya dari plan yang sama: bobot setara, completed=100, archived/cancelled dikecualikan, tanpa target menghasilkan `null`. Flutter menampilkan agregat dari server.

Detail siswa memakai `GET /students/:id/summary`: mean kanonis seluruh target eligible siswa, jumlah target, tujuh hari tren berdasarkan history target yang masih eligible, serta jumlah/rate target selesai pada plan yang periodenya beririsan dengan minggu Senin–Minggu menurut timezone principal. Tidak bergantung pagination daftar; tidak ada target menghasilkan null dan tanpa history menghasilkan tren kosong. Query read-only melakukan UUID/workspace authorization, lookup history/plan terscope, satu aggregate snapshot dan batas waktu 10 detik; tidak menerima clock/ownership client. Nilai hari ini memakai snapshot yang sama dengan angka utama. Detail semantics terdapat di [API](../docs/API.md#ringkasan-detail-siswa). Endpoint baru ini memerlukan backend source terbaru; pembaruan source tidak menjalankan backend, build, migrasi atau seed.

Catatan `teacher` tidak menghasilkan notifikasi dibagikan. Laporan draft tidak mengirim notifikasi; publish idempoten mengikuti visibility student/shared dan penerima portal terkait. Provider berjalan setelah commit, dengan pemulihan otomatis melalui worker outbox Mongo setiap 15 detik (batch 25, concurrency 4). Hasil terminal per perangkat disimpan sebagai hash token/pemilik; kegagalan sementara memakai backoff/jitter dan berhenti setelah 10 percobaan sebagai `failed`. Lease baru 2 menit dengan claim ID; legacy tanpa lease memakai updatedAt 5 menit. Record inbox tidak dihapus ketika push gagal.

`POST /notifications/:id/retry` dibatasi 5/menit, mengulang pending segera atau membuka siklus baru untuk failed (diaudit, checkpoint perangkat tetap dipertahankan); suppressed/delivered tidak dibuka ulang. Penerima, workspace, anak/keluarga aktif dan visibility diperiksa ulang sebelum pengiriman/adapter. Cabut akses menonaktifkan pending/delivering serta menghapus token perangkat di dalam transaksi; registrasi portal juga menulis lock versi akun aktif. H-1 baru memiliki deadline sebelum hari target/jadwal dimulai. Push yang sudah diterima FCM tidak dapat ditarik kembali oleh backend.

Jaminan delivery adalah at-least-once, bukan exactly-once: crash setelah FCM menerima push tetapi sebelum checkpoint tersimpan masih dapat menyebabkan pengulangan. `delivered` bukan bukti pesan dibaca/perangkat menampilkan notifikasi; readAt adalah status inbox terpisah. Adapter HTTPS menerima `audience:{accountType,accountIds}` dan wajib menghormati scope serta Idempotency-Key, bukan broadcast workspace.

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

Guru membuat kode keluarga pada `/families/:id/invitations`, kode Siswa pada `/students/:id/invitations`. Kode tampil `NLR-XXXXX-XXXXX-XXXXX-XXXXX` (20 simbol acak/100-bit), disimpan hanya sebagai SHA-256, **tanpa batas waktu dan dapat dipakai kembali** sampai diganti/dicabut. Pembuatan kode baru mencabut semua kode target sebelumnya, termasuk yang pernah dipakai, serta memperbarui `currentInvitationId` pada siswa/keluarga dalam transaksi. GET invitations mengembalikan maksimal satu item terbaru tanpa token/hash; riwayat lama tetap disimpan. UI mengganti satu card alih-alih menambahkan riwayat ke bawah.

Target legacy tanpa pointer memilih record paling baru (`createdAt`, lalu `_id`), termasuk jika record itu sudah dicabut; kode lebih lama tidak diaktifkan kembali. `expiresAt`/`redeemedAt` legacy tidak lagi membatasi kode terbaru yang belum dicabut. Tidak menjalankan migrasi atau mengubah database nyata saat development. Redeem berulang memperbarui `lastUsedAt`/`useCount`, memvalidasi role/target/status lalu membuat sesi akun portal yang sama dalam transaksi. Pilihan anak tetap berasal dari keanggotaan keluarga aktif; Siswa hanya dirinya. Code replacement/revoke-code tidak memutus sesi existing; revoke-all memutus seluruh akses target. Access tetap 15 menit dan refresh inactivity 30 hari dengan rotation atomik; jika sesi habis, gunakan kembali kode terbaru yang masih aktif. `npm run test:referrals` memeriksa kontrak ini dengan database tiruan tanpa bootstrap Nest atau build.

Cabut kode belum dipakai tidak mencabut sesi yang sudah aktif. `/families/:id/access/revoke` atau `/students/:id/access/revoke` mencabut semua sesi dan kode target itu. Kode fresh dapat memberi akses kembali tanpa menghapus anak/keluarga. Token portal tidak diterima AuthGuard Guru dan token Guru tidak diterima PortalAuthGuard. Public verify tidak mengirim PII; redeem/verify rate limited 10/menit, refresh 30/menit. Kode legacy per-anak tanpa audience/family tidak dapat dipakai untuk akses Orang Tua; buat kode keluarga baru. Tidak ada migrasi data/database/index yang dieksekusi selama perubahan source.

Respons redeem yang hilang karena koneksi/penyimpanan perangkat bermasalah tidak otomatis dicoba ulang: kode sudah mungkin terpakai, sehingga Guru perlu menerbitkan kode baru. Tidak ada jalur pemulihan OTP/nomor HP untuk parent pada fase ini. Kontrak baca parent tersedia di `/portal/dashboard`, `/portal/students`, `/portal/students/:id`, `/portal/plans/:id` dan `/portal/targets/:id`, memakai guard portal dan keanggotaan keluarga saat ini; resource tidak terhubung menghasilkan 404.

Dashboard menerima optional studentId, mempertahankan seluruh children/childrenCount keluarga untuk switcher, menghitung hari dari midnight kalender timezone Guru, serta mengirim weeklyProgress integer nullable dan masing-masing maksimal tiga preview sesi/laporan/target perhatian. Total sesi tetap dihitung terpisah. Daftar siswa default limit 5 memakai StudentListProgressService yang sama dengan Guru; detail siswa selalu menyertakan StudentSummaryService dengan shape persis endpoint summary Guru dan family publik `{id,name,parentName,parentPhone}`. Student publik tidak menyertakan notes/metadata akses; laporan published dan history hanya visibility shared/parent. Plan memuat studentStatus aktual dan progres kanonis. Detail field, pagination/history limits, reschedule expiration dan batas konkurensi terdokumentasi pada [Portal Orang Tua](../docs/API.md#portal-orang-tua). Perubahan source tidak membuild/menjalankan backend, membuat index, atau menulis database.

`GET /portal/sessions/:id/overview` mengembalikan lesson terscope keluarga, schedule asli termasuk timezone/recurrence, serta published shared/parent reports persis sesi itu. Reschedule mendukung cancelled melalui parent DELETE, teacher availability/offer (pending dengan proposedStartAt/proposedEndAt), lalu parent PATCH action accept/decline; accept mengecek ulang benturan dan mengubah hanya satu occurrence secara atomik. Cancel/decline tidak mengubah kalender dan tetap dapat menutup request ketika entitlement habis; pemindahan tetap mengikuti subscription. Semua penulis interval kalender memakai lock workspace dalam transaksi sebelum membaca slot, termasuk create seri dan edit Guru. Inbox parent juga memvalidasi ulang resource terhadap keluarga saat ini, sehingga notifikasi anak yang telah pindah tidak ikut terbaca.

Guard verify/redeem menggunakan pesan backend terpusat: kode salah meminta pengguna memeriksa kode; kode dicabut/diganti/legacy tanpa target atau target unavailable memakai “Kode referral sudah tidak aktif. Silakan minta kode referral terbaru kepada Guru.” Kode aktif yang salah peran diberi arahan memilih peran yang sesuai. DTO memberi pesan kode salah yang sama untuk input kosong/malformed/non-string, tanpa duplikasi validator. Flutter hanya menampilkan `error.message`. Transaksi, rate limit, dan pemisahan izin Guru tetap berlaku; error database tidak disamarkan menjadi kode salah. Masa pakai kode tidak disamakan dengan masa sesi access/refresh.

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

Seed tidak dijalankan di production dan tidak menimpa workspace yang berisi siswa. Seed password tidak dicatat pada log. Library Pino meredaksi authorization, cookies, dan request body; log request menyertakan request ID. Development menampilkan lifecycle dalam format Nest dan request Pino yang mudah dibaca; production menggunakan JSON.

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

## Jadwal kelompok dan presensi batch

`POST /api/v1/schedules` menerima `studentIds` (1–100 UUID unik), atau `studentId` legacy. Server mengotorisasi semua siswa aktif dalam transaksi dengan calendar lock. Seri/occurrence tetap menyimpan row individual per anak, dengan `groupId` opsional yang dibuat server. Tidak perlu menghapus/mengubah index unik lama atau memigrasikan jadwal existing.

List Guru tanpa filter siswa mengelompokkan **sebelum pagination/count**; detail memiliki `participants`. Home menghitung kelompok sekali. Portal tetap menggunakan student/family scope individual, tidak menerima daftar peserta keluarga lain. Reschedule Guru memindahkan seluruh peserta pada occurrence tersebut; approval orang tua hanya memindahkan occurrence anak terkait, sehingga terpisah dari kelompok jika waktunya berbeda. Sesi yang sudah memiliki presensi tersimpan tidak bisa dipindahkan bersama.

`PATCH /api/v1/sessions/:id/attendance-batch` menerima `entries:[{sessionId,attendance}]`. Validasi membership/status semua entry, conditional writes dan event outbox dilakukan atomik. Delivery setelah commit; parent recipient berasal dari child session aktual. Status pending yang tidak dipilih tidak diubah; input terkunci/asing menolak seluruh batch. Legacy single attendance tetap tersedia. Menggunakan service Mongo/FCM existing, tidak menambah Docker/dependency atau mengubah entitlement.

`npm run test:schedule-groups` masuk `npm run verify:source` (fake database/source-only, bukan bukti transaksi Mongo nyata). [Kontrak](../docs/GROUP_SCHEDULES.md), [hasil pemeriksaan](../docs/VERIFICATION.md).

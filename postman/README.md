# Postman collection notifikasi NALARA

Import file `Nalara-Notifications.postman_collection.json` ke Postman.

## Cara menjalankan

1. Pastikan backend berjalan di `http://localhost:3100` atau ubah collection variable `baseUrl`.
2. Buka tab **Variables** pada collection, isi `teacherEmail` dan `teacherPassword` dengan akun Guru development.
3. Jalankan **Login Guru**.
4. Jalankan request di folder **2 - Persiapan Data dan Portal** sesuai kebutuhan. Request yang bertanda opsional boleh dilewati jika ID dan referral sudah ada.
5. Jalankan folder **3 - Trigger Notifikasi Domain** secara berurutan.
6. Periksa penerima melalui folder **4 - Inbox Notifikasi**.
7. Untuk menguji push Firebase, ambil token FCM dari aplikasi lalu isi `teacherDeviceToken`, `parentDeviceToken`, dan `studentDeviceToken`. Jalankan registrasi device sebelum trigger notifikasi.
8. Untuk target jatuh tempo dan reminder jadwal, jalankan request scheduler setelah `NOTIFICATION_SCHEDULER_INTERVAL_MINUTES` terlewati. Nilai default backend adalah 15 menit.

## Skenario yang dicakup

- Presensi `present` → Orang Tua siswa terkait.
- Permintaan perubahan jadwal dari Orang Tua → Guru yang memiliki sesi terkait.
- Target baru → Orang Tua dan Siswa terkait.
- Progress `shared` → Orang Tua dan Siswa terkait.
- Laporan `shared` yang dipublish → Orang Tua dan Siswa terkait.
- Reminder target H-1 dan jadwal H-1 → diproses worker scheduler.
- Inbox Guru, Orang Tua, dan Siswa.
- Tandai satu notifikasi terbaca dan tandai semua terbaca.
- Registrasi/pencabutan device FCM.
- Retry delivery Guru untuk status `pending`/`failed`.

Postman hanya menguji API dan registrasi device. Perilaku tampilan foreground/background, suara, dan redirect saat push ditekan tetap perlu diverifikasi di aplikasi Flutter menggunakan token FCM perangkat nyata.

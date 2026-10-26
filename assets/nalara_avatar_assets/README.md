# NALARA Avatar Assets

Starter pack berisi 18 avatar profil 3D-cartoon dalam format WebP, ukuran 256x256 px.
Setiap avatar menyertakan latar lingkaran pastel agar cocok dipakai sebagai gambar profil. File dipotong dari katalog karakter dan label teks tidak disertakan.

## Struktur
- `student/`: 6 avatar siswa (2 laki-laki, 2 perempuan tanpa hijab, 2 perempuan hijab)
- `adult/`: 6 avatar orang tua/dewasa (2 laki-laki, 2 perempuan tanpa hijab, 2 perempuan hijab)
- `teacher/`: 6 avatar guru (2 laki-laki, 2 perempuan tanpa hijab, 2 perempuan hijab)
- `manifest.json`: ID, label, role, dan path URL yang disarankan

## Contoh URL setelah disajikan oleh NestJS
`https://api.domainlu.com/avatars/student/student_boy_01.webp`

Pastikan path `/avatars` dipetakan ke folder aset saat deployment, dan file gambar ikut tercopy dalam Docker image/build deployment.

## Saran implementasi
Simpan `avatarId` di profil MongoDB, misalnya `student_boy_01`, bukan binary gambar. API dapat mengembalikan `avatarId` dan URL berdasarkan manifest/katalog.

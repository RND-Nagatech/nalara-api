// Development-only PDF design fixture. No application, server, DB or provider.
const {readFile, writeFile, mkdir} = require('node:fs/promises');
const path = require('node:path');
const {source} = require('../test/helpers/source.cjs');
const {renderReportPdf} = source('modules/tutor-tools/report-pdf.ts');

function fixture() {
  return {
    teacherName: 'Nadia Putri', timezone: 'Asia/Jakarta', preview: true,
    generatedAt: new Date('2026-10-18T03:00:00Z'),
    student: {name: 'Raka Pratama', grade: 'Kelas 5 SD'}, subject: {name: 'Matematika'},
    branding: {displayName: 'Ruang Tumbuh', tagline: 'Belajar terarah, tumbuh dengan percaya diri.', accentColor: '#155D49',
      footer: 'Terima kasih telah mendampingi proses belajar Raka. Kemajuan kecil yang konsisten menjadi fondasi untuk langkah berikutnya.'},
    lesson: {startAt: new Date('2026-10-15T08:00:00Z'), endAt: new Date('2026-10-15T09:00:00Z'), attendance: 'present'},
    report: {status: 'published', visibility: 'shared', topic: 'Pecahan senilai dan penjumlahan pecahan',
      summary: 'Raka berlatih mengenali pecahan senilai menggunakan gambar dan contoh sehari-hari. Latihan dilanjutkan dengan menjumlahkan pecahan berpenyebut sama.',
      observations: 'Raka lebih percaya diri menjelaskan langkah pengerjaan dan mulai memeriksa jawabannya secara mandiri.',
      difficulties: 'Masih perlu pendampingan saat menyamakan penyebut sebelum menjumlahkan pecahan.',
      homework: 'Kerjakan lima soal latihan pecahan. Tuliskan langkah penyelesaian, bukan hanya jawaban akhir.',
      recommendation: 'Pertemuan berikutnya berfokus pada pecahan berpenyebut berbeda dengan bantuan model visual.'},
  };
}

async function main() {
  const root = path.resolve(__dirname, '../..');
  const output = path.join(root, 'output/pdf');
  const temporary = path.join(root, 'tmp/pdfs');
  await mkdir(output, {recursive: true}); await mkdir(temporary, {recursive: true});
  const data = fixture();
  data.logo = await readFile(path.join(root, 'flutter-apk/assets/Logo/LOGO_SQUARE.png'));
  await writeFile(path.join(output, 'nalara-laporan-contoh.pdf'), await renderReportPdf(data));
  const long = fixture();
  long.branding.displayName = 'Pusat Pendampingan Belajar dan Pengembangan Keterampilan Nusantara';
  long.branding.tagline = 'Pendampingan belajar privat untuk akademik, musik, bahasa, dan keterampilan dengan laporan perkembangan yang jelas bagi keluarga.';
  long.student.name = 'Contoh Siswa dengan Nama Panjang untuk Pemeriksaan Tata Letak';
  long.subject.name = 'Piano dan Teori Musik - Pendampingan Membaca Notasi serta Koordinasi Tangan';
  long.report.status = 'draft'; long.report.visibility = 'teacher';
  for (const field of ['summary', 'observations', 'difficulties', 'homework', 'recommendation']) {
    long.report[field] = `${field.toUpperCase()} AWAL\n` + 'Catatan belajar panjang, konsisten, dan terukur. '.repeat(60) + `\n${field.toUpperCase()} SELESAI`;
  }
  long.report.homework += '\n' + 'REFERENSIPANJANG'.repeat(35);
  await writeFile(path.join(temporary, 'nalara-laporan-panjang.pdf'), await renderReportPdf(long));
  console.log('Generated fictional logo preview and long/internal draft layout check');
}
if (require.main === module) void main().catch(error => {console.error(error); process.exitCode = 1;});
module.exports = {fixture};

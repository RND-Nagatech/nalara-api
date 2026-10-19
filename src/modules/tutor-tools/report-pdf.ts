import PDFDocument from 'pdfkit';
import { resolve } from 'node:path';
import type { Readable } from 'node:stream';
import type { LessonReport, LessonSession, Student, Subject, TutorPreferences } from '../../database/entities';

export interface ReportPdfInput {
  report: LessonReport;
  lesson: LessonSession;
  student: Student;
  subject: Subject;
  branding: Pick<TutorPreferences, 'displayName'|'tagline'|'footer'|'accentColor'>;
  teacherName: string;
  timezone: string;
  logo?: Buffer;
  generatedAt?: Date;
  preview?: boolean;
}

const palette = {ink: '#22382F', muted: '#68766E', line: '#DFE7DF', cream: '#F8F7F1', sage: '#EEF4ED'};
const margin = 48;
const fonts = resolve(__dirname, '../../../assets/report-fonts');
const clean = (value: string) => Array.from(value.replace(/[\u2010-\u2015]/g, '-').replace(/\r\n?/g, '\n'))
  .filter(char => char.charCodeAt(0) >= 32 || char === '\n' || char === '\t').join('').trim();

/** Pure renderer: receives already-authorized records and a local decoded logo.
 * Explicit line layout keeps headings, long words and footers inside each page.
 */
export async function renderReportPdf(input: ReportPdfInput): Promise<Buffer> {
  const {report, lesson, student, subject, branding} = input;
  const accent = /^#[0-9a-f]{6}$/i.test(branding.accentColor) ? branding.accentColor : '#155D49';
  const doc = new PDFDocument({size: 'A4', bufferPages: true, autoFirstPage: false,
    margins: {top: 88, bottom: 88, left: margin, right: margin},
    info: {Title: `Laporan belajar - ${student.name}`, Author: input.teacherName, Creator: 'NALARA', Subject: 'Laporan perkembangan belajar'}});
  const bytes = new Promise<Buffer>((accept, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => accept(Buffer.concat(chunks))); doc.on('error', reject);
  });
  doc.registerFont('Body', resolve(fonts, 'NalaraSans-Regular.ttf'));
  doc.registerFont('Strong', resolve(fonts, 'NalaraSans-SemiBold.ttf'));
  doc.registerFont('Title', resolve(fonts, 'NalaraSerif-SemiBold.ttf'));
  const pageWidth = 595.28, pageHeight = 841.89;
  const width = pageWidth - margin * 2, bottom = pageHeight - 88;
  const brand = clean(branding.displayName || 'NALARA');
  const audience = report.visibility === 'teacher' ? 'INTERNAL GURU' : report.visibility === 'student' ? 'GURU DAN SISWA' : 'GURU, SISWA DAN ORANG TUA';
  let y = 0;

  function style(font = 'Body', size = 10.5, color = palette.ink) {doc.font(font).fontSize(size).fillColor(color);}
  function text(value: string, x: number, at: number, size = 10.5, font = 'Body', color = palette.ink) {
    style(font, size, color); doc.text(value, x, at, {lineBreak: false});
  }
  function wrap(value: string, maxWidth: number, font = 'Body', size = 10.5): string[] {
    style(font, size);
    const lines: string[] = [];
    for (const paragraph of clean(value).split('\n')) {
      if (!paragraph.trim()) {lines.push(''); continue;}
      let line = '';
      for (const word of paragraph.trim().split(/\s+/)) {
        if (doc.widthOfString(line ? `${line} ${word}` : word) <= maxWidth) {line = line ? `${line} ${word}` : word; continue;}
        if (line) {lines.push(line); line = '';}
        // Also wrap an unbroken ID/URL rather than clipping at the right edge.
        for (const char of Array.from(word)) {
          if (line && doc.widthOfString(line + char) > maxWidth) {lines.push(line); line = '';}
          line += char;
        }
      }
      if (line) lines.push(line);
    }
    return lines;
  }
  function rule(at: number) {doc.moveTo(margin, at).lineTo(pageWidth - margin, at).lineWidth(0.7).strokeColor(palette.line).stroke();}
  function page(first = false) {
    doc.addPage();
    doc.rect(0, 0, pageWidth, 7).fill(accent);
    if (!first) {
      text('LAPORAN PERKEMBANGAN BELAJAR', margin, 32, 8, 'Strong', accent);
      const label = `${student.name} - ${subject.name}`;
      const lines = wrap(label, width - 14, 'Body', 9);
      // The continuation header is intentionally compact; full identity stays
      // on page one and no report content is truncated.
      text(lines.length > 1 ? `${lines[0]}...` : lines[0], margin, 48, 9, 'Body', palette.muted);
      rule(70); y = 88;
    }
  }
  function ensure(height: number) {if (y + height > bottom) page();}
  function heading(title: string, number?: number) {
    ensure(44);
    if (number !== undefined) {
      doc.roundedRect(margin, y - 2, 24, 24, 7).fill(palette.sage);
      text(String(number).padStart(2, '0'), margin + 5, y + 3, 8, 'Strong', accent);
    }
    text(title, margin + (number === undefined ? 0 : 34), y, 11.5, 'Strong', accent);
    y += 22;
  }
  function body(value: string, title: string, inset = 34) {
    const lines = wrap(value, width - inset);
    for (const line of lines) {
      if (y + 15 > bottom) {page(); heading(`${title} (lanjutan)`);}
      if (line) text(line, margin + inset, y);
      y += 15;
    }
    y += 8;
  }
  try {
    page(true);
    const textX = input.logo ? margin + 82 : margin;
    const brandLines = wrap(brand, pageWidth - margin - textX, 'Strong', 19);
    const taglineLines = branding.tagline ? wrap(branding.tagline, pageWidth - margin - textX, 'Body', 9.5) : [];
    const brandHeight = Math.max(input.logo ? 64 : 0, brandLines.length * 24 + (taglineLines.length ? 8 + taglineLines.length * 14 : 0));
    const headerEnd = 38 + brandHeight + 78;
    doc.rect(0, 7, pageWidth, headerEnd - 7).fill(palette.cream);
    if (input.logo) {
      doc.roundedRect(margin, 36, 66, 66, 14).fill('#FFFFFF');
      doc.image(input.logo, margin + 5, 41, {fit: [56, 56], align: 'center', valign: 'center'});
    }
    brandLines.forEach((line, index) => text(line, textX, 38 + index * 24, 19, 'Strong', accent));
    taglineLines.forEach((line, index) => text(line, textX, 38 + brandLines.length * 24 + 8 + index * 14, 9.5, 'Body', palette.muted));
    y = 38 + brandHeight + 12;
    text('LAPORAN SESI', margin, y, 8.5, 'Strong', accent);
    const status = report.status === 'draft' ? 'DRAF - BELUM DITERBITKAN' : 'LAPORAN TERBIT';
    style('Strong', 8);
    const pillWidth = doc.widthOfString(status) + 20;
    doc.roundedRect(pageWidth - margin - pillWidth, y - 5, pillWidth, 23, 11).fill(report.status === 'draft' ? '#FFF0D9' : '#E6F0E7');
    text(status, pageWidth - margin - pillWidth + 10, y + 1, 8, 'Strong', report.status === 'draft' ? '#896123' : accent);
    y += 22;
    text('Perkembangan belajar', margin, y, 24, 'Title');
    y = headerEnd + 16;

    const date = new Intl.DateTimeFormat('id-ID', {timeZone: input.timezone, dateStyle: 'long'});
    const clock = new Intl.DateTimeFormat('id-ID', {timeZone: input.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'});
    const sameDate = date.format(lesson.startAt) === date.format(lesson.endAt);
    const times = `${clock.format(lesson.startAt)} - ${sameDate ? '' : date.format(lesson.endAt) + ', '}${clock.format(lesson.endAt)}`;
    const attendance = {pending: 'Belum dicatat', present: 'Hadir', excused: 'Izin', absent: 'Tidak hadir', cancelled: 'Dibatalkan'}[lesson.attendance];
    const metadata = [['Siswa', `${student.name}${student.grade ? '\n' + student.grade : ''}`], ['Bidang belajar', subject.name],
      ['Tanggal pertemuan', date.format(lesson.startAt)], [`Waktu (${input.timezone})`, times],
      ['Pengajar', input.teacherName], ['Presensi', attendance]];
    const colWidth = (width - 54) / 2;
    const rows = [0, 2, 4].map(index => metadata.slice(index, index + 2).map(([label, value]) => ({label, lines: wrap(value, colWidth)})));
    const heights = rows.map(row => 13 + Math.max(...row.map(cell => cell.lines.length)) * 13 + 9);
    const cardHeight = heights.reduce((sum, height) => sum + height, 0) + 20;
    doc.roundedRect(margin, y, width, cardHeight, 16).fillAndStroke('#FFFFFF', palette.line);
    let rowY = y + 17;
    rows.forEach((row, rowIndex) => {
      row.forEach((cell, column) => {
        const x = margin + 18 + column * (colWidth + 18);
        text(cell.label, x, rowY, 8.5, 'Body', palette.muted);
        cell.lines.forEach((line, index) => text(line, x, rowY + 13 + index * 13, 10.5, 'Strong'));
      });
      rowY += heights[rowIndex];
    });
    y += cardHeight + 20;
    const sections = [['Materi / topik', report.topic], ['Ringkasan sesi', report.summary],
      ['Perkembangan yang diamati', report.observations], ['Kesulitan yang dialami', report.difficulties],
      ['Latihan lanjutan', report.homework], ['Rekomendasi berikutnya', report.recommendation]];
    sections.forEach(([title, value], index) => {
      if (!value?.trim()) return;
      heading(title, index + 1); body(value, title);
    });
    if (branding.footer?.trim()) {heading('Catatan penutup'); body(branding.footer, 'Catatan penutup', 0);}
    const range = doc.bufferedPageRange();
    for (let index = range.start; index < range.start + range.count; index++) {
      doc.switchToPage(index); rule(pageHeight - 66);
      text(`${report.status === 'draft' ? 'DRAF | ' : ''}${audience}`, margin, pageHeight - 53, 8, 'Strong', accent);
      style('Body', 8);
      const numbering = `Halaman ${index + 1} dari ${range.count}`;
      text(numbering, pageWidth - margin - doc.widthOfString(numbering), pageHeight - 53, 8, 'Body', palette.muted);
      const generated = date.format(input.generatedAt ?? new Date());
      text(input.preview ? 'CONTOH DESAIN - DATA FIKTIF' : `Disusun melalui NALARA | Diekspor ${generated}`, margin, pageHeight - 36, 7.5, 'Body', palette.muted);
    }
    doc.end();
  } catch (error) {(doc as unknown as Readable).destroy(error as Error);}
  return bytes;
}

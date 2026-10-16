import 'reflect-metadata';
import { createApplication } from '../main';
import { AuthService } from '../modules/auth/auth.service';
import { Database } from './database.module';
import { StudentsService } from '../modules/students/students.service';
import { SubjectsService } from '../modules/subjects/subjects.module';
import { SchedulesService } from '../modules/schedules/schedules.service';
import { LearningService } from '../modules/learning-plans/learning.service';
import { ReportsService } from '../modules/lesson-reports/reports.service';
import { ListQuery } from '../common/query.dto';
import { safeUser } from '../modules/auth/auth.service';
async function seed() {
  if (process.env.NODE_ENV === 'production') throw new Error('Seed dilarang pada production');
  const app=await createApplication();
  try {
    await app.init();
    const email=process.env.SEED_EMAIL, password=process.env.SEED_PASSWORD;
    if (!email || !password) throw new Error('Isi SEED_EMAIL dan SEED_PASSWORD (minimal 8 karakter, huruf besar/kecil, angka, simbol)');
    const db=app.get(Database), auth=app.get(AuthService);
    const existing=await db.collection('users').findOne({email:email.toLowerCase()}).lean();
    const phone=process.env.SEED_PHONE;
    if (!existing && !phone) throw new Error('Isi SEED_PHONE untuk membuat akun demo baru');
    const actor=existing ? safeUser(existing) : (await auth.register({name:'Bu Nara',email,password,phone:phone!,passwordConfirmation:password})).user;
    if (existing) await auth.login({email,password});
    if(await db.collection('students').exists({workspaceId:actor.workspaceId})) { process.stdout.write('Workspace sudah berisi data; seed tidak mengubah data yang ada.\n'); return; }
    const student=await app.get(StudentsService).create(actor,{name:'Alya Putri',grade:'Kelas 5'});
    const subject=await app.get(SubjectsService).create(actor,{name:'Matematika'});
    const start=new Date(); start.setUTCHours(8,0,0,0); const end=new Date(start.getTime()+3600_000);
    await app.get(SchedulesService).create(actor,{studentId:student._id,subjectId:subject._id,startAt:start.toISOString(),endAt:end.toISOString(),timezone:'Asia/Jakarta',recurrence:'weekly',repeatCount:4});
    const sessions=await app.get(SchedulesService).sessions(actor,new ListQuery());
    const lesson=sessions.items[0];
    const plan=await app.get(LearningService).createPlan(actor,{studentId:student._id,subjectId:subject._id,title:'Pecahan · Minggu ini',startAt:new Date(start.getTime()-86400_000).toISOString(),endAt:new Date(start.getTime()+6*86400_000).toISOString(),targets:[{title:'Memahami konsep pecahan',successCriteria:'Menjelaskan pembilang dan penyebut'},{title:'Operasi penjumlahan pecahan'},{title:'Menyelesaikan soal cerita'}]});
    const target=plan.targets[0];
    await app.get(LearningService).updateProgress(actor,target._id,{progress:20,version:0,note:'Mulai mengenali pecahan',visibility:'teacher',sessionId:lesson._id});
    await app.get(LearningService).updateProgress(actor,target._id,{progress:60,version:1,note:'Dapat menyelesaikan latihan dengan lebih mandiri',visibility:'shared',sessionId:lesson._id});
    await app.get(ReportsService).create(actor,lesson._id,{topic:'Mengenal pecahan',summary:'Membahas pecahan melalui contoh sehari-hari.',targetIds:[target._id],observations:'Lebih percaya diri menjawab pertanyaan.',homework:'Latihan 5 soal pecahan.',visibility:'shared'});
    process.stdout.write(`Seed berhasil untuk ${email}. Kata sandi tidak dicatat.\n`);
  } finally { await app.close(); }
}
void seed().catch(error=>{ process.stderr.write(`${error instanceof Error ? error.message : 'Seed gagal'}\n`); process.exitCode=1; });

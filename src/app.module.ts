import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { APP_GUARD } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { randomUUID } from 'node:crypto';
import { validateEnvironment } from './config/environment';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './modules/auth/auth.module';
import { AuthGuard } from './modules/auth/auth.guard';
import { HealthModule } from './health/health.module';
import { ScopedService } from './common/scoped.service';
import { StudentsModule } from './modules/students/students.module';
import { SubjectsModule } from './modules/subjects/subjects.module';
import { SchedulesModule } from './modules/schedules/schedules.module';
import { LearningModule } from './modules/learning-plans/learning.module';
import { ReportsModule } from './modules/lesson-reports/reports.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { InvitationsModule } from './modules/invitations/invitations.module';
import { FamiliesModule } from './modules/families/families.module';
import { ParentPortalModule } from './modules/parent-portal/parent-portal.module';
import { StudentPortalModule } from './modules/student-portal/student-portal.module';
import { SubscriptionsModule } from './modules/subscriptions/subscriptions.module';
import { SubscriptionGuard } from './modules/subscriptions/subscriptions.guard';
import { TutorToolsModule } from './modules/tutor-tools/tutor-tools.module';
import { TeachingGuideModule } from './modules/teaching-guide/teaching-guide.module';
import { AccountDeletionModule } from './modules/account-deletion/account-deletion.module';
import { AvatarsModule } from './modules/avatars/avatars.module';
import { StudentGroupsModule } from './modules/student-groups/student-groups.module';
import { TuitionFeesModule } from './modules/tuition-fees/tuition-fees.module';
import { TeacherProfileModule } from './modules/teacher-profile/teacher-profile.module';

@Global() @Module({providers:[ScopedService], exports:[ScopedService]}) class CommonModule {}
@Module({imports:[
  StudentGroupsModule,
  TuitionFeesModule,
  TeacherProfileModule,
  ConfigModule.forRoot({isGlobal:true, validate:validateEnvironment}),
  MongooseModule.forRootAsync({inject:[ConfigService], useFactory:(config:ConfigService) => ({uri:config.getOrThrow<string>('MONGODB_URI'), serverSelectionTimeoutMS:5000, socketTimeoutMS:10000, maxPoolSize:20, retryAttempts:2})}),
  LoggerModule.forRootAsync({
    imports: [ConfigModule],
    inject: [ConfigService],
    useFactory: (config: ConfigService) => ({
      pinoHttp: {
        level: config.get<string>('LOG_LEVEL') ?? 'info',
        transport: config.get<string>('NODE_ENV') === 'development'
          ? {target: 'pino-pretty', options: {colorize: true, singleLine: true, translateTime: 'SYS:standard'}}
          : undefined,
        genReqId: (req, res) => {
          const id = typeof req.headers['x-request-id'] === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(req.headers['x-request-id']) ? req.headers['x-request-id'] : randomUUID();
          res.setHeader('x-request-id', id);
          return id;
        },
        redact: ['req.headers.authorization', 'req.headers.cookie', 'req.body', 'res.headers["set-cookie"]'],
        serializers: {req: req => ({id: req.id, method: req.method, url: req.url?.split('?')[0]})},
      },
    }),
  }),
  ThrottlerModule.forRoot([{name:'default', ttl:60_000, limit:120}]),
  DatabaseModule, CommonModule, SubscriptionsModule, AuthModule, HealthModule, StudentsModule, SubjectsModule, SchedulesModule, LearningModule, ReportsModule, NotificationsModule, DashboardModule, InvitationsModule, FamiliesModule, ParentPortalModule, StudentPortalModule, TutorToolsModule, TeachingGuideModule, AccountDeletionModule, AvatarsModule,
], providers:[{provide:APP_GUARD,useClass:ThrottlerGuard},{provide:APP_GUARD,useClass:AuthGuard},{provide:APP_GUARD,useClass:SubscriptionGuard}]})
export class AppModule {}

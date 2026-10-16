import { Global, Injectable, Module, OnModuleInit } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import mongoose, { Connection, Model, Schema } from 'mongoose';
import { Collections } from './entities';
import { authSchemas } from '../modules/auth/auth.schemas';
import { studentsSchemas } from '../modules/students/students.schemas';
import { subjectsSchemas } from '../modules/subjects/subjects.schemas';
import { schedulesSchemas } from '../modules/schedules/schedules.schemas';
import { learningSchemas } from '../modules/learning-plans/learning-plans.schemas';
import { reportsSchemas } from '../modules/lesson-reports/lesson-reports.schemas';
import { invitationsSchemas } from '../modules/invitations/invitations.schemas';
import { notificationsSchemas } from '../modules/notifications/notifications.schemas';
import { auditSchemas } from '../modules/audit-events/audit-events.schemas';
import { familiesSchemas } from '../modules/families/families.schemas';
import { parentPortalSchemas } from '../modules/parent-portal/parent-portal.schemas';
import { subscriptionSchemas } from '../modules/subscriptions/subscriptions.schemas';
import { tutorToolsSchemas } from '../modules/tutor-tools/tutor-tools.schemas';
const schemas:Record<keyof Collections,Schema>={...authSchemas,...studentsSchemas,...subjectsSchemas,...schedulesSchemas,...learningSchemas,...reportsSchemas,...invitationsSchemas,...notificationsSchemas,...parentPortalSchemas,...auditSchemas,...familiesSchemas,...subscriptionSchemas,...tutorToolsSchemas};

@Injectable()
export class Database implements OnModuleInit {
  private readonly models = new Map<keyof Collections, Model<unknown>>();
  constructor(@InjectConnection() readonly connection: Connection) {
    mongoose.set('maxTimeMS', 10000);
    for (const name of Object.keys(schemas) as (keyof Collections)[]) this.models.set(name, connection.model(name, schemas[name]) as unknown as Model<unknown>);
  }
  collection<K extends keyof Collections>(name: K): Model<Collections[K]> { return this.models.get(name)! as Model<Collections[K]>; }
  async onModuleInit() { for (const model of this.models.values()) await model.init(); }
}
@Global()
@Module({providers: [Database], exports: [Database]})
export class DatabaseModule {}

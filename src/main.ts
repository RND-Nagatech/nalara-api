import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger as NestLogger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger as PinoLogger } from 'nestjs-pino';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { ApiExceptionFilter, EnvelopeInterceptor } from './common/api';
export async function createApplication() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {bufferLogs:true,rawBody:true});
  const config = app.get(ConfigService);
  app.useLogger(app.get(PinoLogger));
  app.use(helmet());
  app.useBodyParser('json', {limit:'64kb'});
  app.enableCors({origin:config.getOrThrow<string>('CORS_ORIGINS').split(',').map(value=>value.trim()), credentials:false});
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({whitelist:true, forbidNonWhitelisted:true, transform:true, forbidUnknownValues:true}));
  app.useGlobalFilters(new ApiExceptionFilter(app.get(PinoLogger)));
  app.useGlobalInterceptors(new EnvelopeInterceptor());
  app.enableShutdownHooks();
  const swaggerConfig = new DocumentBuilder().setTitle('NALARA Guru API').setVersion('1.0').addBearerAuth().setDescription('Response: {data: ...}. Lists: {data: {items,total,page,limit}}. Errors: {error: {code,message,requestId}}. Semua route domain khusus guru dalam workspace sesi.').build();
  const document=SwaggerModule.createDocument(app,swaggerConfig);
  const errorSchema={type:'object',properties:{error:{type:'object',properties:{code:{type:'string'},message:{oneOf:[{type:'string'},{type:'array',items:{type:'string'}}]},requestId:{type:'string'}}}}};
  for(const path of Object.values(document.paths)) for(const method of ['get','post','patch'] as const) {
    const operation=path?.[method]; if(!operation) continue;
    for(const code of Object.keys(operation.responses)) if(Number(code)<400) operation.responses[code]={description:'Successful response wrapped in {data}. List data includes items, total, page, limit.',content:{'application/json':{schema:{type:'object',properties:{data:{type:'object',additionalProperties:true}}}}}};
    for(const [status,description] of Object.entries({'400':'VALIDATION_ERROR: invalid input or domain rule','401':'UNAUTHENTICATED: missing/expired session or invalid code','403':'FORBIDDEN: teacher policy denied','404':'NOT_FOUND: resource missing or outside workspace','409':'CONFLICT: duplicate record or stale target version','429':'RATE_LIMITED: too many requests','500':'INTERNAL_ERROR: safe message and request ID','503':'UNAVAILABLE: database or email delivery unavailable'})) operation.responses[status]={description,content:{'application/json':{schema:errorSchema}}};
  }
  SwaggerModule.setup('api/docs',app,document);
  const server = app.getHttpServer(); server.requestTimeout = 30000; server.headersTimeout = 35000;
  return app;
}
async function bootstrap() {
  NestLogger.log('Starting NALARA API...', 'Bootstrap');

  try {
    const app = await createApplication();
    NestLogger.log('Application modules initialized', 'Bootstrap');

    const port = app.get(ConfigService).get<number>('PORT') ?? 3100;
    await app.listen(port, '0.0.0.0');
    NestLogger.log(`API listening on port ${port}`, 'Bootstrap');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    NestLogger.error(`API startup failed: ${message}`, 'Bootstrap');
    process.exitCode = 1;
  }
}

if (require.main === module) void bootstrap();

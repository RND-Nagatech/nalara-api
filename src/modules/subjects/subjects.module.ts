import { Body, ConflictException, Controller, Get, Injectable, Module, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { ApiBearerAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { Actor, IdPipe, Principal } from '../../common/api';
import { ListQuery } from '../../common/query.dto';
import { ScopedService } from '../../common/scoped.service';
export class SubjectDto {
  @ApiProperty() @Transform(({value}) => typeof value === 'string' ? value.trim() : value)
  @IsString() @MinLength(2) @MaxLength(100) name!:string;
}
@Injectable() export class SubjectsService {
  constructor(private readonly scope:ScopedService) {}
  list(a:Principal,q:ListQuery) { return this.scope.list('subjects',a,q); }
  get(a:Principal,id:string) { return this.scope.get('subjects',id,a); }
  async create(a:Principal,d:SubjectDto) {
    try {
      return await this.scope.db.collection('subjects').create({workspaceId:a.workspaceId,name:d.name.trim()});
    } catch (error) {
      if ((error as {code?:number})?.code === 11000) throw new ConflictException('Nama bidang belajar sudah digunakan.');
      throw error;
    }
  }
  async update(a:Principal,id:string,d:SubjectDto) {
    // Resolve ownership before attempting a rename or reporting a name conflict.
    await this.get(a,id);
    try {
      const subject = await this.scope.db.collection('subjects').findOneAndUpdate(
        {_id:id,workspaceId:a.workspaceId},
        {$set:{name:d.name.trim()}},
        {returnDocument:'after',runValidators:true},
      ).lean();
      if (!subject) throw new NotFoundException('Bidang belajar tidak ditemukan');
      return subject;
    } catch (error) {
      if ((error as {code?:number})?.code === 11000) throw new ConflictException('Nama bidang belajar sudah digunakan.');
      throw error;
    }
  }
}
@ApiTags('Subjects') @ApiBearerAuth() @Controller('subjects') export class SubjectsController {
  constructor(private readonly service:SubjectsService) {}
  @Get() list(@Actor() a:Principal,@Query() q:ListQuery) { return this.service.list(a,q); }
  @Post() create(@Actor() a:Principal,@Body() d:SubjectDto) { return this.service.create(a,d); }
  @Get(':id') get(@Actor() a:Principal,@Param('id',IdPipe) id:string) { return this.service.get(a,id); }
  @Patch(':id') update(@Actor() a:Principal,@Param('id',IdPipe) id:string,@Body() d:SubjectDto) { return this.service.update(a,id,d); }
}
@Module({controllers:[SubjectsController],providers:[SubjectsService]}) export class SubjectsModule {}

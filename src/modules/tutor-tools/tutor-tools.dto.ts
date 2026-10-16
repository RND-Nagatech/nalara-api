import { IsBoolean, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Matches, MaxLength, Min, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
const Trim = () => Transform(({value}) => typeof value === 'string' ? value.trim() : value);
export class AssignmentDto {
  @ApiProperty() @IsUUID('4') studentId!: string;
  @ApiProperty() @IsUUID('4') subjectId!: string;
  @ApiProperty({enum:['task','material']}) @IsIn(['task', 'material']) kind!: 'task' | 'material';
  @ApiProperty() @Trim() @IsString() @MinLength(2) @MaxLength(200) title!: string;
  @ApiProperty() @Trim() @IsString() @MinLength(2) @MaxLength(10000) content!: string;
  @ApiPropertyOptional() @IsISO8601({strict: true}) @IsOptional() dueAt?: string;
  @ApiProperty({enum:['draft','published','archived']}) @IsIn(['draft', 'published', 'archived']) status!: 'draft' | 'published' | 'archived';
  @ApiProperty({enum:['student','shared']}) @IsIn(['student', 'shared']) visibility!: 'student' | 'shared';
}
export class SubmissionDto {
  @ApiProperty() @Trim() @IsString() @MinLength(1) @MaxLength(10000) text!: string;
  @ApiProperty() @IsInt() @Min(0) version!: number;
}
export class FeedbackDto { @ApiProperty() @Trim() @IsString() @MinLength(1) @MaxLength(5000) feedback!: string; @ApiProperty() @IsInt() @Min(0) version!: number; }
export class TemplateDto {
  @ApiProperty() @Trim() @IsString() @MinLength(2) @MaxLength(100) name!: string;
  @ApiProperty() @IsString() @MaxLength(200) topic!: string;
  @ApiProperty() @IsString() @MaxLength(3000) summary!: string;
  @ApiProperty() @IsString() @MaxLength(3000) observations!: string;
  @ApiProperty() @IsString() @MaxLength(3000) difficulties!: string;
  @ApiProperty() @IsString() @MaxLength(3000) homework!: string;
  @ApiProperty() @IsString() @MaxLength(3000) recommendation!: string;
}
export class BrandingDto {
  @ApiProperty() @IsString() @MaxLength(100) displayName!: string;
  @ApiProperty() @IsString() @MaxLength(200) tagline!: string;
  @ApiProperty() @IsString() @MaxLength(300) footer!: string;
  @ApiProperty() @Matches(/^#[0-9a-fA-F]{6}$/) accentColor!: string;
}
export class PreferencesDto {
  @ApiProperty() @IsBoolean() reminders!: boolean;
  @ApiProperty() @IsBoolean() progress!: boolean;
  @ApiProperty() @IsBoolean() reports!: boolean;
  @ApiProperty() @IsBoolean() assignments!: boolean;
}

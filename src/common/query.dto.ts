import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
export class ListQuery {
  @ApiPropertyOptional({default: 1}) @Type(() => Number) @IsInt() @Min(1) @IsOptional() page = 1;
  @ApiPropertyOptional({default: 30, maximum: 100}) @Type(() => Number) @IsInt() @Min(1) @Max(100) @IsOptional() limit = 30;
  @ApiPropertyOptional() @IsString() @MaxLength(100) @IsOptional() search?: string;
  @ApiPropertyOptional({enum:['active','archived','draft','published','scheduled','completed','cancelled','pending','approved','rejected','expired']}) @IsIn(['active','archived','draft','published','scheduled','completed','cancelled','pending','approved','rejected','expired']) @IsOptional() status?: string;
  @ApiPropertyOptional() @IsUUID('4') @IsOptional() studentId?: string;
  @ApiPropertyOptional() @IsUUID('4') @IsOptional() planId?: string;
  @ApiPropertyOptional() @IsUUID('4') @IsOptional() scheduleId?: string;
  @ApiPropertyOptional() @IsUUID('4') @IsOptional() sessionId?: string;
  @ApiPropertyOptional() @IsISO8601({strict:true}) @IsOptional() from?: string;
  @ApiPropertyOptional() @IsISO8601({strict:true}) @IsOptional() to?: string;
}

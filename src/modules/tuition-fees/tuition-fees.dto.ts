import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsIn, IsInt, Matches, Max, Min } from 'class-validator';

export class SaveTuitionFeeDto {
  @ApiProperty({description: 'Nominal rupiah utuh'}) @IsInt() @Min(1) @Max(1_000_000_000_000) amount!: number;
  @ApiProperty({example: '2026-11-05'}) @Matches(/^\d{4}-\d{2}-\d{2}$/) @IsDateString({strict: true}) dueDate!: string;
  @ApiProperty({enum: ['unpaid', 'paid']}) @IsIn(['unpaid', 'paid']) status!: 'unpaid' | 'paid';
  @ApiProperty({description: '0 jika belum ada, selain itu version dari GET'}) @IsInt() @Min(0) version!: number;
}

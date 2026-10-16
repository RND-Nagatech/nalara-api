import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, MaxLength, MinLength, ValidateBy } from 'class-validator';
import { isNormalizedReferralCode, normalizeReferralCode } from './referral-code';
import { referralMessages } from './referral-errors';

// One constraint produces one clear message, including empty/non-string input.
const IsReferralCode = () => ValidateBy({name:'isReferralCode',validator:{validate:isNormalizedReferralCode,defaultMessage:()=>referralMessages.wrongCode}});
export class InvitationCodeDto {
  @ApiProperty({description:'Kode referral NLR-…; kode lama 43 karakter juga dikenali.'}) @Transform(({value})=>normalizeReferralCode(value)) @IsReferralCode() token!:string;
  @ApiPropertyOptional({enum:['student','parent']}) @IsIn(['student','parent'],{message:referralMessages.invalidRole}) @IsOptional() audience?:'student'|'parent';
}
export class RedeemCodeDto {
  @ApiProperty() @Transform(({value})=>normalizeReferralCode(value)) @IsReferralCode() token!:string;
  @ApiProperty({enum:['student','parent']}) @IsIn(['student','parent'],{message:referralMessages.invalidRole}) audience!:'student'|'parent';
}
export class PortalRefreshDto { @ApiProperty() @IsString() @MinLength(40) @MaxLength(100) refreshToken!:string; }

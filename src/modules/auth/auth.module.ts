import { Body, Controller, Get, HttpCode, Module, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Actor, AuthRequest, Principal, Public } from '../../common/api';
import { AuthService } from './auth.service';
import { ForgotDto, GoogleLoginDto, LoginDto, RefreshDto, RegisterDto, ResetDto, VerifyResetOtpDto } from './auth.dto';
import { FirebaseAuthService } from './firebase-auth.service';
import { PasswordResetOtpService } from './password-reset-otp.service';
import { ResendMailService } from './resend-mail.service';
@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private readonly service: AuthService) {}
  @Public() @Throttle({default:{limit:8, ttl:60_000}}) @Post('register') register(@Body() dto: RegisterDto) { return this.service.register(dto); }
  @Public() @Throttle({default:{limit:10, ttl:60_000}}) @Post('login') @HttpCode(200) login(@Body() dto: LoginDto) { return this.service.login(dto); }
  @Public() @Throttle({default:{limit:10, ttl:60_000}}) @Post('google') @HttpCode(200) google(@Body() dto: GoogleLoginDto) { return this.service.loginWithGoogle(dto); }
  @Public() @Post('refresh') @HttpCode(200) refresh(@Body() dto: RefreshDto) { return this.service.refresh(dto.refreshToken); }
  @ApiBearerAuth() @Post('logout') @HttpCode(200) logout(@Req() req: AuthRequest) { return this.service.logout(req.sessionId); }
  @Public() @Throttle({default:{limit:3, ttl:60_000}}) @Post('forgot-password') @HttpCode(200) forgot(@Body() dto: ForgotDto) { return this.service.forgot(dto); }
  @Public() @Throttle({default:{limit:10, ttl:60_000}}) @Post('verify-reset-otp') @HttpCode(200) verifyResetOtp(@Body() dto: VerifyResetOtpDto) { return this.service.verifyResetOtp(dto); }
  @Public() @Throttle({default:{limit:5, ttl:60_000}}) @Post('reset-password') @HttpCode(200) reset(@Body() dto: ResetDto) { return this.service.reset(dto); }
}
@ApiTags('Profile') @ApiBearerAuth() @Controller('me')
export class MeController { @Get() me(@Actor() actor: Principal) { return actor; } }
@Module({
  controllers: [AuthController, MeController],
  providers: [
    AuthService,
    FirebaseAuthService,
    PasswordResetOtpService,
    ResendMailService,
  ],
  exports: [AuthService, FirebaseAuthService],
})
export class AuthModule {}

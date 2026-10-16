import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[character] ?? character));

@Injectable()
export class ResendMailService {
  private readonly logger = new Logger(ResendMailService.name);
  constructor(private readonly config: ConfigService) {}

  async sendPasswordResetOtp(to: string, otp: string, expiresInSeconds: number) {
    const apiKey = this.config.get<string>('RESEND_API_KEY');
    const from = this.config.get<string>('RESEND_FROM_EMAIL');
    if (!apiKey || !from) throw new ServiceUnavailableException('Pengiriman email reset belum dikonfigurasi.');
    const recipient = this.config.get<string>('NODE_ENV') !== 'production'
      ? (this.config.get<string>('RESEND_TEST_RECIPIENT') || to)
      : to;
    const expiresInMinutes = Math.max(1, Math.ceil(expiresInSeconds / 60));
    const safeOtp = escapeHtml(otp);
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {'content-type': 'application/json', authorization: `Bearer ${apiKey}`},
        body: JSON.stringify({
          from,
          to: [recipient],
          subject: 'Kode OTP reset password NALARA',
          text: `Kode OTP reset password NALARA: ${otp}. Kode berlaku ${expiresInMinutes} menit. Jika Anda tidak meminta reset password, abaikan email ini.`,
          html: `<div style="font-family:Arial,sans-serif;line-height:1.6"><h2>Reset password NALARA</h2><p>Gunakan kode OTP berikut:</p><p style="font-size:32px;letter-spacing:8px;font-weight:700">${safeOtp}</p><p>Kode berlaku ${expiresInMinutes} menit.</p><p>Jika Anda tidak meminta reset password, abaikan email ini.</p></div>`,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        const providerMessage = (await response.text()).slice(0, 500);
        this.logger.warn(`Resend rejected password reset email (${response.status}): ${providerMessage}`);
        throw new ServiceUnavailableException('Pengiriman email reset gagal. Coba lagi.');
      }
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      this.logger.warn('Resend password reset email request failed.');
      throw new ServiceUnavailableException('Pengiriman email reset gagal. Coba lagi.');
    }
  }
}

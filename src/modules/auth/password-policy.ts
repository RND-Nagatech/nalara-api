import { BadRequestException } from '@nestjs/common';

export function assertPasswordPolicy(password: unknown): asserts password is string {
  if (typeof password !== 'string') throw new BadRequestException('Kata sandi wajib diisi');
  if ([...password].length < 8) throw new BadRequestException('Kata sandi minimal 8 karakter');
  if (password.length > 128) throw new BadRequestException('Kata sandi maksimal 128 karakter');
  if (!/[A-Z]/.test(password)) throw new BadRequestException('Kata sandi harus mengandung huruf besar');
  if (!/[a-z]/.test(password)) throw new BadRequestException('Kata sandi harus mengandung huruf kecil');
  if (!/\d/.test(password)) throw new BadRequestException('Kata sandi harus mengandung angka');
  if (!/[^\p{L}\p{N}\s]/u.test(password)) throw new BadRequestException('Kata sandi harus mengandung simbol');
}

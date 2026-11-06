import { BadRequestException, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import { KioskService } from './kiosk.service';

describe('KioskService evidence storage', () => {
  const image = Buffer.from([0xff, 0xd8, 0xff]);
  const transactionId = 'TX-123';
  const fileName = `${crypto.createHash('sha256').update(image).digest('hex')}.jpg`;
  let prisma: {
    $executeRaw: jest.Mock;
    $queryRaw: jest.Mock;
  };
  let service: KioskService;

  beforeEach(() => {
    prisma = {
      $executeRaw: jest.fn(),
      $queryRaw: jest.fn(),
    };
    service = new KioskService(prisma as never);
  });

  it('stores validated photo bytes in PostgreSQL and returns a stable API URL', async () => {
    prisma.$executeRaw.mockResolvedValue(1);

    await expect(
      service.uploadEvidence(transactionId, {
        buffer: image,
        mimetype: 'image/jpeg',
        originalname: 'meter.jpg',
      }),
    ).resolves.toEqual({
      proofImageUrl: `/api/kiosk/logs/${transactionId}/evidence/${fileName}`,
    });

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const insertQuery = prisma.$executeRaw.mock.calls[0][0] as {
      values: unknown[];
    };
    expect(insertQuery.values).toContain(transactionId);
    expect(insertQuery.values).toContain(fileName);
    expect(insertQuery.values).toContain('image/jpeg');
    expect(insertQuery.values).toContain(image);
  });

  it('rejects invalid image content even when the declared type is allowed', async () => {
    await expect(
      service.uploadEvidence(transactionId, {
        buffer: Buffer.from('not an image'),
        mimetype: 'image/jpeg',
        originalname: 'meter.jpg',
      }),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('retrieves stored bytes and the validated MIME type from PostgreSQL', async () => {
    prisma.$queryRaw.mockResolvedValue([{
      fileName,
      mimeType: 'image/jpeg',
      image,
    }]);

    await expect(
      service.getEvidence(transactionId, fileName),
    ).resolves.toEqual({
      buffer: image,
      mimetype: 'image/jpeg',
    });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(
      (prisma.$queryRaw.mock.calls[0][0] as { values: unknown[] }).values,
    ).toContain(transactionId);
  });

  it('does not return an image with a different stored hash', async () => {
    prisma.$queryRaw.mockResolvedValue([{
      fileName: 'b'.repeat(64) + '.jpg',
      mimeType: 'image/jpeg',
      image,
    }]);

    await expect(service.getEvidence(transactionId, fileName)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('does not retrieve malformed evidence paths', async () => {
    await expect(service.getEvidence('../other', 'image.jpg')).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});

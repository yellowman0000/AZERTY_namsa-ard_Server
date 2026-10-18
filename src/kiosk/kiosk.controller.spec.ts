import { Test, TestingModule } from '@nestjs/testing';
import { KioskController } from './kiosk.controller';
import { KioskService } from './kiosk.service';
import { IngestLogDto } from './dto/ingest-log.dto';

describe('KioskController', () => {
  let controller: KioskController;
  let service: {
    ingestLog: jest.Mock;
    getConnectionState: jest.Mock;
    handleHeartbeat: jest.Mock;
    getKioskStatus: jest.Mock;
  };

  beforeEach(async () => {
    service = {
      ingestLog: jest.fn(),
      getConnectionState: jest.fn(),
      handleHeartbeat: jest.fn(),
      getKioskStatus: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [KioskController],
      providers: [{ provide: KioskService, useValue: service }],
    }).compile();

    controller = module.get<KioskController>(KioskController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('POST /logs (ingestLog)', () => {
    it('should call kioskService.ingestLog and return the result', async () => {
      const dto: IngestLogDto = {
        transactionId: 'TXN-001',
        kioskId: 'KIOSK-001',
        meterVolume: 42.5,
        recordedAt: '2026-10-16T10:00:00.000Z',
        checksum: 'abc123',
      };

      const expected = {
        success: true,
        logId: 'uuid-1',
        transactionId: 'TXN-001',
        kioskId: 'KIOSK-001',
        meterVolume: 42.5,
        recordedAt: new Date('2026-10-16T10:00:00.000Z'),
        createdAt: new Date(),
      };

      service.ingestLog.mockResolvedValue(expected);

      const result = await controller.ingestLog(dto);

      expect(result).toEqual(expected);
      expect(service.ingestLog).toHaveBeenCalledWith(dto);
    });
  });
});

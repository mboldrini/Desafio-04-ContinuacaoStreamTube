import { Test } from '@nestjs/testing';
import { BullModule } from '@nestjs/bullmq';
import { QueueModule } from './queue.module';

jest.mock('@nestjs/bullmq', () => {
  const actual = jest.requireActual('@nestjs/bullmq');
  const Cls = actual.BullModule;
  Cls.forRootAsync = jest
    .fn()
    .mockReturnValue({ module: Cls, imports: [], providers: [], exports: [] });
  Cls.registerQueueAsync = jest
    .fn()
    .mockReturnValue({ module: Cls, imports: [], providers: [], exports: [] });
  return { ...actual, BullModule: Cls };
});

describe('QueueModule', () => {
  it('should compile with BullModule.forRootAsync and registerQueueAsync', async () => {
    const module = await Test.createTestingModule({
      imports: [QueueModule],
    }).compile();

    expect(module).toBeDefined();
    expect(BullModule.forRootAsync).toHaveBeenCalled();
    expect(BullModule.registerQueueAsync).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'video-processing' }),
    );
  });
});

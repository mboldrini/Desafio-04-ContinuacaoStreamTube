import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { StorageService } from '../storage/storage.service';
import { StorageModule } from '../storage/storage.module';
import { createTestDataSource } from '../test/create-test-data-source';
import storageConfig from '../config/storage.config';
import queueConfig from '../config/queue.config';
import { Video } from './entities/video.entity';
import { VideosModule } from './videos.module';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosModule', () => {
  it('should compile with TypeOrmModule.forFeature wiring', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
          validationOptions: { allowUnknown: true },
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        StorageModule,
        VideosModule,
      ],
    })
      .overrideProvider(StorageService)
      .useValue({ onModuleInit: jest.fn(), getPresignedUploadUrl: jest.fn() })
      .compile();

    expect(module).toBeDefined();
    await module.close();
  }, 30000);
});

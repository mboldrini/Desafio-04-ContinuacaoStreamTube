import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { VideosService } from './videos.service';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post('upload-init')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Initiate a video upload',
    description:
      'Creates a draft video record and returns a presigned PUT URL for direct upload to MinIO.',
  })
  @ApiResponse({
    status: 201,
    description: 'Upload initiated',
    schema: {
      properties: {
        video: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            unique_id: { type: 'string' },
            channel_id: { type: 'string', format: 'uuid' },
            title: { type: 'string' },
            status: { type: 'string', enum: ['draft'] },
            storage_key: { type: 'string' },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        upload_url: { type: 'string' },
        expires_at: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitiateUploadDto,
  ) {
    const { video, uploadUrl, expiresAt } =
      await this.videosService.initiateUpload(user.sub, dto);
    return {
      video: {
        id: video.id,
        unique_id: video.unique_id,
        channel_id: video.channel_id,
        title: video.title,
        status: video.status,
        storage_key: video.storage_key,
        created_at: video.created_at,
      },
      upload_url: uploadUrl,
      expires_at: expiresAt,
    };
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Verifies the file exists in storage, transitions status to processing, and enqueues the processing job.',
  })
  @ApiResponse({
    status: 202,
    description: 'Upload completed — processing started',
    schema: {
      properties: {
        video: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            unique_id: { type: 'string' },
            channel_id: { type: 'string', format: 'uuid' },
            title: { type: 'string' },
            status: { type: 'string', enum: ['processing'] },
            updated_at: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Video not owned by authenticated user',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not in draft status',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 422,
    description: 'Video file not found in storage',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const video = await this.videosService.completeUpload(id, user.sub);
    return {
      video: {
        id: video.id,
        unique_id: video.unique_id,
        channel_id: video.channel_id,
        title: video.title,
        status: video.status,
        updated_at: video.updated_at,
      },
    };
  }

  @Get(':uniqueId/stream')
  @Public()
  @ApiOperation({
    summary: 'Stream a video',
    description:
      'Proxies video bytes from MinIO. Supports HTTP Range requests for partial content (206).',
  })
  @ApiResponse({ status: 200, description: 'Full video stream' })
  @ApiResponse({
    status: 206,
    description: 'Partial video content (Range request)',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 422,
    description: 'Video not ready for playback',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async stream(
    @Param('uniqueId') uniqueId: string,
    @Req() req: Request,
    @Res({ passthrough: false }) res: Response,
  ): Promise<void> {
    await this.videosService.streamVideo(uniqueId, req.headers['range'], res);
  }

  @Get(':uniqueId/download')
  @Public()
  @ApiOperation({
    summary: 'Download a video',
    description: 'Returns the full video with Content-Disposition: attachment.',
  })
  @ApiResponse({ status: 200, description: 'Video file download' })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 422,
    description: 'Video not ready for download',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async download(
    @Param('uniqueId') uniqueId: string,
    @Res({ passthrough: false }) res: Response,
  ): Promise<void> {
    await this.videosService.downloadVideo(uniqueId, res);
  }
}

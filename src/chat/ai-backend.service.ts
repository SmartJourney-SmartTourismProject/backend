import { HttpService } from '@nestjs/axios';
import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosError } from 'axios';
import { catchError, firstValueFrom } from 'rxjs';
import { AiTripPlanRequest, AiTripPlanResponse } from './ai-backend.types.js';

/**
 * Thin proxy to the AI backend's POST /trip-plan (docs/AI_BACKEND_ENDPOINTS.md).
 * Per that doc: frontends never call the AI backend directly, only NestJS
 * does, and it has no auth of its own - so this is the one place that talks
 * to it.
 */
@Injectable()
export class AiBackendService {
  private readonly logger = new Logger(AiBackendService.name);
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {
    this.baseUrl = this.config.get<string>('AI_BACKEND_URL', 'http://localhost:8000');
    // Typical latency is 5-20s per AI_BACKEND_ENDPOINTS.md; a slow/retrying
    // Gemini call can push past 60s, hence the generous default.
    this.timeoutMs = Number(this.config.get<string>('AI_BACKEND_TIMEOUT_MS', '120000'));
  }

  async planTrip(request: AiTripPlanRequest): Promise<AiTripPlanResponse> {
    const { data } = await firstValueFrom(
      this.http
        .post<AiTripPlanResponse>(`${this.baseUrl}/trip-plan`, request, {
          timeout: this.timeoutMs,
        })
        .pipe(
          catchError((error: AxiosError) => {
            this.logger.error(
              `AI backend /trip-plan call failed: ${error.message}`,
              error.stack,
            );
            throw new BadGatewayException('The trip-planning service is unavailable right now.');
          }),
        ),
    );
    return data;
  }
}

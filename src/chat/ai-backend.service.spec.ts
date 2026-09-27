import { BadGatewayException } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { AxiosError } from 'axios';
import { AiBackendService } from './ai-backend.service.js';
import type { HttpService } from '@nestjs/axios';
import type { ConfigService } from '@nestjs/config';

function makeConfig(values: Record<string, string> = {}) {
  return { get: vi.fn((key: string, fallback?: string) => values[key] ?? fallback) };
}

describe('AiBackendService.planTrip', () => {
  it('returns the AI backend payload on success', async () => {
    const http = { post: vi.fn().mockReturnValue(of({ data: { final_response: 'ok', itinerary: [], session_id: 's1' } })) };
    const service = new AiBackendService(http as unknown as HttpService, makeConfig() as unknown as ConfigService);

    const result = await service.planTrip({ message: 'hi', user_id: 'u1', client_gps: null });

    expect(result).toEqual({ final_response: 'ok', itinerary: [], session_id: 's1' });
  });

  it('reads the base URL and timeout from config, defaulting when unset', async () => {
    const http = { post: vi.fn().mockReturnValue(of({ data: {} })) };
    const config = makeConfig();
    const service = new AiBackendService(http as unknown as HttpService, config as unknown as ConfigService);

    await service.planTrip({ message: 'hi', user_id: 'u1', client_gps: null });

    expect(http.post).toHaveBeenCalledWith(
      'http://localhost:8000/trip-plan',
      expect.anything(),
      expect.objectContaining({ timeout: 120000 }),
    );
  });

  it.each([
    ['a non-2xx response', new AxiosError('Request failed with status code 500')],
    ['a timeout', new AxiosError('timeout of 120000ms exceeded')],
    ['a network error', new AxiosError('connect ECONNREFUSED')],
  ])('maps %s to a 502 Bad Gateway, never the raw axios error', async (_label, error) => {
    const http = { post: vi.fn().mockReturnValue(throwError(() => error)) };
    const service = new AiBackendService(http as unknown as HttpService, makeConfig() as unknown as ConfigService);

    await expect(service.planTrip({ message: 'hi', user_id: 'u1', client_gps: null })).rejects.toThrow(
      BadGatewayException,
    );
  });
});

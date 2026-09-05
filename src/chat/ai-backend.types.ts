/**
 * Shapes documented in backend/docs/AI_BACKEND_ENDPOINTS.md - POST /trip-plan.
 * Kept in one place so chat and trips agree on what a plan looks like.
 */

export interface AiTripPlanRequest {
  message: string;
  language?: string;
  user_id?: string | null;
  client_gps?: { lat: number; lon: number } | null;
  session_id?: string | null;
}

export interface AiItineraryItem {
  time?: string | null;
  type: string;
  name: string;
  notes?: string | null;
  lat: number;
  lon: number;
}

export interface AiItineraryDay {
  day: number;
  date?: string | null;
  items: AiItineraryItem[];
}

export interface AiWeather {
  current?: { temp: number; condition: string; humidity: number } | null;
  forecast?: Array<{
    date: string;
    temp_min: number;
    temp_max: number;
    condition: string;
    rain_probability: number;
  }>;
}

export interface AiDisaster {
  safe: boolean;
  active_events: unknown[];
  note?: string;
}

export interface AiTripPlanResponse {
  session_id: string;
  destination: string | null;
  itinerary: AiItineraryDay[];
  estimated_cost: number | null;
  currency: string;
  budget_notes: string | null;
  plan_source: 'llm' | 'fallback' | null;
  data_freshness: string | null;
  weather: AiWeather | null;
  disaster: AiDisaster | null;
  final_response: string | null;
  errors: string[];
  trace: Record<string, unknown>;
}

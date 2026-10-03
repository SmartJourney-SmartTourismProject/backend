import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

export class UpdateNotificationSettingsDto {
  @IsOptional()
  @IsBoolean()
  trip_reminders?: boolean;

  @IsOptional()
  @IsBoolean()
  weather_alerts?: boolean;

  @IsOptional()
  @IsBoolean()
  budget_alerts?: boolean;

  @IsOptional()
  @IsBoolean()
  push_enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  email_enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  sound_enabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  sound_volume?: number;
}

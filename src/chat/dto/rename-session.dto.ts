import { IsString, MinLength } from 'class-validator';

export class RenameSessionDto {
  @IsString()
  @MinLength(1)
  title!: string;
}

import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export const LLM_PROVIDERS = ['gemini', 'groq', 'openai', 'anthropic'] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

/** Admin > AI models: the ordered model chain (first = main, rest = failover). */
export class SetLlmChainDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(6)
  @ArrayUnique()
  @Matches(/^(gemini|groq|openai|anthropic):[A-Za-z0-9._/:-]{1,100}$/, {
    each: true,
    message: 'each model must look like "<provider>:<model>" with provider gemini, groq, openai or anthropic',
  })
  chain!: string[];
}

export class SetLlmKeyDto {
  @IsString()
  @MinLength(8)
  @MaxLength(500)
  key!: string;
}

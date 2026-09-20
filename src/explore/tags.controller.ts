import { Controller, Get } from '@nestjs/common';
import { ExploreService } from './explore.service.js';
import { Public } from '../auth/index.js';

// The canonical interest vocabulary (tag_vocabulary, seeded by the AI
// backend's seed_reference.py). PATCH /users/me/preferences only accepts
// travel_interests from this list - docs/BACKEND_ALIGNMENT.md §4 - so the
// frontend offers these as choices rather than a free-text field.
@Public()
@Controller('tags')
export class TagsController {
  constructor(private readonly exploreService: ExploreService) {}

  @Get()
  findAll() {
    return this.exploreService.getTags();
  }
}

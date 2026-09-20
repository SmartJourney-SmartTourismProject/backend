import { Module } from '@nestjs/common';
import { ExploreService } from './explore.service.js';
import { DistrictsController } from './districts.controller.js';
import { CategoriesController } from './categories.controller.js';
import { ListingsController } from './listings.controller.js';
import { TagsController } from './tags.controller.js';
import { EventsController } from './events.controller.js';

@Module({
  controllers: [
    DistrictsController,
    CategoriesController,
    ListingsController,
    EventsController,
    TagsController,
  ],
  providers: [ExploreService],
})
export class ExploreModule {}

// Topic handler self-registration barrel.
// Each import triggers the handler module's registerTopicHandler() call so
// the registry can resolve them by name when a group's topic-handlers.json
// references them.

import './diary.js';

// Starting layouts for Cypress (see start-layout.mjs), bound to the adapter geometry.
import { worldPin, rotatedSize } from './board.mjs';
import { createStartLayout } from './start-layout.mjs';

export const { startLayout, placeNearLargeICs, pinCount } = createStartLayout({ worldPin, rotatedSize });

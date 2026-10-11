// Start layouts (see start-layout.mjs), bound to the core geometry for Node.
import { worldPin, rotatedSize } from './board.mjs';
import { createStartLayout } from './start-layout.mjs';

export const { startLayout, placeNearLargeICs, pinCount } = createStartLayout({ worldPin, rotatedSize });

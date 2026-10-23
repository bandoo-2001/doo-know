export const COLLECTION_CARD_HEIGHT = 252;
export const COLLECTION_CARD_GAP = 16;
export function collectionWindow(input: {
  count: number;
  width: number;
  height: number;
  scrollTop: number;
}) {
  const columns = Math.max(1, Math.min(5, Math.floor((input.width + COLLECTION_CARD_GAP) / 240)));
  const rows = Math.ceil(input.count / columns),
    stride = COLLECTION_CARD_HEIGHT + COLLECTION_CARD_GAP;
  const first = Math.min(Math.max(0, rows - 1), Math.floor(Math.max(0, input.scrollTop) / stride));
  const startRow = Math.max(0, first - 2);
  const endRow = Math.min(
    rows,
    Math.max(first + 1, Math.ceil((Math.max(0, input.scrollTop) + input.height) / stride)) + 2,
  );
  return {
    columns,
    start: startRow * columns,
    end: Math.min(input.count, endRow * columns),
    top: startRow * stride,
    bottom: (rows - endRow) * stride,
    totalHeight: Math.max(0, rows * stride - COLLECTION_CARD_GAP),
  };
}

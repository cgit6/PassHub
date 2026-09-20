import {
  assertRecognitionComparisonInput,
  ComparisonInputError,
  type RecognitionComparisonInput,
} from './recognition-input.js';

export const COMPARISON_FRAME_VERSION = 'PassHub/idem/v2' as const;
export const MAX_COMPARISON_FRAME_BYTES = 1_024;

export function encodeComparisonFrame(
  input: RecognitionComparisonInput,
): Buffer {
  assertRecognitionComparisonInput(input);

  let frame: readonly unknown[];
  switch (input.kind) {
    case 'QR_SCANNED':
      frame = [
        COMPARISON_FRAME_VERSION,
        input.kind,
        [Buffer.byteLength(input.token, 'utf8'), input.token],
      ];
      break;
    case 'FACE_MATCHED':
      frame = [
        COMPARISON_FRAME_VERSION,
        input.kind,
        [Buffer.byteLength(input.provider, 'utf8'), input.provider],
        [
          Buffer.byteLength(input.externalSubjectId, 'utf8'),
          input.externalSubjectId,
        ],
      ];
      break;
    case 'FACE_UNKNOWN':
      frame = [COMPARISON_FRAME_VERSION, input.kind];
      break;
    default:
      throw new ComparisonInputError(
        'INVALID_RECOGNITION_KIND',
        'recognition input kind is unknown',
      );
  }

  const encoded = Buffer.from(JSON.stringify(frame), 'utf8');
  if (encoded.byteLength > MAX_COMPARISON_FRAME_BYTES) {
    throw new RangeError('comparison frame exceeds 1024 bytes');
  }
  return encoded;
}

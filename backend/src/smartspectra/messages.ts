import { SmartSpectraErrorCode, ValidationCode } from "@smartspectra/node-sdk";

// User-facing guidance for each 'validationStatus' code.
const validationMessages: Record<number, string> = {
  [ValidationCode.kOk]: "Good, hold still. Measuring…",
  [ValidationCode.kNoFaceFound]: "No face found. Look at the camera.",
  [ValidationCode.kMultipleFacesFound]: "Only one person should be in view.",
  [ValidationCode.kFaceNotCentered]: "Center your face in the frame.",
  [ValidationCode.kFaceSizeOutOfRange]: "Adjust your distance so your face fits the frame.",
  [ValidationCode.kTooDark]: "Too dark. Add more light in front of you.",
  [ValidationCode.kTooBright]: "Too bright. Avoid direct light on your face.",
  [ValidationCode.kChestNotVisible]: "Make sure your chest is visible.",
  [ValidationCode.kCameraTuning]: "Camera is adjusting…",
  [ValidationCode.kFrameRateTooLow]: "Frame rate too low. Close other apps or check your connection.",
  [ValidationCode.kExcessiveMotion]: "Too much movement. Please hold still.",
  [ValidationCode.kFaceTooClose]: "Move a little further from the camera.",
  [ValidationCode.kFaceTooFar]: "Move a little closer to the camera.",
  [ValidationCode.kFaceTooHigh]: "Move down a little so your face is centered.",
  [ValidationCode.kFaceTooLow]: "Move up a little so your face is centered.",
  [ValidationCode.kFaceNotForward]: "Face the camera directly.",
};

export function validationMessage(code: number, hint?: string): string {
  return validationMessages[code] ?? (hint || "Adjusting…");
}

// User-facing text for SDK error codes (details are logged server-side only).
export function friendlyError(code: number): string {
  switch (code) {
    case SmartSpectraErrorCode.kAuthenticationFailed:
      return "The measurement service rejected the API key.";
    case SmartSpectraErrorCode.kCreditExhausted:
      return "Measurement credits are used up.";
    case SmartSpectraErrorCode.kNetworkError:
    case SmartSpectraErrorCode.kServerError:
      return "The measurement service is unreachable. Please try again.";
    case SmartSpectraErrorCode.kInputUnavailable:
      return "The camera is not available. Close other apps using it and try again.";
    case SmartSpectraErrorCode.kNonMonotonicTimestamp:
    case SmartSpectraErrorCode.kTimestampGap:
      return "The video stream was interrupted. Please try again.";
    default:
      return "The measurement failed. Please try again.";
  }
}

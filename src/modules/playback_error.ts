export interface PlaybackErrorAttempt {
  accountName: string;
  errorCode: string;
  errorReason: string;
}

export interface PlaybackErrorInfo {
  step: string;
  errorCode: string;
  errorReason: string;
  accountName?: string;
  attempts?: PlaybackErrorAttempt[];
  details?: Record<string, string>;
  userMessage: string;
}

export class PlaybackError extends Error {
  info: PlaybackErrorInfo;

  constructor(info: PlaybackErrorInfo) {
    super(info.userMessage);
    this.name = "PlaybackError";
    this.info = info;
  }
}

export function parseErrorCodeAndReason(raw: string): {
  errorCode: string;
  errorReason: string;
} {
  const text = String(raw || "").trim();
  if (!text) {
    return {
      errorCode: "",
      errorReason: ""
    };
  }

  const candidates = [
    /["'](?:msg_code|errno|errNo|status)["']\s*[:=]\s*["']?(\d{3,})["']?/i,
    /\b(?:msg_code|errno|errNo|status)\s*[:=]\s*(\d{3,})/i,
    /\b(?:HTTP|http)\D+(\d{3})\b/,
    /\b(\d{3,6})\b/
  ];
  let errorCode = "";
  for (const rule of candidates) {
    const matched = text.match(rule);
    if (matched?.[1]) {
      errorCode = matched[1].trim();
      break;
    }
  }

  const reasonCandidates = [
    /["']msg["']\s*[:=]\s*["']([^"']+)["']/i,
    /["']error["']\s*[:=]\s*["']([^"']+)["']/i,
    /["']detail["']\s*[:=]\s*["']([^"']+)["']/i,
    /["']message["']\s*[:=]\s*["']([^"']+)["']/i
  ];
  let errorReason = "";
  for (const rule of reasonCandidates) {
    const matched = text.match(rule);
    if (matched?.[1]) {
      errorReason = matched[1].trim();
      break;
    }
  }

  if (!errorReason) {
    errorReason = text
      .replace(/^.*?message=/i, "")
      .replace(/^.*?error\s+\d+\s*:\s*/i, "")
      .replace(/^.*?failed\s*:\s*/i, "")
      .trim();
  }
  if (!errorReason) {
    errorReason = text;
  }

  return {
    errorCode,
    errorReason
  };
}


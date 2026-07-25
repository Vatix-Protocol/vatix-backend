export interface StartupHealthInput {
  cursor: string | null;
  networkId: string;
  cursorKey: string;
}

export interface StartupHealthResult {
  status: 200 | 400;
  valid: boolean;
  errors: string[];
}

export function checkStartupHealth(
  input: StartupHealthInput
): StartupHealthResult {
  const errors: string[] = [];

  if (!input.networkId || input.networkId.trim() === "") {
    errors.push("networkId must not be empty");
  }

  if (!input.cursorKey || input.cursorKey.trim() === "") {
    errors.push("cursorKey must not be empty");
  }

  if (input.cursor !== null) {
    const seq = Number(input.cursor);
    if (!Number.isFinite(seq) || seq < 0 || !Number.isInteger(seq)) {
      errors.push(
        `cursor must be a non-negative integer, got: ${JSON.stringify(input.cursor)}`
      );
    }
  }

  if (errors.length > 0) {
    return { status: 400, valid: false, errors };
  }

  return { status: 200, valid: true, errors: [] };
}

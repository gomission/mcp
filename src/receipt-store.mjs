// Copyright (c) 2026 Phenomena Labs Ltd. All rights reserved.
// Licensed under Apache-2.0. See LICENSE.

import fs from "node:fs";
import path from "node:path";

const RECEIPT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function isInside(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function readReceiptById(workspace, receiptId) {
  const id = typeof receiptId === "string" ? receiptId.trim() : "";
  if (!RECEIPT_ID_PATTERN.test(id)) {
    return { ok: false, found: false, error: "Invalid receipt id." };
  }

  const directory = path.resolve(workspace, "receipts");
  fs.mkdirSync(directory, { recursive: true });
  const file = path.resolve(directory, `${id}.json`);
  if (!isInside(directory, file)) {
    return { ok: false, found: false, error: "Invalid receipt id." };
  }
  if (!fs.existsSync(file)) return { ok: true, found: false, id };

  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return { ok: false, found: false, error: "Invalid receipt file." };
  }
  const realDirectory = fs.realpathSync(directory);
  const realFile = fs.realpathSync(file);
  if (!isInside(realDirectory, realFile)) {
    return { ok: false, found: false, error: "Invalid receipt file." };
  }

  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  try {
    return { ok: true, found: true, id, text: fs.readFileSync(descriptor, "utf8") };
  } finally {
    fs.closeSync(descriptor);
  }
}

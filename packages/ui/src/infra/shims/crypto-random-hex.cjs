'use strict';

module.exports = function randomHex(bytes) {
  const buffer = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buffer);
  let hex = "";
  for (const byte of buffer) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
};

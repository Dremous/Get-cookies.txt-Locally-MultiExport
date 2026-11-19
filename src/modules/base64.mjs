/**
 * Base64 helpers used to pass binary batch payloads through extension
 * messaging, where typed arrays are not guaranteed to survive serialization.
 */

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export const bytesToBase64 = (bytes) => {
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
};

/**
 * @param {string} base64
 * @returns {Uint8Array}
 */
export const base64ToBytes = (base64) => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

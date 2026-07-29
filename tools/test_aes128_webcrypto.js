const { webcrypto } = require("crypto");
const subtle = webcrypto.subtle;
const keyBytes = Uint8Array.from([0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15]);
const iv = new Uint8Array(16); iv[15] = 7;
const plain = new TextEncoder().encode("HLS AES-128 test payload");
(async () => {
  const key = await subtle.importKey("raw", keyBytes, {name:"AES-CBC"}, false, ["encrypt","decrypt"]);
  const encrypted = await subtle.encrypt({name:"AES-CBC",iv}, key, plain);
  const decrypted = await subtle.decrypt({name:"AES-CBC",iv}, key, encrypted);
  const result = new TextDecoder().decode(decrypted);
  if (result !== "HLS AES-128 test payload") throw new Error("AES test failed");
  console.log("AES-128 WebCrypto OK");
})();
